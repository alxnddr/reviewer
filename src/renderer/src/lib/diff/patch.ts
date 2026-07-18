import { parsePatchFiles, type FileDiffMetadata } from "@pierre/diffs";
import { assertNever } from "../../../../shared/assert";

/** Review-domain status of a changed file — the A/M/D/R vocabulary of the tree and badges. */
export type FileChangeStatus = "added" | "modified" | "deleted" | "renamed";

/** One changed file of a parsed patch. `path` is the file's identity within the diff:
 * the post-change path, or the old path for a deletion. */
export type PatchFile = {
  path: string;
  /** Where the file lived before the change; null unless renamed. */
  previousPath: string | null;
  status: FileChangeStatus;
  /** Derived from the wire format — `FileDiffMetadata` has no binary flag, and a binary
   * change is otherwise indistinguishable from a pure rename (both carry zero hunks). */
  isBinary: boolean;
  fileDiff: FileDiffMetadata;
};

export function fileChangeStatus(type: FileDiffMetadata["type"]): FileChangeStatus {
  switch (type) {
    case "new":
      return "added";
    case "change":
      return "modified";
    case "deleted":
      return "deleted";
    case "rename-pure":
    case "rename-changed":
      return "renamed";
    default:
      return assertNever(type);
  }
}

const BINARY_MARKER = /^(?:Binary files .* differ|GIT binary patch)$/m;

/** Per-file segments of a git patch. Hunk content lines always carry a `+`/`-`/space
 * prefix, so a line-anchored `diff --git` cannot match inside a hunk. */
function fileSegments(patch: string): string[] {
  const header = /^diff --git /gm;
  const starts: number[] = [];
  for (let match = header.exec(patch); match !== null; match = header.exec(patch)) {
    starts.push(match.index);
  }
  return starts.map((start, index) => patch.slice(start, starts[index + 1]));
}

/** Patch string (git wire format) → changed files ready for CodeView/FileTree.
 * An empty or unparseable patch yields an empty list.
 *
 * `cacheKeyPrefix` must be unique per (session, load): the shared worker pool
 * caches highlighted output by `fileDiff.cacheKey`, and Pierre defaults a
 * missing key to the file NAME — so equally-named files from different repos
 * (or reloads of one file with new content) would render each other's cached
 * rows. The prefix is required so no call site can opt into that collision. */
export function parsePatch(patch: string, cacheKeyPrefix: string): PatchFile[] {
  const files = parsePatchFiles(patch, cacheKeyPrefix).flatMap((parsed) => parsed.files);
  const segments = fileSegments(patch);
  // Binary detection needs the raw segment; zip by position only when the parser saw
  // exactly one file per segment. Otherwise the flag degrades to false, which renders
  // a binary change as an empty diff instead of mislabeling files.
  const aligned = segments.length === files.length ? segments : null;
  return files.map((fileDiff, index) => {
    const segment = aligned?.[index];
    return {
      path: fileDiff.name,
      previousPath: fileDiff.prevName ?? null,
      status: fileChangeStatus(fileDiff.type),
      isBinary: segment !== undefined && BINARY_MARKER.test(segment),
      fileDiff,
    };
  });
}
