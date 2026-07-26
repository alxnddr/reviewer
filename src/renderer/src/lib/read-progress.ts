import type { ReviewLayer } from "../../../shared/review";
import type { PatchFile } from "./diff/patch";
import { soloFiles } from "./layers";

// Reading progress: which changed files the reader has been through, and everything the
// surfaces derive from that.
//
// **The file is the only atom.** A chapter's progress, the rail's rings, the doc's
// headline and the resume target are all derived here from the same map, against the same
// loaded diff every other derivation reads — so the rail, the band and the doc can never
// disagree about how far through the review someone is. Nothing about progress is stored
// twice, and nothing about it is authored: the artifact says what the change *is*, the
// reader's own session says how much of it they have read.
//
// The file is the right atom because it is the unit every other surface already works in:
// soloing a layer keeps whole files, the tree lists whole files, and a comment renders
// inside the file it annotates — so "I have read this file" subsumes "I have seen its
// findings". A chapter is then read exactly when its extent's files are, which is the same
// aggregation rule `lib/layers.ts` applies to ranges and counts.

/** A file's identity *as content*: what a mark is made against.
 *
 * Not the path — a path is stable across a diff that changed underneath it, and a mark
 * that survived a changed file would be the one lie this feature cannot afford. The git
 * blob ids from the patch's `index` line answer it exactly; a patch without them (some
 * generated diffs carry no index line) falls back to the change's shape, which moves
 * whenever the hunks do. */
export function fileSignature(file: PatchFile): string {
  const { newObjectId, prevObjectId, hunks } = file.fileDiff;
  const identity = `${file.status}:${file.previousPath ?? ""}`;
  if (newObjectId !== undefined || prevObjectId !== undefined) {
    return `${identity}:${prevObjectId ?? ""}..${newObjectId ?? ""}`;
  }
  const shape = hunks
    .map(
      (hunk) =>
        `${hunk.additionStart},${hunk.additionCount},${hunk.deletionStart},${hunk.deletionCount}`,
    )
    .join(";");
  return `${identity}:${shape}`;
}

/** The read marks: a file's path → the signature it was read at. A signature rather than
 * a bare set so a re-derived diff that changed the file reads honestly unread again —
 * GitHub's rule for a PR that gained a commit, without a second concept to explain.
 *
 * Marks for files the loaded diff no longer carries are *kept*, never pruned: narrowing a
 * review to a subrange drops files that widening brings straight back, and their marks
 * come back with them — the same "never dropped, re-anchors when its file returns" rule
 * the comment surface already applies. */
export type ReadFiles = ReadonlyMap<string, string>;

/** The shared empty map: a stable reference, so a session with no progress hands every
 * selector and `useMemo` the same identity instead of a fresh `new Map()` per render. */
export const NO_READ_FILES: ReadFiles = new Map();

export function isFileRead(readFiles: ReadFiles, file: PatchFile): boolean {
  return readFiles.get(file.path) === fileSignature(file);
}

/** The read paths among `files`, for the surfaces that only need membership (a tree row,
 * a file row on the doc) and shouldn't re-derive a signature per row per render. */
export function readPaths(files: readonly PatchFile[], readFiles: ReadFiles): ReadonlySet<string> {
  const paths = new Set<string>();
  for (const file of files) {
    if (isFileRead(readFiles, file)) {
      paths.add(file.path);
    }
  }
  return paths;
}

/** How much of a file set has been read. `total` is always the files actually on the
 * loaded diff, so a chapter pointing at a file that drifted out counts neither side of
 * the ratio — a section can be finished without the reader chasing code that is gone. */
export type ReadTally = { read: number; total: number };

export function tallyRead(files: readonly PatchFile[], readFiles: ReadFiles): ReadTally {
  let read = 0;
  for (const file of files) {
    if (isFileRead(readFiles, file)) {
      read += 1;
    }
  }
  return { read, total: files.length };
}

/** A layer's tally over its **extent** — its own files plus everything nested under it,
 * `soloFiles`' exact subset. So a group is read when its sections are, by the same rule
 * that gives a leaf its own, and the rail's rings nest without a special case. */
export function layerTally(
  files: readonly PatchFile[],
  layer: ReviewLayer,
  layers: readonly ReviewLayer[],
  readFiles: ReadFiles,
): ReadTally {
  return tallyRead(soloFiles(files, layer, layers), readFiles);
}

export function isComplete(tally: ReadTally): boolean {
  return tally.total > 0 && tally.read === tally.total;
}

/** Whole-number share read; an empty set reads 0 rather than NaN. Only ever a *rendering*
 * of a tally — every readout prints the counts, never the percentage alone. */
export function readPct(tally: ReadTally): number {
  return tally.total === 0 ? 0 : Math.round((tally.read / tally.total) * 100);
}

/** Mark (or unmark) a set of files, returning the SAME map when nothing changed so a
 * no-op gesture costs no re-render downstream. Marking is by signature, so a file marked
 * now and re-derived differently later is unread again without anyone clearing anything. */
export function markFilesRead(
  readFiles: ReadFiles,
  files: readonly PatchFile[],
  read: boolean,
): ReadFiles {
  const next = new Map(readFiles);
  let changed = false;
  for (const file of files) {
    if (read) {
      const signature = fileSignature(file);
      if (next.get(file.path) !== signature) {
        next.set(file.path, signature);
        changed = true;
      }
    } else if (next.delete(file.path)) {
      changed = true;
    }
  }
  return changed ? next : readFiles;
}

/** Files whose body is folded away in the code view, leaving only their header band.
 *
 * Folding is its own state rather than a reading of `readFiles`, because the two answer
 * different questions and a reader is allowed to disagree with the default: marking a file
 * read folds it (there is nothing left to look at, and the files still owed should rise up
 * the pane), but the header stays a disclosure, so opening a finished file back up is one
 * click and it stays open. Nothing is derived, so nothing can spring shut under the
 * reader — the only thing that ever folds a file is a gesture they made. */
export const NO_COLLAPSED_FILES: ReadonlySet<string> = new Set();

/** Fold or unfold a set of paths, returning the SAME set when nothing changed — the same
 * no-op contract `markFilesRead` keeps, for the same reason. */
export function withCollapsed(
  collapsed: ReadonlySet<string>,
  paths: readonly string[],
  folded: boolean,
): ReadonlySet<string> {
  const next = new Set(collapsed);
  let changed = false;
  for (const path of paths) {
    if (folded) {
      if (!next.has(path)) {
        next.add(path);
        changed = true;
      }
    } else if (next.delete(path)) {
      changed = true;
    }
  }
  return changed ? next : collapsed;
}

/** Where to pick the walkthrough back up: the first layer in document order whose extent
 * still holds something unread, or null when there is nothing left to resume.
 *
 * Document order, not "the shallowest unfinished thing": the artifact's order *is* the
 * reading order, and a rollup precedes the sections under it — so resuming lands on the
 * group when the group is where the reader stopped, and on the exact section when it
 * isn't. A layer whose files all drifted out of the diff (`total === 0`) is nothing to
 * resume into and is skipped rather than offered as a dead end. */
export function nextUnreadLayer(
  files: readonly PatchFile[],
  layers: readonly ReviewLayer[],
  readFiles: ReadFiles,
): string | null {
  for (const layer of layers) {
    const tally = layerTally(files, layer, layers, readFiles);
    if (tally.total > 0 && tally.read < tally.total) {
      return layer.id;
    }
  }
  return null;
}
