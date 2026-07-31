import { describe, expect, it } from "vitest";
import {
  ARTIFACT_JSON_FORMAT,
  Comment,
  importReview,
  parseArtifactBytes,
  repoDisplayName,
  ReviewAnchor,
  ReviewArtifact,
  type ReviewStamp,
} from "./review";

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

describe("the anchor extend chain", () => {
  // `Comment` inherits the ascending refine through two `.extend()` hops and is the schema
  // persisted session state is re-parsed with (`session.ts`), where nothing else would
  // notice it going missing. `.extend()` preserving a refinement is a zod behavior, not a
  // language one, so it is pinned here: a release that stopped preserving it would
  // otherwise silently reopen "descending range accepted" on the app side alone.
  const descending = { file: "src/a.ts", side: "additions", startLine: 12, endLine: 10 };

  it("rejects a descending range at every hop, at the endLine that has to change", () => {
    for (const parsed of [
      ReviewAnchor.safeParse(descending),
      Comment.safeParse({
        ...descending,
        body: "why",
        id: "11111111-1111-4111-8111-111111111111",
      }),
    ]) {
      expect(parsed.success).toBe(false);
      expect(parsed.success ? [] : parsed.error.issues.map((issue) => issue.path)).toEqual([
        ["endLine"],
      ]);
    }
  });
});

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

    expect(result).toEqual({
      ok: false,
      error: "invalidContent",
      reason: expect.stringContaining("base"),
    });
  });

  it("rejects a flag smuggled through the head ref too, not only base", () => {
    const tampered = validArtifact({ head: "--upload-pack=/tmp/evil" });
    const result = importReview(JSON.stringify(tampered), fixedStamp());

    expect(result).toEqual({
      ok: false,
      error: "invalidContent",
      reason: expect.stringContaining("head"),
    });
  });

  it("rejects a relative repo path — the artifact records the work-tree toplevel", () => {
    const result = importReview(JSON.stringify(validArtifact({ repo: "repos/app" })), fixedStamp());

    expect(result).toEqual({
      ok: false,
      error: "invalidContent",
      reason: expect.stringContaining("Repo path must be absolute"),
    });
  });

  it("returns a typed failure for corrupt bytes instead of throwing", () => {
    expect(importReview("{ not json", fixedStamp())).toEqual({
      ok: false,
      error: "invalidContent",
      reason: expect.stringContaining("JSON"),
    });
  });

  it("names the offending field in its reason, so a hand-edited artifact says where", () => {
    const broken = validArtifact({
      comments: [
        { file: "src/a.ts", side: "sideways", startLine: 10, endLine: 12, body: "look here" },
      ],
    });
    const result = importReview(JSON.stringify(broken), fixedStamp());

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    // The locator is the dot path zod itself would print — array indices bracketed — so the
    // reader can find the one place in the file that has to change.
    expect(result.reason).toContain("comments[0].side");
  });

  it("bounds the reason — part of it is the untrusted file's own text", () => {
    // An unrecognized key is echoed back by zod, and an artifact is up to 32 MiB of JSON
    // somebody else may have written: the banner must not become a 100 KB text node.
    const bloated = validArtifact({ ["k".repeat(5_000)]: 1 });
    const result = importReview(JSON.stringify(bloated), fixedStamp());

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.reason.length).toBeLessThan(300);
  });
});

describe("parseArtifactBytes", () => {
  it("reports bytes that were never JSON as one issue naming the format", () => {
    const parsed = parseArtifactBytes("{ not json");

    expect(parsed.ok).toBe(false);
    if (parsed.ok) {
      return;
    }
    // The distinction the CLI's report keeps: "these bytes were never a document" is not a
    // schema problem with a path, so it is told apart by the issue rather than by a
    // second failure arm.
    expect(parsed.issues).toHaveLength(1);
    expect(parsed.issues[0]).toMatchObject({
      code: "invalid_format",
      format: ARTIFACT_JSON_FORMAT,
      path: [],
    });
    // And it carries no copy of what it refused: the issue is a value three callers pass
    // around, the document behind it is untrusted and up to 32 MiB, and zod's own issues
    // carry no `input` either — the message is the whole diagnosis.
    expect(parsed.issues[0]).not.toHaveProperty("input");
  });

  it("keeps every schema issue rather than collapsing them to one word", () => {
    const broken = validArtifact({
      repo: "repos/app",
      comments: [
        { file: "src/a.ts", side: "sideways", startLine: 10, endLine: 12, body: "look here" },
      ],
    });
    const parsed = parseArtifactBytes(JSON.stringify(broken));

    expect(parsed.ok).toBe(false);
    if (parsed.ok) {
      return;
    }
    expect(parsed.issues.length).toBeGreaterThan(1);
    expect(parsed.issues.map((issue) => issue.path.join("."))).toContain("comments.0.side");
  });

  it("answers with the parsed artifact, defaults filled, for a valid one", () => {
    const parsed = parseArtifactBytes(JSON.stringify(validArtifact({ layers: [], comments: [] })));

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }
    expect(parsed.artifact.repo).toBe("/repos/app");
    expect(parsed.artifact.comments).toEqual([]);
    expect(parsed.artifact.layers).toEqual([]);
  });
});

describe("repoDisplayName", () => {
  // The recents list names a repo beside the tab that opening it produces, so both call
  // this rather than each deriving the name — including the fallback, which used to be a
  // hand-written `|| artifact.repo` at the list's call site.
  it("is the last non-empty segment of the work-tree toplevel", () => {
    expect(repoDisplayName("/repos/app")).toBe("app");
    expect(repoDisplayName("/repos/app/")).toBe("app");
    expect(repoDisplayName("/repos//app")).toBe("app");
  });

  it("answers with the path itself when it has no segment to take", () => {
    expect(repoDisplayName("/")).toBe("/");
    expect(repoDisplayName("")).toBe("");
  });
});
