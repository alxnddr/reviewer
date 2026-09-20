import { createHash } from "node:crypto";
import { access, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { errnoCode } from "../../shared/errors";
import {
  NO_PROGRESS,
  ReviewProgressFile,
  progressSummary,
  type ReadProgress,
  type ReviewProgressSummary,
} from "../../shared/review-progress";

// The artifact-scoped half of read progress: one small JSON per review, so closing a tab and
// reopening the review later resumes instead of restarting. `review-progress.ts` carries the
// shapes and the reasoning about *why* it is stored this way; this is the disk.
//
// Three rules hold the whole module together, and every function here is one of them:
//
//   **On demand only.** Nothing is read until a review is opened or the start screen lists
//   the directory, and nothing is written until progress actually changes. There is no
//   startup pass, so a record this build cannot parse is never touched, never rewritten, and
//   never migrated in bulk — it costs that one review's ring and nothing else.
//
//   **A bad record is "no progress", never an error.** Every read failure — missing, corrupt,
//   a version from a build that does not exist yet — answers `NO_PROGRESS`. A reader who
//   loses their place should see an unread review, not a dialog.
//
//   **Never delete on failure.** An unparseable record is left exactly where it is: the build
//   that can read it may be the next one, and it is the only copy. It is overwritten only
//   when the reader generates real progress to put in its place, which is the one moment
//   clobbering it is unambiguously right. The orphan sweep obeys the same rule from the other
//   side: it asks the *artifact*, not the directory it was listed from, so a record may only
//   be dropped when it parses and the file it names is provably gone. A review opened by path
//   from anywhere — `rvw emit --out`, File ▸ Open Review…, an argv open — lives outside
//   `~/.rvw/reviews` and would otherwise look like an orphan at every listing.

/** The filename for an artifact path: its sha256, truncated. The path is the key (see
 * session.ts's `reviewPath`), but a path is not a filename — it carries separators, unicode,
 * and lengths no filesystem wants — so it is hashed rather than slugged. Truncated because
 * this is a lookup key in a directory of tens of files, not a security boundary; 128 bits of
 * it is far past any collision anyone will see, and the record carries the full path anyway
 * for anybody reading the directory by hand. */
export function progressFileName(artifactPath: string): string {
  return `${createHash("sha256").update(artifactPath).digest("hex").slice(0, 32)}.json`;
}

export type ProgressStore = {
  /** An artifact's recorded progress, or `NO_PROGRESS` for one that has none — which is
   * every artifact until its reader marks a first file. */
  read: (artifactPath: string) => Promise<ReadProgress>;
  /** Mirror a session's progress to its artifact's record. Best-effort: a failed write is
   * logged and swallowed, exactly like the session store's, because a reader mid-review must
   * never see an error about bookkeeping. */
  write: (artifactPath: string, progress: ReadProgress) => Promise<void>;
  /** Ratios for a list of artifacts, for the picker rows. Absent from the map means no
   * record; the caller renders nothing rather than an empty ring. */
  summaries: (artifactPaths: readonly string[]) => Promise<Map<string, ReviewProgressSummary>>;
  /** Drop records whose artifact is gone from disk. `liveNames` is a fast path, not the
   * rule: a record named there is known live without a stat, and every other record is
   * checked against the path it carries rather than assumed orphaned. Called from the one
   * pass that already knows the whole directory (the recents listing), never on its own. */
  prune: (liveNames: ReadonlySet<string>) => Promise<void>;
};

export function createProgressStore(dir: string): ProgressStore {
  // What was last written per file, so a session write-back that did not move the marks —
  // a scroll, a file selection, a brush — does not rewrite the record. The session store
  // debounces at 500ms and every mutation goes through it, so without this a reader
  // scrolling a long diff would rewrite this file continuously.
  const lastWritten = new Map<string, string>();

  /** One record by its *filename*, whole — including the `path` only the sweep reads. `null`
   * is every failure collapsed into one answer, because both callers want the same thing
   * from all of them: missing (the overwhelmingly common case — a review nobody has read
   * yet), unreadable, not JSON, or a format this build predates. The reader sees no
   * progress; the sweep sees a record it does not understand and therefore may not touch. */
  async function readFileRecord(name: string): Promise<ReviewProgressFile | null> {
    let bytes: string;
    try {
      bytes = await readFile(join(dir, name), "utf8");
    } catch {
      return null;
    }
    let json: unknown;
    try {
      json = JSON.parse(bytes);
    } catch {
      return null;
    }
    const parsed = ReviewProgressFile.safeParse(json);
    return parsed.success ? parsed.data : null;
  }

  /** Whether an artifact is *provably* absent: `ENOENT`, and nothing else. A permission
   * failure, a path component that is not a directory, a volume that is not mounted all
   * answer `false` — "I could not look" is not "it is gone", and the caller acting on this
   * deletes the only copy of somebody's read marks. */
  async function artifactIsGone(artifactPath: string): Promise<boolean> {
    try {
      await access(artifactPath);
      return false;
    } catch (error) {
      return errnoCode(error) === "ENOENT";
    }
  }

  async function readRecord(artifactPath: string): Promise<ReadProgress> {
    const record = await readFileRecord(progressFileName(artifactPath));
    if (record === null) {
      return NO_PROGRESS;
    }
    const { readFiles, collapsedFiles, foldsSeeded, readTotal, resolvedComments } = record;
    return { readFiles, collapsedFiles, foldsSeeded, readTotal, resolvedComments };
  }

  return {
    read: readRecord,

    write: async (artifactPath, progress) => {
      const name = progressFileName(artifactPath);
      const record: ReviewProgressFile = {
        version: 1,
        path: artifactPath,
        updated: new Date().toISOString(),
        ...progress,
      };
      // The staleness check is over the *marks*, not the serialized record — `updated` moves
      // on every call and would defeat it.
      const fingerprint = JSON.stringify(progress);
      if (lastWritten.get(name) === fingerprint) {
        return;
      }
      const file = join(dir, name);
      // Write-then-rename: a crash mid-write leaves the previous record intact rather than a
      // truncated one. The temp name is per record, so two reviews saving at once cannot
      // collide on it.
      const temp = `${file}.tmp`;
      try {
        await mkdir(dir, { recursive: true });
        await writeFile(temp, `${JSON.stringify(record, null, 2)}\n`, "utf8");
        await rename(temp, file);
        lastWritten.set(name, fingerprint);
      } catch (error) {
        console.error("Review progress could not be persisted:", error);
        // The fingerprint is deliberately not recorded on failure, so the next write-back
        // retries rather than assuming this one landed.
        await rm(temp, { force: true }).catch(() => {});
      }
    },

    summaries: async (artifactPaths) => {
      const entries = await Promise.all(
        artifactPaths.map(
          async (path): Promise<[string, ReviewProgressSummary]> => [
            path,
            progressSummary(await readRecord(path)),
          ],
        ),
      );
      return new Map(entries);
    },

    prune: async (liveNames) => {
      let names: string[];
      try {
        names = await readdir(dir);
      } catch {
        // No directory is the first-run state, not a failure worth reporting.
        return;
      }
      await Promise.all(
        names
          .filter((name) => name.endsWith(".json") && !liveNames.has(name))
          .map(async (name) => {
            // Not listed is not orphaned. Ask the record where its artifact is and look
            // there: a review kept outside the directory this sweep was handed is the
            // normal case, not the exotic one, and the old rule swept every one of them.
            const record = await readFileRecord(name);
            if (record === null || !(await artifactIsGone(record.path))) {
              return;
            }
            try {
              await rm(join(dir, name));
              lastWritten.delete(name);
            } catch {
              // A record that will not delete is litter, not a problem the reader has.
            }
          }),
      );
    },
  };
}
