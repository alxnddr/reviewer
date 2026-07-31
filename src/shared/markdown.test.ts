import { describe, expect, it } from "vitest";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { visit } from "unist-util-visit";
import {
  fileReferences,
  flattenMarkdown,
  isExternalUrl,
  parseMarkdown,
  remarkFileReferences,
} from "./markdown";

// remark owns the grammar and is tested upstream — nothing here re-checks what a `-`
// or a fence means. What is tested is the reading this app puts on top of it: which
// links are file references, which code spans become them, and how a body flattens for
// a surface too narrow to render it.

describe("isExternalUrl", () => {
  it("reads a scheme (or a protocol-relative host) as leaving the app", () => {
    expect(isExternalUrl("https://example.com")).toBe(true);
    expect(isExternalUrl("mailto:a@b.co")).toBe(true);
    expect(isExternalUrl("//example.com")).toBe(true);
  });

  it("reads a path — including a Windows-ish or dotted one — as a file reference", () => {
    expect(isExternalUrl("src/a.ts")).toBe(false);
    expect(isExternalUrl("./src/a.ts")).toBe(false);
    expect(isExternalUrl("src/a.test.ts")).toBe(false);
  });
});

describe("fileReferences", () => {
  it("collects path links with their label, in document order", () => {
    expect(fileReferences("see [the entry](src/a.ts) and [b](src/b.ts)")).toEqual([
      { label: "the entry", path: "src/a.ts" },
      { label: "b", path: "src/b.ts" },
    ]);
  });

  it("reaches links nested in emphasis, list items, and quotes — but not fences", () => {
    const text =
      "**see [x](src/z.ts)**\n\n- [y](src/z.ts)\n\n> [z](src/z.ts)\n\n```\n[not](a/link)\n```";
    expect(fileReferences(text).map((reference) => reference.label)).toEqual(["x", "y", "z"]);
  });

  it("leaves web links alone — they open in the browser, they name no file", () => {
    expect(fileReferences("[docs](https://example.com) and https://bare.example")).toEqual([]);
  });

  it("takes the label from the link's own text, markers and all stripped", () => {
    expect(fileReferences("[the **entry** `point`](src/a.ts)")).toEqual([
      { label: "the entry point", path: "src/a.ts" },
    ]);
  });
});

describe("remarkFileReferences", () => {
  /** Every link the plugin leaves in the tree, run as the renderer runs it. */
  const promote = (text: string, files: string[]): string[] => {
    const processor = unified()
      .use(remarkParse)
      .use(remarkFileReferences(new Set(files)));
    const tree = processor.runSync(parseMarkdown(text));
    const links: string[] = [];
    visit(tree, "link", (node) => {
      links.push(node.url);
    });
    return links;
  };

  it("promotes a code span that names a diff file to a link", () => {
    expect(promote("see `src/a.ts` now", ["src/a.ts"])).toEqual(["src/a.ts"]);
  });

  it("leaves a code span that names nothing in the diff as code", () => {
    expect(promote("call `doThing()`", ["src/a.ts"])).toEqual([]);
  });

  it("reaches a span nested inside emphasis", () => {
    expect(promote("**see `src/a.ts`**", ["src/a.ts"])).toEqual(["src/a.ts"]);
  });
});

describe("flattenMarkdown", () => {
  const plain = (text: string): string =>
    flattenMarkdown(text)
      .map((run) => run.text)
      .join("");

  it("keeps a plain sentence as one sans run", () => {
    expect(flattenMarkdown("this needs a guard")).toEqual([
      { code: false, text: "this needs a guard" },
    ]);
  });

  it("splits an inline ref into its own mono run", () => {
    expect(flattenMarkdown("call `resolveAnchor` here")).toEqual([
      { code: false, text: "call " },
      { code: true, text: "resolveAnchor" },
      { code: false, text: " here" },
    ]);
  });

  it("drops emphasis markers, keeping the words they wrapped", () => {
    expect(plain("**[BUG]** the guard is missing")).toBe("[BUG] the guard is missing");
    expect(plain("a *soft* and ~~struck~~ point")).toBe("a soft and struck point");
  });

  it("drops heading, list, and quote markers", () => {
    expect(plain("## Why\n\n- one\n- two\n\n> aside")).toBe("Why\n\none\ntwo\n\naside");
  });

  it("reads a link as its label", () => {
    expect(plain("see [the entry](src/a.ts)")).toBe("see the entry");
  });

  it("keeps a fenced block's text as one mono run", () => {
    expect(flattenMarkdown("before\n\n```ts\nconst a = 1;\n```")).toEqual([
      { code: false, text: "before\n\n" },
      { code: true, text: "const a = 1;" },
    ]);
  });

  it("merges adjacent runs of the same kind rather than fragmenting the line", () => {
    expect(flattenMarkdown("**bold** plain *soft*")).toEqual([
      { code: false, text: "bold plain soft" },
    ]);
  });

  it("leaves no trailing blank lines behind a wordless block", () => {
    expect(flattenMarkdown("text\n\n---\n")).toEqual([{ code: false, text: "text" }]);
  });

  it("returns nothing for an empty or whitespace-only body", () => {
    expect(flattenMarkdown("")).toEqual([]);
    expect(flattenMarkdown("   \n\n  ")).toEqual([]);
  });
});
