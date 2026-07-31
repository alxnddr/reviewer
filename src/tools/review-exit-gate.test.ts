import { describe, expect, it } from "vitest";
import {
  importReview,
  reviewDiffFor,
  type ReviewArtifact,
  type ReviewLayerDraft,
  type ReviewStamp,
} from "../shared/review";
import { TWO_FILE_PATCH } from "../shared/diff/fixtures";
import { parsePatch } from "../shared/diff/patch";
import { buildCommentItems, type CommentUiState } from "../shared/diff/comment-annotations";

// The one claim about a **frozen** artifact nothing else composes: bytes that carry their own
// diff, read through the app's whole open path (importReview → reviewDiffFor →
// buildCommentItems), render with every anchor on its authored line. The CLI never emits one —
// `rvw emit` writes refs-only unless asked — so the frozen pin is the path with no gate of its
// own in front of it, and an artifact imported from elsewhere is exactly the case that would
// otherwise go unproven end to end.
//
// The exit gate proper is `cli/exit-gate.test.ts`, which spawns `node dist/rvw.js` against a
// foreign repo with the draft on stdin — the only thing that proves the *shipped bundle*
// works, and the reason this file no longer re-composes the same claim in-process. The
// remaining pieces are each proven where they live: the pre-handoff gate in
// `review-emit.test.ts`, the derived render and its outdated pinning in
// `shared/diff/comment-annotations.test.ts`, the flattening in `shared/review.test.ts`.

const SOURCE = { repo: "/repo", base: "main", head: "feature" } as const;

const FOO_COMMENT: ReviewArtifact["comments"][number] = {
  file: "src/foo.ts",
  side: "additions",
  startLine: 11,
  endLine: 13,
  body: "why foo",
};
const BAR_COMMENT: ReviewArtifact["comments"][number] = {
  file: "src/bar.ts",
  side: "additions",
  startLine: 2,
  endLine: 2,
  body: "why bar",
};
const LAYERS: ReviewLayerDraft[] = [
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

/** Deterministic identity so importReview stays reproducible: the app assigns these
 * on open (crypto.randomUUID + wall clock); the test pins them. */
function stamp(): ReviewStamp {
  let n = 0;
  return { newId: () => `id-${(n += 1)}` };
}

const UI: CommentUiState = { editingId: null, draft: null };

/** The comment annotation the app's render path (buildCommentItems) produced for a
 * file+line: `lineNumber` is the placed line (0 = pinned to the file header), and
 * `outdated` is the resolver verdict CodeView renders. */
function annotationFor(
  items: ReturnType<typeof buildCommentItems>,
  file: string,
): { lineNumber: number; outdated: boolean } {
  const item = items.find((candidate) => candidate.id === file);
  const annotation = item?.annotations?.[0];
  if (annotation === undefined || annotation.metadata.kind !== "comment") {
    throw new Error(`no comment annotation for ${file}`);
  }
  return { lineNumber: annotation.lineNumber, outdated: annotation.metadata.outdated };
}

describe("an imported frozen artifact", () => {
  it("renders verbatim, every anchor placed by passthrough", () => {
    // A hand-authored artifact on the wire whose bytes embed the diff — the shape the CLI
    // never writes and an import from elsewhere may still carry.
    const bytes = JSON.stringify({
      ...SOURCE,
      patch: TWO_FILE_PATCH,
      comments: [FOO_COMMENT, BAR_COMMENT],
      layers: LAYERS,
    });

    const imported = importReview(bytes, stamp());
    expect(imported.ok).toBe(true);
    if (!imported.ok) return;
    expect(reviewDiffFor(imported.review).kind).toBe("frozenPatch");

    const files = parsePatch(imported.review.patch ?? "", "exit-gate");
    const frozen = buildCommentItems(files, imported.review.comments, UI, true);
    expect(annotationFor(frozen, "src/foo.ts")).toEqual({ lineNumber: 11, outdated: false });
    expect(annotationFor(frozen, "src/bar.ts")).toEqual({ lineNumber: 2, outdated: false });
  });
});
