import { describe, expect, it } from "vitest";
import { importReview, ReviewArtifact, type ReviewStamp } from "./review";

const SHA_40 = "a".repeat(40);

function validArtifact(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    repo: "/repos/app",
    base: "main",
    head: SHA_40,
    comments: [
      { file: "src/a.ts", side: "additions", startLine: 10, endLine: 12, body: "look here" },
    ],
    layers: [
      {
        label: "Wire the library",
        summary: "Bring the diff lib into main",
        ranges: [{ file: "src/a.ts", side: "additions", startLine: 10, endLine: 20 }],
      },
    ],
    ...overrides,
  };
}

/** Deterministic identity so a stamped import is exactly assertable. */
function fixedStamp(): ReviewStamp {
  let next = 0;
  return {
    newId: () => `id-${(next += 1)}`,
  };
}

describe("ReviewArtifact", () => {
  it("parses a valid artifact", () => {
    expect(ReviewArtifact.safeParse(validArtifact()).success).toBe(true);
  });

  it("rejects a malformed artifact", () => {
    expect(ReviewArtifact.safeParse(validArtifact({ comments: "nope" })).success).toBe(false);
  });

  it("refuses an unknown key rather than silently dropping it", () => {
    // The artifact is throwaway and unversioned, so a leftover or mistyped key is a typo to
    // surface, never a field to swallow.
    expect(ReviewArtifact.safeParse(validArtifact({ version: 1 })).success).toBe(false);
  });

  it("accepts a comments-only artifact — no `layers` key at all", () => {
    const parsed = ReviewArtifact.safeParse({
      repo: "/repos/app",
      base: "main",
      head: SHA_40,
      comments: [{ file: "src/a.ts", side: "additions", startLine: 1, endLine: 1, body: "why" }],
    });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.layers).toEqual([]);
  });

  it("accepts a layers-only artifact — no `comments` key at all", () => {
    const parsed = ReviewArtifact.safeParse({
      repo: "/repos/app",
      base: "main",
      head: SHA_40,
      layers: [
        {
          label: "The change",
          ranges: [{ file: "src/a.ts", side: "additions", startLine: 1, endLine: 1 }],
        },
      ],
    });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.comments).toEqual([]);
  });

  it("accepts a layer that carries only a label and its ranges", () => {
    const parsed = ReviewArtifact.safeParse(
      validArtifact({
        layers: [
          {
            label: "The change",
            ranges: [{ file: "src/a.ts", side: "additions", startLine: 1, endLine: 1 }],
          },
        ],
      }),
    );
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.layers[0]).toEqual({
      label: "The change",
      ranges: [{ file: "src/a.ts", side: "additions", startLine: 1, endLine: 1 }],
      children: [],
    });
  });

  it("accepts a layer with or without the optional long-form description", () => {
    const withDescription = validArtifact({
      layers: [
        {
          label: "Wire the library",
          summary: "Bring the diff lib into main",
          description: "The chapter prose. See `src/a.ts` for the seam.",
          ranges: [{ file: "src/a.ts", side: "additions", startLine: 10, endLine: 20 }],
        },
      ],
    });
    expect(ReviewArtifact.safeParse(withDescription).success).toBe(true);
    expect(ReviewArtifact.safeParse(validArtifact()).success).toBe(true);
  });
});

describe("importReview", () => {
  it("stamps a uuid id on each imported comment", () => {
    const twoComments = validArtifact({
      layers: [],
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
        id: "id-1",
      },
      {
        file: "src/b.ts",
        side: "deletions",
        startLine: 4,
        endLine: 5,
        body: "two",
        id: "id-2",
      },
    ]);
  });

  it("derives the repo's display name from its path — the artifact never carries one", () => {
    const result = importReview(JSON.stringify(validArtifact()), fixedStamp());

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.review.repo).toEqual({ path: "/repos/app", name: "app" });
    expect(result.review.base).toBe("main");
    expect(result.review.head).toBe(SHA_40);
  });

  it("flattens the authored tree depth-first, stamping id and parent", () => {
    const artifact = validArtifact({
      comments: [],
      layers: [
        {
          label: "Group",
          children: [
            {
              label: "First child",
              ranges: [{ file: "a.ts", side: "additions", startLine: 1, endLine: 1 }],
              children: [
                {
                  label: "Grandchild",
                  ranges: [{ file: "a.ts", side: "additions", startLine: 2, endLine: 2 }],
                },
              ],
            },
            {
              label: "Second child",
              ranges: [{ file: "b.ts", side: "additions", startLine: 1, endLine: 1 }],
            },
          ],
        },
        { label: "Tail", ranges: [{ file: "c.ts", side: "additions", startLine: 1, endLine: 1 }] },
      ],
    });
    const result = importReview(JSON.stringify(artifact), fixedStamp());

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    // Document order is the walk: a subtree is contiguous and follows its parent, and the
    // ids are the app's, in the order they were handed out.
    expect(result.review.layers.map((layer) => [layer.label, layer.id, layer.parent])).toEqual([
      ["Group", "id-1", undefined],
      ["First child", "id-2", "id-1"],
      ["Grandchild", "id-3", "id-2"],
      ["Second child", "id-4", "id-1"],
      ["Tail", "id-5", undefined],
    ]);
  });

  it("keeps a bare layer bare: no summary, no description, no parent", () => {
    const artifact = validArtifact({
      comments: [],
      layers: [
        {
          label: "Only a label",
          ranges: [{ file: "a.ts", side: "additions", startLine: 1, endLine: 3 }],
        },
      ],
    });
    const result = importReview(JSON.stringify(artifact), fixedStamp());

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.review.layers).toEqual([
      {
        id: "id-1",
        label: "Only a label",
        ranges: [{ file: "a.ts", side: "additions", startLine: 1, endLine: 3 }],
      },
    ]);
  });

  it("carries an embedded patch through as a real value and layers in authored order", () => {
    const artifact = validArtifact({
      patch: "diff --git a/x b/x",
      layers: [
        { label: "B", summary: "second" },
        { label: "A", summary: "first" },
      ],
    });
    const result = importReview(JSON.stringify(artifact), fixedStamp());

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.review.patch).toBe("diff --git a/x b/x");
    expect(result.review.layers.map((layer) => layer.label)).toEqual(["B", "A"]);
  });

  it("models a missing embedded patch as null, never undefined", () => {
    const result = importReview(JSON.stringify(validArtifact()), fixedStamp());

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.review.patch).toBeNull();
  });

  it("rejects a base ref that smuggles a flag before it can reach a spawn", () => {
    const tampered = validArtifact({ base: "--upload-pack=/tmp/evil" });
    const result = importReview(JSON.stringify(tampered), fixedStamp());

    expect(result).toEqual({ ok: false, error: "invalidContent" });
  });

  it("rejects a flag smuggled through the head ref too, not only base", () => {
    const tampered = validArtifact({ head: "--upload-pack=/tmp/evil" });
    const result = importReview(JSON.stringify(tampered), fixedStamp());

    expect(result).toEqual({ ok: false, error: "invalidContent" });
  });

  it("rejects a relative repo path — the artifact records the work-tree toplevel", () => {
    const result = importReview(JSON.stringify(validArtifact({ repo: "repos/app" })), fixedStamp());

    expect(result).toEqual({ ok: false, error: "invalidContent" });
  });

  it("returns a typed failure for corrupt bytes instead of throwing", () => {
    expect(importReview("{ not json", fixedStamp())).toEqual({
      ok: false,
      error: "invalidContent",
    });
  });
});
