// The app's one prose tier — a layer's chapter-intro description, the overview body,
// and a comment body — is **CommonMark + GFM, parsed by remark**. Markdown is a solved
// problem with a spec and a maintained implementation; a bespoke grammar only drifts
// from what an author actually types, and every gap in it (a table, a nested list, a
// hard break) reads to them as a bug in this app.
//
// What is left here is the part no library can know: the plugin set the app reads prose
// with — shared, so the React renderer and the CLI gate can never disagree about the
// language — and the app's own reading of a *reference*, which is the one thing this
// markdown means beyond markdown: a schemeless link path names a file in the diff, and
// resolves to a chip that navigates there. A reference may also name a line
// (`path:12`, `path:12-20`, `path:12-20@deletions`), which is what lets a finding about a
// path through the code — a value produced here, misused there — name both ends instead of
// landing the reader on a file header to scroll from.

import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified, type Plugin, type PluggableList } from "unified";
import { CONTINUE, EXIT, visit } from "unist-util-visit";
import { toString } from "mdast-util-to-string";
import type { Definition, Link, Nodes, Root } from "mdast";
import type { ReviewSide } from "./review";

/** The grammar every surface reads: CommonMark plus GFM — tables, task lists,
 * strikethrough, autolinks. One list, so `Markdown` (which parses inside react-markdown)
 * and the tree-walking callers below parse the same language; a plugin added here
 * reaches the renderer, the gate, and the sidebar preview together. */
export const MARKDOWN_PLUGINS: PluggableList = [remarkGfm];

const processor = unified().use(remarkParse).use(MARKDOWN_PLUGINS);

/** Prose → mdast, for the callers that walk the tree instead of rendering it: the gate's
 * dead-reference rule and the sidebar's flattened preview. Pure and I/O-free, so the CLI
 * shares it with the app. */
export function parseMarkdown(text: string): Root {
  return processor.parse(text);
}

/** Does this link leave the app? A URL with a scheme is the web (or something the main
 * process will refuse to open); anything else is a path, which this app reads as a
 * reference to a file in the diff. Bare `www.` autolinks are GFM's, and remark hands
 * them over with the scheme already filled in. */
export function isExternalUrl(url: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/iu.test(url) || url.startsWith("//");
}

/** The line half of a reference, when its author named one. The `path:start-end` spelling
 * is the one `commentToPrompt` already emits (`lib/review-export.ts`), chosen there because
 * an editor, a shell and an agent all read it as a place in a file — so a location is
 * written the way it is read, in both directions, rather than in two spellings a line
 * apart. `additions` is the default side exactly as it is wherever else the app omits one;
 * only a reference to the pre-change lines has to say `@deletions`. */
export type ReferenceSpan = { side: ReviewSide; startLine: number; endLine: number };

/** A reference: a link whose target is a path, so it names a file rather than the web —
 * and, with a suffix, one range inside that file. `span: null` is the whole file, which is
 * what every reference was before the suffix existed. `url` is the target as its author wrote
 * it, suffix and all (`src/a.ts:12-14@deletions`): a report that refuses a reference quotes
 * what is to be fixed, and `path` alone would quote a link the author never wrote. */
export type FileReference = {
  label: string;
  url: string;
  path: string;
  span: ReferenceSpan | null;
};

/** What the app reads a link target as. Three answers, because a link can fail in a way
 * that is neither the web nor a file: `malformed` is a schemeless target that reached for
 * the line grammar and missed (`src/app.ts:abc`, `src/app.ts:20-10`, `src/app.ts:0`).
 *
 * Kept apart from a path reference rather than folded into one, even though reading `:abc`
 * as part of the filename would "work": the two are fixed differently — one names a file
 * that is not in this diff, the other is a typo in a form — and the gate can only say which
 * if the parse does. */
export type LinkTarget =
  | { kind: "external" }
  | { kind: "reference"; path: string; span: ReferenceSpan | null }
  | { kind: "malformed" };

const LINE_SPEC = /^(?<start>\d+)(?:-(?<end>\d+))?(?:@(?<side>additions|deletions))?$/u;

/** The suffix as a span, or null when it is not one. Every rule the anchor schema enforces
 * on a line range is enforced here too — positive, ascending, and a real integer — because
 * this range is placed by the same `resolveAnchor` an authored anchor is, and a range it
 * could never place is a typo to report rather than a placement to attempt. */
function readLineSpec(spec: string): ReferenceSpan | null {
  const match = LINE_SPEC.exec(spec)?.groups;
  if (match === undefined) {
    return null;
  }
  const startLine = Number(match["start"]);
  const endLine = match["end"] === undefined ? startLine : Number(match["end"]);
  const side: ReviewSide = match["side"] === "deletions" ? "deletions" : "additions";
  return startLine >= 1 && endLine >= startLine && Number.isSafeInteger(endLine)
    ? { side, startLine, endLine }
    : null;
}

/** How this app reads one link target — the single reading the renderer's chip and the
 * gate's dead-reference rule both go through, so a link that fails the gate is a link the
 * app would have drawn dead.
 *
 * The span parse runs **before** the scheme test, and that order is the whole of why a
 * top-level file works: `index.ts:12` matches `isExternalUrl`'s scheme pattern (`index.ts`
 * is a legal scheme name), so testing for the web first would read a line reference at the
 * repo root as a URL — and react-markdown's `defaultUrlTransform` would then blank the href
 * for being an unknown protocol. A reference is recognised by its *suffix*, and only what
 * is left of the target is asked whether it leaves the app (`http://host/p:12` is still a
 * URL). Past that the reading is unchanged: a scheme is the web, and a schemeless target
 * with no colon at all is a path. */
export function readLinkTarget(url: string): LinkTarget {
  // The *first* colon is the suffix marker, because a path in a diff can carry none: git
  // quotes a path that would need one and Windows forbids it outright. That is what makes
  // `src/app.ts:abc` diagnosable rather than a filename nobody wrote.
  const colon = url.indexOf(":");
  if (colon === -1) {
    return isExternalUrl(url) ? { kind: "external" } : { kind: "reference", path: url, span: null };
  }
  const path = url.slice(0, colon);
  const span = readLineSpec(url.slice(colon + 1));
  if (span !== null && path !== "" && !isExternalUrl(path)) {
    return { kind: "reference", path, span };
  }
  // A bad suffix behind a real scheme is still the web (`mailto:a@b.co`), and the app has
  // never read those; only a schemeless target is this app's to diagnose.
  return isExternalUrl(url) ? { kind: "external" } : { kind: "malformed" };
}

/** Why a link that meant to be a reference is not one:
 *
 * - `suffix` — the target reached for the line grammar and missed (`src/app.ts:abc`).
 * - `definition` — a reference-style definition (`[r]: src/app.ts:12`) whose target is a
 *   path. Only an inline `[label](path)` is a reference this app reads: the gate checks
 *   inline links, and the postable rewrite replaces them by their offsets, so a path behind
 *   `[label][r]`, `[label][]` or a bare `[label]` would slip past both and be posted as a
 *   repo-relative link that breaks on the code host. Refusing the form is cheaper than
 *   teaching two more walkers to resolve identifiers, and the fix — write it inline — is one
 *   an author makes in seconds.
 *
 * A closed pair, so the gate's sentence for each is a compile-time obligation. */
export type MalformedForm = "suffix" | "definition";

/** A link that meant to be a reference and is not one yet — reported with the target as
 * written, since the thing to fix is the text inside the parentheses (or after the colon,
 * for a definition). */
export type MalformedReference = { label: string; url: string; why: MalformedForm };

/** Every link and link definition in a body, in document order, with the one reading of its
 * target — the walk both callers below go through, so the gate's references and the ones the
 * postable text rewrites are the same links read the same way. */
function visitTargets(
  text: string,
  onTarget: (node: Link | Definition, target: LinkTarget) => void,
): void {
  visit(parseMarkdown(text), ["link", "definition"], (node) => {
    if (node.type === "link" || node.type === "definition") {
      onTarget(node, readLinkTarget(node.url));
    }
  });
}

/** Every reference in a body, in document order, and every link that tried to be one and
 * missed — what `rvw check` walks to enforce that a reference names a file present in the
 * diff, and a line present in that file, since one that does not renders inert in the app.
 * External links are not references and are left alone, and so is a definition of one. One
 * walk for both answers: they are two outcomes of the same reading, and a caller that
 * reported only the first would pass a draft whose chips are dead. */
export function proseReferences(text: string): {
  references: FileReference[];
  malformed: MalformedReference[];
} {
  const references: FileReference[] = [];
  const malformed: MalformedReference[] = [];
  visitTargets(text, (node, target) => {
    if (node.type === "definition") {
      // A path behind a definition, readable or not, is refused as a form (`MalformedForm`).
      if (target.kind !== "external") {
        malformed.push({ label: node.label ?? node.identifier, url: node.url, why: "definition" });
      }
    } else if (target.kind === "reference") {
      references.push({
        label: toString(node),
        url: node.url,
        path: target.path,
        span: target.span,
      });
    } else if (target.kind === "malformed") {
      malformed.push({ label: toString(node), url: node.url, why: "suffix" });
    }
  });
  return { references, malformed };
}

/** The markup a *plain-text* field would have rendered as, had it been prose: a code span or
 * strong emphasis. A closed pair because these are the two an author reaches for out of habit
 * in a visual's label or note (`` `fetchBlob()` ``, `**new**`), and each is fixed differently.
 */
export type InlineMarkup = "code" | "strong";

/** Which code spans count as markup: any, or only one that wraps the whole text. The second is
 * for a field that holds *source* — a skeleton line's `code` — where a backtick is as often
 * syntax (a JS template literal, a shell substitution, a Kotlin identifier) as habit, and the
 * habit has one shape: the entire line wrapped, `` `fetchBlob(path)` ``. */
export type CodeSpanRule = "any" | "whole";

/** The first inline markup in a line of text, or null when it would read as plain words — the
 * question the gate asks of a visual's text, which the app draws literally. Asked of the
 * parser rather than a regex because CommonMark decides what `**` and a backtick mean by
 * context: `f(**kwargs)` and `a ** b` are not emphasis, a lone backtick is not a code span, and
 * only the parser that renders prose knows which a given line is. */
export function inlineMarkup(text: string, codeSpans: CodeSpanRule = "any"): InlineMarkup | null {
  const start = text.length - text.trimStart().length;
  const end = text.trimEnd().length;
  let found: InlineMarkup | null = null;
  visit(parseMarkdown(text), ["inlineCode", "strong"], (node) => {
    const counts =
      node.type === "strong" ||
      codeSpans === "any" ||
      (node.position?.start.offset === start && node.position.end.offset === end);
    if (counts) {
      found = node.type === "strong" ? "strong" : "code";
    }
    return counts ? EXIT : CONTINUE;
  });
  return found;
}

/** The block constructs a line of *inline* prose can turn into by accident — a `lede`, a step,
 * a layer `summary`, which every surface sets inside a sentence-sized slot (a list item, a
 * heading row, a rail hint). Each is one an author reaches for without meaning structure: a
 * step written `1. Parse the config` (the app numbers steps itself), a summary opening `#`,
 * a `>` before a quoted error, a `---` as a separator. Closed, so the gate's sentence for each
 * is a compile-time obligation. `table` cannot occur on one line (a table needs its delimiter
 * row) and is listed so the set states the whole of "block", not just what the single-line
 * rule happens to leave reachable. */
export type BlockMarkup = "heading" | "blockquote" | "list" | "code" | "table" | "thematicBreak";

const BLOCK_MARKUP: ReadonlySet<string> = new Set<BlockMarkup>([
  "heading",
  "blockquote",
  "list",
  "code",
  "table",
  "thematicBreak",
]);

function isBlockMarkup(type: string): type is BlockMarkup {
  return BLOCK_MARKUP.has(type);
}

/** The first block construct in a piece of inline prose, or null when it parses as the plain
 * paragraph it is drawn as. Asked of the same parser the renderer uses, for `inlineMarkup`'s
 * reason: whether `1. x`, `# x` or `- x` is a list or a heading is CommonMark's decision
 * (`#x` is not a heading, `1) x` is a list, `2025. was a year` is one too), and a regex would
 * only approximate it. A top-level `definition` or `html` node is not reported here — a path
 * behind a definition is the reference rule's (`MalformedForm`), and neither is markup an
 * author types by habit. */
export function blockMarkup(text: string): BlockMarkup | null {
  for (const node of parseMarkdown(text).children) {
    if (isBlockMarkup(node.type)) {
      return node.type;
    }
  }
  return null;
}

/** A reference together with where its link sits in the source: the half-open
 * `[start, end)` of the whole `[label](target)`, and the label as its author wrote it —
 * markup included, so `` [`retry()`](src/a.ts:12) `` keeps its code span when the link
 * around it is rewritten. `title` is the link's optional `"title"`, null when it has none. */
export type PlacedReference = FileReference & {
  start: number;
  end: number;
  labelSource: string;
  title: string | null;
};

/** Every reference in a body with its place in the source, for a caller that rewrites the
 * text rather than reading it — the postable comment, whose repo-relative links would break
 * once posted (`shared/postable-comment.ts`). Offsets rather than a re-serialized tree: the
 * rewrite has to leave every other byte the author wrote alone, and remark-stringify would
 * re-spell the whole document (list markers, emphasis, escapes) on the way back out.
 *
 * Positions come from the parse, so a link-shaped run inside a code span or a fence is never
 * here — it was never a link. Malformed targets and reference-style definitions are left
 * out: there is no location to rewrite them to, and the gate has already refused both in an
 * authored draft. */
export function placedReferences(text: string): PlacedReference[] {
  const placed: PlacedReference[] = [];
  visitTargets(text, (node, target) => {
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    // A definition is never placed: the form is refused (`MalformedForm`), so there is no
    // second spelling of a reference for the rewrite to know about.
    if (
      node.type !== "link" ||
      target.kind !== "reference" ||
      start === undefined ||
      end === undefined
    ) {
      return;
    }
    const first = node.children.at(0)?.position?.start.offset;
    const last = node.children.at(-1)?.position?.end.offset;
    placed.push({
      label: toString(node),
      url: node.url,
      path: target.path,
      span: target.span,
      start,
      end,
      labelSource: first === undefined || last === undefined ? "" : text.slice(first, last),
      title: node.title ?? null,
    });
  });
  return placed;
}

/** Promote a `` `code` `` span that names a file in the diff to a real link, so the one
 * rule "a path is a reference" is decided once, in the tree, and every renderer just
 * draws links. Prose names files both ways — `` `src/app.ts` `` in a sentence and
 * `[the entry point](src/app.ts)` — and only the author's phrasing differs.
 *
 * A transform rather than a check in the renderer: the span *becomes* a link before
 * anything looks at it, which is also why an inline code span that names nothing keeps
 * its own meaning untouched.
 *
 * The line suffix comes along for the ride — `` `src/app.ts:12` `` promotes exactly as
 * `[label](src/app.ts:12)` does — because `path:12` is the form the fix prompt hands an
 * agent, so it is the form an author pastes back into prose. Only a span whose *path* is in
 * the diff is promoted, so a quoted tool line (`Error: nope`, `a.ts:12:5: warning`) is left
 * as the code it is. */
export function remarkFileReferences(files: ReadonlySet<string>): Plugin<[], Root> {
  return () => (tree: Root) => {
    visit(tree, "inlineCode", (node, index, parent) => {
      const target = readLinkTarget(node.value);
      if (
        parent === undefined ||
        index === undefined ||
        target.kind !== "reference" ||
        !files.has(target.path)
      ) {
        return;
      }
      parent.children[index] = {
        type: "link",
        url: node.value,
        children: [{ type: "text", value: node.value }],
      };
    });
  };
}

/** A run of flattened prose: the words, and whether they were written as code. */
export type PlainRun = { code: boolean; text: string };

/** Block containers whose children are read as separate lines rather than run together. */
const LINE_SEPARATED = new Set(["blockquote", "list", "listItem", "table", "tableRow"]);

/** Markdown flattened to the words it renders: every marker dropped (`**[BUG]**` becomes
 * `[BUG]`), blocks separated by a blank line. This is what a one-line preview shows —
 * markup that is quiet on a card is loud in a 14px rail row, where a body opening
 * `**[BUG]**` reads as punctuation before it reads as a word.
 *
 * Code keeps its flag rather than its backticks: a caller sets those runs mono, which is
 * most of what makes a preview recognisable as the comment it stands for, and costs the
 * line no characters. Runs rather than a string for exactly that reason — `toString`
 * already covers the case where the split does not matter.
 *
 * Flattening the parsed tree, not the source text, is what keeps a preview from ever
 * disagreeing with the card about what a body says. */
export function flattenMarkdown(text: string): PlainRun[] {
  const runs: PlainRun[] = [];

  // Adjacent same-kind runs merge, so a separator lands inside a run rather than
  // fragmenting the line into pieces the caller would have to stitch back together.
  const push = (code: boolean, value: string): void => {
    const last = runs.at(-1);
    if (last !== undefined && last.code === code) {
      last.text += value;
    } else if (value !== "") {
      runs.push({ code, text: value });
    }
  };

  const collect = (node: Nodes): void => {
    switch (node.type) {
      case "text":
      case "html":
        push(false, node.value);
        return;
      case "inlineCode":
      case "code":
        push(true, node.value);
        return;
      // An image reads as its alt text, which is the only part of it that is words.
      case "image":
        push(false, node.alt ?? "");
        return;
      case "break":
        push(false, " ");
        return;
      // Pure structure: no words to contribute.
      case "thematicBreak":
        return;
      default: {
        if (!("children" in node)) {
          return;
        }
        const separator = LINE_SEPARATED.has(node.type) ? "\n" : "";
        for (const [index, child] of node.children.entries()) {
          if (index > 0) {
            push(false, separator);
          }
          collect(child);
        }
      }
    }
  };

  for (const [index, block] of parseMarkdown(text).children.entries()) {
    if (index > 0) {
      push(false, "\n\n");
    }
    collect(block);
  }

  // A block that carried no words (an empty fence, a rule) leaves its separator behind;
  // drop it so a flattened body never ends in blank lines a hint would render as rows.
  const last = runs.at(-1);
  if (last !== undefined && !last.code) {
    last.text = last.text.replace(/\s+$/u, "");
    if (last.text === "") {
      runs.pop();
    }
  }

  return runs;
}
