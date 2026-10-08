import { describe, expect, it } from "vitest";
import {
  ARTIFACT_JSON_FORMAT,
  artifactPath,
  Comment,
  importReview,
  isWholeFileRange,
  parseArtifactBytes,
  pinReview,
  repoDisplayName,
  reservedTag,
  ReviewAnchor,
  ReviewArtifact,
  ReviewComment,
  ReviewLayerInput,
  ReviewLayerRange,
  ReviewOrigin,
  ReviewOverview,
  reviewOriginFor,
  ReviewVisual,
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
    // The locator is `artifactPath` — positions from 1, marked `#`, as every report counts
    // them — so the reader can find the one place in the file that has to change.
    expect(result.reason).toContain("comments#1.side");
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

describe("pinReview", () => {
  // The whole availability rule as a table: what this machine has (the check main ran) against
  // whether the artifact carries a patch.
  const AUTHORED = { path: "/home/box/app", name: "app" };
  const LOCAL = { path: "/work/app", name: "app" };
  const PATCH = "diff --git a/src/a.ts b/src/a.ts\n";
  const withPatch = {
    repo: AUTHORED,
    base: "main",
    head: SHA_40,
    patch: PATCH,
    reviewedHead: null,
    pr: null,
  };
  const refsOnly = { ...withPatch, patch: null };
  const REFS = { kind: "refs", base: "main", head: SHA_40 };
  const FROZEN = { kind: "frozenPatch", patch: PATCH };
  const NOT_A_REPO = { code: "notARepo", path: AUTHORED.path } as const;

  it("goes live whenever the repo and refs are here, whether or not a patch rides along", () => {
    for (const origin of [withPatch, refsOnly]) {
      expect(pinReview(origin, { kind: "live", repo: LOCAL })).toEqual({
        ok: true,
        repo: LOCAL,
        reviewDiff: REFS,
      });
    }
  });

  it("opens off the patch when the repo is not here, keeping the authored path as its label", () => {
    expect(pinReview(withPatch, { kind: "repoMissing", failure: NOT_A_REPO })).toEqual({
      ok: true,
      repo: AUTHORED,
      reviewDiff: FROZEN,
    });
  });

  it("opens off the patch on a checkout that lacks the refs, or whose refs spell another diff", () => {
    const expected = { ok: true, repo: LOCAL, reviewDiff: FROZEN };
    expect(pinReview(withPatch, { kind: "refsMissing", repo: LOCAL, missing: [SHA_40] })).toEqual(
      expected,
    );
    expect(pinReview(withPatch, { kind: "patchDiffers", repo: LOCAL })).toEqual(expected);
  });

  it("fails a refs-only review with no repo here, carrying git's own reason", () => {
    expect(pinReview(refsOnly, { kind: "repoMissing", failure: NOT_A_REPO })).toEqual({
      ok: false,
      failure: { code: "repoUnavailable", reason: NOT_A_REPO },
    });
  });

  it("fails a refs-only review whose refs are missing, naming them", () => {
    expect(pinReview(refsOnly, { kind: "refsMissing", repo: LOCAL, missing: [SHA_40] })).toEqual({
      ok: false,
      failure: { code: "refsUnavailable", missing: [SHA_40] },
    });
  });

  it("counts an empty embedded patch as no patch at all", () => {
    expect(
      pinReview({ ...withPatch, patch: "" }, { kind: "repoMissing", failure: NOT_A_REPO }).ok,
    ).toBe(false);
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

describe("the comment vocabulary", () => {
  const anchor = { file: "src/a.ts", side: "additions", startLine: 10, endLine: 12 } as const;

  it("admits a comment carrying none of the three — the shape every review before them had", () => {
    expect(ReviewComment.safeParse({ ...anchor, body: "why" }).success).toBe(true);
  });

  it("parses all three and leaves an absent one absent rather than defaulted", () => {
    const parsed = ReviewComment.parse({
      ...anchor,
      body: "why",
      tag: "perf",
      severity: "blocking",
    });
    expect(parsed.tag).toBe("perf");
    expect(parsed.severity).toBe("blocking");
    // Not "" and not "minor": an unset field is unset, which is what lets a renderer draw
    // nothing rather than a pill the author never asked for.
    expect(parsed.evidence).toBeUndefined();
    expect("evidence" in parsed).toBe(false);
  });

  it("refuses an over-long tag at the tag, so `rvw emit` can name the field to fix", () => {
    const parsed = ReviewComment.safeParse({ ...anchor, body: "why", tag: "x".repeat(25) });
    expect(parsed.success).toBe(false);
    expect(parsed.success ? [] : parsed.error.issues.map((issue) => issue.path)).toEqual([["tag"]]);
  });

  it("refuses a severity outside the closed three rather than dropping it", () => {
    // The whole point of the closed axis: a review that writes `P0` is told so at emit,
    // instead of shipping an artifact whose severity silently vanished.
    const parsed = ReviewComment.safeParse({ ...anchor, body: "why", severity: "P0" });
    expect(parsed.success).toBe(false);
    expect(parsed.success ? [] : parsed.error.issues.map((issue) => issue.path)).toEqual([
      ["severity"],
    ]);
  });

  it("refuses an empty tag, evidence or postable — an absent key is how you say you have none", () => {
    expect(ReviewComment.safeParse({ ...anchor, body: "why", tag: "" }).success).toBe(false);
    expect(ReviewComment.safeParse({ ...anchor, body: "why", evidence: "" }).success).toBe(false);
    expect(ReviewComment.safeParse({ ...anchor, body: "why", postable: "" }).success).toBe(false);
  });

  it("parses postable beside the body, and leaves it absent on a comment that has none", () => {
    const parsed = ReviewComment.parse({ ...anchor, body: "why", postable: "for the author" });
    expect(parsed.postable).toBe("for the author");
    expect("postable" in ReviewComment.parse({ ...anchor, body: "why" })).toBe(false);
  });

  it("keeps the three off ReviewAnchor, which the validator and coverage report on", () => {
    // `AnchorSpan` is four fields and must stay four: a layer range is an anchor too, and
    // nothing in the gate or the coverage report should learn what a tag is.
    expect(Object.keys(ReviewAnchor.parse(anchor))).toEqual([
      "file",
      "side",
      "startLine",
      "endLine",
    ]);
  });

  it("matches the three reserved words case-insensitively, and nothing else", () => {
    expect(reservedTag("pre-existing")).toBe("pre-existing");
    expect(reservedTag("Decision")).toBe("decision");
    expect(reservedTag("  QUESTION ")).toBe("question");
    expect(reservedTag("perf")).toBeNull();
    expect(reservedTag("pre existing")).toBeNull();
    expect(reservedTag(undefined)).toBeNull();
  });
});

describe("a layer range's note", () => {
  const anchor = { file: "src/a.ts", side: "additions", startLine: 10, endLine: 20 } as const;

  it("parses on a layer range and rides through the artifact untouched", () => {
    const artifact = ReviewArtifact.parse(
      validArtifact({
        layers: [{ label: "Wire the library", ranges: [{ ...anchor, note: "the contract" }] }],
      }),
    );
    expect(artifact.layers[0]?.ranges[0]?.note).toBe("the contract");
  });

  it("is dropped from a comment rather than admitted — a comment already has a body", () => {
    // The field is `.extend()`ed onto the layer range alone, so a note written on a comment
    // is an unknown key on a plain object: dropped, exactly like any other typo there. The
    // point is that no second place to write prose about a finding comes into existence.
    const parsed = ReviewComment.parse({ ...anchor, body: "why", note: "not a place for this" });
    expect("note" in parsed).toBe(false);
  });

  it("leaves ReviewAnchor itself at four fields — the type every locator is reported as", () => {
    // `AnchorSpan` is what the validator's problems and coverage's uncovered spans are, and
    // neither has any business carrying a sentence. Pinned separately from the comment
    // vocabulary's copy of this assertion because a note is the field most likely to be
    // "simplified" up onto the anchor by someone who has just read the layer schema.
    expect(Object.keys(ReviewAnchor.parse(anchor))).toEqual([
      "file",
      "side",
      "startLine",
      "endLine",
    ]);
  });

  it("refuses an over-long note at the note, so `rvw emit` can name the field to fix", () => {
    const parsed = ReviewLayerRange.safeParse({ ...anchor, note: "x".repeat(121) });
    expect(parsed.success).toBe(false);
    expect(parsed.success ? [] : parsed.error.issues.map((issue) => issue.path)).toEqual([
      ["note"],
    ]);
  });

  it("refuses an empty note — an absent key is how you say you have none", () => {
    expect(ReviewLayerRange.safeParse({ ...anchor, note: "" }).success).toBe(false);
    expect(ReviewLayerRange.parse(anchor).note).toBeUndefined();
  });
});

describe("a whole-file layer range", () => {
  const messages = (input: unknown): string[] => {
    const parsed = ReviewLayerRange.safeParse(input);
    return parsed.success ? [] : parsed.error.issues.map((issue) => issue.message);
  };

  it("is a file alone, persisted as written — no side or lines are invented for it", () => {
    const range = ReviewLayerRange.parse({ file: "src/a.ts", note: "all of it" });
    expect(range).toEqual({ file: "src/a.ts", note: "all of it" });
    expect(isWholeFileRange(range)).toBe(true);
    const line = ReviewLayerRange.parse({
      file: "src/a.ts",
      side: "additions",
      startLine: 1,
      endLine: 2,
    });
    expect(isWholeFileRange(line)).toBe(false);
  });

  it("refuses a line range missing a key instead of reading it as the whole file", () => {
    // The failure the shape is built against: `{ file, side, startLine }` passing as a
    // whole-file claim would silently widen a range the author meant to be three lines.
    expect(
      ReviewLayerRange.safeParse({ file: "a.ts", side: "additions", startLine: 3 }).success,
    ).toBe(false);
    expect(messages({ file: "a.ts", side: "additions", startLine: 3 })[0]).toContain("endLine");
    expect(messages({ file: "a.ts", startLine: 3 })[0]).toContain("line range");
  });

  it("still reports a bad value at its field, whichever form it is", () => {
    const at = (input: unknown) => {
      const parsed = ReviewLayerRange.safeParse(input);
      return parsed.success ? [] : parsed.error.issues.map((issue) => issue.path);
    };
    expect(at({ file: "a.ts", note: "x".repeat(121) })).toEqual([["note"]]);
    expect(at({ file: "a.ts", side: "additions", startLine: 5, endLine: 2 })).toEqual([
      ["endLine"],
    ]);
  });

  it("mixes with line ranges in one layer and survives import into the in-app layer", () => {
    const review = importReview(
      JSON.stringify(
        validArtifact({
          layers: [
            {
              label: "Own one file, share another",
              ranges: [
                { file: "src/a.ts" },
                { file: "src/b.ts", side: "additions", startLine: 1, endLine: 4 },
              ],
            },
          ],
        }),
      ),
      fixedStamp(),
    );
    expect(review.ok ? review.review.layers[0]?.ranges : null).toEqual([
      { file: "src/a.ts" },
      { file: "src/b.ts", side: "additions", startLine: 1, endLine: 4 },
    ]);
  });
});

describe("the overview verdict", () => {
  const overview = { title: "Back off per host", body: "why it is shaped this way" };

  it("parses the three words and refuses a fourth", () => {
    for (const verdict of ["ready", "caution", "blocked"]) {
      expect(ReviewOverview.parse({ ...overview, verdict }).verdict).toBe(verdict);
    }
    // Not a score, and not somebody else's vocabulary: an artifact that writes one is told
    // so at emit rather than opening with the claim silently gone.
    expect(ReviewOverview.safeParse({ ...overview, verdict: "approved" }).success).toBe(false);
    expect(ReviewOverview.safeParse({ ...overview, verdict: 4 }).success).toBe(false);
  });

  it("is optional, and absent stays absent", () => {
    const parsed = ReviewOverview.parse(overview);
    expect(parsed.verdict).toBeUndefined();
    expect("verdict" in parsed).toBe(false);
  });

  it("reaches the imported review verbatim — the app derives nothing about it", () => {
    const result = importReview(
      JSON.stringify(validArtifact({ overview: { ...overview, verdict: "caution" } })),
      fixedStamp(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    // The doc rides through import untouched, like `patch` and the refs beside it: the one
    // authored judgement in the artifact is never recomputed, re-derived or defaulted.
    expect(result.review.overview?.verdict).toBe("caution");
  });

  it("drops an unknown key rather than refusing the doc — how an older build reads one", () => {
    // `ReviewOverview` is a plain `z.object`, unlike `ReviewArtifact` and `ReviewLayerInput`,
    // and that is the whole compatibility story for this field: a build that predates the
    // verdict opens a review carrying one and simply does not show it, where the same
    // artifact carrying `skim` or `reviewedHead` would be refused outright. Asserted with a
    // key no schema will ever know, so the claim stays true once `verdict` is old news.
    const parsed = ReviewOverview.parse({ ...overview, fromTheFuture: "a later field" });
    expect("fromTheFuture" in parsed).toBe(false);
  });
});

describe("the pull request a review is of", () => {
  const PR = { host: "github.com", owner: "acme", repo: "widgets", number: 42 } as const;

  it("parses on the artifact and reaches the imported review and its origin verbatim", () => {
    const result = importReview(JSON.stringify(validArtifact({ pr: PR })), fixedStamp());
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.review.pr).toEqual(PR);
    // The origin is what the session keeps of the artifact, and the card's GitHub link and
    // the export both read the pull request from there.
    expect(reviewOriginFor(result.review).pr).toEqual(PR);
  });

  it("models an artifact that names none as null, never undefined", () => {
    const result = importReview(JSON.stringify(validArtifact()), fixedStamp());
    expect(result.ok && result.review.pr).toBe(null);
  });

  it("refuses a host it does not know, a bad owner, and a number that is not a PR's", () => {
    for (const pr of [
      { ...PR, host: "gitlab.com" },
      { ...PR, owner: "../etc" },
      { ...PR, repo: ".." },
      { ...PR, number: 0 },
      { ...PR, number: 1.5 },
    ]) {
      expect(ReviewArtifact.safeParse(validArtifact({ pr })).success).toBe(false);
    }
  });

  it("parses a persisted origin from before the field, as one that names no pull request", () => {
    // `.default(null)`, the `reviewedHead` precedent: a session written by an older build has
    // no `pr` key, and must still parse strictly rather than lose its whole origin.
    const origin = ReviewOrigin.parse({
      repo: { path: "/repos/app", name: "app" },
      base: "main",
      head: SHA_40,
      patch: null,
    });
    expect(origin.pr).toBe(null);
    expect(origin.reviewedHead).toBe(null);
  });
});

describe("the guide: lede, steps and visuals", () => {
  const at = { file: "src/a.ts", side: "additions", startLine: 10, endLine: 12 } as const;
  const flow = {
    kind: "flow",
    caption: "How a share reaches a thread",
    nodes: [
      { id: "main", label: "MainActivity", status: "same" },
      { id: "take-share", label: "takeShare()", status: "added", note: "new entry", at },
    ],
    edges: [{ from: "main", to: "take-share", label: "intent" }],
  } as const;
  const skeleton = {
    kind: "skeleton",
    caption: "How a blob read reaches the network",
    lines: [
      { depth: 0, code: "loadBlob(path)", status: "same" },
      { depth: 1, code: "withRetry(() => fetchBlob(path))", status: "added", at },
    ],
  } as const;

  it("makes body optional: an overview may be a title and the guide's front alone", () => {
    const parsed = ReviewOverview.parse({
      title: "Share to a thread",
      lede: "Shared content reaches a thread on both platforms.",
      steps: ["Register the intent", "Stage and upload"],
      visual: flow,
    });
    expect(parsed.body).toBeUndefined();
    expect(parsed.steps).toHaveLength(2);
    // An overview written to the old contract — a body and nothing else — still parses.
    expect(ReviewOverview.safeParse({ title: "t", body: "b" }).success).toBe(true);
  });

  it("refuses a lede or step that breaks a line, and a step count outside 2 to 5", () => {
    expect(ReviewOverview.safeParse({ title: "t", lede: "one\ntwo" }).success).toBe(false);
    expect(ReviewOverview.safeParse({ title: "t", steps: ["a\r\nb", "c"] }).success).toBe(false);
    expect(ReviewOverview.safeParse({ title: "t", steps: ["only"] }).success).toBe(false);
    expect(
      ReviewOverview.safeParse({ title: "t", steps: ["1", "2", "3", "4", "5", "6"] }).success,
    ).toBe(false);
  });

  it("refuses a layer summary that breaks a line — it is set inline, like a step", () => {
    expect(ReviewLayerInput.safeParse({ label: "l", summary: "Reads `x` now" }).success).toBe(true);
    expect(ReviewLayerInput.safeParse({ label: "l", summary: "one\ntwo" }).success).toBe(false);
  });

  it("parses both kinds and refuses a third — the union is closed", () => {
    expect(ReviewVisual.parse(flow).kind).toBe("flow");
    expect(ReviewVisual.parse(skeleton).kind).toBe("skeleton");
    expect(ReviewVisual.safeParse({ ...flow, kind: "chart" }).success).toBe(false);
    // A skeleton line is a line: it is added, removed or the same, never "changed".
    const changedLine = {
      ...skeleton,
      lines: [skeleton.lines[0], { ...skeleton.lines[1], status: "changed" }],
    };
    expect(ReviewVisual.safeParse(changedLine).success).toBe(false);
  });

  it("holds the drawn limits: node count, label length, slug ids, depth", () => {
    const node = flow.nodes[0];
    const nodes = (count: number) =>
      Array.from({ length: count }, (_, i) => ({ ...node, id: `n${i}` }));
    expect(ReviewVisual.safeParse({ ...flow, nodes: nodes(1) }).success).toBe(false);
    expect(ReviewVisual.safeParse({ ...flow, nodes: nodes(14) }).success).toBe(true);
    expect(ReviewVisual.safeParse({ ...flow, nodes: nodes(15) }).success).toBe(false);
    expect(
      ReviewVisual.safeParse({ ...flow, nodes: [{ ...node, label: "x".repeat(41) }, node] })
        .success,
    ).toBe(false);
    expect(
      ReviewVisual.safeParse({ ...flow, nodes: [{ ...node, id: "two words" }, node] }).success,
    ).toBe(false);
    const deep = { ...skeleton, lines: [{ ...skeleton.lines[0], depth: 7 }, skeleton.lines[1]] };
    expect(ReviewVisual.safeParse(deep).success).toBe(false);
  });

  it("carries a layer's visual and focus through the flatten, absent staying absent", () => {
    const result = importReview(
      JSON.stringify(
        validArtifact({
          overview: { title: "t", lede: "One sentence.", visual: flow },
          layers: [
            { label: "Pictured", ranges: [at], visual: skeleton, focus: at },
            { label: "Plain", ranges: [at] },
          ],
        }),
      ),
      fixedStamp(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const [pictured, plain] = result.review.layers;
    expect(pictured?.visual).toEqual(skeleton);
    expect(pictured?.focus).toEqual(at);
    expect(plain !== undefined && ("visual" in plain || "focus" in plain)).toBe(false);
    expect(result.review.overview?.visual).toEqual(flow);
    expect(result.review.overview?.lede).toBe("One sentence.");
  });

  it("refuses a stray key on a layer but drops one inside a visual — the reader's leniency", () => {
    // The layer is a strictObject; a visual's objects are plain, so a node from a newer build
    // opens here without its unknown key. `rvw emit` refuses the same key from an author.
    expect(
      ReviewArtifact.safeParse(validArtifact({ layers: [{ label: "x", ranges: [at], focal: at }] }))
        .success,
    ).toBe(false);
    const future = { ...flow, nodes: [{ ...flow.nodes[0], shape: "hexagon" }, flow.nodes[1]] };
    const parsed = ReviewVisual.parse(future);
    expect(parsed.kind === "flow" && "shape" in (parsed.nodes[0] ?? {})).toBe(false);
  });
});

describe("artifactPath", () => {
  it("counts positions from 1 and marks them, as every other locator in a report does", () => {
    expect(artifactPath(["layers", 1, "children", 0, "ranges", 2, "startLine"])).toBe(
      "layers#2.children#1.ranges#3.startLine",
    );
    expect(artifactPath(["overview", "steps", 0])).toBe("overview.steps#1");
    expect(artifactPath([])).toBe("");
  });

  it("quotes a key that is not a plain identifier, so a dot in one names one place", () => {
    expect(artifactPath(["overview", "a.b", "c"])).toBe('overview["a.b"].c');
    expect(artifactPath(["my key"])).toBe('["my key"]');
  });
});
