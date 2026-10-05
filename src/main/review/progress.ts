import { createHash } from "node:crypto";
import { access, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { errnoCode } from "../../shared/errors";
import { GitHubPostRecord } from "../../shared/github-posting";
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
//   **One writer at a time per record.** Two things write a record: the session mirror (`write`,
//   from every renderer write-back that moved the marks) and Layer C's poster (`writePosted`,
//   after each comment GitHub accepts). Each keeps the other's half — `write` carries the
//   `github` key through, `writePosted` the marks — which is a read and then a write, so the two
//   are queued per file (`serially`) and can never interleave into a record that lost one half.
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
  /** What was posted from this review to its pull request (Layer C): `record` null for none yet,
   * or `ok: false` for a record on disk this build cannot read — the whole file, or just its
   * `github` value. Unlike the read marks, "unreadable" is not folded into "nothing": a poster
   * that read it as nothing would post again what the record says is already out. */
  readPosted: (
    artifactPath: string,
  ) => Promise<{ ok: true; record: GitHubPostRecord | null } | { ok: false }>;
  /** Replace the posted record, keeping the read marks beside it. Answers whether it landed —
   * and refuses, writing nothing, when the record on disk cannot be read: it is never replaced by
   * one that has lost what it held (the "never delete on failure" rule above). A failed write is
   * logged; the poster reports what GitHub accepted either way, and the next post still finds
   * those comments on GitHub by their text (`main/github/posting.ts`). */
  writePosted: (artifactPath: string, record: GitHubPostRecord | null) => Promise<boolean>;
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
  /** The tail of each record's write queue, by filename. */
  const queues = new Map<string, Promise<unknown>>();

  /** `task` run after every earlier one queued for `name` has settled — a failed one included —
   * so a read-then-write of one record never interleaves with another. The map holds only the
   * tail and lets it go once nothing is queued behind it. */
  function serially<T>(name: string, task: () => Promise<T>): Promise<T> {
    const previous = queues.get(name) ?? Promise.resolve();
    const run = previous.then(task, task);
    const tail = run.catch(() => {});
    queues.set(name, tail);
    void tail.then(() => {
      if (queues.get(name) === tail) {
        queues.delete(name);
      }
    });
    return run;
  }

  /** Write a whole record, temp file then rename. Answers whether it landed. The `github` value
   * may be carried raw (`unknown`): see `write`. */
  async function writeRecord(
    name: string,
    record: Omit<ReviewProgressFile, "github"> & { github?: unknown },
  ): Promise<boolean> {
    const file = join(dir, name);
    // Write-then-rename: a crash mid-write leaves the previous record intact rather than a
    // truncated one. The temp name is per record, and the queue keeps two writes of one record
    // from sharing it.
    const temp = `${file}.tmp`;
    try {
      await mkdir(dir, { recursive: true });
      await writeFile(temp, `${JSON.stringify(record, null, 2)}\n`, "utf8");
      await rename(temp, file);
      return true;
    } catch (error) {
      console.error("Review progress could not be persisted:", error);
      await rm(temp, { force: true }).catch(() => {});
      return false;
    }
  }

  /** One record by its *filename*, whole — including the `path` only the sweep reads. `null`
   * is every failure collapsed into one answer, because both callers want the same thing
   * from all of them: missing (the overwhelmingly common case — a review nobody has read
   * yet), unreadable, not JSON, or a format this build predates. The reader sees no
   * progress; the sweep sees a record it does not understand and therefore may not touch. */
  /** One record's file as it stands: missing, there but unreadable (not JSON, not a record this
   * build parses, or a `github` value that does not parse — which the record's own schema would
   * quietly drop), or a record, with its `github` value exactly as it was on disk. */
  async function readFileState(
    name: string,
  ): Promise<
    | { kind: "missing" }
    | { kind: "unreadable" }
    | { kind: "record"; record: ReviewProgressFile; rawGithub: unknown; githubReadable: boolean }
  > {
    let bytes: string;
    try {
      bytes = await readFile(join(dir, name), "utf8");
    } catch (error) {
      return errnoCode(error) === "ENOENT" ? { kind: "missing" } : { kind: "unreadable" };
    }
    let json: unknown;
    try {
      json = JSON.parse(bytes);
    } catch {
      return { kind: "unreadable" };
    }
    const parsed = ReviewProgressFile.safeParse(json);
    if (!parsed.success) {
      return { kind: "unreadable" };
    }
    const rawGithub = (json as { github?: unknown }).github;
    return {
      kind: "record",
      record: parsed.data,
      rawGithub,
      githubReadable: rawGithub === undefined || GitHubPostRecord.safeParse(rawGithub).success,
    };
  }

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

  /** Whether an artifact is *provably* absent: `ENOENT`, from a parent directory that reads
   * and does not list it. `ENOENT` alone proves nothing, which is what this used to believe:
   * ejecting a disk on macOS removes its mount point under `/Volumes` outright, so every path
   * on an unmounted volume answers exactly what a deleted file does — not `ENOTCONN`, not
   * `EIO` — and a reader who ejected the disk a review lives on had its record swept at the
   * next listing. The parent is the witness: a directory that can be listed is a directory
   * that is there. A permission failure, a path component that is not a directory, a parent
   * that is itself missing all answer `false` — "I could not look" is not "it is gone", and
   * the caller acting on this deletes the only copy of somebody's read marks.
   *
   * The price is a record that outlives a folder deleted whole (a removed checkout, a temp
   * dir): a few hundred bytes of litter against somebody's read marks, and litter is the side
   * to err on. The gap that remains, named rather than pretended away: a mount point that
   * survives as an *empty directory* — an unclean eject on macOS, the convention on Linux —
   * lists, and lists nothing, so an artifact kept at the volume's root is still swept. Nothing
   * a path can be asked tells that apart from a deleted file. */
  async function artifactIsGone(artifactPath: string): Promise<boolean> {
    try {
      await access(artifactPath);
      return false;
    } catch (error) {
      if (errnoCode(error) !== "ENOENT") {
        return false;
      }
    }
    try {
      // Asked of the listing, not merely that there is one: a volume mounted between the two
      // looks — missing above, present here — reads as live rather than as a readable parent.
      // `access` still goes first, because it is the one that knows the filesystem's own idea
      // of a name (case, unicode normalization); this exact comparison only ever decides
      // inside that remount window.
      return !(await readdir(dirname(artifactPath))).includes(basename(artifactPath));
    } catch {
      return false;
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
      // The staleness check is over the *marks*, not the serialized record — `updated` moves
      // on every call and would defeat it.
      const fingerprint = JSON.stringify(progress);
      if (lastWritten.get(name) === fingerprint) {
        return;
      }
      await serially(name, async () => {
        // What main posted rides through: the renderer's write-back knows nothing of it. Carried
        // as it was on disk, unparsed, so a value this build cannot read is not dropped by a
        // write about something else. (A record unreadable as a whole is overwritten with the
        // reader's real progress, as before — this file's stated rule.)
        const existing = await readFileState(name);
        const github = existing.kind === "record" ? existing.rawGithub : undefined;
        const landed = await writeRecord(name, {
          version: 1,
          path: artifactPath,
          updated: new Date().toISOString(),
          ...progress,
          ...(github === undefined ? {} : { github }),
        });
        // Recorded only when it landed, so the next write-back retries rather than assuming
        // this one did.
        if (landed) {
          lastWritten.set(name, fingerprint);
        }
      });
    },

    readPosted: async (artifactPath) => {
      const state = await readFileState(progressFileName(artifactPath));
      switch (state.kind) {
        case "missing":
          return { ok: true, record: null };
        case "unreadable":
          return { ok: false };
        case "record":
          return state.githubReadable
            ? { ok: true, record: state.record.github ?? null }
            : { ok: false };
      }
    },

    writePosted: (artifactPath, posted) => {
      const name = progressFileName(artifactPath);
      return serially(name, async () => {
        const existing = await readFileState(name);
        if (
          existing.kind === "unreadable" ||
          (existing.kind === "record" && !existing.githubReadable)
        ) {
          console.error("A review's progress record could not be read, so it was not replaced.");
          return false;
        }
        const marks: ReadProgress =
          existing.kind === "missing"
            ? NO_PROGRESS
            : {
                readFiles: existing.record.readFiles,
                collapsedFiles: existing.record.collapsedFiles,
                foldsSeeded: existing.record.foldsSeeded,
                readTotal: existing.record.readTotal,
                resolvedComments: existing.record.resolvedComments,
              };
        return writeRecord(name, {
          version: 1,
          path: artifactPath,
          updated: new Date().toISOString(),
          ...marks,
          ...(posted === null ? {} : { github: posted }),
        });
      });
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
