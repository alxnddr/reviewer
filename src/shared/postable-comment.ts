import {
  parseMarkdown,
  placedReferences,
  type PlacedReference,
  type ReferenceSpan,
} from "./markdown";
import type { ReviewComment } from "./review";
import type { CommitSha } from "./git";
import type { PatchFile } from "./diff/patch";
import type { PullRequest } from "./pull-request";

// The text a comment leaves the app as, for the change's author. One pure function, in shared
// and node-free, because two very different places send it: the card's Copy in the renderer
// now, and main's poster (`main/github/posting.ts`) — and the day they disagree about what a comment says on the
// pull request is the day a reader copies one thing and posts another.
//
// **The source is `postable`, never `body`.** There is no fallback. `body` is written to the
// reader of the review, in the agent's voice, with its hedges and its "I ran"; posting it would
// put that voice in front of someone who never asked for the briefing. A comment with no
// `postable` answers null — the agent wrote nothing for the author, so the comment is not for
// posting, and neither this function nor the card invents something in its place.
//
// **References are rewritten, and nothing else is touched.** A file reference in this app's
// markdown is a repo-relative path (`[the caller](src/a.ts:12-14)`), which resolves against the
// page it is posted on and breaks there. Each one is found by the same parse the gate and the
// renderer read references with (`placedReferences`, over `readLinkTarget`) — no second
// grammar — and replaced in place by its source offsets, so the rest of what the author wrote
// survives byte for byte: a link-shaped run inside a code span or a fence was never a link, and
// is never here. Re-serializing the tree instead would re-spell every list marker and escape.
//
// Two forms are deliberately not rewritten. A reference-style definition (`[r]: src/a.ts:12`)
// is refused by the gate in an authored draft (`MalformedForm` in `markdown.ts`), so it only
// reaches here if the reader typed one into the editor, and then it leaves as written. An
// image whose source is a repo path (`![](docs/flow.png)`) is not a reference to this app and
// is neither gated nor rewritten: posted, it shows as a broken image.
//
// **Evidence goes under a fold, and only when asked.** It is the reader's receipts, written to
// them; sending it to the author is the reader's call (`postableIncludesEvidence`), never a
// default. The fold is raw `<details>`, which GitHub renders and this app deliberately does not
// (`Markdown` has no `rehype-raw` — `components/CommentEvidence.tsx` says why), so this HTML
// only ever exists in text that has left the app. Whatever precedes `</details>` is closed
// first: a fence left open at the end of the evidence — or at the end of the postable, ahead
// of the fold — would otherwise run to the end of the comment on the code host, swallowing the
// closer and showing the HTML as code.
//
// **The options object is the extension point.** `tag` and `severity` are not in the text: a
// Conventional Comments-style `issue (blocking):` lead is an open question, and when it is
// answered it is one more field on `PostableOptions` and one more part in `postableComment`'s
// composition, not a second function.

/** How a file reference becomes text outside the app.
 *
 * - `inline`: the label, then the location as code — ``the caller (`src/a.ts:12-14`)`` — which
 *   reads correctly anywhere, linked to nothing.
 * - `github`: a blob link at the reviewed commit, which is where the lines the review read
 *   still are however far the branch has moved since. Two kinds of reference fall back to
 *   inline, because a blob at that commit cannot show them: a `@deletions` span, and any
 *   reference to a path in `absentAtHead` — the files the change deletes, and the old name of
 *   one it renames, which a blob link at `sha` would answer with a 404. The caller derives the
 *   set from the parsed diff (`PatchFile.status === "deleted"`, `PatchFile.previousPath`);
 *   this module has no diff to read it from. */
export type PostableReferences =
  | { kind: "inline" }
  | {
      kind: "github";
      owner: string;
      repo: string;
      sha: string;
      absentAtHead: ReadonlySet<string>;
    };

export type PostableOptions = {
  includeEvidence: boolean;
  /** How a file reference becomes text outside the app. */
  references: PostableReferences;
};

/** Whether the comment carries text for the author at all. A `postable` of only whitespace
 * counts as none: the schema's `min(1)` admits it, but the app's own editor trims on save and
 * removes the field when nothing is left (`stores/review/curation.ts`), so the one way such a
 * value exists is an artifact written by hand — and it has to read the same as the editor's
 * answer everywhere: no block on the card, nothing to copy, counted as missing by
 * `rvw emit --pr`. Not refused by the schema instead, because the schema is also what the app
 * opens artifacts with, and a blank field is no reason to refuse to show a review. */
export function hasPostable(
  comment: Pick<ReviewComment, "postable">,
): comment is { postable: string } {
  return comment.postable !== undefined && comment.postable.trim() !== "";
}

/** The comment as it leaves the app for the change's author, or null when it has no
 * `postable` (`hasPostable`): there is nothing written for the author. */
export function postableComment(comment: ReviewComment, options: PostableOptions): string | null {
  if (!hasPostable(comment)) {
    return null;
  }
  const text = rewriteReferences(comment.postable, options.references);
  const evidence = comment.evidence;
  if (!options.includeEvidence || evidence === undefined || evidence.trim() === "") {
    return text;
  }
  // Evidence is prose in the same markdown and names files the same way, so its references
  // are rewritten too — a receipt that links nowhere on the code host is a receipt nobody can
  // follow.
  const receipts = closeOpenFence(rewriteReferences(evidence, options.references));
  return `${closeOpenFence(text)}\n\n<details>\n<summary>Evidence</summary>\n\n${receipts}\n\n</details>\n`;
}

/** The opening fence of a fenced code block: up to three spaces, then three or more of one
 * fence character. */
const FENCE_OPEN = /^ {0,3}(?<fence>`{3,}|~{3,})/u;

/** `text` with a fenced code block left open at its end closed again, or `text` unchanged.
 *
 * Read off the same parse every other caller uses rather than by counting fences in the
 * source, which a fence inside a list, a quote or another fence would fool. mdast does not
 * record whether a fence closed, so the block's own source says: a closed one ends on a line
 * of its fence character at least as long as its opening run. Only the document's last
 * top-level block can still be open at the end, and only that one matters here — a fence in a
 * list item or a quote ends at the blank line the caller appends next, because `</details>`
 * at column 0 continues neither. An indented code block ends the same way and is left alone. */
function closeOpenFence(text: string): string {
  const last = parseMarkdown(text).children.at(-1);
  if (last?.type !== "code" || last.position?.end.offset === undefined) {
    return text;
  }
  const lines = text.slice(last.position.start.offset, last.position.end.offset).split("\n");
  const fence = FENCE_OPEN.exec(lines[0] ?? "")?.groups?.["fence"];
  if (fence === undefined || (lines.length > 1 && closesFence(lines.at(-1) ?? "", fence))) {
    return text;
  }
  return `${text}${text.endsWith("\n") ? "" : "\n"}${fence}`;
}

/** Whether `line` closes a block opened by `fence`: up to three spaces of indent, a run of
 * the same character at least as long, and nothing after it but whitespace. */
function closesFence(line: string, fence: string): boolean {
  const run = line.replace(/^ {0,3}/u, "").replace(/[ \t\r]+$/u, "");
  return run.length >= fence.length && [...run].every((character) => character === fence[0]);
}

/** `text` with every file reference replaced by its outside-the-app form. Back to front, so
 * an earlier reference's offsets are still true when it is reached. */
function rewriteReferences(text: string, references: PostableReferences): string {
  let rewritten = text;
  for (const reference of placedReferences(text).toReversed()) {
    rewritten =
      rewritten.slice(0, reference.start) +
      referenceText(reference, references) +
      rewritten.slice(reference.end);
  }
  return rewritten;
}

/** One reference, as the chosen `references` spells it. A value-returning switch with no
 * `default:`, so a third host is a compile error here rather than a link silently left
 * repo-relative. */
function referenceText(reference: PlacedReference, references: PostableReferences): string {
  switch (references.kind) {
    case "inline":
      return inlineReference(reference);
    case "github":
      // A blob link at the head commit shows the file as it is *after* the change, so the
      // pre-change lines a `@deletions` span names are not on that page at all — a link there
      // would land the author on unrelated code — and a file the change deleted or renamed
      // away is not there at all. Inline names the place honestly instead.
      return reference.span?.side === "deletions" || references.absentAtHead.has(reference.path)
        ? inlineReference(reference)
        : githubReference(reference, references);
  }
}

/** ``label (`path:12-14`)``, or the code span alone when the label already says the path —
 * `[src/a.ts](src/a.ts:12)` would otherwise read `src/a.ts (src/a.ts:12)`. A pre-change span
 * says so in words, because its numbers count lines in the old file and an author reading
 * them against the new one would look in the wrong place. */
function inlineReference(reference: PlacedReference): string {
  const location = locationText(reference.path, reference.span);
  const code = codeSpan(location);
  const old = reference.span?.side === "deletions";
  const label = reference.label.trim();
  if (label === "" || label === reference.path || label === location) {
    return old ? `${code} (before this change)` : code;
  }
  return old
    ? `${reference.labelSource} (${code}, before this change)`
    : `${reference.labelSource} (${code})`;
}

/** `[label](https://github.com/o/r/blob/<sha>/<path>#L12-L14)` — the author's label kept as
 * written, markup and all, and the link's title kept if it had one. A label-less link would
 * render as nothing, so it borrows the location as its text. */
function githubReference(
  reference: PlacedReference,
  github: Extract<PostableReferences, { kind: "github" }>,
): string {
  const path = reference.path
    .split("/")
    .map((segment) => urlSegment(segment))
    .join("/");
  const lines = reference.span === null ? "" : lineFragment(reference.span);
  const url = `https://github.com/${urlSegment(github.owner)}/${urlSegment(github.repo)}/blob/${urlSegment(github.sha)}/${path}${lines}`;
  const label =
    reference.labelSource === ""
      ? codeSpan(locationText(reference.path, reference.span))
      : reference.labelSource;
  const title =
    reference.title === null ? "" : ` "${reference.title.replaceAll(/["\\]/gu, "\\$&")}"`;
  return `[${label}](${url}${title})`;
}

/** GitHub's line fragment: `#L12` for one line, `#L12-L14` for a run. */
function lineFragment(span: ReferenceSpan): string {
  return span.startLine === span.endLine
    ? `#L${span.startLine}`
    : `#L${span.startLine}-L${span.endLine}`;
}

/** The location in the app's own `path:12-14` spelling — the one an editor, a shell and an
 * agent all read as a place in a file — normalised, so `path:12-12` and `path:12` copy the
 * same. A whole-file reference is the path alone. */
function locationText(path: string, span: ReferenceSpan | null): string {
  if (span === null) {
    return path;
  }
  return span.startLine === span.endLine
    ? `${path}:${span.startLine}`
    : `${path}:${span.startLine}-${span.endLine}`;
}

/** One URL path segment. `encodeURIComponent` leaves `(` and `)` alone, and an unbalanced
 * paren ends a markdown link destination early, so those two are encoded by hand. */
function urlSegment(segment: string): string {
  return encodeURIComponent(segment).replaceAll("(", "%28").replaceAll(")", "%29");
}

/** `text` as an inline code span that survives any backticks inside it: the fence is one
 * longer than the longest run it contains, and a span that starts or ends with a backtick is
 * padded so the fence cannot swallow it (CommonMark strips that one space back off). */
function codeSpan(text: string): string {
  const longest = Math.max(0, ...(text.match(/`+/gu) ?? []).map((run) => run.length));
  const fence = "`".repeat(longest + 1);
  const pad = text.startsWith("`") || text.endsWith("`") ? " " : "";
  return `${fence}${pad}${text}${pad}${fence}`;
}

/** The paths a blob link at the reviewed head would answer with a 404: every file the change
 * deletes, and the old name of every file it renames. Derived from the diff *at the reviewed
 * commit* — the caller's job to hand that one in, not whatever diff is on screen.
 *
 * A renamed-away path that a new file has taken again (A renamed to B, a new A added) is still
 * listed: a reference to A then leaves inline rather than linked. That is the safe direction to
 * be wrong in — an inline location is never a broken link — and telling "the new A" from "the
 * old A" would need the reference to say which it means, which a path cannot. */
export function absentAtHead(files: readonly PatchFile[]): ReadonlySet<string> {
  const absent = new Set<string>();
  for (const file of files) {
    if (file.status === "deleted") {
      absent.add(file.path);
    }
    if (file.previousPath !== null) {
      absent.add(file.previousPath);
    }
  }
  return absent;
}

/** How the postable text's file references leave the app, for a review in this state. Here,
 * in shared, because every sender of the text — the card's Copy and Copy & open now, main's
 * poster (`main/github/posting.ts`) — must build the identical body from the identical rule.
 *
 * Links into the pull request's repository at the reviewed commit when the review names a pull
 * request, the commit it was written against, *and* the caller has the diff at that commit to
 * read `absentAtHead` from — the commit is what pins a blob link to the lines the review read,
 * however far the branch has moved since. With any of the three missing, inline references:
 * the location written as code, correct anywhere and linked to nothing. A review with a `pr`
 * but no `reviewedHead` is one written by hand (`rvw emit` always stamps both), and a blob link
 * at a branch name would drift under the author's feet. `reviewedFiles` is null when the caller
 * cannot vouch that its diff is the reviewed one (a narrowed or moved view), and then a link
 * could name a file the reviewed commit does not have — inline is the honest form. */
export function postableReferencesFor(
  pr: PullRequest | null,
  reviewedHead: CommitSha | null,
  reviewedFiles: readonly PatchFile[] | null,
): PostableReferences {
  if (pr === null || reviewedHead === null || reviewedFiles === null) {
    return { kind: "inline" };
  }
  switch (pr.host) {
    case "github.com":
      return {
        kind: "github",
        owner: pr.owner,
        repo: pr.repo,
        sha: reviewedHead,
        absentAtHead: absentAtHead(reviewedFiles),
      };
  }
}
