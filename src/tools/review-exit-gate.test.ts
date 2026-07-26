import { describe, expect, it } from "vitest";
import {
  importReview,
  reviewDiffFor,
  type ReviewArtifact,
  type ReviewStamp,
} from "../shared/review";
import { parsePatch } from "../renderer/src/lib/diff/patch";
import {
  buildCommentItems,
  type CommentUiState,
} from "../renderer/src/lib/diff/comment-annotations";
import { emitReviewArtifact } from "./review-emit";
import { parseReviewArtifact, validatePlacement, type ValidationProblem } from "./review-validator";

// The exit gate composed as one test: skill (emitReviewArtifact) → placement check
// (parseReviewArtifact + validatePlacement) → the app's own open + render path (importReview,
// reviewDiffFor, buildCommentItems). It invents no schema, code, or copy — it wires the shipped
// pieces together and asserts the guarantee it rests on: a skill-emitted refs-only artifact
// opens with every comment on its exact authored line and zero manual fixing, and a mis-anchored
// draft is caught before handoff — while the app's re-derivation path still degrades a drifted
// anchor to `outdated` pinned to the file header, never a crash or a silent mis-placement. Here
// the same paths run against a hermetic two-file patch so the gate is deterministic in CI — the
// emit gate validates against that patch, and the app re-derives the same range from git on open.
// A rare imported frozen artifact is exercised inline.

// `src/foo.ts` covers additions 10..14 (a same-side hunk over 11..13); `src/bar.ts`
// covers additions 1..3 (a hunk over line 2). Two files so the adversarial case can
// prove the corrupted comment degrades while its sibling still places.
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

const SOURCE: ReviewArtifact["source"] = {
  kind: "local",
  repo: { path: "/repo", name: "repo" },
  base: "main",
  head: "feature",
};

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
// The same comment drifted out of every hunk: the tamper the validator must catch and
// the app's re-derivation must flag outdated rather than mis-place.
const FOO_DRIFTED: ReviewArtifact["comments"][number] = {
  ...FOO_COMMENT,
  startLine: 9000,
  endLine: 9001,
};
const LAYERS: ReviewArtifact["layers"] = [
  { id: "rollup", label: "Rollup", summary: "parent", kind: "feature", ranges: [] },
  {
    id: "leaf",
    label: "Leaf",
    summary: "child",
    description: "Adds [bar](src/bar.ts).",
    kind: "validation",
    parent: "rollup",
    ranges: [{ file: "src/bar.ts", side: "additions", startLine: 2, endLine: 2 }],
  },
];

/** Deterministic identity so importReview stays reproducible: the app assigns these
 * on open (crypto.randomUUID + wall clock); the test pins them. */
function stamp(): ReviewStamp {
  let n = 0;
  return { newId: () => `id-${(n += 1)}` };
}

const UI: CommentUiState = { editingId: null, draft: null };

/** The exact bytes the skill hands over: emit + self-validate, exactly as the
 * `rvw emit` shell would write on a clean pass. */
function emittedBytes(): string {
  const result = emitReviewArtifact({
    repo: SOURCE.repo,
    base: SOURCE.base,
    head: SOURCE.head,
    patch: PATCH,
    comments: [FOO_COMMENT, BAR_COMMENT],
    layers: LAYERS,
  });
  if (!result.ok) {
    throw new Error(`fixture should emit clean: ${result.problems.map((p) => p.kind).join(", ")}`);
  }
  return result.bytes;
}

/** A hand-authored artifact on the wire — the shape a tamper or a validator-bypassing
 * caller produces. `patch` is omitted when null so `reviewDiffFor` falls to the `refs`
 * (re-derived) form, the path the app takes for a patch-less artifact. */
function artifactBytes(patch: string | null, comments: ReviewArtifact["comments"]): string {
  const artifact = {
    version: 1,
    source: SOURCE,
    ...(patch === null ? {} : { patch }),
    comments,
    layers: LAYERS,
  };
  return JSON.stringify(artifact);
}

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

function problemKinds(problems: ValidationProblem[]): string[] {
  return problems.map((problem) => problem.kind);
}

/** The gate the skill runs before handoff: parse the untrusted bytes, then place every anchor
 * against the captured diff — the exact `parseReviewArtifact` + `validatePlacement` composition
 * `rvw emit`/`rvw validate` run, returning the problems (empty when clean). */
function placementProblems(bytes: string, patch: string): ValidationProblem[] {
  const parsed = parseReviewArtifact(bytes);
  if (!parsed.ok) {
    return parsed.problems;
  }
  return validatePlacement(parsed.artifact, patch);
}

describe("exit gate: skill → validator → Reviewer", () => {
  it("a skill-emitted refs-only artifact validates and re-derives with every comment on its authored line", () => {
    const bytes = emittedBytes();

    // The gate clears it — the same parse + placement check the app anchors with, run before
    // handoff, against the captured diff.
    expect(placementProblems(bytes, PATCH)).toEqual([]);

    // The app opens it: importReview stamps identity, and because the artifact is refs-only
    // it carries no patch — the render pin is `refs`, re-derived from git.
    const imported = importReview(bytes, stamp());
    expect(imported.ok).toBe(true);
    if (!imported.ok) return;
    expect(imported.review.patch).toBeNull();
    expect(reviewDiffFor(imported.review).kind).toBe("refs");

    // buildCommentItems is exactly what Pierre's CodeView renders from. The diff the app
    // re-derives from git for the range is the one the anchors were authored against (here
    // PATCH); derived render: every comment lands on its authored line, none outdated.
    const files = parsePatch(PATCH, "exit-gate");
    const derived = buildCommentItems(files, imported.review.comments, UI, false);
    expect(annotationFor(derived, "src/foo.ts")).toEqual({ lineNumber: 11, outdated: false });
    expect(annotationFor(derived, "src/bar.ts")).toEqual({ lineNumber: 2, outdated: false });

    // Layers step in the authored order — the app re-sorts nothing.
    expect(imported.review.layers.map((layer) => layer.id)).toEqual(["rollup", "leaf"]);
  });

  it("still renders an imported frozen artifact verbatim, every anchor placed by passthrough", () => {
    // The CLI never emits a frozen patch, but the app must still render a rare imported one
    // verbatim. Construct one inline — bytes that embed the patch — and prove the
    // frozen render pin places every anchor unconditionally, off git.
    const imported = importReview(artifactBytes(PATCH, [FOO_COMMENT, BAR_COMMENT]), stamp());
    expect(imported.ok).toBe(true);
    if (!imported.ok) return;
    expect(reviewDiffFor(imported.review).kind).toBe("frozenPatch");

    const files = parsePatch(imported.review.patch ?? "", "exit-gate");
    const frozen = buildCommentItems(files, imported.review.comments, UI, true);
    expect(annotationFor(frozen, "src/foo.ts")).toEqual({ lineNumber: 11, outdated: false });
    expect(annotationFor(frozen, "src/bar.ts")).toEqual({ lineNumber: 2, outdated: false });
  });

  it("catches a mis-anchored draft before handoff, and the app's re-derivation flags the drift as outdated", () => {
    // 1) The primary guard: the emit gate refuses a drifted anchor before any bytes are written.
    // It places every anchor against the captured diff, so the drifted range surfaces with its
    // exact locator and the artifact never clears the gate.
    const refused = emitReviewArtifact({
      repo: SOURCE.repo,
      base: SOURCE.base,
      head: SOURCE.head,
      patch: PATCH,
      comments: [FOO_DRIFTED, BAR_COMMENT],
      layers: LAYERS,
    });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(problemKinds(refused.problems)).toContain("commentAnchorOutdated");
    expect(refused.problems).toContainEqual({
      kind: "commentAnchorOutdated",
      anchor: { file: "src/foo.ts", side: "additions", startLine: 9000, endLine: 9001 },
    });

    // 2) The app's fallback: a refs-only artifact is re-derived from git,
    // so the app takes the `refs` path and anchors resolve against that live diff. Force the
    // same drift through it — importReview never throws, the drifted comment keeps its anchor
    // and pins to the file header (lineNumber 0) flagged outdated, and its sibling still places.
    // No crash, no silent drop, no wrong-line placement.
    const imported = importReview(artifactBytes(null, [FOO_DRIFTED, BAR_COMMENT]), stamp());
    expect(imported.ok).toBe(true);
    if (!imported.ok) return;
    expect(reviewDiffFor(imported.review).kind).toBe("refs");

    // The diff the app re-derives from git for the range is the same one the embedded
    // patch froze; a drifted anchor no hunk covers is what surfaces as outdated.
    const files = parsePatch(PATCH, "exit-gate");
    const derived = buildCommentItems(files, imported.review.comments, UI, false);
    expect(annotationFor(derived, "src/foo.ts")).toEqual({ lineNumber: 0, outdated: true });
    expect(annotationFor(derived, "src/bar.ts")).toEqual({ lineNumber: 2, outdated: false });
  });
});
