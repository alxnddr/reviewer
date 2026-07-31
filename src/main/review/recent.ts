import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArtifactBytes, repoDisplayName, type ReviewLayerInput } from "../../shared/review";
import { REVIEW_EXTENSION, reviewsDir } from "../../shared/node/reviews-dir";
import { errnoCode } from "../../shared/errors";
import type {
  RecentReview,
  RecentReviewSummary,
  RecentReviewsResponse,
} from "../../shared/review-ipc";
import { hasProgress, type ReviewProgressSummary } from "../../shared/review-progress";
import { REVIEW_MAX_BYTES } from "./guard";
import { progressFileName, type ProgressStore } from "./progress";

// Reading rvw's managed reviews directory, for the picker that lists what has been reviewed
// before. The directory is the CLI's output and this is the app's only look inside it —
// `reviewsDir` is imported from shared rather than restated, so the two programs cannot drift
// to different folders and leave the list permanently empty.
//
// Nothing here opens a review. It stats, sorts, and peeks — the actual open still goes through
// `guard.ts` on the path the reader picks, so this module can be wrong about a file (stale
// mtime, a summary read a moment before someone rewrote it) without any of that reaching a
// session.
//
// Two orderings matter and they are not the same one. The *sort* is over every artifact in the
// directory, so "newest first" means newest of all of them; the *cap* is applied after, so a
// directory with a thousand files still shows the thousand newest-first and drops the oldest
// ones. Doing it the other way — cap then sort — would show an arbitrary N sorted nicely.

/** How many artifacts the list will carry. High enough that no real reviews directory reaches
 * it (this is a folder one CLI writes one file to per review), low enough that the parse pass
 * below stays a handful of milliseconds. Whatever is dropped is counted and reported, never
 * silently swallowed. */
export const RECENT_MAX = 200;

/** The layer tree flattened to a count — a walk, because `layers` nests and a reader
 * comparing two rows means "how many sections does it have", not "how many top-level ones". */
function countLayers(layers: readonly ReviewLayerInput[]): number {
  return layers.reduce((total, layer) => total + 1 + countLayers(layer.children), 0);
}

/** An artifact's bytes → the handful of facts a row shows, or null when those bytes are not an
 * artifact. Pure, and read through the same `parseArtifactBytes` seam the open path uses: a
 * file this says is readable is a file that will open, and one it calls unreadable is one the
 * guard would have refused anyway. Why it failed is dropped here on purpose — a row has no
 * room for it, and the click that follows lands in the open path, which does say. */
export function summarizeArtifact(bytes: string): RecentReviewSummary | null {
  const parsed = parseArtifactBytes(bytes);
  if (!parsed.ok) {
    return null;
  }
  const artifact = parsed.artifact;
  return {
    repoPath: artifact.repo,
    // Derived from the path by the same function `importReview` derives it with — the row
    // and the tab it opens should not disagree about what the repo is called.
    repoName: repoDisplayName(artifact.repo),
    base: artifact.base,
    head: artifact.head,
    title: artifact.overview?.title ?? null,
    comments: artifact.comments.length,
    layers: countLayers(artifact.layers),
    portable: artifact.patch !== undefined && artifact.patch.length > 0,
  };
}

/** One candidate file, after the cheap pass: its path and the mtime the list sorts on. */
type Candidate = { path: string; modified: Date };

/** Every `.reviewer.json` in `dir` that is a readable file, with its mtime. A file that
 * vanishes between the listing and the stat is dropped rather than reported — it is a race
 * with the CLI, not a state worth showing anyone. */
async function candidates(dir: string, names: readonly string[]): Promise<Candidate[]> {
  const stated = await Promise.all(
    names.map(async (name): Promise<Candidate | null> => {
      const path = join(dir, name);
      try {
        // `stat`, not the readdir entry's own `isFile`: a symlinked artifact is a real way to
        // keep a review around, and a dirent reports the link rather than its target.
        const stats = await stat(path);
        return stats.isFile() ? { path, modified: stats.mtime } : null;
      } catch {
        return null;
      }
    }),
  );
  return stated.filter((candidate): candidate is Candidate => candidate !== null);
}

/** A candidate's summary, or null when it cannot have one. The size check comes before the
 * read for the same reason it does in the guard: an over-cap file is refused without ever
 * loading its bytes, so a stray multi-gigabyte file in this directory cannot take the window
 * down just by being listed. */
async function summarize(path: string): Promise<RecentReviewSummary | null> {
  try {
    const stats = await stat(path);
    if (stats.size > REVIEW_MAX_BYTES) {
      return null;
    }
    return summarizeArtifact(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

/** The reviews directory as a list: newest first, capped, each row carrying what its artifact
 * says about itself. `env`/`home` are arguments so a test can point the whole thing at a temp
 * directory without touching the real one — the same injection `reviewsDir` already asks for.
 *
 * A missing directory is not a failure: it is what a machine that has never run `rvw emit`
 * looks like, and it answers with an empty list. Only a directory that exists and refuses to be
 * listed sets `unreadable`. */
export async function listRecentReviews(
  progress: ProgressStore,
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): Promise<RecentReviewsResponse> {
  const dir = reviewsDir(env, home);

  let names: string[];
  try {
    names = await readdir(dir);
  } catch (error) {
    const missing = errnoCode(error) === "ENOENT";
    return { dir, reviews: [], truncated: 0, unreadable: !missing };
  }

  const found = await candidates(
    dir,
    names.filter((name) => name.endsWith(REVIEW_EXTENSION)),
  );
  // Newest first. Ties (two emits inside one filesystem tick) fall back to the path, so the
  // order is at least stable across two calls rather than however the sort happened to land.
  found.sort(
    (left, right) =>
      right.modified.getTime() - left.modified.getTime() || left.path.localeCompare(right.path),
  );

  const kept = found.slice(0, RECENT_MAX);
  // Progress rides alongside the summaries rather than being fetched per row by the renderer:
  // this pass already opens every artifact, and one more small read per candidate — all of
  // them in flight together, like the summaries — is far cheaper than a round trip per row.
  const [summaries, tallies] = await Promise.all([
    Promise.all(kept.map((candidate) => summarize(candidate.path))),
    progress.summaries(kept.map((candidate) => candidate.path)),
  ]);
  const reviews = kept.map(
    (candidate, index): RecentReview => ({
      path: candidate.path,
      modified: candidate.modified.toISOString(),
      summary: summaries[index] ?? null,
      // Only a *started* review carries one. A row for something nobody has opened should
      // show no glyph at all, and null says that once here rather than at each of the two
      // surfaces that render a row.
      progress: tallyFor(tallies, candidate.path),
    }),
  );

  // The one place the whole artifact directory is known, so the one place an orphaned
  // progress record can be recognized as orphaned: anything keyed to a review that is no
  // longer here. Deliberately over the *found* set, not the capped one — a review pushed
  // past RECENT_MAX is still on disk, and sweeping its progress because the list was long
  // would be a silent data loss. Fire-and-forget: the list must not wait on housekeeping.
  void progress
    .prune(new Set(found.map((candidate) => progressFileName(candidate.path))))
    .catch(() => {});

  return { dir, reviews, truncated: found.length - kept.length, unreadable: false };
}

/** A candidate's tally, or null when there is nothing to show — no record, or one whose
 * reader never marked a file. Both mean "not started", which is a row with no ring. */
function tallyFor(
  tallies: ReadonlyMap<string, ReviewProgressSummary>,
  path: string,
): ReviewProgressSummary | null {
  const tally = tallies.get(path);
  return tally !== undefined && hasProgress(tally) ? tally : null;
}
