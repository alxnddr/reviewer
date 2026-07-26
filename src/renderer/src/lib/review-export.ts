import {
  ReviewArtifact,
  type Comment,
  type ImportedReview,
  type ReviewComment,
  type ReviewLayer,
  type ReviewOverview,
  type ReviewSide,
  type ReviewSource,
} from "../../../shared/review";
import { assertNever } from "../../../shared/assert";
import type { CommitSha, DiffSelection, RepoInfo } from "../../../shared/git";
import { resolveAnchor } from "./diff/anchor";
import type { PatchFile } from "./diff/patch";
import { layerOwning } from "./layers";

// The two review exports, both pure and headless so they snapshot and round-trip in
// tests without a window. `serializeReview` re-emits the authored `.reviewer.json` —
// the exact projection `importReview` reads, so an edited review re-serializes and
// re-imports identically; `reviewToMarkdown` renders a portable curated review in
// the authored layer order. Neither writes derived state: the app-assigned `id` is
// stripped, and outdated is a Markdown-only note that never reaches the JSON. Disk
// I/O lives only in main (src/main/review/save.ts) — these produce strings.

/** Re-emit the curated review to the versioned artifact schema, authored fields
 * only: comments drop their app-assigned `id` back to the minimal wire
 * shape; layers keep `id`/`label`/`summary`/`kind`/`ranges` and the optional
 * `description`/`parent` in array order (the `id` is authored — a `parent`
 * references it); `source`, `version`, and any embedded `patch` pass through
 * verbatim. `.parse` is the pre-write contract gate: a shape that would not
 * re-import throws here rather than reaching disk. */
export function serializeReview(review: ImportedReview): ReviewArtifact {
  const comments: ReviewComment[] = review.comments.map((comment) => ({
    file: comment.file,
    side: comment.side,
    startLine: comment.startLine,
    endLine: comment.endLine,
    body: comment.body,
  }));
  return ReviewArtifact.parse({
    version: 1,
    source: review.source,
    // Absent patch stays an absent key (the import contract's optional), not an
    // empty string — a null patch and an empty patch are not the same artifact.
    ...(review.patch === null ? {} : { patch: review.patch }),
    // The tour doc round-trips verbatim, on the same absent-key rule: a review with no
    // overview re-emits without the key, never with a null one.
    ...(review.overview === null ? {} : { overview: review.overview }),
    comments,
    layers: review.layers,
  });
}

/** git's empty-tree object hash: the base an unborn repo's first (staged) diff is
 * taken against. It is a valid `CommitSha` (40-hex), so a working-tree review
 * authored before the repo has any commit still records a schema-valid `source` —
 * the frozen patch beside it, never these refs, is what renders. */
const EMPTY_TREE_SHA = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/** How a plain repo session's on-screen diff becomes an artifact `source`: the refs
 * to record, and whether a frozen patch must ride along because those refs alone
 * cannot reproduce the exact diff its comments were authored against. */
export type ExportSourcePlan = { source: ReviewSource; needsPatch: boolean };

/** Express a plain repo session's diff (one with no imported `reviewOrigin`) as an
 * export source. A branch comparison round-trips as pure refs — a `reviewRefs`
 * re-derive reproduces its three-dot diff exactly — so it needs no patch. Every
 * other arm embeds a frozen patch: a commit range's diff is taken against
 * `first`'s parent (which the refs do not name), and a working-tree diff has no ref
 * for its new side. `headSha` is the session HEAD (the newest log commit), the
 * committed endpoint a working-tree diff records as provenance; `null` only on an
 * unborn repo, where the empty-tree hash stands in. */
export function exportSourceFor(
  selection: DiffSelection,
  repo: RepoInfo,
  headSha: CommitSha | null,
): ExportSourcePlan {
  switch (selection.kind) {
    case "branches":
    case "reviewRefs":
      return {
        source: { kind: "local", repo, base: selection.base, head: selection.head },
        needsPatch: false,
      };
    case "commitRange":
      return {
        source: { kind: "local", repo, base: selection.first, head: selection.last },
        needsPatch: true,
      };
    case "commitRangeWithUncommitted":
      return {
        source: { kind: "local", repo, base: selection.first, head: headSha ?? selection.first },
        needsPatch: true,
      };
    case "uncommitted": {
      const ref = headSha ?? EMPTY_TREE_SHA;
      return { source: { kind: "local", repo, base: ref, head: ref }, needsPatch: true };
    }
    default:
      return assertNever(selection);
  }
}

/** A comment as Markdown needs: the authored anchor + body plus the render-time
 * outdated flag, which the JSON never carries. */
export type MarkdownComment = {
  file: string;
  side: ReviewSide;
  startLine: number;
  endLine: number;
  body: string;
  outdated: boolean;
};

export type MarkdownReview = {
  source: ReviewSource;
  /** The authored tour doc, or null: it becomes the document's title and lead, so the
   * export reads as the review the app opens on rather than a bare comment dump. */
  overview: ReviewOverview | null;
  layers: readonly ReviewLayer[];
  comments: readonly MarkdownComment[];
};

/** Project the in-app comments to Markdown comments, resolving each against the
 * loaded diff for its outdated flag exactly as the line annotations do
 * (comment-annotations.ts): a frozen embedded patch places every anchor; a
 * re-derived diff flags a comment whose range no same-side hunk still covers. */
export function markdownCommentsFrom(
  comments: readonly Comment[],
  files: readonly PatchFile[],
  frozen: boolean,
): MarkdownComment[] {
  const byPath = new Map(files.map((file) => [file.path, file]));
  return comments.map((comment) => {
    const file = byPath.get(comment.file) ?? null;
    const resolution = resolveAnchor(
      comment,
      frozen ? { kind: "frozen" } : { kind: "derived", file: file?.fileDiff ?? null },
    );
    return {
      file: comment.file,
      side: comment.side,
      startLine: comment.startLine,
      endLine: comment.endLine,
      body: comment.body,
      outdated: resolution.status === "outdated",
    };
  });
}

/** A comment belongs to the layer that owns it — the deepest one whose own ranges cover
 * it (`layerOwning`), which is the same rule the overview counts by, so the export and the
 * app never section a finding differently. Comments no layer covers fall to the general
 * section. */
function layerIndexOfComment(
  layers: readonly ReviewLayer[],
  comment: MarkdownComment,
): number | null {
  const owner = layerOwning(layers, comment);
  if (owner === null) {
    return null;
  }
  const index = layers.findIndex((layer) => layer.id === owner.id);
  return index === -1 ? null : index;
}

/** Stable order within a section: by file, then line range, then side — so a
 * regenerated export is byte-identical and snapshot-testable. */
function compareComments(a: MarkdownComment, b: MarkdownComment): number {
  if (a.file !== b.file) return a.file < b.file ? -1 : 1;
  if (a.startLine !== b.startLine) return a.startLine - b.startLine;
  if (a.endLine !== b.endLine) return a.endLine - b.endLine;
  if (a.side !== b.side) return a.side < b.side ? -1 : 1;
  return 0;
}

function locationOf(comment: MarkdownComment): string {
  const range =
    comment.startLine === comment.endLine
      ? `L${comment.startLine}`
      : `L${comment.startLine}–${comment.endLine}`;
  const tags: string[] = [];
  // The additions side is the diff's default reading; only a deletion-side anchor
  // needs the side spelled out to place the reader. Outdated rides the same paren.
  if (comment.side === "deletions") tags.push("deletions");
  if (comment.outdated) tags.push("outdated");
  return tags.length === 0 ? range : `${range} (${tags.join(", ")})`;
}

/** One comment as a list item: a machine-token header (`path` + location as code
 * spans) then the body inline, its continuation lines indented so a multi-line
 * body stays inside the item. */
function commentBullet(comment: MarkdownComment): string {
  const [first, ...rest] = comment.body.split("\n");
  const head = `- \`${comment.file}\` ${locationOf(comment)} — ${first ?? ""}`;
  return [head, ...rest.map((line) => `  ${line}`)].join("\n");
}

/** The curated review as portable Markdown: a repo + `base…head` header, then one
 * `##` section per layer in authored reading order — its summary and the
 * comments it covers — and a general section for any layer-less comments. A review
 * with a tour doc leads with it: its title becomes the `#` heading and its body the
 * lead paragraphs, which need no conversion — the markdown-lite grammar (paragraphs,
 * code spans, `[label](path)` links) is already Markdown. Machine tokens (paths, refs)
 * render as code spans; the output ends in exactly one newline, deterministic so it is
 * snapshot-testable. */
export function reviewToMarkdown(review: MarkdownReview): string {
  const other: MarkdownComment[] = [];
  const byLayer: MarkdownComment[][] = review.layers.map(() => []);
  for (const comment of review.comments) {
    const index = layerIndexOfComment(review.layers, comment);
    if (index === null) {
      other.push(comment);
    } else {
      byLayer[index]?.push(comment);
    }
  }

  const overview = review.overview;
  const lines: string[] =
    overview === null
      ? [`# Review — ${review.source.repo.name}`, ""]
      : [`# ${overview.title}`, "", `Review — \`${review.source.repo.name}\``, ""];
  lines.push(`\`${review.source.base}\` … \`${review.source.head}\``);
  if (overview !== null) {
    lines.push("", overview.body.trim());
  }

  review.layers.forEach((layer, index) => {
    lines.push("", `## ${layer.label}`, "", layer.summary);
    const covered = (byLayer[index] ?? []).slice().sort(compareComments);
    if (covered.length > 0) {
      lines.push("", ...covered.map(commentBullet));
    }
  });

  if (other.length > 0) {
    lines.push(
      "",
      "## Other comments",
      "",
      ...other.slice().sort(compareComments).map(commentBullet),
    );
  }

  return `${lines.join("\n")}\n`;
}
