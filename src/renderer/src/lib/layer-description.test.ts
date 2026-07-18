import { describe, expect, it } from "vitest";
import { parseLayerDescription } from "./layer-description";

const DIFF = new Set(["src/a.ts", "src/b.ts"]);

describe("parseLayerDescription", () => {
  it("splits blank-line paragraphs and soft-wraps single newlines", () => {
    const result = parseLayerDescription("first\nline\n\nsecond", DIFF);
    expect(result).toHaveLength(2);
    expect(result[0]?.runs).toEqual([{ kind: "text", text: "first line" }]);
    expect(result[1]?.runs).toEqual([{ kind: "text", text: "second" }]);
  });

  it("returns no paragraphs for empty or whitespace-only input", () => {
    expect(parseLayerDescription("", DIFF)).toEqual([]);
    expect(parseLayerDescription("   \n\n  ", DIFF)).toEqual([]);
  });

  it("resolves a code span that names a diff file to a clickable link", () => {
    const [para] = parseLayerDescription("see `src/a.ts` now", DIFF);
    expect(para?.runs).toEqual([
      { kind: "text", text: "see " },
      { kind: "code", text: "src/a.ts", file: "src/a.ts" },
      { kind: "text", text: " now" },
    ]);
  });

  it("leaves a code span that is not a diff file inert", () => {
    const [para] = parseLayerDescription("call `doThing()`", DIFF);
    expect(para?.runs).toEqual([
      { kind: "text", text: "call " },
      { kind: "code", text: "doThing()", file: null },
    ]);
  });

  it("resolves a present link and fails soft on an absent one", () => {
    const [present] = parseLayerDescription("[the file](src/b.ts)", DIFF);
    expect(present?.runs).toEqual([
      { kind: "link", label: "the file", path: "src/b.ts", file: "src/b.ts" },
    ]);
    const [absent] = parseLayerDescription("[gone](src/z.ts)", DIFF);
    expect(absent?.runs).toEqual([{ kind: "link", label: "gone", path: "src/z.ts", file: null }]);
  });

  it("interleaves several runs in order within one paragraph", () => {
    const [para] = parseLayerDescription("a `src/a.ts` b [x](src/b.ts) c", DIFF);
    expect(para?.runs.map((r) => r.kind)).toEqual(["text", "code", "text", "link", "text"]);
  });
});
