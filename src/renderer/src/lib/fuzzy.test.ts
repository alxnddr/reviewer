import { describe, expect, it } from "vitest";
import { fuzzyMatches } from "./fuzzy";

describe("fuzzyMatches", () => {
  it("matches an in-order subsequence across path segments", () => {
    expect(fuzzyMatches("srcbtn", "src/components/Button.tsx")).toBe(true);
    expect(fuzzyMatches("cmpbtn", "src/components/Button.tsx")).toBe(true);
  });

  it("rejects characters that appear out of order", () => {
    expect(fuzzyMatches("btnsrc", "src/components/Button.tsx")).toBe(false);
  });

  it("rejects characters absent from the path", () => {
    expect(fuzzyMatches("xyz", "src/components/Button.tsx")).toBe(false);
  });

  it("ignores case on both sides", () => {
    expect(fuzzyMatches("BUTTON", "src/components/button.tsx")).toBe(true);
    expect(fuzzyMatches("button", "src/components/BUTTON.TSX")).toBe(true);
  });

  it("ignores whitespace in the query", () => {
    expect(fuzzyMatches("src btn", "src/components/Button.tsx")).toBe(true);
  });

  it("matches everything on a blank query", () => {
    expect(fuzzyMatches("", "src/components/Button.tsx")).toBe(true);
    expect(fuzzyMatches("   ", "src/components/Button.tsx")).toBe(true);
  });

  it("consumes each occurrence once — repeated query chars need repeats in the path", () => {
    expect(fuzzyMatches("ss", "src/s.ts")).toBe(true);
    expect(fuzzyMatches("sss", "as.ts")).toBe(false);
  });
});
