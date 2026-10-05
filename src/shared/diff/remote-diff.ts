import { absentAtHead } from "../postable-comment";
import type { AnchorSpan } from "../review";
import { hunksCoverRange } from "./anchor";
import { unquoteGitPath } from "./git-path";
import { filesByAnchorPath, type PatchFile } from "./patch";
import type { HunkGeometry } from "./walk";

// Whether the code host's own diff of a pull request carries an anchor — the question behind
// "GitHub would not take this as a line comment" (`next-features.md`, B4), asked with the rule
// every anchor in the app is placed by. No second parser and no second resolver: the host's
// patch goes through `parsePatch` like any other, and an anchor is "on" it exactly when one
// same-side hunk covers its whole range by the hunk header's geometry — `hunksCoverRange`, the
// body of `resolveAnchor`'s derived mode (`anchor.ts` says why that geometry).
//
// **Why the host's diff can disagree with the one the review was read against**, even at the
// same head commit:
//
//   - *Hunk boundaries.* `DIFF_CONFIG` (`shared/node/git-diff.ts`) pins prefixes and quoting
//     but deliberately not `diff.algorithm`, so a reader with `diff.algorithm=histogram` gets a
//     different alignment of the same change — one hunk where the host has two, or the reverse —
//     and a line one diff shows as context the other collapses away. (Pinning the algorithm
//     would change every captured patch's bytes; that is its own decision, not this one's.)
//   - *The merge base.* The review compares against a local base branch; a stale one moves the
//     merge base back, and the local diff then carries the base's own newer changes — whole files
//     and extra hunks the pull request never touched, which the host's diff (against the base as
//     it is now) does not.
//   - *Not a difference, but it looked like one:* names. The host C-quotes a name outside ASCII
//     (`core.quotePath`, git's default) and this app's capture does not, so the same file comes
//     back under two spellings. Both sides go through `unquoteGitPath` before they are compared.
//
// All three are covered by fixture pairs in `fixtures.ts` (`HISTOGRAM_PATCH` / `MYERS_PATCH`,
// `STALE_BASE_LOCAL_PATCH` / `STALE_BASE_HOST_PATCH`, `QUOTED_PATH_LOCAL_PATCH` /
// `QUOTED_PATH_HOST_PATCH`), captured from real `git diff` runs and a real GitHub answer.
//
// **Geometry, not the parse.** A host diff can run to megabytes, and the comparison needs only
// which hunk spans each path has. `diffGeometry` keeps exactly that — the four header numbers per
// hunk, per name — so main can cache a pull request's diff (`main/github/diff-check.ts`) without
// holding its lines.
//
// **The question is one hunk, not "anywhere in the file"**, because that is what a line comment
// through the API needs: the line, and for a range its first line too, inside one hunk of the
// pull request's diff. (GitHub's newer Files page lets a person comment on any line of a changed
// file by hand; the API, which Layer C posts through, does not.) Pure and node-free, in
// `shared`, so main's poster refuses the same comments the card marks.

/** An anchor with the id of the comment it belongs to. */
export type IdentifiedAnchor = AnchorSpan & { id: string };

/** A parsed diff cut down to what placement asks: every name a file answers to — unquoted, and
 * both of a renamed file's names, by `filesByAnchorPath`'s rule — to its hunks' header numbers.
 * A file with no hunks (a binary change, a pure rename) answers with none, so nothing places on
 * it. */
export type DiffGeometry = ReadonlyMap<string, readonly HunkGeometry[]>;

export function diffGeometry(files: readonly PatchFile[]): DiffGeometry {
  const geometry = new Map<string, readonly HunkGeometry[]>();
  for (const [name, file] of filesByAnchorPath(files)) {
    geometry.set(
      unquoteGitPath(name),
      file.fileDiff.hunks.map(({ additionStart, additionCount, deletionStart, deletionCount }) => ({
        additionStart,
        additionCount,
        deletionStart,
        deletionCount,
      })),
    );
  }
  return geometry;
}

/** Whether the host's diff carries `anchor`'s whole range in one same-side hunk. The anchor's
 * file is unquoted like the diff's names, so a name the local capture still had to quote (one
 * with a `"`, a tab, a backslash) meets its host spelling. */
export function placesOnDiff(anchor: AnchorSpan, geometry: DiffGeometry): boolean {
  return hunksCoverRange(geometry.get(unquoteGitPath(anchor.file)) ?? [], anchor);
}

/** The ids of the anchors the host's diff does not carry, in the order given. */
export function anchorsOutsideDiff(
  anchors: readonly IdentifiedAnchor[],
  geometry: DiffGeometry,
): string[] {
  return anchors.filter((anchor) => !placesOnDiff(anchor, geometry)).map((anchor) => anchor.id);
}

/** What Layer C's poster needs of the host's diff at the reviewed commit, cut down like
 * `diffGeometry` so it can be cached without the lines:
 *
 * - `geometry`: as above — whether the host would take each comment as a line comment.
 * - `paths`: every name a file answers to (unquoted) → the path the host files it under, the
 *   file's own `path` (its new name, or its old name for a deletion). A comment authored against
 *   a pre-rename name is posted on the renamed file, which is where the host shows its lines.
 * - `absentAtHead`: the names a blob link at the reviewed commit would answer with a 404 for —
 *   `postable-comment.ts`'s `absentAtHead`, unquoted — which the posted text's references read.
 *
 * All three from the host's own diff, because what is posted lands on the host: its paths, its
 * hunks, and its idea of what the reviewed commit holds. */
export type RemoteDiffIndex = {
  geometry: DiffGeometry;
  paths: ReadonlyMap<string, string>;
  absentAtHead: ReadonlySet<string>;
};

export function remoteDiffIndex(files: readonly PatchFile[]): RemoteDiffIndex {
  const paths = new Map<string, string>();
  for (const [name, file] of filesByAnchorPath(files)) {
    paths.set(unquoteGitPath(name), unquoteGitPath(file.path));
  }
  return {
    geometry: diffGeometry(files),
    paths,
    absentAtHead: new Set([...absentAtHead(files)].map((name) => unquoteGitPath(name))),
  };
}

/** The path the host files `anchor`'s comment under, or null when its diff has no such file. */
export function remotePath(
  anchor: Pick<AnchorSpan, "file">,
  index: RemoteDiffIndex,
): string | null {
  return index.paths.get(unquoteGitPath(anchor.file)) ?? null;
}
