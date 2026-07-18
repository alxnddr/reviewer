import Ajv2020 from "ajv/dist/2020";
import type { ValidateFunction } from "ajv";
import { describe, expect, it } from "vitest";
import { ReviewArtifact } from "../shared/review";
import { reviewArtifactJsonSchema } from "./review-schema";

// The emitted schema is only worth emitting if a real third-party validator enforces it,
// so these tests compile it with Ajv rather than inspecting its keys. Where the schema and
// the zod contract *must* diverge (the cross-field range rule), that divergence is asserted
// in both directions — the schema documents it, zod rejects it — so a future zod release
// that starts serializing refinements makes the "schema accepts it" assertion fail loudly
// rather than leaving a stale comment behind.

const VALID = {
  version: 1,
  source: { kind: "local", repo: { path: "/repo", name: "repo" }, base: "main", head: "feature" },
  patch: "diff --git a/a.ts b/a.ts\n",
  comments: [{ file: "a.ts", side: "additions", startLine: 2, endLine: 4, body: "why" }],
  layers: [
    {
      id: "one",
      label: "One",
      summary: "first",
      kind: "feature",
      ranges: [{ file: "a.ts", side: "additions", startLine: 2, endLine: 4 }],
    },
  ],
};

function compiled(): ValidateFunction {
  // `strict: false` because zod emits `additionalProperties` alongside `oneOf` branches,
  // which Ajv's strict mode flags as a schema-authoring smell rather than an error.
  return new Ajv2020({ strict: false }).compile(reviewArtifactJsonSchema());
}

describe("reviewArtifactJsonSchema", () => {
  it("accepts a valid artifact", () => {
    expect(compiled()(VALID)).toBe(true);
    expect(ReviewArtifact.safeParse(VALID).success).toBe(true);
  });

  it('rejects side:"old" — the wire word an agent is most likely to guess wrong', () => {
    const artifact = {
      ...VALID,
      comments: [{ file: "a.ts", side: "old", startLine: 2, endLine: 4, body: "why" }],
    };
    expect(compiled()(artifact)).toBe(false);
    expect(ReviewArtifact.safeParse(artifact).success).toBe(false);
  });

  it("rejects a version other than 1, so a future schema is never mis-read as v1", () => {
    expect(compiled()({ ...VALID, version: 2 })).toBe(false);
  });

  it("rejects an unknown top-level key rather than silently ignoring it", () => {
    expect(compiled()({ ...VALID, submitted: true })).toBe(false);
  });

  it("documents the descending-range rule it structurally cannot enforce, which zod enforces", () => {
    const descending = {
      ...VALID,
      comments: [{ file: "a.ts", side: "additions", startLine: 9, endLine: 4, body: "why" }],
    };
    // JSON Schema has no keyword relating two sibling properties, so the emitted document
    // cannot reject this. The contract does — which is why `rvw validate` is the authority.
    expect(compiled()(descending)).toBe(true);
    expect(ReviewArtifact.safeParse(descending).success).toBe(false);

    // ...and the rule an agent must honor is stated in the schema it authors against.
    const schema = reviewArtifactJsonSchema();
    expect(JSON.stringify(schema)).toContain("endLine must be greater than or equal to startLine");
    expect(schema.description).toContain("`rvw validate`");
  });

  it("is derived from the contract, not hand-written: every artifact key appears in the schema", () => {
    const properties = reviewArtifactJsonSchema().properties ?? {};
    expect(Object.keys(properties).sort()).toEqual([
      "comments",
      "layers",
      "patch",
      "source",
      "version",
    ]);
  });
});
