import { describe, expect, it } from "vitest";
import { ReviewArtifact } from "../shared/review";
import { TWO_FILE_PATCH } from "../shared/diff/fixtures";
import { parseReviewArtifact, validatePlacement } from "./review-validator";
import { emitReviewArtifact, type EmitInput } from "./review-emit";

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
      layer: "1",
      label: "ghost",
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
