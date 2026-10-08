import { describe, expect, it } from "vitest";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { visit } from "unist-util-visit";
import {
  flattenMarkdown,
  isExternalUrl,
  parseMarkdown,
  placedReferences,
  proseReferences,
  readLinkTarget,
  remarkFileReferences,
} from "./markdown";

// remark owns the grammar and is tested upstream — nothing here re-checks what a `-`
// or a fence means. What is tested is the reading this app puts on top of it: which
// links are file references, where inside a file one points, which code spans become
// them, and how a body flattens for a surface too narrow to render it.

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

describe("readLinkTarget", () => {
  it("reads a bare path as the whole file", () => {
    expect(readLinkTarget("src/a.ts")).toEqual({
      kind: "reference",
      path: "src/a.ts",
      span: null,
    });
  });

  it("reads a line, a range, and a side", () => {
    expect(readLinkTarget("src/a.ts:12")).toEqual({
      kind: "reference",
      path: "src/a.ts",
      span: { side: "additions", startLine: 12, endLine: 12 },
    });
    expect(readLinkTarget("src/a.ts:12-20")).toEqual({
      kind: "reference",
      path: "src/a.ts",
      span: { side: "additions", startLine: 12, endLine: 20 },
    });
    expect(readLinkTarget("src/a.ts:12-20@deletions")).toEqual({
      kind: "reference",
      path: "src/a.ts",
      span: { side: "deletions", startLine: 12, endLine: 20 },
    });
  });

  // The order the span parse and the scheme test run in, from the outside: `index.ts` is a
  // legal scheme name, so a reference to a top-level file is the case a web-first reading
  // gets wrong — and gets wrong silently, as a link with no href.
  it("reads a line reference to a top-level file, whose path looks like a scheme", () => {
    expect(readLinkTarget("index.ts:12")).toEqual({
      kind: "reference",
      path: "index.ts",
      span: { side: "additions", startLine: 12, endLine: 12 },
    });
  });

  it("leaves the web the web, suffix-shaped or not", () => {
    expect(readLinkTarget("https://example.com")).toEqual({ kind: "external" });
    expect(readLinkTarget("mailto:a@b.co")).toEqual({ kind: "external" });
    expect(readLinkTarget("//example.com")).toEqual({ kind: "external" });
    expect(readLinkTarget("http://host/page:12")).toEqual({ kind: "external" });
  });

  it("calls a schemeless target with a suffix that is not a span malformed", () => {
    expect(readLinkTarget("src/a.ts:abc")).toEqual({ kind: "malformed" });
    expect(readLinkTarget("src/a.ts:12:5")).toEqual({ kind: "malformed" });
    expect(readLinkTarget("src/a.ts:12-")).toEqual({ kind: "malformed" });
    expect(readLinkTarget("src/a.ts:12@both")).toEqual({ kind: "malformed" });
  });

  // The same three rules the anchor schema enforces, so a reference cannot ask
  // `resolveAnchor` to place a range no anchor could ever have been authored as.
  it("refuses a range that is not a line range at all", () => {
    expect(readLinkTarget("src/a.ts:0")).toEqual({ kind: "malformed" });
    expect(readLinkTarget("src/a.ts:20-10")).toEqual({ kind: "malformed" });
    expect(readLinkTarget("src/a.ts:99999999999999999999")).toEqual({ kind: "malformed" });
  });
});

describe("proseReferences", () => {
  it("collects path links with their label, in document order", () => {
    expect(proseReferences("see [the entry](src/a.ts) and [b](src/b.ts)").references).toEqual([
      { label: "the entry", url: "src/a.ts", path: "src/a.ts", span: null },
      { label: "b", url: "src/b.ts", path: "src/b.ts", span: null },
    ]);
  });

  it("carries the line span a reference named", () => {
    expect(proseReferences("the [caller](src/b.ts:40-44) never awaits it").references).toEqual([
      {
        label: "caller",
        url: "src/b.ts:40-44",
        path: "src/b.ts",
        span: { side: "additions", startLine: 40, endLine: 44 },
      },
    ]);
  });

  it("reaches links nested in emphasis, list items, and quotes — but not fences", () => {
    const text =
      "**see [x](src/z.ts)**\n\n- [y](src/z.ts)\n\n> [z](src/z.ts)\n\n```\n[not](a/link)\n```";
    expect(proseReferences(text).references.map((reference) => reference.label)).toEqual([
      "x",
      "y",
      "z",
    ]);
  });

  it("leaves web links alone — they open in the browser, they name no file", () => {
    const found = proseReferences("[docs](https://example.com) and https://bare.example");
    expect(found.references).toEqual([]);
    expect(found.malformed).toEqual([]);
  });

  it("reports a link that reached for the line grammar and missed, as written", () => {
    const found = proseReferences("the [caller](src/b.ts:forty) never awaits it");
    expect(found.references).toEqual([]);
    expect(found.malformed).toEqual([{ label: "caller", url: "src/b.ts:forty", why: "suffix" }]);
  });

  it("refuses a path behind a reference-style definition in every use, and leaves a web one alone", () => {
    // Full, collapsed and shortcut uses all resolve through a definition, which is the node
    // read: the form is refused once per definition however many times it is used.
    const text = [
      "See [x][r], [src/a.ts][] and [lbl].",
      "",
      "[r]: src/a.ts:12",
      "[src/a.ts]: src/a.ts",
      "[lbl]: src/b.ts:nope",
      "[web]: https://example.com",
    ].join("\n");
    const found = proseReferences(text);
    expect(found.references).toEqual([]);
    expect(found.malformed).toEqual([
      { label: "r", url: "src/a.ts:12", why: "definition" },
      { label: "src/a.ts", url: "src/a.ts", why: "definition" },
      { label: "lbl", url: "src/b.ts:nope", why: "definition" },
    ]);
    expect(placedReferences(text)).toEqual([]);
  });

  it("takes the label from the link's own text, markers and all stripped", () => {
    expect(proseReferences("[the **entry** `point`](src/a.ts)").references).toEqual([
      { label: "the entry point", url: "src/a.ts", path: "src/a.ts", span: null },
    ]);
  });
});

describe("placedReferences", () => {
  it("places each reference by its source offsets, label markup kept as written", () => {
    const text = 'see [`retry()`](src/a.ts:12-14) and [b](src/b.ts "why")';
    const placed = placedReferences(text);
    expect(placed.map((reference) => text.slice(reference.start, reference.end))).toEqual([
      "[`retry()`](src/a.ts:12-14)",
      '[b](src/b.ts "why")',
    ]);
    expect(placed[0]).toMatchObject({
      label: "retry()",
      labelSource: "`retry()`",
      path: "src/a.ts",
      span: { side: "additions", startLine: 12, endLine: 14 },
      title: null,
    });
    expect(placed[1]).toMatchObject({ labelSource: "b", title: "why" });
  });

  it("finds exactly the references proseReferences reads — never one inside code", () => {
    const text =
      "`[a](src/a.ts)` [b](src/b.ts) [web](https://x.dev) [bad](src/c.ts:x)\n\n```\n[c](src/c.ts)\n```";
    expect(placedReferences(text).map((reference) => reference.path)).toEqual(
      proseReferences(text).references.map((reference) => reference.path),
    );
    expect(placedReferences(text).map((reference) => reference.path)).toEqual(["src/b.ts"]);
  });

  it("gives a label-less link an empty label source", () => {
    expect(placedReferences("[](src/a.ts)")[0]?.labelSource).toBe("");
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

  it("promotes a span that names a line of a diff file, suffix and all", () => {
    expect(promote("see `src/a.ts:12-20` now", ["src/a.ts"])).toEqual(["src/a.ts:12-20"]);
  });

  it("leaves a code span that names nothing in the diff as code", () => {
    expect(promote("call `doThing()`", ["src/a.ts"])).toEqual([]);
  });

  // The quoted output an `evidence` field is full of: it has a colon in it, and the thing
  // before the colon is not a file in the diff, so nothing about it is a reference.
  it("leaves a quoted tool line as code", () => {
    expect(promote("`Error: nope` and `src/b.ts:12:5: warning`", ["src/a.ts"])).toEqual([]);
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

  // A rail row is 14px and one line long: the label is the words: the line suffix is a
  // navigation target, and spending characters of a preview on `:40-44` would cost the
  // claim the room it needs.
  it("reads a line reference as its label too, suffix and all left behind", () => {
    expect(plain("the [caller](src/b.ts:40-44) never awaits it")).toBe(
      "the caller never awaits it",
    );
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
