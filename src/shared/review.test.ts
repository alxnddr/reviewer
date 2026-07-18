import { describe, expect, it } from "vitest";
import { importReview, ReviewArtifact, type ReviewStamp } from "./review";

const SHA_40 = "a".repeat(40);

function validArtifact(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    source: {
      kind: "local",
      repo: { path: "/repos/app", name: "app" },
      base: "main",
      head: SHA_40,
    },
    patch: undefined,
    comments: [
      { file: "src/a.ts", side: "additions", startLine: 10, endLine: 12, body: "look here" },
    ],
    layers: [
      {
        id: "wire",
        label: "Wire the library",
        summary: "Bring the diff lib into main",
        kind: "feature",
        ranges: [{ file: "src/a.ts", side: "additions", startLine: 10, endLine: 20 }],
      },
    ],
    ...overrides,
  };
}

/** Deterministic identity so a stamped import is exactly assertable. */
function fixedStamp(): ReviewStamp {
  const ids = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"];
  let next = 0;
  return {
    newId: () => ids[next++] ?? "00000000-0000-4000-8000-000000000000",
  };
}

describe("ReviewArtifact", () => {
  it("parses a valid v1 artifact", () => {
    expect(ReviewArtifact.safeParse(validArtifact()).success).toBe(true);
  });

  it("rejects a version-2 artifact rather than mis-reading it as v1", () => {
    expect(ReviewArtifact.safeParse(validArtifact({ version: 2 })).success).toBe(false);
  });

  it("rejects a malformed artifact", () => {
    expect(ReviewArtifact.safeParse(validArtifact({ comments: "nope" })).success).toBe(false);
  });

  it("accepts a layer with or without the optional long-form description", () => {
    const withDescription = validArtifact({
      layers: [
        {
          id: "wire",
          label: "Wire the library",
          summary: "Bring the diff lib into main",
          description: "The chapter prose. See `src/a.ts` for the seam.",
          kind: "feature",
          ranges: [{ file: "src/a.ts", side: "additions", startLine: 10, endLine: 20 }],
        },
      ],
    });
    expect(ReviewArtifact.safeParse(withDescription).success).toBe(true);
    // The base fixture carries no description — still valid (additive to v1).
    expect(ReviewArtifact.safeParse(validArtifact()).success).toBe(true);
  });
});

describe("importReview", () => {
  it("stamps a uuid id on each imported comment", () => {
    const twoComments = validArtifact({
      comments: [
        { file: "src/a.ts", side: "additions", startLine: 1, endLine: 1, body: "one" },
        { file: "src/b.ts", side: "deletions", startLine: 4, endLine: 5, body: "two" },
      ],
    });
    const result = importReview(JSON.stringify(twoComments), fixedStamp());

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.review.comments).toEqual([
      {
        file: "src/a.ts",
        side: "additions",
        startLine: 1,
        endLine: 1,
        body: "one",
        id: "11111111-1111-4111-8111-111111111111",
      },
      {
        file: "src/b.ts",
        side: "deletions",
        startLine: 4,
        endLine: 5,
        body: "two",
        id: "22222222-2222-4222-8222-222222222222",
      },
    ]);
  });

  it("carries an embedded patch through as a real value and layers in authored order", () => {
    const artifact = validArtifact({
      patch: "diff --git a/x b/x",
      layers: [
        { id: "b", label: "B", summary: "second", kind: "feature", ranges: [] },
        { id: "a", label: "A", summary: "first", kind: "feature", ranges: [] },
      ],
    });
    const result = importReview(JSON.stringify(artifact), fixedStamp());

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.review.patch).toBe("diff --git a/x b/x");
    expect(result.review.layers.map((layer) => layer.id)).toEqual(["b", "a"]);
  });

  it("models a missing embedded patch as null, never undefined", () => {
    const result = importReview(JSON.stringify(validArtifact()), fixedStamp());

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.review.patch).toBeNull();
  });

  it("rejects a source ref that smuggles a flag before it can reach a spawn", () => {
    const tampered = validArtifact({
      source: {
        kind: "local",
        repo: { path: "/repos/app", name: "app" },
        base: "--upload-pack=/tmp/evil",
        head: "main",
      },
    });
    const result = importReview(JSON.stringify(tampered), fixedStamp());

    expect(result).toEqual({ ok: false, error: "invalidContent" });
  });

  it("rejects a flag smuggled through the head ref too, not only base", () => {
    const tampered = validArtifact({
      source: {
        kind: "local",
        repo: { path: "/repos/app", name: "app" },
        base: "main",
        head: "--upload-pack=/tmp/evil",
      },
    });
    const result = importReview(JSON.stringify(tampered), fixedStamp());

    expect(result).toEqual({ ok: false, error: "invalidContent" });
  });

  it("returns a typed failure for corrupt bytes instead of throwing", () => {
    expect(importReview("{ not json", fixedStamp())).toEqual({
      ok: false,
      error: "invalidContent",
    });
  });
});
