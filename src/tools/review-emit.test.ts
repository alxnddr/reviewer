import { describe, expect, it } from "vitest";
import { ReviewArtifact } from "../shared/review";
import { parseReviewArtifact, validatePlacement } from "./review-validator";
import { emitReviewArtifact, type EmitInput } from "./review-emit";

// A two-file patch so comment anchors and layer ranges have real hunks to place
// against: `src/foo.ts` covers additions 10..14, `src/bar.ts` covers additions 1..3.
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

const COMMENTS = [
  { file: "src/foo.ts", side: "additions", startLine: 11, endLine: 13, body: "why" },
];
const LAYERS = [
  { id: "rollup", label: "Rollup", summary: "parent", ranges: [] },
  {
    id: "leaf",
    label: "Leaf",
    summary: "child",
    description: "Adds [bar](src/bar.ts).",
    parent: "rollup",
    ranges: [{ file: "src/bar.ts", side: "additions", startLine: 2, endLine: 2 }],
  },
];

function input(overrides: Partial<EmitInput> = {}): EmitInput {
  return {
    repo: { path: "/repo", name: "repo" },
    base: "main",
    head: "feature",
    patch: PATCH,
    comments: COMMENTS,
    layers: LAYERS,
    ...overrides,
  };
}

describe("emitReviewArtifact", () => {
  it("assembles a version:1 refs-only artifact whose anchors place against the captured diff", () => {
    const result = emitReviewArtifact(input());
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const parsed = parseReviewArtifact(result.bytes);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    // Refs-only: the artifact carries no embedded patch — the app re-derives the diff
    // from `source` on open, and re-validation places against that captured diff, not stored bytes.
    expect(parsed.artifact.patch).toBeUndefined();
    expect(validatePlacement(parsed.artifact, PATCH)).toEqual([]);

    const artifact = ReviewArtifact.parse(JSON.parse(result.bytes));
    expect(artifact.version).toBe(1);
    expect(artifact.source).toEqual({
      kind: "local",
      repo: { path: "/repo", name: "repo" },
      base: "main",
      head: "feature",
    });
    expect(artifact.layers).toHaveLength(2);
    // Layer order is emitted as authored — the app never re-sorts.
    expect(artifact.layers.map((layer) => layer.id)).toEqual(["rollup", "leaf"]);
    expect(artifact.comments[0]?.side).toBe("additions");
  });

  it("refuses handoff — no bytes — when a comment anchor sits outside every hunk", () => {
    const result = emitReviewArtifact(
      input({
        comments: [
          { file: "src/foo.ts", side: "additions", startLine: 50, endLine: 50, body: "drifted" },
        ],
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems).toContainEqual({
      kind: "commentAnchorOutdated",
      anchor: { file: "src/foo.ts", side: "additions", startLine: 50, endLine: 50 },
    });
  });

  it("refuses handoff — no bytes — on a bad side enum, reported at the offending path", () => {
    const result = emitReviewArtifact(
      input({
        comments: [{ file: "src/foo.ts", side: "old", startLine: 11, endLine: 13, body: "bad" }],
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems).toContainEqual(
      expect.objectContaining({ kind: "schema", path: "comments.0.side" }),
    );
  });

  it("refuses handoff — no bytes — on a descending range (the ascending refine, isolated)", () => {
    // A valid side so the enum passes and the range refine is what rejects it — otherwise
    // the bad side short-circuits first and the descending range is never checked.
    const result = emitReviewArtifact(
      input({
        comments: [
          { file: "src/foo.ts", side: "additions", startLine: 13, endLine: 11, body: "bad" },
        ],
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems).toContainEqual(
      expect.objectContaining({ kind: "schema", path: "comments.0" }),
    );
  });

  it("refuses handoff — no bytes — on an unresolved description link", () => {
    const result = emitReviewArtifact(
      input({
        layers: [
          {
            id: "leaf",
            label: "Leaf",
            summary: "child",
            description: "See [ghost](does/not/exist.ts).",
            ranges: [{ file: "src/bar.ts", side: "additions", startLine: 2, endLine: 2 }],
          },
        ],
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems).toContainEqual({
      kind: "unresolvedLink",
      layerId: "leaf",
      label: "ghost",
      path: "does/not/exist.ts",
    });
  });
});
