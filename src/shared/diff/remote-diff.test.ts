import { describe, expect, it } from "vitest";
import type { AnchorSpan } from "../review";
import {
  HISTOGRAM_PATCH,
  MYERS_PATCH,
  QUOTED_PATH_HOST_PATCH,
  QUOTED_PATH_LOCAL_PATCH,
  RENAMES_PATCH,
  STALE_BASE_HOST_PATCH,
  STALE_BASE_LOCAL_PATCH,
} from "./fixtures";
import { ANALYSIS_CACHE_KEY, parsePatch } from "./patch";
import { anchorsOutsideDiff, diffGeometry, type IdentifiedAnchor } from "./remote-diff";

// The B4 comparison, proven against real pairs of diffs that disagree: the same change aligned
// by two diff algorithms, and the same pull request diffed against a fresh and a stale base.
// Each case is stated both ways round, because the point is that an anchor the reader's diff
// places can be one the host's diff does not — the local side has to place for the case to
// mean anything.

const myersFiles = parsePatch(MYERS_PATCH, ANALYSIS_CACHE_KEY);
const histogramFiles = parsePatch(HISTOGRAM_PATCH, ANALYSIS_CACHE_KEY);
const hostFiles = parsePatch(STALE_BASE_HOST_PATCH, ANALYSIS_CACHE_KEY);
const staleFiles = parsePatch(STALE_BASE_LOCAL_PATCH, ANALYSIS_CACHE_KEY);
const myers = diffGeometry(myersFiles);
const histogram = diffGeometry(histogramFiles);
const host = diffGeometry(hostFiles);
const stale = diffGeometry(staleFiles);

function anchor(id: string, span: Partial<AnchorSpan> & { file: string }): IdentifiedAnchor {
  return { id, side: "additions", startLine: 1, endLine: 1, ...span };
}

describe("anchorsOutsideDiff", () => {
  it("reads the fixtures the way their comments say", () => {
    expect(myers.get("src/loop.c")?.map((hunk) => hunk.additionStart)).toEqual([7, 18]);
    expect(histogram.get("src/loop.c")?.map((hunk) => hunk.additionStart)).toEqual([7]);
    expect([...host.keys()]).toEqual(["src/list.txt"]);
    expect([...stale.keys()]).toEqual(["src/config.ts", "src/list.txt"]);
  });

  it("flags lines a histogram diff shows that the host's myers diff collapses away", () => {
    const anchors = [
      // In both: inside myers' first hunk and histogram's only one.
      anchor("both", { file: "src/loop.c", startLine: 9, endLine: 10 }),
      // Context in histogram's hunk, between myers' two.
      anchor("gap", { file: "src/loop.c", startLine: 14, endLine: 17 }),
      // One hunk in histogram, two in myers: a range is never placed across a collapsed gap.
      anchor("across", { file: "src/loop.c", startLine: 12, endLine: 19 }),
    ];
    expect(anchorsOutsideDiff(anchors, histogram)).toEqual([]);
    expect(anchorsOutsideDiff(anchors, myers)).toEqual(["gap", "across"]);
  });

  it("flags what a stale base adds: the base's own file, and the hunk lines it widened", () => {
    const anchors = [
      anchor("base-file", { file: "src/config.ts", startLine: 1, endLine: 1 }),
      // New-file line 1 is only in the stale diff's widened first hunk.
      anchor("widened", { file: "src/list.txt", startLine: 1, endLine: 1 }),
      anchor("pr-line", { file: "src/list.txt", startLine: 5, endLine: 5 }),
      anchor("pr-tail", { file: "src/list.txt", startLine: 18, endLine: 19 }),
      anchor("old-side", { file: "src/list.txt", side: "deletions", startLine: 5, endLine: 5 }),
    ];
    expect(anchorsOutsideDiff(anchors, stale)).toEqual([]);
    expect(anchorsOutsideDiff(anchors, host)).toEqual(["base-file", "widened"]);
  });

  it("asks the anchor's own side", () => {
    // Myers' second hunk is old-file 18..30 against new-file 18..27: line 29 exists only on the
    // old side.
    const old = anchor("old", {
      file: "src/loop.c",
      side: "deletions",
      startLine: 29,
      endLine: 29,
    });
    const added = anchor("new", { file: "src/loop.c", startLine: 29, endLine: 29 });
    expect(anchorsOutsideDiff([old, added], myers)).toEqual(["new"]);
  });

  it("finds a renamed file under its old name, and carries nothing for a hunkless rename", () => {
    const renames = diffGeometry(parsePatch(RENAMES_PATCH, ANALYSIS_CACHE_KEY));
    const anchors = [
      anchor("old-name", { file: "src/old-edit.txt", startLine: 2, endLine: 2 }),
      anchor("pure", { file: "src/pure.txt", startLine: 1, endLine: 1 }),
    ];
    expect(anchorsOutsideDiff(anchors, renames)).toEqual(["pure"]);
  });

  it("carries nothing at all when the host's diff is empty", () => {
    expect(anchorsOutsideDiff([anchor("a", { file: "src/list.txt" })], diffGeometry([]))).toEqual([
      "a",
    ]);
  });

  it("matches a name GitHub C-quotes to the plain UTF-8 name the reader's diff uses", () => {
    const name = "Day01-20/11.常用数据结构之字符串.md";
    const local = diffGeometry(parsePatch(QUOTED_PATH_LOCAL_PATCH, ANALYSIS_CACHE_KEY));
    const github = diffGeometry(parsePatch(QUOTED_PATH_HOST_PATCH, ANALYSIS_CACHE_KEY));
    const anchors = [
      anchor("changed", { file: name, startLine: 7, endLine: 7 }),
      anchor("context", { file: name, side: "deletions", startLine: 4, endLine: 10 }),
      anchor("past", { file: name, startLine: 11, endLine: 11 }),
    ];
    expect(anchorsOutsideDiff(anchors, local)).toEqual(["past"]);
    // The regression: every comment on the file read as outside GitHub's diff.
    expect(anchorsOutsideDiff(anchors, github)).toEqual(["past"]);
  });

  it("meets an anchor on a name the reader's own diff still had to quote", () => {
    const quoted = diffGeometry(
      parsePatch(
        String.raw`diff --git "a/say "hi".txt" "b/say "hi".txt"
index 1111111..2222222 100644
--- "a/say "hi".txt"
+++ "b/say "hi".txt"
@@ -1 +1 @@
-a
+b
`,
        ANALYSIS_CACHE_KEY,
      ),
    );
    // As the agent wrote it (the escaped name it saw), and as a person would write it.
    const anchors = [
      anchor("escaped", { file: String.raw`say "hi".txt` }),
      anchor("plain", { file: 'say "hi".txt' }),
    ];
    expect(anchorsOutsideDiff(anchors, quoted)).toEqual([]);
  });
});
