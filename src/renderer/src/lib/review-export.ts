import {
  ReviewArtifact,
  type Comment,
  type ImportedReview,
  type ReviewArtifactDraft,
  type ReviewComment,
  type ReviewLayer,
  type ReviewLayerDraft,
  type ReviewOverview,
  type ReviewSide,
} from "../../../shared/review";
import { assertNever } from "../../../shared/assert";
import { countLabel } from "../../../shared/plural";
import type { CommitSha, DiffSelection, RepoInfo, ReviewRef } from "../../../shared/git";
import { resolveAnchor } from "../../../shared/diff/anchor";
import { filesByAnchorPath, type PatchFile } from "../../../shared/diff/patch";
import { snippetForAnchor, type DiffSnippet } from "./diff/snippet";
import { layerOwning } from "../../../shared/layers";

// The three review exports, all pure and headless so they snapshot and round-trip in
// tests without a window. `serializeReview` re-emits the authored `.reviewer.json` —
// the exact projection `importReview` reads, so an edited review re-serializes and
// re-imports identically; `reviewToMarkdown` renders a portable curated review in
// the authored layer order; `commentToPrompt`/`commentsToPrompt` render one comment or
// all of them as a prompt for an agent to act on. None writes derived state: the
// app-assigned `id` is stripped, and outdated is a rendered note that never reaches the
// JSON. Disk I/O lives only in main (src/main/review/save.ts) — these produce strings.
//
// The prompt exports differ from the Markdown one in *who reads the output*. Markdown is
// read by a person who has the review; a prompt is read by an agent that does not — a
// fresh session, in the repo, with no memory of any of this. Everything the prompt says
// that the Markdown export does not (the imperative, the anchored code, the sentence
// explaining a deletions-side range) is there because that reader needs it, and
// everything both leave out is left out because neither does.

/** Re-emit the curated review to the artifact schema, authored fields only — the exact
 * inverse of what `importReview` derived. Comments drop their app-assigned `id` back to the
 * minimal wire shape; layers are re-nested and drop their stamped `id`/`parent`; the repo
 * goes back to the bare path its display name came from; refs and any embedded `patch` pass
 * through verbatim. `.parse` is the pre-write contract gate: a shape that would not
 * re-import throws here rather than reaching disk. What is *returned* is the draft, not the
 * parsed value — parsing fills the array defaults back in, and an exported artifact should
 * read like a hand-authored one rather than one carrying `"children": []` under every
 * leaf. */
export function serializeReview(review: ImportedReview): ReviewArtifactDraft {
  const comments: ReviewComment[] = review.comments.map((comment) => ({
    file: comment.file,
    side: comment.side,
    startLine: comment.startLine,
    endLine: comment.endLine,
    body: comment.body,
  }));
  const artifact: ReviewArtifactDraft = {
    repo: review.repo.path,
    base: review.base,
    head: review.head,
    // Absent patch stays an absent key (the import contract's optional), not an
    // empty string — a null patch and an empty patch are not the same artifact.
    ...(review.patch === null ? {} : { patch: review.patch }),
    // The tour doc round-trips verbatim, on the same absent-key rule: a review with no
    // overview re-emits without the key, never with a null one.
    ...(review.overview === null ? {} : { overview: review.overview }),
    ...(comments.length === 0 ? {} : { comments }),
    ...(review.layers.length === 0 ? {} : { layers: nestLayers(review.layers) }),
  };
  ReviewArtifact.parse(artifact);
  return artifact;
}

/** The flat in-app layers folded back into the authored tree: each layer hangs off the one
 * its `parent` names, keeping its order among its siblings, and the stamped `id`/`parent`
 * are dropped — they are identity the app assigned, never something anyone wrote. An empty
 * `children` is omitted rather than emitted, for the same reason the import never asked for
 * it. A `parent` naming no layer in the array re-emits as a root, the same fail-soft the
 * outline reads it with, so an export can never silently lose a layer.
 *
 * @internal Exported for its own unit test only — `serializeReview` is the one caller. */
export function nestLayers(layers: readonly ReviewLayer[]): ReviewLayerDraft[] {
  const nodes = layers.map(
    (layer): ReviewLayerDraft => ({
      label: layer.label,
      ...(layer.summary === undefined ? {} : { summary: layer.summary }),
      ...(layer.description === undefined ? {} : { description: layer.description }),
      ...(layer.ranges.length === 0 ? {} : { ranges: layer.ranges }),
    }),
  );
  const indexById = new Map(layers.map((layer, index) => [layer.id, index]));
  const roots: ReviewLayerDraft[] = [];
  layers.forEach((layer, index) => {
    const node = nodes[index];
    if (node === undefined) {
      return;
    }
    const parentIndex = layer.parent === undefined ? undefined : indexById.get(layer.parent);
    const parent =
      parentIndex === undefined || parentIndex === index ? undefined : nodes[parentIndex];
    if (parent === undefined) {
      roots.push(node);
    } else if (parent.children === undefined) {
      parent.children = [node];
    } else {
      parent.children.push(node);
    }
  });
  return roots;
}

/** git's empty-tree object hash: the base an unborn repo's first (staged) diff is
 * taken against. It is a valid `CommitSha` (40-hex), so a working-tree review
 * authored before the repo has any commit still records schema-valid refs —
 * the frozen patch beside it, never these refs, is what renders. */
const EMPTY_TREE_SHA = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/** How a plain repo session's on-screen diff becomes an artifact's `repo`/`base`/`head`:
 * the refs to record, and whether a frozen patch must ride along because those refs alone
 * cannot reproduce the exact diff its comments were authored against. */
export type ExportSourcePlan = {
  repo: RepoInfo;
  base: ReviewRef;
  head: ReviewRef;
  needsPatch: boolean;
};

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
      return { repo, base: selection.base, head: selection.head, needsPatch: false };
    case "commitRange":
      return { repo, base: selection.first, head: selection.last, needsPatch: true };
    case "commitRangeWithUncommitted":
      return { repo, base: selection.first, head: headSha ?? selection.first, needsPatch: true };
    case "uncommitted": {
      const ref = headSha ?? EMPTY_TREE_SHA;
      return { repo, base: ref, head: ref, needsPatch: true };
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
  repo: RepoInfo;
  base: ReviewRef;
  head: ReviewRef;
  /** The authored tour doc, or null: it becomes the document's title and lead, so the
   * export reads as the review the app opens on rather than a bare comment dump. */
  overview: ReviewOverview | null;
  layers: readonly ReviewLayer[];
  comments: readonly MarkdownComment[];
};

/** One comment resolved against the loaded diff: its Markdown projection, and the file the
 * resolution read it through. Both exports need the same resolution, and the prompt export
 * additionally needs the *file* — so the pass happens once and hands back both, rather than
 * each export looking the file up its own way and the two disagreeing about which file a
 * renamed anchor belongs to. */
type ResolvedComment = { comment: MarkdownComment; file: PatchFile | null };

/** Resolve each comment against the loaded diff exactly as the line annotations do
 * (comment-annotations.ts): a frozen embedded patch places every anchor; a re-derived diff
 * flags a comment whose range no same-side hunk still covers. "Exactly as" includes the
 * rename lookup — a file answers to both its names (`filesByAnchorPath`), or an export
 * would call a comment the app shows placed outdated. The projected `file` stays the
 * *authored* path, which is the anchor the artifact round-trips on; only the resolution
 * reads through the rename. */
function resolveComments(
  comments: readonly Comment[],
  files: readonly PatchFile[],
  frozen: boolean,
): ResolvedComment[] {
  const byPath = filesByAnchorPath(files);
  return comments.map((comment) => {
    const file = byPath.get(comment.file) ?? null;
    const resolution = resolveAnchor(
      comment,
      frozen ? { kind: "frozen" } : { kind: "derived", file: file?.fileDiff ?? null },
    );
    return {
      comment: {
        file: comment.file,
        side: comment.side,
        startLine: comment.startLine,
        endLine: comment.endLine,
        body: comment.body,
        outdated: resolution.status === "outdated",
      },
      file,
    };
  });
}

/** Project the in-app comments to Markdown comments. */
export function markdownCommentsFrom(
  comments: readonly Comment[],
  files: readonly PatchFile[],
  frozen: boolean,
): MarkdownComment[] {
  return resolveComments(comments, files, frozen).map((resolved) => resolved.comment);
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

// ── Serializing a value nothing validated as Markdown ───────────────────────────
//
// The prose tiers of a review (an overview body, a layer summary, a comment body) *are*
// Markdown — they are authored as it and pass through verbatim. The fields below are not:
// a layer `label`, an overview `title`, a repo name and a file path are values, and the
// schema that admits them (`z.string().min(1)`, a filesystem path) constrains nothing about
// the characters Markdown reads as structure. Interpolated raw, a label carrying a newline
// splits the document at the heading and a path carrying a backtick ends the code span
// early — output that parses cleanly as something other than what it says. So every such
// value goes through one of the two helpers here on its way into a line, and the escaping
// rule for a kind of position is decided once rather than at each interpolation.
//
// "Every" spans both exports, not just the Markdown one below: the prompt payload is the
// same headings and the same code spans, read by an agent that will act on whatever
// structure it finds — a label that splits a section there mis-files the work order.

/** The longest run of backticks anywhere in a string — the number every backtick delimiter
 * below is sized against, since content that carries backticks of its own is exactly the
 * case where a fixed-length delimiter closes early. */
function longestBacktickRun(content: string): number {
  let longest = 0;
  for (const run of content.matchAll(/`+/gu)) {
    longest = Math.max(longest, run[0].length);
  }
  return longest;
}

/** Text on a heading line, from a field that was never constrained to one line. Line
 * breaks collapse to a single space — the words survive, the document's structure does
 * not move — and the two `#` runs an ATX line reads as markers are escaped: a leading one,
 * so a label cannot spell a level of its own, and a trailing one, which CommonMark takes
 * for the optional *closing* sequence and drops (`## Foo ##` is the heading "Foo", so an
 * unescaped label ending in hashes silently loses them). Escaping the first `#` of each
 * run is enough — the rest of the run is then no longer marker-adjacent. Everything else
 * is left alone: a heading is a phrase, and escaping punctuation an author typed on
 * purpose would make the export read worse than the app does. */
function headingText(text: string): string {
  const oneLine = text.replaceAll(/\s*[\r\n]+\s*/gu, " ").trim();
  return oneLine.replace(/^#/u, "\\#").replace(/(\s)(#+)$/u, "$1\\$2");
}

/** A value as an inline code span that its own content cannot end: delimited by one more
 * backtick than the longest run inside it, and padded with a space in the two cases
 * CommonMark would otherwise read the edge of the content as part of the delimiter —
 * content that starts or ends with a backtick (which would merge with the delimiter run),
 * and content that both starts and ends with a space (which the parser strips one of from
 * each side, unless the content is nothing but spaces). One pad answers both, because
 * that strip is exactly what takes the padding back: the rendered span is the value either
 * way. A line break would end the span too (a path may legally carry one), and collapses
 * the same way a heading's does. */
function codeSpan(value: string): string {
  const inline = value.replaceAll(/[\r\n]+/gu, " ");
  const ticks = "`".repeat(longestBacktickRun(inline) + 1);
  const touchesTick = inline.startsWith("`") || inline.endsWith("`");
  const wouldStrip = inline.startsWith(" ") && inline.endsWith(" ") && /[^ ]/u.test(inline);
  const pad = touchesTick || wouldStrip ? " " : "";
  return `${ticks}${pad}${inline}${pad}${ticks}`;
}

/** One comment as a list item: a machine-token header (`path` + location as code
 * spans) then the body inline, its continuation lines indented so a multi-line
 * body stays inside the item. */
function commentBullet(comment: MarkdownComment): string {
  const [first, ...rest] = comment.body.split("\n");
  const head = `- ${codeSpan(comment.file)} ${locationOf(comment)} — ${first ?? ""}`;
  return [head, ...rest.map((line) => `  ${line}`)].join("\n");
}

/** The curated review as portable Markdown: a repo + `base…head` header, then one
 * `##` section per layer in authored reading order — its summary, when it has one, and the
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
      ? [`# Review — ${headingText(review.repo.name)}`, ""]
      : [`# ${headingText(overview.title)}`, "", `Review — ${codeSpan(review.repo.name)}`, ""];
  lines.push(`${codeSpan(review.base)} … ${codeSpan(review.head)}`);
  if (overview !== null) {
    lines.push("", overview.body.trim());
  }

  review.layers.forEach((layer, index) => {
    // A layer's summary is optional, so a layer that carries only a label contributes a
    // heading and its comments — never a blank line standing in for prose nobody wrote.
    lines.push("", `## ${headingText(layer.label)}`);
    if (layer.summary !== undefined) {
      lines.push("", layer.summary);
    }
    const covered = (byLayer[index] ?? []).toSorted(compareComments);
    if (covered.length > 0) {
      lines.push("", ...covered.map((comment) => commentBullet(comment)));
    }
  });

  if (other.length > 0) {
    lines.push(
      "",
      "## Other comments",
      "",
      ...other.toSorted(compareComments).map((comment) => commentBullet(comment)),
    );
  }

  return `${lines.join("\n")}\n`;
}

// ── The prompt exports ──────────────────────────────────────────────────────────

/** How many lines of the anchored code a prompt block carries before it says what it
 * withheld. One cap for both prompt forms — a second one per form would be a concept to
 * explain and a number to keep in step. Generous on purpose: a comment anchors to "the
 * smallest span that carries the point" (skills/present-review), so this only ever bites
 * on an outlier, and when it does the block says so rather than trimming in silence. */
export const PROMPT_SNIPPET_MAX_LINES = 24;

/** A comment as a prompt needs it: the Markdown projection plus the real lines its anchor
 * points at. Null when there are none to lift — an outdated anchor (no covering hunk), or a
 * file the loaded diff does not carry — which is also the case the format has to stay valid
 * without. */
export type PromptComment = MarkdownComment & { snippet: DiffSnippet | null };

/** Project the in-app comments for a prompt: the same resolution the Markdown export takes,
 * plus the anchored code lifted from the same resolved file. An outdated anchor is not asked
 * for a snippet at all — it has no covering hunk, so there would be nothing to lift, and
 * the block leans on its drift sentence instead. */
export function promptCommentsFrom(
  comments: readonly Comment[],
  files: readonly PatchFile[],
  frozen: boolean,
): PromptComment[] {
  return resolveComments(comments, files, frozen).map(({ comment, file }) => ({
    ...comment,
    snippet:
      comment.outdated || file === null
        ? null
        : snippetForAnchor(file.fileDiff, comment, PROMPT_SNIPPET_MAX_LINES),
  }));
}

/** The fence a block of content can be wrapped in: one backtick longer than the longest run
 * inside it, and never shorter than three. A comment body may legitimately carry a fenced
 * snippet of the fix (the authoring skill says so), and code routinely carries template
 * literals — a hard-coded ``` closes the block early on both, which is a payload that reads
 * as valid and is not. */
function fenceFor(content: string): string {
  return "`".repeat(Math.max(3, longestBacktickRun(content) + 1));
}

/** Where a comment sits, as its prompt states it: `path:line` or `path:start-end`.
 *
 * A colon and an ASCII hyphen, not the `L12–15` the Markdown export uses: `path:12-15` is
 * the form an editor, a shell, and an agent all already read as a place in a file, and the
 * en dash in the human range is a character none of them accept. */
function promptRange(comment: PromptComment): string {
  return comment.startLine === comment.endLine
    ? `${comment.file}:${comment.startLine}`
    : `${comment.file}:${comment.startLine}-${comment.endLine}`;
}

/** What a reader of the payload has to be told about the range before acting on it. The
 * Markdown export tags the same two facts with one word each (`locationOf`); here they are
 * spelled out as consequences, because a person reading an export knows what "deletions"
 * means for a line number and an agent about to edit a file needs to be told. The additions
 * side stays silent — it is the default reading, and the numbers mean exactly what they
 * appear to. */
function promptQualifiers(comment: PromptComment): string[] {
  const clauses: string[] = [];
  if (comment.side === "deletions") {
    clauses.push(
      "deletions side — these are lines of the file as it stood before this change, not of the file now",
    );
  }
  if (comment.outdated) {
    clauses.push(
      "outdated — the diff no longer carries these lines, so find the code by content rather than by number",
    );
  }
  return clauses;
}

/** One comment's prompt block: a heading naming its anchor, the body verbatim, and the
 * anchored code. Byte-identical in both prompt forms — the single-comment payload is this
 * block under one imperative line, and the whole-review payload is these blocks under a
 * heading each layer — so an agent that can act on one can act on the other, and there is
 * only one shape to keep right.
 *
 * The heading is the reason it can be shared: a `###` reads as a section in a document of
 * twelve and as a label on a payload of one, where a bare anchor line would need the
 * grouping form to prefix it and the two would drift apart by a character. */
function promptBlock(comment: PromptComment): string[] {
  const qualifiers = promptQualifiers(comment);
  const anchor = codeSpan(promptRange(comment));
  const lines = [
    `### ${qualifiers.length === 0 ? anchor : `${anchor} (${qualifiers.join("; ")})`}`,
    "",
    comment.body.trim(),
  ];
  const snippet = comment.snippet;
  if (snippet !== null) {
    const code = snippet.lines.map((line) => line.text).join("\n");
    const fence = fenceFor(code);
    lines.push("", fence, code, fence);
    if (snippet.hidden > 0) {
      lines.push(
        "",
        `…${snippet.hidden === 1 ? " 1 more line" : ` ${snippet.hidden} more lines`}, through line ${comment.endLine}.`,
      );
    }
  }
  return lines;
}

/** The blocks of one section, a blank line between them. */
function promptBlocks(comments: readonly PromptComment[]): string[] {
  return comments.flatMap((comment, index) =>
    index === 0 ? promptBlock(comment) : ["", ...promptBlock(comment)],
  );
}

/** One comment as a prompt: the block, under the one line that makes it an instruction.
 *
 * That line is the whole difference between this and a record of the comment. A body says
 * *why*, never *what* — that is the authoring rule the review was written to — so an agent
 * handed the body alone will as readily explain it or ask about it as fix it. Naming the
 * verb is not an opinion about the code; it is the reader of the app having pressed a
 * button, restated for a reader who was not there. */
export function commentToPrompt(comment: PromptComment): string {
  return `${["Fix this code review comment.", "", ...promptBlock(comment)].join("\n")}\n`;
}

export type PromptReview = {
  repo: RepoInfo;
  /** The refs the review was authored against, or null for a session with no authored
   * origin — a plain repo diff the reader commented on themselves has none to name, and
   * the payload simply omits them rather than inventing a range. */
  refs: { base: ReviewRef; head: ReviewRef } | null;
  /** The tour doc, for its title alone: a fresh agent needs the name of the body of work,
   * and the body is 100–250 words about why the change exists rather than about the fixes. */
  overview: ReviewOverview | null;
  layers: readonly ReviewLayer[];
  comments: readonly PromptComment[];
};

/** Every comment of a review as one prompt: a header naming the change and the diff, then
 * the comments grouped under the layer that owns each — the same `layerOwning` rule the
 * overview counts by and the Markdown export sections by, so no surface sections a comment
 * differently from another.
 *
 * Layer order, because it is the order the review was *authored* in, and passing it through
 * is the one thing this export does about priority. It never re-orders and never ranks.
 *
 * Two differences from the Markdown export, both because this is a work order rather than a
 * document of the review: a layer with no comments contributes no section (there is nothing
 * to do under it), and nothing is numbered — the payload runs in layer order while the
 * sidebar list runs in diff order, so any number here would name a different comment than
 * the same number there. Each block is identified by its anchor, which is how every surface
 * in the app already identifies a comment and the only identifier an agent can act on. */
export function commentsToPrompt(review: PromptReview): string {
  const other: PromptComment[] = [];
  const byLayer: PromptComment[][] = review.layers.map(() => []);
  for (const comment of review.comments) {
    const index = layerIndexOfComment(review.layers, comment);
    if (index === null) {
      other.push(comment);
    } else {
      byLayer[index]?.push(comment);
    }
  }
  const sections = review.layers.flatMap((layer, index) => {
    const covered = byLayer[index] ?? [];
    return covered.length === 0 ? [] : [{ label: layer.label, comments: covered }];
  });
  const loose = other.toSorted(compareComments);

  const title = review.overview?.title;
  const count = review.comments.length;
  const refs =
    review.refs === null ? "" : ` (${codeSpan(review.refs.base)} … ${codeSpan(review.refs.head)})`;
  const lines: string[] = [
    title === undefined
      ? "# Code review comments"
      : `# Code review comments — ${headingText(title)}`,
    "",
    `${countLabel(count, "comment")} from a code review of ${codeSpan(review.repo.name)}${refs}. Address each one.${
      sections.length === 0 ? "" : " They are grouped in the review’s own reading order."
    }`,
  ];
  for (const section of sections) {
    lines.push(
      "",
      `## ${headingText(section.label)}`,
      "",
      ...promptBlocks(section.comments.toSorted(compareComments)),
    );
  }
  if (loose.length > 0) {
    // Only worth a heading when there are layer sections for it to sit apart from: on a
    // review with no layers at all these are simply the comments, and a lone "Other
    // comments" over all of them would be naming a distinction that does not exist.
    if (sections.length > 0) {
      lines.push("", "## Other comments");
    }
    lines.push("", ...promptBlocks(loose));
  }
  return `${lines.join("\n")}\n`;
}
