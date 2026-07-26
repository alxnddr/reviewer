import * as z from "zod";
import { ReviewRef, RepoInfo } from "./git";

// The review domain contract: `.reviewer.json` is the single integration
// point, defined here as zod schemas — the schema *is* the format, so every read
// of disk/CLI JSON is parsed, never trusted. Ref-bearing fields reuse the git.ts
// schemas so a tampered artifact can't smuggle a spawn arg past the same
// validation that guards a `git` child. The app assigns each comment an
// `id` on import; the wire comment is minimal.

/** The A/D side an anchor lives on — the wire word matches `@pierre/diffs`'
 * `AnnotationSide`, so a range maps straight onto a rendered hunk. */
export const ReviewSide = z.enum(["deletions", "additions"]);
export type ReviewSide = z.infer<typeof ReviewSide>;

const LineNumber = z.number().int().positive();

/** Kept together so the wire comment, the in-app comment, and a layer range
 * share one anchor definition — the Range shape is identical across comments and
 * layers, so anchoring and the outdated rule apply unchanged. */
const anchorShape = {
  file: z.string().min(1),
  side: ReviewSide,
  startLine: LineNumber,
  endLine: LineNumber,
};

type LineSpan = { startLine: number; endLine: number };

/** An inverted range is not a real anchor — reject it rather than represent it. */
const rangeIsAscending = (range: LineSpan): boolean => range.endLine >= range.startLine;
const ASCENDING_RANGE_RULE = "endLine must be greater than or equal to startLine";
const rangeError = { error: ASCENDING_RANGE_RULE };

/** Carried as schema metadata, not just a `.refine` predicate, because the ascending
 * rule compares two sibling fields — a shape no JSON Schema keyword can express. It
 * survives the serialization `rvw schema` derives from these schemas, so an agent
 * authoring against that output still reads the rule the parse enforces. */
const anchorDescription = `An anchor: file + side + line range. ${ASCENDING_RANGE_RULE}.`;

/** `file + side + line range` — the unit the anchoring resolver places
 * or flags outdated. Persisted as authored; the placed line is recomputed on
 * load, never stored (the session.ts inputs-not-derived precedent). */
export const ReviewAnchor = z
  .object(anchorShape)
  .refine(rangeIsAscending, rangeError)
  .meta({ description: anchorDescription });
export type ReviewAnchor = z.infer<typeof ReviewAnchor>;

/** A comment as written in the artifact — minimal on the wire; the app stamps
 * identity on import (mirrors `SessionId`, never renderer-chosen). */
export const ReviewComment = z
  .object({ ...anchorShape, body: z.string().min(1) })
  .refine(rangeIsAscending, rangeError)
  .meta({ description: `${anchorDescription} \`body\` says why, never what.` });
export type ReviewComment = z.infer<typeof ReviewComment>;

/** The in-app comment: the authored shape plus the app-assigned `id` stamped by
 * `importReview`. Non-optional — once imported a comment always has identity, so
 * the illegal "comment without an id" state is unrepresentable. */
export const Comment = z
  .object({
    ...anchorShape,
    body: z.string().min(1),
    id: z.uuid(),
  })
  .refine(rangeIsAscending, rangeError);
export type Comment = z.infer<typeof Comment>;

/** One layer of the ordered review. `id` is authored, not app-assigned, because `parent`
 * references it. `kind` is an open, author-chosen semantic category (e.g. `validation`,
 * `feature`) the UI maps to an icon — a closed enum would reject categories the authoring
 * agent legitimately invents, so it stays a free label, not stringly-typed data hiding a
 * fixed set. `summary` is the one-line list label; the optional `description` is the
 * long-form prose the app reads both as this layer's section of the overview doc and above
 * the diff — the artifact's small markdown tier, resolved to clickable file links at
 * render, absent on artifacts that carry only a summary.
 *
 * `parent` makes `layers` a **tree**, and the array is that tree in document order — a
 * layer's descendants follow it, together, before the next layer at its level. Every
 * surface renders the array as written, so the order you emit is the order it is read.
 *
 * A layer's **extent** is its own ranges plus every range under it. One rule, at every
 * level: a parent is not a different kind of node, it is a layer that happens to contain
 * others, exactly like a directory. So a parent is a real place to stand — soloing it
 * shows the whole group, soloing a child narrows to that section — and its counts are the
 * group's totals. Nothing has to arbitrate between a parent's files and its children's,
 * because they are the same claim at two scopes.
 *
 * The gate enforces what keeps that legible: nesting at most five levels deep, no cycles,
 * every `parent` naming a real layer, every layer reaching some code (its own ranges or a
 * descendant's), and the array in document order. The app reads a violation as un-nested —
 * a hand-edited artifact still opens and still reads top to bottom — while `rvw
 * emit`/`check` refuse to produce one. */
export const ReviewLayer = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  summary: z.string().min(1),
  description: z.string().min(1).optional(),
  ranges: z.array(ReviewAnchor),
  parent: z.string().min(1).optional(),
});
export type ReviewLayer = z.infer<typeof ReviewLayer>;

/** The review's front matter — the tour doc the app opens on, before any diff.
 * `title` names the change the way its author would say it out loud; `body` is the
 * long-form "what this does, why it is shaped this way", written in the *same*
 * markdown grammar a layer `description` uses (paragraphs, headings, lists, quotes,
 * fences; `` `code` `` and `[label](path)` links resolved against the diff, strong
 * and emphasis) — one prose tier for the whole
 * artifact, so the parser, the link gate, and the renderer are shared rather than
 * forked. The walkthrough itself is never authored here: the app derives the chapter
 * list, its files, and its counts from `layers` and the loaded diff, so the doc can
 * never drift from the layers it introduces. Optional — an artifact without one opens
 * straight onto the diff. */
export const ReviewOverview = z.object({
  title: z.string().min(1),
  body: z.string().min(1),
});
export type ReviewOverview = z.infer<typeof ReviewOverview>;

/** Where the review's diff comes from. Single-arm on purpose: the union is the
 * seam a `github` arm plugs into without reshaping the artifact. */
export const ReviewSource = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("local"), repo: RepoInfo, base: ReviewRef, head: ReviewRef }),
]);
export type ReviewSource = z.infer<typeof ReviewSource>;

/** The `.reviewer.json` artifact. `version` is a literal so a future
 * schema can never be mis-read as v1. The `rvw` CLI emits **refs-only**
 * artifacts by default — no `patch` — which the app re-derives `base...head` from
 * git on open; the anchors then resolve positionally against that diff. A
 * `patch` is present only on a rare imported/frozen artifact, which the app still
 * renders verbatim so its anchors always place, but which the CLI never
 * produces or surfaces. `layers` order *is* reading order; the app never re-sorts. */
export const ReviewArtifact = z.object({
  version: z.literal(1),
  source: ReviewSource,
  patch: z.string().optional(),
  /** The tour doc the review opens on; absent on an artifact that has none. */
  overview: ReviewOverview.optional(),
  comments: z.array(ReviewComment),
  layers: z.array(ReviewLayer),
});
export type ReviewArtifact = z.infer<typeof ReviewArtifact>;

/** The diff a review pins onto its session so the anchors place on their exact
 * authored lines, kept distinct from the user's mode pickers — a
 * review sha never lands in the branch fields. `frozenPatch` renders the artifact's
 * embedded diff verbatim: the diff can't have drifted, so `AnchorDiff.frozen`
 * places every anchor. `refs` re-derives `base..head` from git when no patch was
 * embedded; the anchors then resolve positionally against that diff. */
export const ReviewDiff = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("frozenPatch"), patch: z.string().min(1) }),
  z.object({ kind: z.literal("refs"), base: ReviewRef, head: ReviewRef }),
]);
export type ReviewDiff = z.infer<typeof ReviewDiff>;

/** The pin a review binds to its session: the embedded patch when present, else the
 * authored refs. An empty embedded patch is not a usable frozen diff, so it falls
 * through to the refs form rather than freezing an empty diff. */
export function reviewDiffFor(review: ImportedReview): ReviewDiff {
  return review.patch !== null && review.patch.length > 0
    ? { kind: "frozenPatch", patch: review.patch }
    : { kind: "refs", base: review.source.base, head: review.source.head };
}

/** A validated review ready to bind to a session. `patch` models its absence as
 * null rather than an optional key so consumers branch on a real value. */
export type ImportedReview = {
  source: ReviewSource;
  patch: string | null;
  /** The authored tour doc, or null for an artifact that carries none — modelled as
   * a real value (not an optional key) so consumers branch on it, like `patch`. */
  overview: ReviewOverview | null;
  comments: Comment[];
  layers: ReviewLayer[];
};

/** The authored artifact provenance a review session carries so it can re-emit the
 * same `.reviewer.json` it opened: the `source` refs and the
 * optional embedded `patch`, exactly as imported. Kept apart from the session's
 * `reviewDiff` render pin, which is *cleared* the moment the reviewer navigates to
 * their own diff — the origin is stable, so export always reproduces the
 * authored source and patch verbatim, whatever diff is on screen. `patch` models
 * absence as null (no optional key) so the serializer branches on a real value.
 * Null for a plain repo session: there is no authored review to export. */
export const ReviewOrigin = z.object({
  source: ReviewSource,
  patch: z.string().nullable(),
});
export type ReviewOrigin = z.infer<typeof ReviewOrigin>;

/** The origin an imported review pins onto its session — the fields the round-trip
 * export needs that the `reviewDiff` render pin cannot retain (a frozen pin drops
 * the refs; a cleared pin drops everything). */
export function reviewOriginFor(review: ImportedReview): ReviewOrigin {
  return { source: review.source, patch: review.patch };
}

export type ImportReviewResult =
  | { ok: true; review: ImportedReview }
  | { ok: false; error: "invalidContent" };

/** Injected identity so `importReview` stays pure and deterministic: main
 * supplies `crypto.randomUUID`, tests supply fixed values. */
export type ReviewStamp = {
  newId: () => string;
};

/** Untrusted artifact text → a validated review, or a typed failure — never a
 * throw. The single seam the open paths call: it parses (safeParse, never
 * trusts disk/CLI bytes) and stamps each comment with app-assigned identity. */
export function importReview(bytes: string, stamp: ReviewStamp): ImportReviewResult {
  let json: unknown;
  try {
    json = JSON.parse(bytes);
  } catch {
    return { ok: false, error: "invalidContent" };
  }

  const parsed = ReviewArtifact.safeParse(json);
  if (!parsed.success) {
    return { ok: false, error: "invalidContent" };
  }

  const comments: Comment[] = parsed.data.comments.map((comment) => ({
    ...comment,
    id: stamp.newId(),
  }));

  return {
    ok: true,
    review: {
      source: parsed.data.source,
      patch: parsed.data.patch ?? null,
      overview: parsed.data.overview ?? null,
      comments,
      layers: parsed.data.layers,
    },
  };
}
