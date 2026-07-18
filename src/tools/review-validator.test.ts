import { describe, expect, it } from "vitest";
import type { ReviewArtifact } from "../shared/review";
import {
  parseReviewArtifact,
  validatePlacement,
  type ValidationProblem,
  type ValidationReport,
} from "./review-validator";

// Two files so anchoring, layer ranges, and description links all have real diff
// to place against. `src/foo.ts` carries a modification hunk covering additions
// 10..14 / deletions 10..12; `src/bar.ts` covers additions 1..3.
const PATCH = [
  "diff --git a/src/foo.ts b/src/foo.ts",
  "index 1111111..2222222 100644",
  "--- a/src/foo.ts",
  "+++ b/src/foo.ts",
  "@@ -10,3 +10,5 @@",
  " ctx10",
  "-old11",
  "+new11",
  "+new12",
  "+new13",
  " ctx14",
  "diff --git a/src/bar.ts b/src/bar.ts",
  "index 3333333..4444444 100644",
  "--- a/src/bar.ts",
  "+++ b/src/bar.ts",
  "@@ -1,2 +1,3 @@",
  " keep1",
  "+added2",
  " keep3",
  "",
].join("\n");

const SOURCE: ReviewArtifact["source"] = {
  kind: "local",
  repo: { path: "/repo", name: "repo" },
  base: "main",
  head: "feature",
};

function validArtifact(overrides: Partial<ReviewArtifact> = {}): ReviewArtifact {
  return {
    version: 1,
    source: SOURCE,
    patch: PATCH,
    comments: [{ file: "src/foo.ts", side: "additions", startLine: 11, endLine: 13, body: "note" }],
    layers: [
      {
        id: "rollup",
        label: "Rollup",
        summary: "parent",
        kind: "feature",
        ranges: [],
      },
      {
        id: "leaf",
        label: "Leaf",
        summary: "child",
        // A resolving link plus an inert code span: only the broken-link case is a
        // problem, so the code span must not be flagged.
        description: "Touches [bar](src/bar.ts) via `helper`.",
        kind: "validation",
        ranges: [{ file: "src/bar.ts", side: "additions", startLine: 2, endLine: 2 }],
      },
    ],
    ...overrides,
  };
}

function kinds(problems: ValidationProblem[]): string[] {
  return problems.map((problem) => problem.kind);
}

/** Parse the untrusted bytes, then place every anchor against the artifact's own embedded
 * patch — the frozen path the CLI takes for an imported artifact that still carries one, and
 * the exact composition (`parseReviewArtifact` + `validatePlacement`) the refs-only path runs
 * against a re-derived diff. Collapses the two steps into one `{ ok }` report so each case
 * asserts the same shape the app anchors against. */
function validate(bytes: string): ValidationReport {
  const parsed = parseReviewArtifact(bytes);
  if (!parsed.ok) {
    return { ok: false, problems: parsed.problems };
  }
  const problems = validatePlacement(parsed.artifact, parsed.artifact.patch ?? "");
  return problems.length === 0 ? { ok: true } : { ok: false, problems };
}

describe("parseReviewArtifact + validatePlacement", () => {
  it("returns ok for an artifact whose every anchor places and every link resolves", () => {
    expect(validate(JSON.stringify(validArtifact()))).toEqual({ ok: true });
  });

  it("flags a comment range outside any hunk and a comment on an absent file with exact locators", () => {
    const artifact = validArtifact({
      comments: [
        { file: "src/foo.ts", side: "additions", startLine: 50, endLine: 50, body: "drifted" },
        { file: "src/gone.ts", side: "additions", startLine: 1, endLine: 1, body: "absent" },
      ],
    });

    const report = validate(JSON.stringify(artifact));
    expect(report.ok).toBe(false);
    if (report.ok) return;
    expect(report.problems).toContainEqual({
      kind: "commentAnchorOutdated",
      anchor: { file: "src/foo.ts", side: "additions", startLine: 50, endLine: 50 },
    });
    expect(report.problems).toContainEqual({
      kind: "commentFileAbsent",
      anchor: { file: "src/gone.ts", side: "additions", startLine: 1, endLine: 1 },
    });
  });

  it("flags an unresolved description link while leaving a parent rollup's empty ranges valid", () => {
    const artifact = validArtifact({
      layers: [
        { id: "rollup", label: "Rollup", summary: "parent", kind: "feature", ranges: [] },
        {
          id: "leaf",
          label: "Leaf",
          summary: "child",
          description: "See [ghost](does/not/exist.ts).",
          kind: "validation",
          ranges: [{ file: "src/bar.ts", side: "additions", startLine: 2, endLine: 2 }],
        },
      ],
    });

    const report = validate(JSON.stringify(artifact));
    expect(report.ok).toBe(false);
    if (report.ok) return;
    expect(report.problems).toEqual([
      { kind: "unresolvedLink", layerId: "leaf", label: "ghost", path: "does/not/exist.ts" },
    ]);
  });

  it("flags a layer range outside any hunk and a layer range on an absent file as layerRangeOutdated", () => {
    const artifact = validArtifact({
      layers: [
        {
          id: "drifted",
          label: "Drifted",
          summary: "range past the hunk",
          kind: "feature",
          ranges: [{ file: "src/foo.ts", side: "additions", startLine: 90, endLine: 90 }],
        },
        {
          id: "absent",
          label: "Absent",
          summary: "range on a file not in the diff",
          kind: "feature",
          ranges: [{ file: "src/gone.ts", side: "additions", startLine: 1, endLine: 1 }],
        },
      ],
    });

    const report = validate(JSON.stringify(artifact));
    expect(report.ok).toBe(false);
    if (report.ok) return;
    // A file absent from the patch funnels through the same `null` fileDiff path as an
    // out-of-hunk range, so both surface as layerRangeOutdated with the layer's id.
    expect(report.problems).toContainEqual({
      kind: "layerRangeOutdated",
      layerId: "drifted",
      anchor: { file: "src/foo.ts", side: "additions", startLine: 90, endLine: 90 },
    });
    expect(report.problems).toContainEqual({
      kind: "layerRangeOutdated",
      layerId: "absent",
      anchor: { file: "src/gone.ts", side: "additions", startLine: 1, endLine: 1 },
    });
  });

  it("reports non-JSON bytes as a typed problem without throwing", () => {
    const report = validate("}{ not json");
    expect(report.ok).toBe(false);
    if (report.ok) return;
    expect(kinds(report.problems)).toEqual(["invalidJson"]);
  });

  it("reports a bad side enum as a schema problem on the offending path without throwing", () => {
    const artifact = {
      ...validArtifact(),
      comments: [{ file: "src/foo.ts", side: "old", startLine: 11, endLine: 13, body: "bad" }],
    };
    const report = validate(JSON.stringify(artifact));
    expect(report.ok).toBe(false);
    if (report.ok) return;
    expect(report.problems).toContainEqual(
      expect.objectContaining({ kind: "schema", path: "comments.0.side" }),
    );
  });

  it("reports a descending range as a schema problem, exercising the ascending refine", () => {
    // A valid side isolates the range refine: `side: "old"` would fail the enum first
    // and short-circuit before `rangeIsAscending` ever runs (review.ts), so this is the
    // only fixture that proves a descending range is rejected on its own.
    const artifact = {
      ...validArtifact(),
      comments: [
        { file: "src/foo.ts", side: "additions", startLine: 13, endLine: 11, body: "bad" },
      ],
    };
    const report = validate(JSON.stringify(artifact));
    expect(report.ok).toBe(false);
    if (report.ok) return;
    expect(report.problems).toContainEqual(
      expect.objectContaining({ kind: "schema", path: "comments.0" }),
    );
  });

  it("reports a diff with no changes as the missing-patch problem", () => {
    // A patch that parses to no file has no diff to place anchors against, whether it is
    // absent (JSON.stringify drops the `undefined`) or an empty string.
    expect(validate(JSON.stringify({ ...validArtifact(), patch: undefined }))).toEqual({
      ok: false,
      problems: [{ kind: "missingPatch" }],
    });
    expect(validate(JSON.stringify(validArtifact({ patch: "" })))).toEqual({
      ok: false,
      problems: [{ kind: "missingPatch" }],
    });
  });
});
