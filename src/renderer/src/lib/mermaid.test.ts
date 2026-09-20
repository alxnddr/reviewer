import type { Element } from "hast";
import { describe, expect, it } from "vitest";
import {
  MERMAID_CONFIG,
  MERMAID_MAX_TEXT_SIZE,
  failedOutcome,
  mermaidSource,
  planDiagram,
  readFence,
  renderedOutcome,
} from "./mermaid";

/** The `pre` remark-rehype builds for a fence: one `code` child, a `language-*` class when
 * the fence named a language, the block's text with its trailing newline. */
function fence(language: string | null, text: string): Element {
  return {
    type: "element",
    tagName: "pre",
    properties: {},
    children: [
      {
        type: "element",
        tagName: "code",
        properties: language === null ? {} : { className: [`language-${language}`] },
        children: [{ type: "text", value: text }],
      },
    ],
  };
}

describe("readFence", () => {
  it("reads the language and the text off a fence's pre", () => {
    expect(readFence(fence("ts", "const a = 1;\n"))).toEqual({
      language: "ts",
      text: "const a = 1;\n",
    });
  });

  it("answers a null language for a fence that named none", () => {
    expect(readFence(fence(null, "plain\n"))).toEqual({ language: null, text: "plain\n" });
  });

  it("is null for anything that is not one code element in a pre", () => {
    expect(readFence(undefined)).toBeNull();
    expect(readFence({ type: "element", tagName: "pre", properties: {}, children: [] })).toBeNull();
    expect(
      readFence({
        type: "element",
        tagName: "pre",
        properties: {},
        children: [{ type: "text", value: "bare" }],
      }),
    ).toBeNull();
  });
});

describe("mermaidSource", () => {
  it("hands over a mermaid fence's text, whatever case the author typed", () => {
    expect(mermaidSource(fence("mermaid", "graph TD\n  A-->B\n"))).toBe("graph TD\n  A-->B\n");
    expect(mermaidSource(fence("Mermaid", "graph TD\n"))).toBe("graph TD\n");
  });

  it("leaves every other block a block", () => {
    expect(mermaidSource(fence("ts", "graph TD\n"))).toBeNull();
    expect(mermaidSource(fence(null, "graph TD\n"))).toBeNull();
    // A prefix is not the language: `mermaid-js` is somebody's config file, not a diagram.
    expect(mermaidSource(fence("mermaid-js", "graph TD\n"))).toBeNull();
    expect(mermaidSource(undefined)).toBeNull();
  });
});

describe("MERMAID_CONFIG", () => {
  // Pinned value by value: each of these is a line whose quiet removal reopens the
  // directive-override attack the constant's doc describes, and nothing else would notice.
  it("never scans the document, and stays strict", () => {
    expect(MERMAID_CONFIG.startOnLoad).toBe(false);
    expect(MERMAID_CONFIG.securityLevel).toBe("strict");
  });

  it("forbids a diagram directive every key the hardening rests on", () => {
    expect(MERMAID_CONFIG.secure).toEqual(
      expect.arrayContaining(["secure", "securityLevel", "startOnLoad", "maxTextSize"]),
    );
    // The two mermaid added to its default list after the feature was specified; both are
    // set below, so both have to be out of a directive's reach.
    expect(MERMAID_CONFIG.secure).toEqual(
      expect.arrayContaining(["suppressErrorRendering", "maxEdges"]),
    );
  });

  it("secures every key it sets", () => {
    const unsecured = Object.keys(MERMAID_CONFIG).filter(
      (key) => !MERMAID_CONFIG.secure.includes(key),
    );
    expect(unsecured).toEqual([]);
  });

  it("caps the text, and throws on a bad diagram rather than drawing mermaid's own error", () => {
    expect(MERMAID_CONFIG.maxTextSize).toBe(MERMAID_MAX_TEXT_SIZE);
    expect(MERMAID_MAX_TEXT_SIZE).toBeLessThan(50_000);
    expect(MERMAID_CONFIG.suppressErrorRendering).toBe(true);
  });
});

describe("planDiagram", () => {
  it("draws an ordinary diagram", () => {
    expect(planDiagram("graph TD\n  A-->B\n")).toEqual({ kind: "draw" });
  });

  it("refuses an empty fence without loading anything", () => {
    expect(planDiagram("")).toMatchObject({ kind: "refuse" });
    expect(planDiagram("  \n\n")).toMatchObject({ kind: "refuse" });
  });

  it("refuses a source over the cap, which mermaid would have drawn as an error diagram", () => {
    expect(planDiagram("x".repeat(MERMAID_MAX_TEXT_SIZE))).toEqual({ kind: "draw" });
    const over = planDiagram("x".repeat(MERMAID_MAX_TEXT_SIZE + 1));
    expect(over).toMatchObject({ kind: "refuse" });
    expect(over.kind === "refuse" ? over.reason : "").toContain(String(MERMAID_MAX_TEXT_SIZE));
  });
});

describe("renderedOutcome", () => {
  it("is the diagram when there is one", () => {
    expect(renderedOutcome("<svg></svg>")).toEqual({ kind: "drawn", svg: "<svg></svg>" });
  });

  it("is a failure when the render came back empty — never an empty box", () => {
    expect(renderedOutcome("")).toMatchObject({ kind: "failed" });
    expect(renderedOutcome(" \n")).toMatchObject({ kind: "failed" });
  });
});

describe("failedOutcome", () => {
  it("keeps the first line of mermaid's paragraph, which carries the line number", () => {
    const error = new Error(
      "Parse error on line 2:\ngraph TD\n  A--\n-----^\nExpecting 'LINK', got 'NEWLINE'",
    );
    expect(failedOutcome(error)).toEqual({ kind: "failed", reason: "Parse error on line 2" });
  });

  it("skips leading blank lines and clamps a long one", () => {
    expect(failedOutcome(new Error("\n\n  No diagram type detected  \n"))).toEqual({
      kind: "failed",
      reason: "No diagram type detected",
    });
    const clamped = failedOutcome(new Error("y".repeat(500)));
    expect(clamped.kind === "failed" ? clamped.reason.length : 0).toBe(160);
    expect(clamped.kind === "failed" ? clamped.reason.endsWith("…") : false).toBe(true);
  });

  it("still says something when the throw said nothing", () => {
    expect(failedOutcome(new Error(""))).toEqual({
      kind: "failed",
      reason: "The diagram could not be drawn.",
    });
    expect(failedOutcome("a bare string")).toEqual({ kind: "failed", reason: "a bare string" });
  });
});
