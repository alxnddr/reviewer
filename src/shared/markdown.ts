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
// resolves to a chip that navigates there.

import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified, type Plugin, type PluggableList } from "unified";
import { visit } from "unist-util-visit";
import { toString } from "mdast-util-to-string";
import type { Nodes, Root } from "mdast";

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

/** A reference: a link whose target is a path, so it names a file rather than the web. */
export type FileReference = { label: string; path: string };

/** Every file reference in a body, in document order — what `rvw check` walks to enforce
 * that a reference names a file present in the diff, since one that does not renders
 * inert in the app. External links are not references and are left alone. */
export function fileReferences(text: string): FileReference[] {
  const references: FileReference[] = [];
  visit(parseMarkdown(text), "link", (node) => {
    if (!isExternalUrl(node.url)) {
      references.push({ label: toString(node), path: node.url });
    }
  });
  return references;
}

/** Promote a `` `code` `` span that names a file in the diff to a real link, so the one
 * rule "a path is a reference" is decided once, in the tree, and every renderer just
 * draws links. Prose names files both ways — `` `src/app.ts` `` in a sentence and
 * `[the entry point](src/app.ts)` — and only the author's phrasing differs.
 *
 * A transform rather than a check in the renderer: the span *becomes* a link before
 * anything looks at it, which is also why an inline code span that names nothing keeps
 * its own meaning untouched. */
export function remarkFileReferences(files: ReadonlySet<string>): Plugin<[], Root> {
  return () => (tree: Root) => {
    visit(tree, "inlineCode", (node, index, parent) => {
      if (parent === undefined || index === undefined || !files.has(node.value)) {
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
