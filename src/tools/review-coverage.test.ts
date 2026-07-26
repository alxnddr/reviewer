import { describe, expect, it } from "vitest";
import type { ReviewAnchor, ReviewArtifact, ReviewLayerInput } from "../shared/review";
import {
  changedLineUniverse,
  coverageOfPatch,
  isComplete,
  layerExtentsOf,
  type CoverageResult,
} from "./review-coverage";

// The coverage core proven against the changed-line universe. Each test builds a
// real patch and asserts the exact headline, per-file breakdown, and contiguous uncovered
// spans — the load-bearing definition is the universe boundary (changed lines only, per
// side), so the fixtures pin the precise line numbers a walkthrough must explain.

// A hunk touching src/foo.ts: additions {11,12} (new-file coords), deletion {11}
// (old-file coords); ctx lines are excluded from the universe.
const FOO_HUNK = [
  "diff --git a/src/foo.ts b/src/foo.ts",
  "index 1111111..2222222 100644",
  "--- a/src/foo.ts",
  "+++ b/src/foo.ts",
  "@@ -10,4 +10,5 @@",
  " ctx10",
  "-old11",
  "+new11",
  "+new12",
  " ctx13",
  " ctx14",
];

// A second file src/bar.ts with additions {5,6,7,8} — the whole-file gap fixture.
const BAR_HUNK = [
  "diff --git a/src/bar.ts b/src/bar.ts",
  "index 3333333..4444444 100644",
  "--- a/src/bar.ts",
  "+++ b/src/bar.ts",
  "@@ -4,1 +4,5 @@",
  " keep4",
  "+add5",
  "+add6",
  "+add7",
  "+add8",
];

function patch(...hunks: string[][]): string {
  return `${hunks.flat().join("\n")}\n`;
}

function artifact(embeddedPatch: string | undefined, layers: ReviewLayerInput[]): ReviewArtifact {
  return {
    repo: "/repo",
    base: "main",
    head: "feature",
    patch: embeddedPatch,
    comments: [],
    layers,
  };
}

function layer(
  label: string,
  ranges: ReviewAnchor[],
  children: ReviewLayerInput[] = [],
): ReviewLayerInput {
  return { label, summary: label, ranges, children };
}

function reportOf(result: CoverageResult) {
  if (!result.ok) {
    throw new Error(`expected a report, got error ${result.error}`);
  }
  return result.report;
}

/** Coverage over an artifact's own patch — the finished-artifact path (`rvw check --coverage
 * <artifact>`), which re-derives the diff from the recorded repo/refs in production but here
 * scores the fixture's embedded patch directly through the shared `coverageOfPatch` core.
 * The authored tree is walked flat first, exactly as the CLI does: a nested layer's ranges
 * count for the diff the same as a top-level one's. */
function coverageForArtifact(artifact: ReviewArtifact): CoverageResult {
  return coverageOfPatch(artifact.patch ?? "", layerExtentsOf(artifact.layers));
}

describe("coverage over an artifact's diff", () => {
  it("counts a nested layer's ranges: a grouping parent covers what its children do", () => {
    const result = coverageForArtifact(
      artifact(patch(FOO_HUNK), [
        {
          label: "Group",
          summary: "carries no ranges of its own",
          ranges: [],
          children: [
            layer("inner", [
              { file: "src/foo.ts", side: "additions", startLine: 11, endLine: 12 },
              { file: "src/foo.ts", side: "deletions", startLine: 11, endLine: 11 },
            ]),
          ],
        },
      ]),
    );

    expect(reportOf(result).headline).toEqual({
      coverableChangedLines: 3,
      coveredChangedLines: 3,
    });
  });

  it("reports 100% and no gaps when layers span every changed line, and stays complete", () => {
    const result = coverageForArtifact(
      artifact(patch(FOO_HUNK), [
        layer("l1", [
          { file: "src/foo.ts", side: "additions", startLine: 11, endLine: 12 },
          { file: "src/foo.ts", side: "deletions", startLine: 11, endLine: 11 },
        ]),
      ]),
    );
    const report = reportOf(result);

    expect(report.headline).toEqual({ coverableChangedLines: 3, coveredChangedLines: 3 });
    expect(report.uncoveredSpans).toEqual([]);
    expect(report.files).toEqual([
      { file: "src/foo.ts", status: "covered", coverableChangedLines: 3, coveredChangedLines: 3 },
    ]);
    expect(isComplete(report)).toBe(true);
  });

  it("names the uncovered whole file and the partial hunk's exact contiguous spans", () => {
    // foo fully covered; bar in no layer at all (whole-file gap); a partial layer over
    // bar's additions covering only 5-6 leaves the contiguous span 7-8.
    const result = coverageForArtifact(
      patchedGapArtifact([
        layer("covers-foo", [
          { file: "src/foo.ts", side: "additions", startLine: 11, endLine: 12 },
        ]),
        layer("covers-foo-del", [
          { file: "src/foo.ts", side: "deletions", startLine: 11, endLine: 11 },
        ]),
        layer("partial-bar", [{ file: "src/bar.ts", side: "additions", startLine: 5, endLine: 6 }]),
      ]),
    );
    const report = reportOf(result);

    expect(report.headline).toEqual({ coverableChangedLines: 7, coveredChangedLines: 5 });
    expect(report.files).toEqual([
      { file: "src/foo.ts", status: "covered", coverableChangedLines: 3, coveredChangedLines: 3 },
      {
        file: "src/bar.ts",
        status: "partiallyCovered",
        coverableChangedLines: 4,
        coveredChangedLines: 2,
      },
    ]);
    expect(report.uncoveredSpans).toEqual([
      { file: "src/bar.ts", side: "additions", startLine: 7, endLine: 8 },
    ]);
    expect(isComplete(report)).toBe(false);
  });

  it("marks a file touched by no layer range as uncovered with its whole-hunk span", () => {
    const result = coverageForArtifact(
      patchedGapArtifact([
        layer("covers-foo", [
          { file: "src/foo.ts", side: "additions", startLine: 11, endLine: 12 },
          { file: "src/foo.ts", side: "deletions", startLine: 11, endLine: 11 },
        ]),
      ]),
    );
    const report = reportOf(result);

    expect(report.files).toContainEqual({
      file: "src/bar.ts",
      status: "uncovered",
      coverableChangedLines: 4,
      coveredChangedLines: 0,
    });
    expect(report.uncoveredSpans).toEqual([
      { file: "src/bar.ts", side: "additions", startLine: 5, endLine: 8 },
    ]);
  });

  it("classifies a binary and a pure rename non-coverable, excluding both from the denominator", () => {
    const binary = [
      "diff --git a/logo.png b/logo.png",
      "index 1111111..2222222 100644",
      "Binary files a/logo.png and b/logo.png differ",
    ];
    const rename = [
      "diff --git a/old.ts b/new.ts",
      "similarity index 100%",
      "rename from old.ts",
      "rename to new.ts",
    ];
    const result = coverageForArtifact(
      artifact(patch(FOO_HUNK, binary, rename), [
        // A parent rollup with empty ranges contributes nothing and is not a failure.
        layer("rollup", []),
        layer("covers-foo", [
          { file: "src/foo.ts", side: "additions", startLine: 11, endLine: 12 },
          { file: "src/foo.ts", side: "deletions", startLine: 11, endLine: 11 },
        ]),
      ]),
    );
    const report = reportOf(result);

    expect(report.headline).toEqual({ coverableChangedLines: 3, coveredChangedLines: 3 });
    expect(report.files).toContainEqual({
      file: "logo.png",
      status: "nonCoverable",
      reason: "binary",
    });
    expect(report.files).toContainEqual({
      file: "new.ts",
      status: "nonCoverable",
      reason: "pureRename",
    });
    expect(report.uncoveredSpans).toEqual([]);
    expect(isComplete(report)).toBe(true);
  });

  it("counts additions and deletions independently — a range on the wrong side does not cover", () => {
    // The only range spans lines 11-12 on the *deletions* side. It covers deletion 11
    // (in the universe) but cannot cover additions 11-12, which share the numbers on the
    // other coordinate space.
    const result = coverageForArtifact(
      artifact(patch(FOO_HUNK), [
        layer("wrong-side", [
          { file: "src/foo.ts", side: "deletions", startLine: 11, endLine: 12 },
        ]),
      ]),
    );
    const report = reportOf(result);

    expect(report.headline).toEqual({ coverableChangedLines: 3, coveredChangedLines: 1 });
    expect(report.uncoveredSpans).toEqual([
      { file: "src/foo.ts", side: "additions", startLine: 11, endLine: 12 },
    ]);
  });

  it("returns a typed missing-patch failure rather than a silent 100% on a patch-less artifact", () => {
    expect(coverageForArtifact(artifact(undefined, []))).toEqual({
      ok: false,
      error: "missingPatch",
    });
    expect(coverageForArtifact(artifact("", []))).toEqual({ ok: false, error: "missingPatch" });
  });

  it("refuses a non-empty patch that carries no diff, rather than reporting 0-of-0 covered", () => {
    // Carrying a diff is a property of the content, not the length: a blank or prose `patch`
    // parses to no file, so there is no universe to score. Reporting it as vacuously complete
    // would hand an authoring agent a 100% that describes nothing.
    for (const notADiff of ["   ", "\n\n", "this is not a diff at all"]) {
      expect(coverageForArtifact(artifact(notADiff, []))).toEqual({
        ok: false,
        error: "missingPatch",
      });
      expect(coverageOfPatch(notADiff, [])).toEqual({ ok: false, error: "missingPatch" });
    }
  });

  it("splits two uncovered runs separated by a covered line into two contiguous spans", () => {
    // bar's additions are {5,6,7,8}; covering only 6 leaves 5 and 7-8 — two disjoint runs, not
    // one span swallowing the covered line between them.
    const report = reportOf(
      coverageForArtifact(
        patchedGapArtifact([
          layer("foo", [
            { file: "src/foo.ts", side: "additions", startLine: 11, endLine: 12 },
            { file: "src/foo.ts", side: "deletions", startLine: 11, endLine: 11 },
          ]),
          layer("bar", [{ file: "src/bar.ts", side: "additions", startLine: 6, endLine: 6 }]),
        ]),
      ),
    );
    expect(report.uncoveredSpans).toEqual([
      { file: "src/bar.ts", side: "additions", startLine: 5, endLine: 5 },
      { file: "src/bar.ts", side: "additions", startLine: 7, endLine: 8 },
    ]);
  });

  it("calls a mode-only change non-coverable, never `covered` — nothing covers it", () => {
    // The third content-less arm beside binary and pure-rename: git reports the file changed,
    // but no `+`/`-` line exists to anchor into. Saying `covered` would credit a walkthrough
    // (here, one with no layers at all) for explaining something it never touched.
    const modeOnly = ["diff --git a/run.sh b/run.sh", "old mode 100644", "new mode 100755"];
    const report = reportOf(coverageForArtifact(artifact(patch(FOO_HUNK, modeOnly), [])));
    expect(report.files).toContainEqual({
      file: "run.sh",
      status: "nonCoverable",
      reason: "noChangedLines",
    });
    expect(report.uncoveredSpans.some((span) => span.file === "run.sh")).toBe(false);
  });

  it("does not call a diff of nothing but content-less files complete-with-coverage", () => {
    // A mode-only-and-binary diff has no coverable line, so completeness is vacuous — but the
    // files must still read non-coverable, never `covered`, so the report never claims a layer
    // explained them.
    const modeOnly = ["diff --git a/run.sh b/run.sh", "old mode 100644", "new mode 100755"];
    const report = reportOf(coverageForArtifact(artifact(patch(modeOnly), [])));
    expect(report.headline).toEqual({ coverableChangedLines: 0, coveredChangedLines: 0 });
    expect(isComplete(report)).toBe(true);
    expect(report.files).toEqual([
      { file: "run.sh", status: "nonCoverable", reason: "noChangedLines" },
    ]);
  });
});

describe("changedLineUniverse", () => {
  it("lists each coverable file's per-side contiguous changed spans, in deletions-then-additions order", () => {
    expect(changedLineUniverse(patch(FOO_HUNK, BAR_HUNK))).toEqual([
      {
        file: "src/foo.ts",
        status: "modified",
        coverable: true,
        spans: [
          { side: "deletions", startLine: 11, endLine: 11 },
          { side: "additions", startLine: 11, endLine: 12 },
        ],
      },
      {
        file: "src/bar.ts",
        status: "modified",
        coverable: true,
        spans: [{ side: "additions", startLine: 5, endLine: 8 }],
      },
    ]);
  });

  it("lists a binary and a pure rename non-coverable, with no spans to anchor into", () => {
    const binary = [
      "diff --git a/logo.png b/logo.png",
      "index 1111111..2222222 100644",
      "Binary files a/logo.png and b/logo.png differ",
    ];
    const rename = [
      "diff --git a/old.ts b/new.ts",
      "similarity index 100%",
      "rename from old.ts",
      "rename to new.ts",
    ];
    expect(changedLineUniverse(patch(binary, rename))).toEqual([
      { file: "logo.png", status: "modified", coverable: false, reason: "binary" },
      { file: "new.ts", status: "renamed", coverable: false, reason: "pureRename" },
    ]);
  });

  it("is the same universe coverage scores: every span is uncovered when no layer touches it", () => {
    // The load-bearing shared-derivation guarantee (one universe, two consumers): the spans
    // `rvw diff --json` lists are exactly what `rvw check --coverage` treats as the universe, so an
    // anchor authored from the listing lands inside what coverage will later measure.
    const source = patch(FOO_HUNK, BAR_HUNK);
    const universeSpans = changedLineUniverse(source).flatMap((file) =>
      file.coverable ? file.spans.map((span) => ({ file: file.file, ...span })) : [],
    );
    expect(reportOf(coverageOfPatch(source, [])).uncoveredSpans).toEqual(universeSpans);
  });
});

/** foo (fully coverable) + bar (a whole-file gap) with the given layers — the shared
 * two-file fixture the gap tests vary only the layers of. */
function patchedGapArtifact(layers: ReviewLayerInput[]): ReviewArtifact {
  return artifact(patch(FOO_HUNK, BAR_HUNK), layers);
}
