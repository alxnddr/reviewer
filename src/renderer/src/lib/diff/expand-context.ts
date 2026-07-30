import type {
  FileContents,
  FileDiffContentsLoader,
  FileDiffLoadedFiles,
  FileDiffMetadata,
} from "@pierre/diffs";
import { assertNever } from "../../../../shared/assert";
import type {
  DiffSelection,
  FileAtRef,
  FileContentsRequest,
  FileContentsResponse,
  FileContentsSource,
  RepoPath,
} from "../../../../shared/git";

/** Lines revealed per expander click. Pierre's default is 100, which leaps too far
 * to read as "load a little more"; a smaller chunk matches the GitHub-style edge
 * expander a reviewer expects and still clamps cleanly at file bounds. Live only in
 * the incremental mode below (`expandUnchanged: false`); the whole-file
 * `expandUnchanged: true` mode would ignore it. */
export const EXPANSION_LINE_COUNT = 20;

/** The two sources an expander reads full file text from: the diff's old side and
 * new side. Every live selection resolves to a pair — there is no un-expandable live
 * selection; only a frozen artifact (no repo) refuses, gated in
 * `resolveExpandLoader`. */
export type ExpansionSources = { oldSource: FileContentsSource; newSource: FileContentsSource };

/** Map a selection to the old/new sources its expander reads at, matching exactly the
 * two versions `git diff` compared for that selection (`ops.ts` `getDiff`):
 *
 * - `branches`/`reviewRefs` diff three-dot (`base...head`), so the old side is the
 *   merge-base. Reading it at `base` is exact whenever `base` is an ancestor of `head`
 *   — always for an authored review and the ordinary branch pick; a diverged `base`
 *   is the known ceiling and fails soft. The new side at `head` is exact.
 * - `commitRange` diffs `first^..last`, so the old side is `first`'s parent
 *   (`parentOf`, the same base `resolveRangeBase` computes) and the new side is `last`.
 * - `commitRangeWithUncommitted` diffs `first^` against the working tree.
 * - `uncommitted` diffs `HEAD` against the working tree. */
export function expansionSources(selection: DiffSelection): ExpansionSources {
  switch (selection.kind) {
    case "branches":
    case "reviewRefs":
      return {
        oldSource: { kind: "ref", ref: selection.base },
        newSource: { kind: "ref", ref: selection.head },
      };
    case "commitRange":
      return {
        oldSource: { kind: "parentOf", commit: selection.first },
        newSource: { kind: "ref", ref: selection.last },
      };
    case "commitRangeWithUncommitted":
      return {
        oldSource: { kind: "parentOf", commit: selection.first },
        newSource: { kind: "worktree" },
      };
    case "uncommitted":
      return { oldSource: { kind: "head" }, newSource: { kind: "worktree" } };
    default:
      return assertNever(selection);
  }
}

/** No `cacheKey`: Pierre appends a hydration segment to the partial diff's own
 * (collision-free, from `parsePatch`) key for the loaded full file, so setting one
 * here would only risk colliding with that scheme. `name` drives Pierre's language
 * inference, so the highlight of expanded lines follows the file it came from. */
function fileContents(name: string, side: Extract<FileAtRef, { kind: "present" }>): FileContents {
  return { name, contents: side.text };
}

type LoadPaths = { oldPath: string; newPath: string };

/** Map the two per-side reads onto Pierre's loader union. Pierre only calls the
 * loader for `change`/`rename-changed` diffs (`canHydrateCollapsedContext`), whose
 * new side always has a blob — an absent new side (a deleted file) is unrepresentable
 * in `FileDiffLoadedFiles`, so it surfaces as a load failure rather than a fabricated
 * `""`. An absent old side maps to Pierre's own `oldFile: null` (its "same as new"
 * signal); we reach it only defensively, since a change diff's old side is present. */
export function toLoadedFiles(
  paths: LoadPaths,
  oldSide: FileAtRef,
  newSide: FileAtRef,
): FileDiffLoadedFiles {
  if (newSide.kind === "absent") {
    throw new Error("cannot expand a diff whose new side has no blob at its ref");
  }
  const newFile = fileContents(paths.newPath, newSide);
  return oldSide.kind === "absent"
    ? { oldFile: null, newFile }
    : { oldFile: fileContents(paths.oldPath, oldSide), newFile };
}

/** The bridge method that reads a file's full text at a ref, injected so the loader
 * is testable without the preload. */
export type FileContentsFetch = (request: FileContentsRequest) => Promise<FileContentsResponse>;

async function readSide(
  fetch: FileContentsFetch,
  repoPath: RepoPath,
  source: FileContentsSource,
  path: string,
): Promise<FileAtRef> {
  const response = await fetch({ repoPath, source, path });
  if (!response.ok) {
    // Fail soft: a git failure rejects the load so Pierre keeps the hunk-only view,
    // never surfacing the error as fabricated content.
    throw new Error(`file read failed: ${response.failure.code}`);
  }
  return response.value;
}

/** A `loadDiffFiles` loader for a live-repo diff: read each side's full text from its
 * source and hand Pierre the union it expects. The IPC round-trip is the only effect;
 * the side-mapping stays pure (`toLoadedFiles`). A rename-changed reads its old side
 * at the pre-rename path; a plain change shares one path across sides. */
export function createExpandLoader(
  repoPath: RepoPath,
  sources: ExpansionSources,
  fetch: FileContentsFetch,
): FileDiffContentsLoader {
  return async (fileDiff: FileDiffMetadata): Promise<FileDiffLoadedFiles> => {
    const oldPath = fileDiff.prevName ?? fileDiff.name;
    const newPath = fileDiff.name;
    const [oldSide, newSide] = await Promise.all([
      readSide(fetch, repoPath, sources.oldSource, oldPath),
      readSide(fetch, repoPath, sources.newSource, newPath),
    ]);
    return toLoadedFiles({ oldPath, newPath }, oldSide, newSide);
  };
}

/** Inputs the diff surface gates context expansion on. */
export type ExpandLoaderInputs = {
  /** A frozen review artifact has no live repo behind it. */
  frozen: boolean;
  repoPath: RepoPath | null;
  selection: DiffSelection | null;
  fetch: FileContentsFetch | null;
};

/** The single decision point for whether the diff surface can expand context: a
 * loader whenever a live repo backs the selection, null otherwise. Every live
 * selection is expandable, so the only refusal is the frozen gate — first and
 * hardest, since a frozen artifact has no repo behind it and never offers a git-backed
 * action, mirroring how an outdated anchor pins rather than crashes. */
export function resolveExpandLoader(inputs: ExpandLoaderInputs): FileDiffContentsLoader | null {
  const { frozen, repoPath, selection, fetch } = inputs;
  if (frozen || repoPath === null || selection === null || fetch === null) {
    return null;
  }
  return createExpandLoader(repoPath, expansionSources(selection), fetch);
}

/** The expansion slice of a diff's `CodeViewOptions`. The presence of `loadDiffFiles`
 * is the gate: Pierre only offers an expander for a partial diff that has a loader
 * (`canHydrateCollapsedContext`), so a frozen artifact (null loader) shows no
 * affordance and fires no git read. */
export type ExpansionOptions = {
  /** Kept false: `expandUnchanged: true` makes Pierre eagerly hydrate and render the
   * WHOLE file at once (a deferred "expand all") and ignores `expansionLineCount`.
   * The incremental edge expander is the default mode — the loader reveals
   * `expansionLineCount` lines per click. */
  expandUnchanged: false;
  expansionLineCount: number;
  /** Omitted (not `undefined`) when there is no loader, so the option stays absent
   * rather than explicitly cleared under `exactOptionalPropertyTypes`. */
  loadDiffFiles?: FileDiffContentsLoader;
};

export function expansionOptions(loadDiffFiles: FileDiffContentsLoader | null): ExpansionOptions {
  return {
    expandUnchanged: false,
    expansionLineCount: EXPANSION_LINE_COUNT,
    ...(loadDiffFiles === null ? {} : { loadDiffFiles }),
  };
}
