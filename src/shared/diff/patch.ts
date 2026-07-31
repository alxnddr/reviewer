import { ALTERNATE_FILE_NAMES_GIT, parsePatchFiles, type FileDiffMetadata } from "@pierre/diffs";
import { assertNever } from "../assert";

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

/** Every path the loaded diff answers to → the file that carries it. A renamed file
 * answers to both of its names: an anchor authored before the rename names the old
 * path, and the file it belongs to is right there under its new one, so keying the
 * lookup on `path` alone would strand every comment a rename touched.
 *
 * `path` is seeded last and therefore wins a collision: if A was renamed to B while
 * a different file took the name A, a comment on A belongs to the file that *is* A
 * today, not to the one that used to be. */
export function filesByAnchorPath(files: readonly PatchFile[]): Map<string, PatchFile> {
  const byPath = new Map<string, PatchFile>();
  for (const file of files) {
    if (file.previousPath !== null) {
      byPath.set(file.previousPath, file);
    }
  }
  for (const file of files) {
    byPath.set(file.path, file);
  }
  return byPath;
}

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

/** The rename line that renames the file a `diff --git` header just opened. */
const RENAME_TO = "rename to ";

/** The file break the parser itself splits on (`diff --git`, trailing space or not), the
 * other line that names the file it opens (`rename to`), and the two ways a patch says "no
 * line diff here" — the textual marker, and the header of a real binary payload
 * (`git diff --binary`). All are line-anchored, and every hunk content line carries a
 * `+`/`-`/space prefix, so none of them can match inside a hunk. */
const FILE_BREAK_OR_BINARY_MARKER =
  /^(?:diff --git.*|rename to .*|Binary files |GIT binary patch)/gmu;

/** The post-change paths whose file carries a binary marker. One pass, attributing each
 * marker to the header above it and correlating by *name*: a header this loop cannot read
 * costs that one file its flag, where zipping per-file substrings against the parsed list
 * by index used to cost every file its flag on any single disagreement about where the
 * files break.
 *
 * The keys must be exactly the `fileDiff.name`s the parser derives, so this reads the
 * name the same two ways it does: its header regex, then the `rename to` line, which wins
 * — and which is *not* the same string when git quotes a path (`core.quotePath`, on by
 * default outside this app's own capture), since the header carries the path unquoted and
 * `rename to` carries the quotes. The parser's third source, `+++ b/`, cannot matter: a
 * file that says "binary" never carries one.
 *
 * Nothing sliced out of the patch outlives the loop: a patch may be `MAX_PATCH_BYTES`
 * (32 MB) and must not be copied to answer a per-file boolean. */
function binaryPaths(patch: string): Set<string> {
  const binary = new Set<string>();
  let current: string | undefined;
  FILE_BREAK_OR_BINARY_MARKER.lastIndex = 0;
  for (
    let match = FILE_BREAK_OR_BINARY_MARKER.exec(patch);
    match !== null;
    match = FILE_BREAK_OR_BINARY_MARKER.exec(patch)
  ) {
    const line = match[0];
    if (line.startsWith("diff --git")) {
      const names = ALTERNATE_FILE_NAMES_GIT.exec(line.trim());
      current = (names?.[3] ?? names?.[4])?.trim();
    } else if (current === undefined) {
      // A header nobody can read owns everything up to the next one, its own name included.
      continue;
    } else if (line.startsWith(RENAME_TO)) {
      current = line.slice(RENAME_TO.length).trim();
    } else {
      binary.add(current);
    }
  }
  return binary;
}

/** The prefix a caller passes when it parses a patch to *measure* it and never renders a line
 * of it — the CLI's validator, coverage, and universe passes. The key exists only to keep the
 * highlight cache collision-free (below), and a caller that never highlights puts nothing in
 * that cache, so one stable, obviously-inert value serves them all. Named once here rather
 * than re-invented as a magic string per module, each restating the contract in its own
 * words. */
export const ANALYSIS_CACHE_KEY = "analysis";

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
  // Binary detection needs the raw marker, which the parsed metadata drops; it is looked up
  // by the file's own post-change path, never by its position in the list.
  const binary = binaryPaths(patch);
  return files.map((fileDiff) => ({
    path: fileDiff.name,
    previousPath: fileDiff.prevName ?? null,
    status: fileChangeStatus(fileDiff.type),
    isBinary: binary.has(fileDiff.name),
    fileDiff,
  }));
}
