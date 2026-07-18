import { describe, expect, it } from "vitest";
import { segmentInlineCode } from "./comment-body";

describe("segmentInlineCode", () => {
  it("keeps a plain sentence as one sans run", () => {
    expect(segmentInlineCode("this needs a guard")).toEqual([
      { code: false, text: "this needs a guard" },
    ]);
  });

  it("splits an inline ref into its own mono run", () => {
    expect(segmentInlineCode("call `resolveAnchor` here")).toEqual([
      { code: false, text: "call " },
      { code: true, text: "resolveAnchor" },
      { code: false, text: " here" },
    ]);
  });

  it("handles a body that opens with code and one with adjacent spans", () => {
    expect(segmentInlineCode("`a` and `b`")).toEqual([
      { code: true, text: "a" },
      { code: false, text: " and " },
      { code: true, text: "b" },
    ]);
  });

  it("leaves an unpaired trailing backtick as literal text", () => {
    expect(segmentInlineCode("a lone ` mark")).toEqual([{ code: false, text: "a lone ` mark" }]);
  });
});
