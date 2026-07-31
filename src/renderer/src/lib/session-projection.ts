import type { CommitSha, RepoInfo } from "../../../shared/git";
import type { Session } from "../../../shared/session";
import type { DiffState, LogState } from "./load-state";
import type { ReadFiles } from "./read-progress";

// A session slice projected back out: what main persists, and the two small readings of it
// the export path needs.
//
// All three are pure — the write-back's scheduling, the bridge call and the native save sheet
// stay in the store, and only the shape they carry is decided here. `persistedSession` is the
// one seam where the app's `Map`/`Set` progress becomes the record and array JSON can hold.

/** The suggested export filename stem from the repo name — the native sheet's
 * pre-fill only, but the request schema rejects path separators, so a repo name
 * carrying one (never a real toplevel basename, but untrusted all the same) is
 * flattened rather than sent as a request main would reject. */
export function reviewFileBase(repoName: string): string {
  const safe = repoName.replaceAll(/[\\/]/gu, "-").split("\0").join("-").trim();
  return `${safe === "" ? "review" : safe}-review`;
}

/** The session HEAD: the newest committed log entry's sha (the working-tree
 * pseudo-entry rides on top and carries no sha), or null on an unborn repo whose
 * log holds no commit. The committed endpoint an exported working-tree review
 * records as its source (`exportSourceFor`). */
export function headShaOf(log: LogState | null): CommitSha | null {
  if (log === null || log.phase !== "loaded") {
    return null;
  }
  for (const entry of log.entries) {
    if (entry.kind === "commit") {
      return entry.commit.sha;
    }
  }
  return null;
}

/** The slice fields the write-back carries, stated as the wire shape minus the three fields
 * the slice holds differently: `repo` (the slice keeps the repo, `Session` wraps it in a
 * source), and the two progress collections the app works in as a `Map` and a `Set`. Plus
 * `diff`, which is never persisted and is read only for the file count below.
 *
 * Derived from `Session` rather than written out, so the drift this could have runs the safe
 * way: a field added to the persisted schema becomes a field this projection must be handed,
 * which is a typecheck failure at the call site rather than a value quietly dropped from
 * every write-back. `SessionSlice` satisfies it structurally, so nothing here imports the
 * store. */
export type PersistedSlice = Omit<Session, "source" | "readFiles" | "collapsedFiles"> & {
  repo: RepoInfo;
  readFiles: ReadFiles;
  collapsedFiles: ReadonlySet<string>;
  diff: DiffState;
};

/** Inputs only — log/branches/diff are re-derived on load and never cross IPC. */
export function persistedSession(slice: PersistedSlice): Session {
  return {
    id: slice.id,
    source: { kind: "local", repo: slice.repo },
    head: slice.head,
    base: slice.base,
    commitSelection: slice.commitSelection,
    selectedFilePath: slice.selectedFilePath,
    scrollTop: slice.scrollTop,
    comments: slice.comments,
    layers: slice.layers,
    overview: slice.overview,
    reviewDiff: slice.reviewDiff,
    reviewSubrange: slice.reviewSubrange,
    reviewOrigin: slice.reviewOrigin,
    reviewPath: slice.reviewPath,
    // Map and Set are what the app reads progress as; a record and an array are what JSON
    // and the schema can carry. The conversion lives here, at the one seam, so nothing
    // downstream has to know the wire shape.
    readFiles: Object.fromEntries(slice.readFiles),
    collapsedFiles: [...slice.collapsedFiles],
    // Refreshed from the diff on screen whenever there is one, so the cached denominator
    // tracks the review as it is now; a session persisting before its diff has loaded keeps
    // the count it was restored with rather than publishing a zero the start screen would
    // render as "0 files".
    readTotal: slice.diff.phase === "loaded" ? slice.diff.files.length : slice.readTotal,
  };
}
