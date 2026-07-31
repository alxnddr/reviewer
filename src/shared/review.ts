import * as z from "zod";
import { errorMessage } from "./errors";
import { ReviewRef, RepoInfo, RepoPath } from "./git";

// The review domain contract: `.reviewer.json` is the single integration
// point, defined here as zod schemas — the schema *is* the format, so every read
// of disk/CLI JSON is parsed, never trusted. Ref-bearing fields reuse the git.ts
// schemas so a tampered artifact can't smuggle a spawn arg past the same
// validation that guards a `git` child.
//
// The wire shape is the *authored* shape and nothing else: no identifiers to invent, no
// field the app can derive. `importReview` stamps identity (a comment's `id`, a layer's
// `id`/`parent`) and derives what follows from what was written (the repo's display name
// from its path, the flat layer array from the nested one), so the artifact carries only
// decisions a reviewer actually made.

/** The A/D side an anchor lives on — the wire word matches `@pierre/diffs`'
 * `AnnotationSide`, so a range maps straight onto a rendered hunk. */
export const ReviewSide = z.enum(["deletions", "additions"]);
export type ReviewSide = z.infer<typeof ReviewSide>;

const LineNumber = z.number().int().positive();

/** An inclusive `startLine..endLine` run — the line half of every anchor, on its own
 * because the rules that only compare the two numbers (the ascending refine here, coverage's
 * span arithmetic) have no business knowing which file or side they came from. */
export type LineSpan = { startLine: number; endLine: number };

/** An inverted range is not a real anchor — reject it rather than represent it. */
const rangeIsAscending = (range: LineSpan): boolean => range.endLine >= range.startLine;
const ASCENDING_RANGE_RULE = "endLine must be greater than or equal to startLine";
/** Reported at `endLine`, not on the anchor object: the rule compares two siblings but only
 * one of them is the one to edit, so the path an authoring agent reads names the field it
 * has to change rather than the whole anchor. */
const rangeError = { error: ASCENDING_RANGE_RULE, path: ["endLine"] };

/** Carried as schema metadata, not just a `.refine` predicate, because the ascending
 * rule compares two sibling fields — a shape no JSON Schema keyword can express. It
 * survives the serialization `rvw schema` derives from these schemas, so an agent
 * authoring against that output still reads the rule the parse enforces. */
const anchorDescription = `An anchor: file + side + line range. ${ASCENDING_RANGE_RULE}.`;

/** `file + side + line range` — the unit the anchoring resolver places
 * or flags outdated. Persisted as authored; the placed line is recomputed on
 * load, never stored (the session.ts inputs-not-derived precedent).
 *
 * One schema rather than a field bag each user re-spreads: a layer range *is* an anchor,
 * and the wire comment and the in-app comment are `.extend()`s of it — the Range shape is
 * identical across comments and layers, so anchoring and the outdated rule apply unchanged.
 * `.extend()` carries the ascending refine along with the fields, so an anchor-shaped
 * schema derived from this one cannot forget it. */
export const ReviewAnchor = z
  .object({
    file: z.string().min(1),
    side: ReviewSide,
    startLine: LineNumber,
    endLine: LineNumber,
  })
  .refine(rangeIsAscending, rangeError)
  .meta({ description: anchorDescription });
export type ReviewAnchor = z.infer<typeof ReviewAnchor>;

/** The same `file + side + range` as a plain shape — `ReviewAnchor` minus the ascending
 * refine, which is a *parse-time* rule about untrusted input and says nothing about a range
 * the code derived itself. Every locator a tool reports is this: the validator's problem
 * anchors and coverage's uncovered spans are the same four fields, so they are the same
 * type, and a `ReviewAnchor` is assignable straight into one. */
export type AnchorSpan = LineSpan & { file: string; side: ReviewSide };

/** A comment as written in the artifact — minimal on the wire; the app stamps
 * identity on import (mirrors `SessionId`, never renderer-chosen). `body` is prose in
 * the same markdown the overview and a layer description take — the app renders one
 * grammar everywhere — though a comment is usually a sentence, not a document. */
export const ReviewComment = ReviewAnchor.extend({ body: z.string().min(1) }).meta({
  description: `${anchorDescription} \`body\` says why, never what, and is markdown (CommonMark + GFM).`,
});
export type ReviewComment = z.infer<typeof ReviewComment>;

/** The in-app comment: the authored shape plus the app-assigned `id` stamped by
 * `importReview`. Non-optional — once imported a comment always has identity, so
 * the illegal "comment without an id" state is unrepresentable. Extended from
 * `ReviewComment` rather than rebuilt beside it, so the in-app shape cannot drift from
 * the wire one. */
export const Comment = ReviewComment.extend({ id: z.uuid() });
export type Comment = z.infer<typeof Comment>;

/** A layer as written in the artifact: **nested**, and identity-free. A layer that
 * contains others carries them in `children`, so the outline is a real tree on the wire
 * rather than a flat array an author has to encode one into — no id to invent, no `parent`
 * to point back at it, no document order to hand-maintain. `label` is the row's name; the
 * optional `summary` is the one-line deck under it; the optional `description` is the
 * long-form prose the app reads both as this layer's section of the overview doc and above
 * the diff — markdown (CommonMark + GFM), with a path reference resolved to a clickable
 * file link at render, absent on a layer that carries only a label.
 *
 * A layer's **extent** is its own ranges plus every range under it. One rule, at every
 * level: a parent is not a different kind of node, it is a layer that happens to contain
 * others, exactly like a directory. So a parent is a real place to stand — soloing it
 * shows the whole group, soloing a child narrows to that section — and its counts are the
 * group's totals. Nothing has to arbitrate between a parent's files and its children's,
 * because they are the same claim at two scopes; a pure grouping layer just leaves
 * `ranges` empty.
 *
 * Nesting makes a dangling parent, a cycle, and a mis-ordered array unrepresentable, so
 * only two rules are left for the gate to check: at most `MAX_LAYER_DEPTH` levels deep,
 * and every layer reaching some code — its own ranges, or a descendant's. The app reads a
 * too-deep layer as un-nested (a hand-edited artifact still opens and still reads top to
 * bottom) while `rvw emit`/`check` refuse to produce one. */
export const ReviewLayerInput = z
  .strictObject({
    label: z.string().min(1),
    summary: z.string().min(1).optional(),
    description: z.string().min(1).optional(),
    ranges: z.array(ReviewAnchor).default([]),
    /** A getter, not a `z.lazy` wrapper: it defers the self-reference the same way, but
     * leaves the schema's own type *inferable*, so the two exported types below are read
     * off this declaration instead of hand-written beside it and asserted onto it — a
     * field added here can no longer diverge from a type nothing checks. */
    get children() {
      return z.array(ReviewLayerInput).default([]);
    },
  })
  .meta({
    id: "reviewLayer",
    description:
      "A section of the review. Nest sub-sections in `children`; a layer with no `ranges` of its own is a grouping layer, and must have a descendant that has some.",
  });
export type ReviewLayerInput = z.infer<typeof ReviewLayerInput>;

/** The same layer before the schema fills its defaults in — the shape an author actually
 * writes, where a leaf is `{ label, ranges }` and nothing more. */
export type ReviewLayerDraft = z.input<typeof ReviewLayerInput>;

/** The in-app layer: the authored fields plus the identity `importReview` stamps —
 * `id`, and `parent` naming the id of the layer it hangs off. Flat, and in document order
 * by construction (the flatten walks the tree pre-order), so every surface renders the
 * array as it stands and nothing re-sorts it. Identity is app-assigned for the same reason
 * a comment's is: it is derived from the artifact, never authored into it. */
export const ReviewLayer = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  summary: z.string().min(1).optional(),
  description: z.string().min(1).optional(),
  ranges: z.array(ReviewAnchor),
  parent: z.string().min(1).optional(),
});
export type ReviewLayer = z.infer<typeof ReviewLayer>;

/** One authored layer paired with the two things a report needs to name it now that it
 * carries no id: its **ordinal path** (`"4.2.1"` — its position in the array the author
 * wrote, and the same section number the rail shows) and its 1-based nesting depth. */
export type LayerInputEntry = { layer: ReviewLayerInput; ordinal: string; depth: number };

/** Every layer of an authored outline, depth-first — the same pre-order `importReview`
 * flattens by, so an ordinal names the row the reader will end up seeing. */
export function walkLayerInputs(layers: readonly ReviewLayerInput[]): LayerInputEntry[] {
  const entries: LayerInputEntry[] = [];
  const visit = (siblings: readonly ReviewLayerInput[], prefix: string, depth: number): void => {
    for (const [index, layer] of siblings.entries()) {
      const ordinal = prefix === "" ? String(index + 1) : `${prefix}.${index + 1}`;
      entries.push({ layer, ordinal, depth });
      visit(layer.children, ordinal, depth + 1);
    }
  };
  visit(layers, "", 1);
  return entries;
}

/** The review's front matter — the tour doc the app opens on, before any diff.
 * `title` names the change the way its author would say it out loud; `body` is the
 * long-form "what this does, why it is shaped this way", written in the *same*
 * markdown a layer `description` and a comment take — CommonMark + GFM, parsed by
 * remark, with `` `code` `` and `[label](path)` naming a diff file resolved to a
 * clickable reference — one prose tier for the whole artifact, so the parser, the link
 * gate, and the renderer are shared rather than forked. The walkthrough itself is never authored here: the app derives the chapter
 * list, its files, and its counts from `layers` and the loaded diff, so the doc can
 * never drift from the layers it introduces. Optional — an artifact without one opens
 * straight onto the diff. */
export const ReviewOverview = z.object({
  title: z.string().min(1),
  body: z.string().min(1),
});
export type ReviewOverview = z.infer<typeof ReviewOverview>;

/** The `.reviewer.json` artifact — every key a decision someone made, and nothing else.
 * `repo`/`base`/`head` say which diff this reviews: the work-tree toplevel and the two
 * refs, flat, because there has only ever been one kind of source and a wrapper around a
 * single arm is a key an author writes for no reason. The repo's display name is *not*
 * here — it is always the path's last segment, so `importReview` derives it.
 *
 * The `rvw` CLI emits **refs-only** artifacts — no `patch` — which the app re-derives
 * `base...head` from git on open; the anchors then resolve positionally against that diff.
 * A `patch` rides along only on an artifact exported from a diff its refs cannot reproduce
 * (a commit range, or the working tree, where `base === head`), and the app renders it
 * verbatim so those anchors always place.
 *
 * `comments` and `layers` both default to empty: a review that only annotates lines and a
 * review that is only a walkthrough are both whole artifacts, and neither should have to
 * write the other's key as `[]`. Unknown keys are refused rather than dropped, so a typo
 * is an error the author sees instead of a field that silently vanishes. */
export const ReviewArtifact = z.strictObject({
  /** The work-tree toplevel, absolute — the same canonical root `git rev-parse
   * --show-toplevel` reports, whatever directory the review was authored from. */
  repo: RepoPath,
  base: ReviewRef,
  head: ReviewRef,
  patch: z.string().min(1).optional(),
  /** The tour doc the review opens on; absent on an artifact that has none. */
  overview: ReviewOverview.optional(),
  comments: z.array(ReviewComment).default([]),
  layers: z
    .array(ReviewLayerInput)
    .meta({
      description:
        "The reading order the review is toured in — the diff cut into ordered chapters. Optional in shape only: write layers unless the review was asked for as comments alone.",
    })
    .default([]),
});
export type ReviewArtifact = z.infer<typeof ReviewArtifact>;

/** The artifact as authored — the input side of the contract, before the schema fills in
 * its array defaults. What `serializeReview` returns and writes: an exported review should
 * read like a hand-written one, so the keys an author never had to write (`comments: []`,
 * `children: []`) are not written back at them. */
export type ReviewArtifactDraft = z.input<typeof ReviewArtifact>;

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
    : { kind: "refs", base: review.base, head: review.head };
}

/** A validated review ready to bind to a session. `repo` is a full `RepoInfo`: the
 * artifact carries only the path, and the name is derived here (see `repoDisplayName`), so
 * every downstream consumer keeps reading the repo the same way a plain repo session's does.
 * `patch` models its absence as null rather than an optional key so consumers branch on a
 * real value. */
export type ImportedReview = {
  repo: RepoInfo;
  base: ReviewRef;
  head: ReviewRef;
  patch: string | null;
  /** The authored tour doc, or null for an artifact that carries none — modelled as
   * a real value (not an optional key) so consumers branch on it, like `patch`. */
  overview: ReviewOverview | null;
  comments: Comment[];
  layers: ReviewLayer[];
};

/** The authored artifact provenance a review session carries so it can re-emit the
 * same `.reviewer.json` it opened: the repo and refs its diff came from, and the
 * optional embedded `patch`, exactly as imported. Kept apart from the session's
 * `reviewDiff` render pin, which is *cleared* the moment the reviewer navigates to
 * their own diff — the origin is stable, so export always reproduces the
 * authored repo, refs, and patch verbatim, whatever diff is on screen. `patch` models
 * absence as null (no optional key) so the serializer branches on a real value.
 * Null for a plain repo session: there is no authored review to export. */
export const ReviewOrigin = z.object({
  repo: RepoInfo,
  base: ReviewRef,
  head: ReviewRef,
  patch: z.string().nullable(),
});
export type ReviewOrigin = z.infer<typeof ReviewOrigin>;

/** The origin an imported review pins onto its session — the fields the round-trip
 * export needs that the `reviewDiff` render pin cannot retain (a frozen pin drops
 * the refs; a cleared pin drops everything). */
export function reviewOriginFor(review: ImportedReview): ReviewOrigin {
  return { repo: review.repo, base: review.base, head: review.head, patch: review.patch };
}

export type ImportReviewResult =
  | { ok: true; review: ImportedReview }
  /** `reason` is what zod objected to first (see `firstIssueReason`), carried rather than
   * dropped so the banner over a hand-edited artifact can say which field is wrong instead
   * of only that the file is not a review. */
  | { ok: false; error: "invalidContent"; reason: string };

/** Injected identity so `importReview` stays pure and deterministic: main
 * supplies `crypto.randomUUID`, tests supply fixed values. */
export type ReviewStamp = {
  newId: () => string;
};

/** The repo's display name: the last segment of its work-tree toplevel. Never authored —
 * it is a function of the path, and a field an author could get wrong is a field the
 * artifact should not carry. The artifact's `repo` is a validated absolute path, so the last
 * non-empty segment is the name (and `/` stands for itself).
 *
 * The one derivation, exported rather than restated: the recent-reviews list names a repo
 * beside the tab that opening it will produce, and a second copy of this rule is a way for
 * the two to disagree about what the repo is called. The path fallback is part of the rule,
 * not something a caller adds — a segment-less path answers with itself. */
export function repoDisplayName(path: string): string {
  const segments = path.split("/").filter((segment) => segment.length > 0);
  return segments.at(-1) ?? path;
}

/** The authored tree flattened into the array every surface reads: depth-first over
 * `children`, each layer stamped with an app-assigned `id` and linked to its parent's — the
 * same stamping a comment's `id` gets, for the same reason. Document order is a property of
 * this walk rather than a promise the artifact had to keep, so "the array is the document"
 * is true by construction and there is nothing left to check. */
export function flattenLayers(
  inputs: readonly ReviewLayerInput[],
  stamp: ReviewStamp,
): ReviewLayer[] {
  const layers: ReviewLayer[] = [];
  const visit = (input: ReviewLayerInput, parent: string | undefined): void => {
    const id = stamp.newId();
    layers.push({
      id,
      label: input.label,
      ...(input.summary === undefined ? {} : { summary: input.summary }),
      ...(input.description === undefined ? {} : { description: input.description }),
      ranges: input.ranges,
      ...(parent === undefined ? {} : { parent }),
    });
    for (const child of input.children) {
      visit(child, id);
    }
  };
  for (const input of inputs) {
    visit(input, undefined);
  }
  return layers;
}

/** A parse of artifact bytes: the validated artifact, or every issue that stopped it —
 * zod's own, so nothing about the failure is thrown away before the caller sees it. */
export type ParsedArtifactBytes =
  | { ok: true; artifact: ReviewArtifact }
  | { ok: false; issues: z.core.$ZodIssue[] };

/** The `format` on the issue reported for bytes that never were a JSON document. Not one of
 * zod's own string formats — no schema here parses JSON — so it is named once and matched
 * against, rather than spelled out at the one call site that separates "this was never a
 * document" from "this document is not a review". */
export const ARTIFACT_JSON_FORMAT = "json";

/** Untrusted bytes → a validated artifact, or every reason zod refused them. Three callers
 * read artifact bytes — the app's open path (`importReview`), the recents lister's peek, and
 * the CLI's pre-handoff check — and each used to run its own `JSON.parse` in a try/catch
 * followed by its own `safeParse`, then collapse both outcomes into its own single word. Only
 * one of the three kept *why*. Both steps happen here once and the issues survive, so each
 * caller projects them into its own failure vocabulary instead of discarding the diagnosis.
 *
 * Bytes that are not JSON at all report as an issue rather than as an arm of their own: the
 * caller that cares reads the distinction off the issue (`ARTIFACT_JSON_FORMAT`), and the two
 * that only want a sentence get one list to render whichever way the parse failed. */
export function parseArtifactBytes(bytes: string): ParsedArtifactBytes {
  let json: unknown;
  try {
    json = JSON.parse(bytes);
  } catch (error) {
    return {
      ok: false,
      issues: [
        {
          code: "invalid_format",
          format: ARTIFACT_JSON_FORMAT,
          // Root path: nothing in the document can be pointed at when the document did not
          // parse. `JSON.parse`'s own message carries the offset, which is the locator.
          path: [],
          message: errorMessage(error),
          // No `input`, deliberately: zod's own issues carry none, and an artifact is up to
          // 32 MiB of untrusted JSON — attaching it would make this issue the one value in
          // the parse result that holds the whole document, handed to three callers and one
          // `JSON.stringify` away from the unbounded leak `MAX_REASON_LENGTH` below exists to
          // prevent. The message is the diagnosis; the bytes are the caller's already.
        },
      ],
    };
  }

  const parsed = ReviewArtifact.safeParse(json);
  return parsed.success
    ? { ok: true, artifact: parsed.data }
    : { ok: false, issues: parsed.error.issues };
}

/** Bound on the sentence below, because part of it is the file's own text: zod names an
 * unrecognized key back at the author, and an artifact is up to 32 MiB of untrusted JSON, so an
 * absurd key would otherwise ride into the open-failure banner as one unbreakable text node —
 * the bound `RepoPath` carries, for the same reason. No honest message comes close. */
const MAX_REASON_LENGTH = 200;

/** The first thing zod objected to, as one line a reader can act on: `path — message`, or the
 * message alone when the objection is about the document as a whole (bytes that are not JSON,
 * an unrecognized key at the root). Only the first, because this ends up in a banner — the
 * full list is a report, and `rvw check` already prints one.
 *
 * The locator is zod's own `toDotPath` rather than a `join(".")`, for the reason the validator
 * uses it: it brackets array indices (`comments[2].endLine`) and escapes a key containing a
 * dot, so the path names exactly one place in the file the reader has open. */
function firstIssueReason(issues: readonly z.core.$ZodIssue[]): string {
  const issue = issues[0];
  if (issue === undefined) {
    // Unreachable: a failed parse reports at least one issue, and the JSON arm above builds
    // its own. Answered rather than asserted — an open must not throw on the way to a banner.
    return "The file is not a valid review.";
  }
  const path = z.core.toDotPath(issue.path);
  const reason = path === "" ? issue.message : `${path} — ${issue.message}`;
  return reason.length > MAX_REASON_LENGTH ? `${reason.slice(0, MAX_REASON_LENGTH)}…` : reason;
}

/** Untrusted artifact text → a validated review, or a typed failure — never a
 * throw. The single seam the open paths call: it parses (`parseArtifactBytes`, never trusts
 * disk/CLI bytes), stamps app-assigned identity onto each comment and each layer, and derives
 * what the artifact deliberately does not carry — the repo's name from its path, the flat
 * layer array from the nested one. */
export function importReview(bytes: string, stamp: ReviewStamp): ImportReviewResult {
  const parsed = parseArtifactBytes(bytes);
  if (!parsed.ok) {
    return { ok: false, error: "invalidContent", reason: firstIssueReason(parsed.issues) };
  }

  const artifact = parsed.artifact;
  const comments: Comment[] = artifact.comments.map((comment) => ({
    ...comment,
    id: stamp.newId(),
  }));

  return {
    ok: true,
    review: {
      repo: { path: artifact.repo, name: repoDisplayName(artifact.repo) },
      base: artifact.base,
      head: artifact.head,
      patch: artifact.patch ?? null,
      overview: artifact.overview ?? null,
      comments,
      layers: flattenLayers(artifact.layers, stamp),
    },
  };
}
