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
import { visit } from "unist-util-visit";
import { toString } from "mdast-util-to-string";
import type { Nodes, Root } from "mdast";
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
 * what every reference was before the suffix existed. */
export type FileReference = { label: string; path: string; span: ReferenceSpan | null };

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

/** A link that meant to be a reference and is not one yet — reported with the target as
 * written, since the thing to fix is the text inside the parentheses. */
export type MalformedReference = { label: string; url: string };

/** Every reference in a body, in document order, and every link that tried to be one and
 * missed — what `rvw check` walks to enforce that a reference names a file present in the
 * diff, and a line present in that file, since one that does not renders inert in the app.
 * External links are not references and are left alone. One walk for both answers: they are
 * two outcomes of the same reading, and a caller that reported only the first would pass a
 * draft whose chips are dead. */
export function proseReferences(text: string): {
  references: FileReference[];
  malformed: MalformedReference[];
} {
  const references: FileReference[] = [];
  const malformed: MalformedReference[] = [];
  visit(parseMarkdown(text), "link", (node) => {
    const target = readLinkTarget(node.url);
    if (target.kind === "reference") {
      references.push({ label: toString(node), path: target.path, span: target.span });
    } else if (target.kind === "malformed") {
      malformed.push({ label: toString(node), url: node.url });
    }
  });
  return { references, malformed };
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
