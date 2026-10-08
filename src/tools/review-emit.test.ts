import { describe, expect, it } from "vitest";
import { ReviewArtifact } from "../shared/review";
import { TWO_FILE_PATCH } from "../shared/diff/fixtures";
import { parseReviewArtifact, validatePlacement } from "./review-validator";
import {
  emitReviewArtifact,
  postableGap,
  postableGapLine,
  unlinkedPostableLine,
  type EmitInput,
} from "./review-emit";

const COMMENTS = [
  { file: "src/foo.ts", side: "additions", startLine: 11, endLine: 13, body: "why" },
];
const LAYERS = [
  {
    label: "Rollup",
    summary: "parent",
    children: [
      {
        label: "Leaf",
        summary: "child",
        description: "Adds [bar](src/bar.ts).",
        ranges: [{ file: "src/bar.ts", side: "additions", startLine: 2, endLine: 2 }],
      },
    ],
  },
];

function input(overrides: Partial<EmitInput> = {}): EmitInput {
  return {
    repo: "/repo",
    base: "main",
    head: "feature",
    patch: TWO_FILE_PATCH,
    comments: COMMENTS,
    layers: LAYERS,
    ...overrides,
  };
}

describe("emitReviewArtifact", () => {
  it("writes the reviewed head through, and changes nothing about the gate by doing it", () => {
    // `reviewedHead` is provenance and nothing else. The proof that it is inert is that the
    // gate's verdict and the placement of every anchor are byte-for-byte what they were
    // without it — so the only difference between the two artifacts is the one key.
    const plain = emitReviewArtifact(input());
    const stamped = emitReviewArtifact(input({ reviewedHead: "c".repeat(40) }));
    expect(plain.ok && stamped.ok).toBe(true);
    if (!plain.ok || !stamped.ok) return;

    const parsed = parseReviewArtifact(stamped.bytes);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.artifact.reviewedHead).toBe("c".repeat(40));
    expect(validatePlacement(parsed.artifact, TWO_FILE_PATCH)).toEqual([]);

    // The same bytes with that one line removed.
    const withoutKey = JSON.parse(stamped.bytes) as Record<string, unknown>;
    delete withoutKey.reviewedHead;
    expect(withoutKey).toEqual(JSON.parse(plain.bytes));
  });

  it("omits the reviewed head when the caller has no sha to offer", () => {
    const result = emitReviewArtifact(input());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.bytes).not.toContain("reviewedHead");
  });

  it("gates a skim layer exactly like any other: its ranges must still place", () => {
    // The mark changes how the app *renders* a chapter, never what the gate asks of it.
    // Marking a layer skim must not become a way to smuggle an anchor that does not place —
    // and, below, must not shrink what coverage demands either.
    const skimmed = emitReviewArtifact(
      input({
        layers: [
          {
            label: "Lockfiles",
            skim: true,
            ranges: [{ file: "src/bar.ts", side: "additions", startLine: 2, endLine: 2 }],
          },
        ],
      }),
    );
    expect(skimmed.ok).toBe(true);
    if (!skimmed.ok) return;
    expect(JSON.parse(skimmed.bytes).layers[0]).toMatchObject({ skim: true });

    const misplaced = emitReviewArtifact(
      input({
        layers: [
          {
            label: "Lockfiles",
            skim: true,
            ranges: [{ file: "src/bar.ts", side: "additions", startLine: 900, endLine: 900 }],
          },
        ],
      }),
    );
    expect(misplaced.ok).toBe(false);
  });

  it("assembles a refs-only artifact whose anchors place against the captured diff", () => {
    const result = emitReviewArtifact(input());
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const parsed = parseReviewArtifact(result.bytes);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    // Refs-only: the artifact carries no embedded patch — the app re-derives the diff
    // from the recorded repo/refs on open, and re-validation places against that captured
    // diff, not stored bytes.
    expect(parsed.artifact.patch).toBeUndefined();
    expect(validatePlacement(parsed.artifact, TWO_FILE_PATCH)).toEqual([]);

    const artifact = ReviewArtifact.parse(JSON.parse(result.bytes));
    expect(artifact.repo).toBe("/repo");
    expect(artifact.base).toBe("main");
    expect(artifact.head).toBe("feature");
    // The authored nesting is emitted as authored — the CLI never flattens or re-sorts.
    expect(artifact.layers).toHaveLength(1);
    expect(artifact.layers[0]?.children.map((child) => child.label)).toEqual(["Leaf"]);
    expect(artifact.comments[0]?.side).toBe("additions");
  });

  it("emits a comments-only draft, and a layers-only one, without either placeholder key", () => {
    // A draft that carries only one half writes only that half: `JSON.stringify` drops the
    // undefined, and the schema defaults the absent key to empty.
    const commentsOnly = emitReviewArtifact(input({ layers: undefined }));
    expect(commentsOnly.ok).toBe(true);
    if (!commentsOnly.ok) return;
    expect(JSON.parse(commentsOnly.bytes)).not.toHaveProperty("layers");

    const layersOnly = emitReviewArtifact(input({ comments: undefined }));
    expect(layersOnly.ok).toBe(true);
    if (!layersOnly.ok) return;
    expect(JSON.parse(layersOnly.bytes)).not.toHaveProperty("comments");
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
      nearestHunks: [{ startLine: 10, endLine: 14 }],
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
      expect.objectContaining({ kind: "schema", path: "comments[0].side" }),
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
      expect.objectContaining({ kind: "schema", path: "comments[0].endLine" }),
    );
  });

  it("refuses handoff — no bytes — on an unresolved description link", () => {
    const result = emitReviewArtifact(
      input({
        layers: [
          {
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
      site: { at: "layer", layer: "1" },
      label: "ghost",
      url: "does/not/exist.ts",
      path: "does/not/exist.ts",
    });
  });
});

describe("emitReviewArtifact — carrying the diff", () => {
  it("embeds the captured patch verbatim when asked, so the artifact needs no repo", () => {
    const result = emitReviewArtifact(input({ embedPatch: true }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const artifact = ReviewArtifact.parse(JSON.parse(result.bytes));
    // Verbatim, not re-serialized: the app renders an embedded patch as-is, so a byte that
    // changed here would be a line the reader sees differently from the one that was gated.
    expect(artifact.patch).toBe(TWO_FILE_PATCH);
    // And the anchors still place — against the very bytes the file now carries, which is
    // the stronger of the two checks, not a weaker one.
    expect(validatePlacement(artifact, artifact.patch ?? "")).toEqual([]);
  });

  it("still omits the key by default, so the ordinary artifact stays refs-only", () => {
    const result = emitReviewArtifact(input());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(ReviewArtifact.parse(JSON.parse(result.bytes)).patch).toBeUndefined();
  });

  it("refuses to write an empty patch as an embedded one — it would freeze an empty diff", () => {
    // An empty capture cannot be embedded: the schema's `patch` is a non-empty string, and
    // `reviewDiffFor` would fall through to the refs form anyway, so writing it would only
    // promise a portability the file cannot keep. The gate then refuses the artifact on its
    // own terms — anchors cannot place against no diff — which is the correct outcome; what
    // matters here is that the failure is the empty *range*, not an invalid artifact shape.
    const result = emitReviewArtifact(input({ patch: "", embedPatch: true }));
    expect(result.ok).toBe(false);
  });

  it("leaves everything else about the artifact untouched", () => {
    const refs = emitReviewArtifact(input());
    const embedded = emitReviewArtifact(input({ embedPatch: true }));
    expect(refs.ok && embedded.ok).toBe(true);
    if (!refs.ok || !embedded.ok) return;

    const { patch, ...withoutPatch } = ReviewArtifact.parse(JSON.parse(embedded.bytes));
    expect(patch).toBeDefined();
    expect(withoutPatch).toEqual(ReviewArtifact.parse(JSON.parse(refs.bytes)));
  });
});

describe("emitReviewArtifact — the pull request", () => {
  const PR = { host: "github.com", owner: "acme", repo: "widgets", number: 42 } as const;

  it("writes the pull request through, and changes nothing about the gate by doing it", () => {
    // Provenance, like `reviewedHead`: the only difference it makes to the artifact is its key.
    const plain = emitReviewArtifact(input());
    const linked = emitReviewArtifact(input({ pr: PR }));
    expect(plain.ok && linked.ok).toBe(true);
    if (!plain.ok || !linked.ok) return;

    expect(linked.artifact.pr).toEqual(PR);
    expect(plain.bytes).not.toContain('"pr"');
    const withoutKey = JSON.parse(linked.bytes) as Record<string, unknown>;
    delete withoutKey.pr;
    expect(withoutKey).toEqual(JSON.parse(plain.bytes));
  });

  it("hands back the artifact its bytes parse to, so the shell reports off validated values", () => {
    const result = emitReviewArtifact(input());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.artifact).toEqual(ReviewArtifact.parse(JSON.parse(result.bytes)));
  });
});

describe("postableGap", () => {
  const anchor = { file: "src/foo.ts", side: "additions", startLine: 11, endLine: 13 } as const;

  it("counts the comments with no text for the change's author, out of all of them", () => {
    const artifact = ReviewArtifact.parse({
      repo: "/repo",
      base: "main",
      head: "feature",
      comments: [
        { ...anchor, body: "one", postable: "Could this say why?" },
        { ...anchor, body: "two" },
        { ...anchor, body: "three" },
      ],
    });
    expect(postableGap(artifact)).toEqual({ missing: 2, total: 3 });
  });

  it("counts a whitespace-only postable as missing, as the app reads it", () => {
    const artifact = ReviewArtifact.parse({
      repo: "/repo",
      base: "main",
      head: "feature",
      comments: [{ ...anchor, body: "one", postable: "  \n " }],
    });
    expect(postableGap(artifact)).toEqual({ missing: 1, total: 1 });
  });

  it("answers zero of zero for a review with no comments", () => {
    const artifact = ReviewArtifact.parse({ repo: "/repo", base: "main", head: "feature" });
    expect(postableGap(artifact)).toEqual({ missing: 0, total: 0 });
  });
});

describe("postableGapLine", () => {
  it("agrees the verb with the comments that have none, and the noun with all of them", () => {
    expect(postableGapLine({ missing: 3, total: 7 })).toBe("3 of 7 comments have no postable text");
    expect(postableGapLine({ missing: 1, total: 7 })).toBe("1 of 7 comments has no postable text");
    expect(postableGapLine({ missing: 1, total: 1 })).toBe("1 of 1 comment has no postable text");
  });
});

describe("unlinkedPostableLine", () => {
  it("counts the comments that do carry postable text, the verb agreeing with that count", () => {
    expect(unlinkedPostableLine({ missing: 1, total: 3 })).toBe(
      "2 of 3 comments have postable text, but no --pr names the pull request — pass --pr so the app can link and post it",
    );
    expect(unlinkedPostableLine({ missing: 2, total: 3 })).toMatch(
      /^1 of 3 comments has postable/u,
    );
  });

  it("says nothing when no comment carries any", () => {
    expect(unlinkedPostableLine({ missing: 3, total: 3 })).toBeNull();
    expect(unlinkedPostableLine({ missing: 0, total: 0 })).toBeNull();
  });
});
