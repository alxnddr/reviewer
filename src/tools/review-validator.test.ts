import { describe, expect, it } from "vitest";
import type { ReviewArtifact, ReviewLayerDraft } from "../shared/review";
import { RENAMES_PATCH, TWO_HUNKS_PATCH } from "../renderer/src/lib/diff/fixtures";
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

/** The artifact as authored — the shape these fixtures write, before the parse fills in
 * `ranges`/`children`. */
type Draft = {
  repo: string;
  base: string;
  head: string;
  patch?: string | undefined;
  overview?: ReviewArtifact["overview"];
  comments?: ReviewArtifact["comments"];
  layers?: ReviewLayerDraft[];
};

function validArtifact(overrides: Partial<Draft> = {}): Draft {
  return {
    repo: "/repo",
    base: "main",
    head: "feature",
    patch: PATCH,
    comments: [{ file: "src/foo.ts", side: "additions", startLine: 11, endLine: 13, body: "note" }],
    layers: [
      {
        label: "Rollup",
        summary: "parent",
        children: [
          {
            label: "Leaf",
            summary: "child",
            // A resolving link plus an inert code span: only the broken-link case is a
            // problem, so the code span must not be flagged.
            description: "Touches [bar](src/bar.ts) via `helper`.",
            ranges: [{ file: "src/bar.ts", side: "additions", startLine: 2, endLine: 2 }],
          },
        ],
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

  it("agrees with the app that a range across a hunk boundary does not place, but each half does", () => {
    // Both sides of one rule: the gate runs the app's own `resolveAnchor`, so a range
    // spanning the collapsed context between two hunks — the range the surface's `+`
    // clamps away rather than author — is refused here too, while the two halves it
    // clamps to place. An agent hears about it before handing the review over, instead
    // of the reader finding the comment pinned to the file header.
    const artifact = validArtifact({
      patch: TWO_HUNKS_PATCH,
      comments: [
        { file: "src/two-hunks.txt", side: "additions", startLine: 5, endLine: 28, body: "note" },
      ],
      layers: [
        {
          label: "Both hunks",
          summary: "one range per hunk",
          ranges: [
            { file: "src/two-hunks.txt", side: "additions", startLine: 5, endLine: 6 },
            { file: "src/two-hunks.txt", side: "additions", startLine: 27, endLine: 28 },
          ],
        },
      ],
    });

    const report = validate(JSON.stringify(artifact));
    expect(report.ok).toBe(false);
    if (report.ok) return;
    expect(report.problems).toEqual([
      {
        kind: "commentAnchorOutdated",
        anchor: { file: "src/two-hunks.txt", side: "additions", startLine: 5, endLine: 28 },
      },
    ]);
  });

  it("places a comment authored before a rename, and still fails a layer range on the old path", () => {
    // The app hosts the comment on the renamed file (deletions are old-file
    // coordinates, so the anchor is untouched by the rename) — the gate must agree.
    // A layer range on the same old path is a different story: the app's layer scroll
    // only finds a file by its current path, so passing it would green-light a
    // walkthrough stop the reader cannot reach.
    const artifact = validArtifact({
      patch: RENAMES_PATCH,
      comments: [
        { file: "src/old-edit.txt", side: "deletions", startLine: 2, endLine: 2, body: "note" },
      ],
      layers: [
        {
          label: "Rename",
          summary: "moved it",
          ranges: [{ file: "src/old-edit.txt", side: "deletions", startLine: 2, endLine: 2 }],
        },
      ],
    });

    const report = validate(JSON.stringify(artifact));
    expect(report.ok).toBe(false);
    if (report.ok) return;
    expect(kinds(report.problems)).toEqual(["layerRangeOutdated"]);
  });

  it("flags an unresolved description link by ordinal, leaving a parent rollup's empty ranges valid", () => {
    const artifact = validArtifact({
      layers: [
        {
          label: "Rollup",
          summary: "parent",
          children: [
            {
              label: "Leaf",
              summary: "child",
              description: "See [ghost](does/not/exist.ts).",
              ranges: [{ file: "src/bar.ts", side: "additions", startLine: 2, endLine: 2 }],
            },
          ],
        },
      ],
    });

    const report = validate(JSON.stringify(artifact));
    expect(report.ok).toBe(false);
    if (report.ok) return;
    expect(report.problems).toEqual([
      { kind: "unresolvedLink", layer: "1.1", label: "ghost", path: "does/not/exist.ts" },
    ]);
  });

  it("holds the overview's prose to the same dead-link rule as a layer description", () => {
    const artifact = validArtifact({
      overview: {
        title: "Tour",
        body: "Starts in [foo](src/foo.ts), then [nowhere](src/gone.ts).",
      },
    });

    const report = validate(JSON.stringify(artifact));
    expect(report.ok).toBe(false);
    if (report.ok) return;
    // Only the unresolved one is a problem: the link that names a file in the diff
    // renders as a live chip and passes.
    expect(report.problems).toEqual([
      { kind: "overviewUnresolvedLink", label: "nowhere", path: "src/gone.ts" },
    ]);
  });

  it("passes an overview whose every reference resolves", () => {
    const artifact = validArtifact({
      overview: { title: "Tour", body: "Read [foo](src/foo.ts) first; `src/bar.ts` follows." },
    });

    expect(validate(JSON.stringify(artifact)).ok).toBe(true);
  });

  it("flags a layer range outside any hunk and a layer range on an absent file as layerRangeOutdated", () => {
    const artifact = validArtifact({
      layers: [
        {
          label: "Drifted",
          summary: "range past the hunk",
          ranges: [{ file: "src/foo.ts", side: "additions", startLine: 90, endLine: 90 }],
        },
        {
          label: "Absent",
          summary: "range on a file not in the diff",
          ranges: [{ file: "src/gone.ts", side: "additions", startLine: 1, endLine: 1 }],
        },
      ],
    });

    const report = validate(JSON.stringify(artifact));
    expect(report.ok).toBe(false);
    if (report.ok) return;
    // A file absent from the patch funnels through the same `null` fileDiff path as an
    // out-of-hunk range, so both surface as layerRangeOutdated at the layer's ordinal.
    expect(report.problems).toContainEqual({
      kind: "layerRangeOutdated",
      layer: "1",
      anchor: { file: "src/foo.ts", side: "additions", startLine: 90, endLine: 90 },
    });
    expect(report.problems).toContainEqual({
      kind: "layerRangeOutdated",
      layer: "2",
      anchor: { file: "src/gone.ts", side: "additions", startLine: 1, endLine: 1 },
    });
  });

  it("names a nested layer by its ordinal path, the section number the reader will see", () => {
    const artifact = validArtifact({
      layers: [
        {
          label: "First",
          ranges: [{ file: "src/bar.ts", side: "additions", startLine: 2, endLine: 2 }],
        },
        {
          label: "Second",
          children: [
            {
              label: "A",
              ranges: [{ file: "src/bar.ts", side: "additions", startLine: 2, endLine: 2 }],
            },
            {
              label: "B",
              ranges: [{ file: "src/foo.ts", side: "additions", startLine: 90, endLine: 90 }],
            },
          ],
        },
      ],
    });

    const report = validate(JSON.stringify(artifact));
    expect(report.ok).toBe(false);
    if (report.ok) return;
    expect(report.problems).toEqual([
      {
        kind: "layerRangeOutdated",
        layer: "2.2",
        anchor: { file: "src/foo.ts", side: "additions", startLine: 90, endLine: 90 },
      },
    ]);
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
    // A patch that parses to no file has no diff to place anchors against; an absent one
    // (JSON.stringify drops the `undefined`) takes the same route.
    expect(validate(JSON.stringify({ ...validArtifact(), patch: undefined }))).toEqual({
      ok: false,
      problems: [{ kind: "missingPatch" }],
    });
  });
});

// What is left of the outline contract once `children` carries the shape: a depth the
// reader can follow, and every layer reaching some code. Dangling parents, cycles, and a
// mis-ordered array are gone — nesting cannot express them.
describe("the outline contract", () => {
  const group = (label: string, children: ReviewLayerDraft[] = []): ReviewLayerDraft => ({
    label,
    summary: "a theme",
    children,
  });
  const stop = (label = "Child", children: ReviewLayerDraft[] = []): ReviewLayerDraft => ({
    label,
    summary: "the code",
    ranges: [{ file: "src/bar.ts", side: "additions" as const, startLine: 2, endLine: 2 }],
    children,
  });

  const problemsFor = (layers: ReviewLayerDraft[]): ValidationProblem[] => {
    const report = validate(JSON.stringify(validArtifact({ layers })));
    return report.ok ? [] : report.problems;
  };

  it("accepts a nested tree", () => {
    expect(problemsFor([group("Group", [group("Inner", [stop()])]), stop("After")])).toEqual([]);
  });

  it("accepts a parent that carries ranges of its own — extent is own plus descendants'", () => {
    expect(problemsFor([stop("Parent", [stop()])])).toEqual([]);
  });

  it("refuses nesting past the depth cap", () => {
    const chain = group("l1", [
      group("l2", [group("l3", [group("l4", [group("l5", [stop("l6")])])])]),
    ]);
    expect(problemsFor([chain])).toContainEqual({
      kind: "nestingTooDeep",
      layer: "1.1.1.1.1.1",
      depth: 6,
    });
  });

  it("refuses a layer that reaches no code at all, at any depth", () => {
    // A range-less layer is fine when something under it has ranges; alone it is an
    // outline entry with no review behind it.
    expect(problemsFor([group("Group", [stop()])])).toEqual([]);
    expect(problemsFor([group("Group"), stop("Elsewhere")])).toContainEqual({
      kind: "layerWalksNothing",
      layer: "1",
    });
    expect(problemsFor([group("Group", [group("Inner")]), stop("Elsewhere")])).toContainEqual({
      kind: "layerWalksNothing",
      layer: "1.1",
    });
  });
});
