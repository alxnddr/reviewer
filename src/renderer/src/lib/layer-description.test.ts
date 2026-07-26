import { describe, expect, it } from "vitest";
import { blockInlineRuns, parseLayerDescription } from "./layer-description";

const DIFF = new Set(["src/a.ts", "src/b.ts"]);

describe("parseLayerDescription", () => {
  it("splits blank-line paragraphs and soft-wraps single newlines", () => {
    const result = parseLayerDescription("first\nline\n\nsecond", DIFF);
    expect(result).toEqual([
      { kind: "paragraph", runs: [{ kind: "text", text: "first line" }] },
      { kind: "paragraph", runs: [{ kind: "text", text: "second" }] },
    ]);
  });

  it("returns no blocks for empty or whitespace-only input", () => {
    expect(parseLayerDescription("", DIFF)).toEqual([]);
    expect(parseLayerDescription("   \n\n  ", DIFF)).toEqual([]);
  });

  it("resolves a code span that names a diff file to a clickable link", () => {
    const [para] = parseLayerDescription("see `src/a.ts` now", DIFF);
    expect(para).toEqual({
      kind: "paragraph",
      runs: [
        { kind: "text", text: "see " },
        { kind: "code", text: "src/a.ts", file: "src/a.ts" },
        { kind: "text", text: " now" },
      ],
    });
  });

  it("leaves a code span that is not a diff file inert", () => {
    const [para] = parseLayerDescription("call `doThing()`", DIFF);
    expect(para).toEqual({
      kind: "paragraph",
      runs: [
        { kind: "text", text: "call " },
        { kind: "code", text: "doThing()", file: null },
      ],
    });
  });

  it("resolves a present link and fails soft on an absent one", () => {
    const [present] = parseLayerDescription("[the file](src/b.ts)", DIFF);
    expect(present).toEqual({
      kind: "paragraph",
      runs: [{ kind: "link", label: "the file", path: "src/b.ts", file: "src/b.ts" }],
    });
    const [absent] = parseLayerDescription("[gone](src/z.ts)", DIFF);
    expect(absent).toEqual({
      kind: "paragraph",
      runs: [{ kind: "link", label: "gone", path: "src/z.ts", file: null }],
    });
  });

  it("interleaves several runs in order within one paragraph", () => {
    const [para] = parseLayerDescription("a `src/a.ts` b [x](src/b.ts) c", DIFF);
    expect(para?.kind === "paragraph" && para.runs.map((r) => r.kind)).toEqual([
      "text",
      "code",
      "text",
      "link",
      "text",
    ]);
  });

  it("parses strong and emphasis, nesting inline runs inside them", () => {
    const [para] = parseLayerDescription("a **bold `x`** and *soft* and _quiet_", DIFF);
    expect(para).toEqual({
      kind: "paragraph",
      runs: [
        { kind: "text", text: "a " },
        {
          kind: "strong",
          runs: [
            { kind: "text", text: "bold " },
            { kind: "code", text: "x", file: null },
          ],
        },
        { kind: "text", text: " and " },
        { kind: "emphasis", runs: [{ kind: "text", text: "soft" }] },
        { kind: "text", text: " and " },
        { kind: "emphasis", runs: [{ kind: "text", text: "quiet" }] },
      ],
    });
  });

  it("does not italicise snake_case or bare asterisk arithmetic", () => {
    const [snake] = parseLayerDescription("uses foo_bar_baz here", DIFF);
    expect(snake).toEqual({
      kind: "paragraph",
      runs: [{ kind: "text", text: "uses foo_bar_baz here" }],
    });
    const [math] = parseLayerDescription("2 * 3 * 4", DIFF);
    expect(math).toEqual({ kind: "paragraph", runs: [{ kind: "text", text: "2 * 3 * 4" }] });
  });

  it("parses headings with their level and inline runs", () => {
    const blocks = parseLayerDescription("# Top\n\n### Deep `src/a.ts`", DIFF);
    expect(blocks).toEqual([
      { kind: "heading", level: 1, runs: [{ kind: "text", text: "Top" }] },
      {
        kind: "heading",
        level: 3,
        runs: [
          { kind: "text", text: "Deep " },
          { kind: "code", text: "src/a.ts", file: "src/a.ts" },
        ],
      },
    ]);
  });

  it("collects bullet items into one list, ending it at a blank line", () => {
    const blocks = parseLayerDescription("- one\n- two `x`\n\nafter", DIFF);
    expect(blocks).toEqual([
      {
        kind: "list",
        ordered: false,
        start: 1,
        items: [
          [{ kind: "text", text: "one" }],
          [
            { kind: "text", text: "two " },
            { kind: "code", text: "x", file: null },
          ],
        ],
      },
      { kind: "paragraph", runs: [{ kind: "text", text: "after" }] },
    ]);
  });

  it("keeps an ordered list's authored start and soft-wraps indented continuations", () => {
    const blocks = parseLayerDescription("3. first line\n   still first\n4. second", DIFF);
    expect(blocks).toEqual([
      {
        kind: "list",
        ordered: true,
        start: 3,
        items: [
          [{ kind: "text", text: "first line still first" }],
          [{ kind: "text", text: "second" }],
        ],
      },
    ]);
  });

  it("starts a list even without a blank line after the paragraph above", () => {
    const blocks = parseLayerDescription("intro:\n- item", DIFF);
    expect(blocks.map((block) => block.kind)).toEqual(["paragraph", "list"]);
  });

  it("keeps a fenced block verbatim, dropping the fence and its info string", () => {
    const blocks = parseLayerDescription("```ts\nconst a = 1;\n\n  indented\n```\ntail", DIFF);
    expect(blocks).toEqual([
      { kind: "codeBlock", text: "const a = 1;\n\n  indented" },
      { kind: "paragraph", runs: [{ kind: "text", text: "tail" }] },
    ]);
  });

  it("runs an unclosed fence to the end instead of dropping the text", () => {
    expect(parseLayerDescription("```\nleft open", DIFF)).toEqual([
      { kind: "codeBlock", text: "left open" },
    ]);
  });

  it("folds quote lines into one aside", () => {
    expect(parseLayerDescription("> a\n> b", DIFF)).toEqual([
      { kind: "quote", runs: [{ kind: "text", text: "a b" }] },
    ]);
  });

  it("reads a --- line as a rule, not a paragraph or list", () => {
    expect(parseLayerDescription("above\n\n---\n\nbelow", DIFF).map((b) => b.kind)).toEqual([
      "paragraph",
      "rule",
      "paragraph",
    ]);
    expect(parseLayerDescription("- - -", DIFF)).toEqual([{ kind: "rule" }]);
  });
});

describe("blockInlineRuns", () => {
  it("reaches links nested in emphasis, list items, and quotes — but not fences", () => {
    const text =
      "**see [x](src/z.ts)**\n\n- [y](src/z.ts)\n\n> [z](src/z.ts)\n\n```\n[not](a/link)\n```";
    const links = parseLayerDescription(text, DIFF)
      .flatMap(blockInlineRuns)
      .filter((run) => run.kind === "link");
    expect(links).toHaveLength(3);
    expect(links.every((run) => run.file === null)).toBe(true);
  });
});
