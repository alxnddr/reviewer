import { describe, expect, it } from "vitest";
import {
  backtrackingLines,
  buildManyHunksPatch,
  ONE_HUNK_PATCH,
  OUTLINE_PATCH,
} from "../../../../shared/diff/fixtures";
import { parsePatch, type PatchFile } from "../../../../shared/diff/patch";
import { hunkSpan } from "../../../../shared/diff/walk";
import type { AnchorSpan } from "../../../../shared/review";
import { hunkSnippet, LEADING_NOISE, representativeAnchors, spanIndex } from "./snippet";

// The guide's hunk card (`hunkSnippet`). `snippetForAnchor`, the prompt's lift, is pinned in
// `overview.test.ts` and `review-export.test.ts`; this is the card's own contract: unified
// order, both numbers, `context` *unchanged* rows of air with the change rows on the way free,
// one hunk only, and a cap that says what it cut.

const foo = parsePatch(ONE_HUNK_PATCH, "test")[0]!;
const outline = parsePatch(OUTLINE_PATCH, "test");
const server = outline.find((file) => file.path === "cmd/server.go")!;

describe("hunkSnippet", () => {
  it("reads unified rows with both numbers, and marks the anchor's own", () => {
    const snippet = hunkSnippet(
      foo.fileDiff,
      { file: "src/foo.ts", side: "additions", startLine: 11, endLine: 11 },
      { context: 1, maxLines: 20 },
    );
    expect(snippet).toEqual({
      lines: [
        { kind: "context", oldLine: 10, newLine: 10, text: "ctx10", focused: false },
        { kind: "deletion", oldLine: 11, newLine: null, text: "old11", focused: false },
        { kind: "addition", oldLine: null, newLine: 11, text: "new11", focused: true },
        { kind: "addition", oldLine: null, newLine: 12, text: "new12", focused: false },
        { kind: "addition", oldLine: null, newLine: 13, text: "new13", focused: false },
        { kind: "context", oldLine: 12, newLine: 14, text: "ctx12", focused: false },
      ],
      hidden: 0,
      context: "ctx7",
    });
  });

  it("reads a deletions anchor in old-file numbers, with its replacement riding along", () => {
    const snippet = hunkSnippet(
      foo.fileDiff,
      { file: "src/foo.ts", side: "deletions", startLine: 11, endLine: 11 },
      { context: 0, maxLines: 20 },
    );
    expect(snippet?.lines.map((line) => [line.text, line.focused])).toEqual([
      ["old11", true],
      ["new11", false],
      ["new12", false],
      ["new13", false],
    ]);
  });

  it("caps the window and counts what it cut", () => {
    const snippet = hunkSnippet(
      foo.fileDiff,
      { file: "src/foo.ts", side: "additions", startLine: 11, endLine: 13 },
      { context: 2, maxLines: 3 },
    );
    expect(snippet?.lines.map((line) => line.text)).toEqual(["ctx9", "ctx10", "old11"]);
    expect(snippet?.hidden).toBe(5);
  });

  it("stops its air short of a neighbouring change block", () => {
    const blob = outline.find((file) => file.path === "src/blob.ts")!;
    // `patchText` (new 8-10) sits two unchanged rows below the rewritten `loadBlob`; the card
    // must not climb into that rewrite.
    const snippet = hunkSnippet(
      blob.fileDiff,
      { file: "src/blob.ts", side: "additions", startLine: 8, endLine: 10 },
      { context: 4, maxLines: 20 },
    );
    expect(snippet?.lines.map((line) => line.newLine)).toEqual([6, 7, 8, 9, 10, 11, 12, 13, 14]);
  });

  it("stays inside the hunk that holds the anchor and names it by the header's context", () => {
    const snippet = hunkSnippet(
      server.fileDiff,
      { file: "cmd/server.go", side: "additions", startLine: 19, endLine: 19 },
      { context: 1, maxLines: 20 },
    );
    expect(snippet?.lines.map((line) => line.newLine)).toEqual([18, null, 19, 20]);
    expect(snippet?.context).toBe("func (s *Server) Handle(path string) string {");
  });

  it("is null for an anchor no hunk carries", () => {
    expect(
      hunkSnippet(
        foo.fileDiff,
        { file: "src/foo.ts", side: "additions", startLine: 40, endLine: 42 },
        { context: 2, maxLines: 20 },
      ),
    ).toBeNull();
  });
});

/** A file created by the change: every line an addition, in one hunk. */
function addedFile(path: string, lines: readonly string[]): string {
  return [
    `diff --git a/${path} b/${path}`,
    "new file mode 100644",
    "index 0000000..1111111",
    "--- /dev/null",
    `+++ b/${path}`,
    `@@ -0,0 +1,${lines.length} @@`,
    ...lines.map((line) => `+${line}`),
    "",
  ].join("\n");
}

const RETRY = [
  "// Copyright the authors.",
  "// Retries a blob fetch per host.",
  'import { sleep } from "./sleep";',
  'import type { Blob } from "./blob";',
  "",
  "export function retryBlob(path: string): Blob {",
  "  return sleep(path);",
  "}",
];

/** Every hunk of a file, both sides — what a whole-file range expands to. */
function wholeFile(file: PatchFile): AnchorSpan[] {
  return file.fileDiff.hunks.flatMap((hunk) =>
    (["additions", "deletions"] as const).flatMap((side) => {
      const span = hunkSpan(hunk, side);
      return span.end >= span.start
        ? [{ file: file.path, side, startLine: span.start, endLine: span.end }]
        : [];
    }),
  );
}

const candidate = (file: PatchFile) => ({ file, spans: wholeFile(file) });
const NONE_GENERATED = () => false;

describe("hunkSnippet under anchor lead", () => {
  it("starts at the anchor in an added file instead of walking back to line 1", () => {
    const [retry] = parsePatch(addedFile("src/retry.ts", RETRY), "test");
    const anchor = { file: "src/retry.ts", side: "additions", startLine: 6, endLine: 6 } as const;
    const opts = { context: 2, maxLines: 20 };
    expect(hunkSnippet(retry!.fileDiff, anchor, opts)?.lines[0]?.newLine).toBe(1);
    expect(
      hunkSnippet(retry!.fileDiff, anchor, { ...opts, lead: "anchor" })?.lines.map(
        (line) => line.newLine,
      ),
    ).toEqual([6, 7, 8]);
  });

  it("still brings the deletion an added anchor replaced", () => {
    const snippet = hunkSnippet(
      foo.fileDiff,
      { file: "src/foo.ts", side: "additions", startLine: 12, endLine: 12 },
      { context: 0, maxLines: 20, lead: "anchor" },
    );
    // new12's block-mates above it (new11) stay out; the deletion is the other kind, but it is
    // not directly above new12, so the window opens on new12 itself.
    expect(snippet?.lines.map((line) => line.text)).toEqual(["new12", "new13"]);
    const first = hunkSnippet(
      foo.fileDiff,
      { file: "src/foo.ts", side: "additions", startLine: 11, endLine: 11 },
      { context: 0, maxLines: 20, lead: "anchor" },
    );
    expect(first?.lines.map((line) => line.text)).toEqual(["old11", "new11", "new12", "new13"]);
  });
});

describe("representativeAnchors", () => {
  it("opens an added file on its first declaration, past the header comment and imports", () => {
    const [retry] = parsePatch(addedFile("src/retry.ts", RETRY), "test");
    const [pick] = representativeAnchors([candidate(retry!)], NONE_GENERATED);
    expect(pick?.anchor).toEqual({
      file: "src/retry.ts",
      side: "additions",
      startLine: 6,
      endLine: 6,
    });
    expect(pick?.lead).toBe("anchor");
  });

  it("skips the leading noise of an added file with no declaration in it", () => {
    const script = ["#!/bin/sh", "# Rotate the logs.", "set -e", "", 'mv "$1" "$1.1"'];
    const [rotate] = parsePatch(addedFile("bin/rotate.sh", script), "test");
    // `set -e` is not noise by the list, so the card opens on it — after the shebang and comment.
    const [pick] = representativeAnchors([candidate(rotate!)], NONE_GENERATED);
    expect(pick?.anchor.startLine).toBe(3);
  });

  it("keeps an added prose file's first line — `# Title` is content there, not a comment", () => {
    const [notes] = parsePatch(addedFile("docs/notes.md", ["# Retry", "", "Why."]), "test");
    const [pick] = representativeAnchors([candidate(notes!)], NONE_GENERATED);
    expect(pick?.anchor.startLine).toBe(1);
  });

  it("ranks hand-written over generated, source over tests, then the bigger file", () => {
    const files = parsePatch(
      addedFile("src/retry.test.ts", [...RETRY, "", "", "", ""]) +
        addedFile("src/client.gen.ts", [...RETRY, ...RETRY]) +
        addedFile("src/small.ts", ["export const LIMIT = 3;"]) +
        addedFile("src/retry.ts", RETRY),
      "test",
    );
    const picks = [
      ...representativeAnchors(
        files.map((file) => candidate(file)),
        (file) => file.path === "src/client.gen.ts",
      ),
    ];
    expect(picks.map((pick) => pick.file.path)).toEqual([
      "src/retry.ts",
      "src/small.ts",
      "src/retry.test.ts",
      "src/client.gen.ts",
    ]);
  });

  it("names a body-only edit by the symbol it sits in, and keeps its change block", () => {
    const [size] = parsePatch(
      [
        "diff --git a/src/size.ts b/src/size.ts",
        "index 1111111..2222222 100644",
        "--- a/src/size.ts",
        "+++ b/src/size.ts",
        "@@ -1,4 +1,4 @@",
        " export function size(blob: Blob): number {",
        "   const header = blob.header;",
        "-  return header.length;",
        "+  return header.length + 1;",
        " }",
        "",
      ].join("\n"),
      "test",
    );
    const [pick] = representativeAnchors([candidate(size!)], NONE_GENERATED);
    expect(pick?.lead).toBe("block");
    const snippet = hunkSnippet(size!.fileDiff, pick!.anchor, {
      context: 2,
      maxLines: 20,
      lead: pick!.lead,
    });
    expect(snippet?.lines.map((line) => line.kind)).toEqual([
      "context",
      "context",
      "deletion",
      "addition",
      "context",
    ]);
  });

  it("offers nothing for a file the chapter's spans hold no changed line of", () => {
    const [retry] = parsePatch(addedFile("src/retry.ts", RETRY), "test");
    expect([...representativeAnchors([{ file: retry!, spans: [] }], NONE_GENERATED)]).toEqual([]);
  });
});

describe("spanIndex", () => {
  it("answers whether any span holds a line, per side, over merged and unsorted spans", () => {
    const at = (side: AnchorSpan["side"], startLine: number, endLine: number): AnchorSpan => ({
      file: "f",
      side,
      startLine,
      endLine,
    });
    const index = spanIndex([
      at("additions", 20, 25),
      at("additions", 1, 3),
      at("additions", 4, 6),
      at("additions", 22, 30),
      at("deletions", 10, 10),
    ]);
    const held = (side: AnchorSpan["side"]) =>
      Array.from({ length: 32 }, (_, line) => line).filter((line) => index.holds(side, line));
    expect(held("additions")).toEqual([
      1, 2, 3, 4, 5, 6, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30,
    ]);
    expect(held("deletions")).toEqual([10]);
  });
});

// A PR's patch is someone else's input and the pick runs for every chapter card, so both halves
// stay linear: bounds are generous against the linear cost, far under the old one.
describe("representativeAnchors on adversarial input", () => {
  it("tests a line for leading noise in time linear in it, far past the line budget", () => {
    let slowest = 0;
    for (const line of backtrackingLines(20_000)) {
      const started = performance.now();
      LEADING_NOISE.test(line);
      slowest = Math.max(slowest, performance.now() - started);
    }
    expect(slowest).toBeLessThan(100);
  });

  it("counts a whole-file range over thousands of hunks without testing every span per line", () => {
    // 20,000 hunks, one span each: lines × spans was 800 million comparisons.
    const [many] = parsePatch(buildManyHunksPatch(20_000), "test");
    const started = performance.now();
    const [pick] = representativeAnchors([candidate(many!)], NONE_GENERATED);
    expect(performance.now() - started).toBeLessThan(1000);
    expect(pick?.anchor.startLine).toBe(10);
  });

  it("is an iterator the caller stops, not a list of every file's pick", () => {
    const files = parsePatch(addedFile("src/a.ts", RETRY) + addedFile("src/b.ts", RETRY), "test");
    const picks = representativeAnchors(
      files.map((file) => candidate(file)),
      NONE_GENERATED,
    );
    expect(Array.isArray(picks)).toBe(false);
    expect(picks.next().value?.file.path).toBe("src/a.ts");
    expect(picks.next().value?.file.path).toBe("src/b.ts");
    expect(picks.next().done).toBe(true);
  });
});
