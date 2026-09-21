import * as z from "zod";
import { errorMessage } from "./errors";
import { CommitSha, type GitFailure, ReviewRef, RepoInfo, RepoPath } from "./git";

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

/** How much a finding should block, on the one axis the app is allowed to act on.
 *
 * Three levels and words rather than P-numbers: every scale in the field (P0–P2,
 * High/Medium/Low, critical/major/minor/trivial, P0–P3) collapses onto three without
 * losing a distinction anyone acts on, and a reader meeting the artifact cold reads
 * `blocking` where `P0` needs a legend. A fourth level is one authors would disagree
 * about — `trivial`, `info` and P3 all land on `minor`.
 *
 * Closed, unlike `tag` beside it, and that is the entire difference between them: this
 * is an axis the renderer sorts, colours and counts by, so its values have to mean the
 * same thing in every review. Provenance and stance — pre-existing, a decision, a
 * question — are *not* weight and live on `tag`. */
export const CommentSeverity = z.enum(["blocking", "important", "minor"]);
export type CommentSeverity = z.infer<typeof CommentSeverity>;

/** The longest a `tag` may be. The same job `MAX_REASON_LENGTH` does further down: the
 * field is free text on purpose, so the only thing worth enforcing is that a value cannot
 * break the row it renders in. A pill is a word or two; 24 characters is well past every
 * taxonomy in the field and well short of a sentence. */
const MAX_TAG_LENGTH = 24;

/** The three tag values the app knows, lower-cased. Every other tag is an opaque label it
 * only displays, and this list is the whole extent of Reviewer's opinion about what a
 * finding *is* — deliberately provenance and stance, never weight, which is `severity`.
 *
 * They are the three words `skills/present-review` asks authors to open a body with, moved
 * off the body's first line and onto a field: a body that spends its title line on
 * `**Pre-existing**` spends it on a label instead of the claim, and prose is a convention
 * the app cannot see. Matched case-insensitively, because an author typing `Decision` and
 * one typing `decision` mean the same thing and neither is wrong. */
export const RESERVED_TAGS = ["pre-existing", "decision", "question"] as const;
export type ReservedTag = (typeof RESERVED_TAGS)[number];

/** Which reserved word a tag is, or null for a label the app has no opinion about. The one
 * place the comparison is written, so the rail, the card and any later grouping cannot
 * disagree about whether `Question ` is the reserved word. */
export function reservedTag(tag: string | undefined): ReservedTag | null {
  if (tag === undefined) {
    return null;
  }
  const normalized = tag.trim().toLowerCase();
  return RESERVED_TAGS.find((reserved) => reserved === normalized) ?? null;
}

/** A comment as written in the artifact — minimal on the wire; the app stamps
 * identity on import (mirrors `SessionId`, never renderer-chosen). `body` is prose in
 * the same markdown the overview and a layer description take — the app renders one
 * grammar everywhere — though a comment is usually a sentence, not a document.
 *
 * `body` is the only required half. The three optional fields beside it are the review
 * vocabulary every shipping reviewer converged on, split by what the app may *do* with
 * each: `severity` is closed and acted on, `tag` is free text and only displayed, and
 * `evidence` is the receipts folded under the claim. Each carries its own
 * `.meta({ description })` because `rvw schema` is derived from this object and the
 * authoring skill names that output as the authority on field rules — an undescribed
 * field is a field an agent guesses at. A description states the field's rule and what the
 * app does with it, and stops: *when* to write one is the skill's
 * (`skills/present-review/SKILL.md`), and saying it in both places made every agent that
 * fetched the schema pay for the same advice twice (912 bytes of it, measured).
 *
 * A plain `z.object`, like every `ReviewAnchor` descendant, so an artifact carrying these
 * keys still opens in an older build: the unknown keys are dropped and the review reads as
 * it did before. That is why they ship ahead of the `strictObject` additions (`skim`,
 * `reviewedHead`), which make an older app refuse the file outright. */
export const ReviewComment = ReviewAnchor.extend({
  body: z.string().min(1),
  tag: z
    .string()
    .min(1)
    .max(MAX_TAG_LENGTH)
    .optional()
    .meta({
      description: `A short free-form label, at most ${MAX_TAG_LENGTH} characters, shown as a pill beside the comment. Tag a comment only when the label changes how it is read, never every comment. The app knows ${RESERVED_TAGS.join(", ")}; any other value is printed as written.`,
    }),
  severity: CommentSeverity.optional().meta({
    description:
      "How much this finding should block, if your review already ranks findings: blocking (must be resolved before merge), important (should be addressed), minor (worth knowing, not worth blocking). Leave it unset rather than guessing; unset is not minor.",
  }),
  evidence: z.string().min(1).optional().meta({
    description:
      "What you ran or read to confirm the finding — the command and the lines of output that show it — as markdown, rendered folded under the body. Put it here rather than in `body`, which stays the sentence.",
  }),
}).meta({
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

/** The longest a range `note` may be. A note is one row's worth of explanation, sitting in
 * the space a file row has left after its path and its counts — long enough for a clause a
 * reader takes in without stopping, short enough that it cannot become the paragraph the
 * layer's `description` already is. */
const MAX_NOTE_LENGTH = 120;

/** A layer's range: an anchor plus the one line saying what *this* slice of the layer
 * contributes to it. The overview lists a chapter's files with a tick and a `+`/`−` count;
 * before this, the only place to explain a particular file was the layer's prose, which does
 * not line up with the rows the reader is looking at while they choose where to start.
 *
 * Layer ranges only, and deliberately not `ReviewAnchor` itself: a comment already has
 * `body`, and the validator's problem anchors and coverage's uncovered spans are the same
 * four fields (`AnchorSpan`) and must stay incapable of carrying prose. So the note is
 * `.extend()`ed on here, where a range is a *place in a chapter*, rather than on the anchor
 * every tool in the codebase reports positions with.
 *
 * **First note wins.** A layer may anchor several ranges in one file; the row that file gets
 * shows the first note in authored order and never joins them — a sentence stitched out of
 * two notes is a sentence nobody wrote, and showing the longest is a rule no author could
 * predict. The `.meta` says so, because an author whose second note is silently unread has
 * to be able to find out why from the schema `rvw schema` publishes. */
export const ReviewLayerRange = ReviewAnchor.extend({
  note: z
    .string()
    .min(1)
    .max(MAX_NOTE_LENGTH)
    .optional()
    .meta({
      description: `One line, at most ${MAX_NOTE_LENGTH} characters: what this range contributes to its layer, not what changed in it. Shown beside the file's row in the overview. When a layer anchors several ranges in one file, only the first note is shown.`,
    }),
});
export type ReviewLayerRange = z.infer<typeof ReviewLayerRange>;

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
 * bottom) while `rvw emit`/`check` refuse to produce one.
 *
 * `skim` is the one field that is not about what a layer *says* but about how much of it
 * there is to read: the lockfile, the generated client, the rename sweep. The skill used to
 * tell authors to fold that kind of thing into the layer it serves, which buried it inside a
 * real chapter, inflated that chapter's counts, and still asked the reader to get through it
 * before the chapter read as finished. Marked instead, it stays a chapter of its own —
 * covered, counted, navigable — and the app chips its heading `Skim` and opens its files folded. It
 * is deliberately the author's mark and not a score: CodeRabbit collapses a summary below a
 * model-assigned complexity threshold, which puts a judgement between the author and the
 * reader; this is the same effect with nobody in between. Nothing enforces where a skim
 * layer sits, either — ordering is the author's call everywhere else in this format.
 *
 * This object is a `strictObject`, so `skim` is the kind of addition an older build *refuses*
 * the whole artifact over rather than dropping (contrast `ReviewComment`'s optional three,
 * which are plain `z.object` keys and silently vanish). It ships with `reviewedHead` for that
 * reason: one compatibility break, decided once, instead of two. */
export const ReviewLayerInput = z
  .strictObject({
    label: z.string().min(1),
    summary: z.string().min(1).optional(),
    description: z.string().min(1).optional(),
    /** `ReviewLayerRange`, not a bare anchor: a range here is a place *in a chapter* and may
     * carry the one-line `note` that explains it on the overview's file row. Adding it there
     * rather than widening `ReviewAnchor` is what keeps every locator in the codebase four
     * fields. An unknown key inside a range is dropped rather than refused — the range schema
     * is a plain object, unlike this one — so a note reaching an older build costs the note
     * and nothing else. */
    ranges: z.array(ReviewLayerRange).default([]),
    /** `true` or absent, never `false`: the flag is a mark an author puts on one layer, and
     * a `skim: false` on the other twelve would be twelve authored keys saying nothing. The
     * literal is what makes the absent form the only other form. */
    skim: z.literal(true).optional().meta({
      description:
        "Marks this layer as the mechanical remainder: lockfiles, generated output, a rename sweep, formatting. Write one such layer, holding everything of that kind. The app marks its heading Skim and opens its files folded in the diff; coverage still counts its lines. It means there is nothing here to read, never that there is a lot.",
    }),
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
  ranges: z.array(ReviewLayerRange),
  parent: z.string().min(1).optional(),
  /** Carried through from the authored layer verbatim — the app reads it, it never
   * derives it. Absent, never `false`, on the same rule the wire shape keeps. */
  skim: z.literal(true).optional(),
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

/** The author's answer to "should this land", on the one axis a reader triaging a queue of
 * reviews acts on. Three values, because every scale in the field collapses onto them without
 * losing a distinction anyone acts on — Greptile's 0–5 rubric, CodeRabbit's four-way merge
 * risk, Qodo's `safe_to_merge | merge_with_caution | changes_required` all read as these.
 *
 * A word and not a number, deliberately. Every other figure on the overview is *measured* by
 * the app from the diff, and a `4/5` beside them would be the one authored digit on a screen
 * of counted ones — read as a score the app computed, which it cannot and will not. Nothing
 * checks a verdict either: it is the reviewer's judgement, so the gate has no opinion about
 * it (`rvw check`'s 0/1/2 contract says nothing about whether the change is good) and no
 * comment severity rolls up into it. The app gives the claim a place to sit and stops there.
 *
 * On `ReviewOverview`, which is a plain `z.object` — so unlike `skim` and `reviewedHead`, an
 * artifact carrying a verdict still opens in an older build, with the key dropped. */
export const ReviewVerdict = z.enum(["ready", "caution", "blocked"]);
export type ReviewVerdict = z.infer<typeof ReviewVerdict>;

/** The review's front matter — the tour doc the app opens on, before any diff.
 * `title` names the change the way its author would say it out loud; `body` is the
 * long-form "what this does, why it is shaped this way", written in the *same*
 * markdown a layer `description` and a comment take — CommonMark + GFM, parsed by
 * remark, with `` `code` `` and `[label](path)` naming a diff file resolved to a
 * clickable reference — one prose tier for the whole artifact, so the parser, the link
 * gate, and the renderer are shared rather than forked. The walkthrough itself is never authored here: the app derives the chapter
 * list, its files, and its counts from `layers` and the loaded diff, so the doc can
 * never drift from the layers it introduces. Optional — an artifact without one opens
 * straight onto the diff.
 *
 * `verdict` is the one key here the app did not already have a place for, and the only
 * authored *judgement* anywhere in the artifact: everything else on this doc is either prose
 * or a number the app measured. It is optional and shorthand — the sentence in `body` is
 * still where the reasoning lives. */
export const ReviewOverview = z.object({
  title: z.string().min(1),
  body: z.string().min(1),
  verdict: ReviewVerdict.optional().meta({
    description:
      "Whether this should land: `ready` (as it stands), `caution` (landable once the comments are read), `blocked` (something has to change first). Shown as a chip on the review and on the picker row. It never replaces the verdict sentence in `body`.",
  }),
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
 * A `patch` rides along on an artifact exported from a diff its refs cannot reproduce (a commit
 * range, or the working tree, where `base === head`), and on one emitted with `--embed-patch` to
 * be read where the repo is not. The app renders it verbatim whenever this machine cannot
 * reproduce it from the refs — see `pinReview` — so those anchors always place.
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
  /** The commit `head` resolved to when the review was written. Pure provenance: nothing
   * about placement, coverage or the pin reads it (`pinReview` takes `base`/`head` and
   * nothing else), so an artifact with it and the same artifact without it render
   * identically. It exists because `head` is usually a *branch name* — deliberately, so the
   * review follows the branch — and a review authored at A then opened at D has no way to
   * say that three commits landed in between. Every reviewer in the field states it
   * (CodeRabbit's `up to f31a1`, Codex's `Reviewed commit:`, Greptile's "Last reviewed
   * commit"); the app says it as one line on the overview and nowhere else.
   *
   * Written whether or not `head` is a branch. A sha-pinned review whose `reviewedHead`
   * equals its `head` costs one line in the file and removes a conditional from both sides. */
  reviewedHead: CommitSha.optional().meta({
    description:
      "The full commit sha `head` resolved to at emit time — provenance, so the app can tell a reader their branch has moved on since the review was written. `rvw emit` fills this in; do not write it by hand.",
  }),
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
 * places every anchor. `refs` re-derives `base..head` from git whenever this machine has
 * the repo and the refs (see `pinReview`); the anchors then resolve positionally against that
 * diff. */
export const ReviewDiff = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("frozenPatch"), patch: z.string().min(1) }),
  z.object({ kind: z.literal("refs"), base: ReviewRef, head: ReviewRef }),
]);
export type ReviewDiff = z.infer<typeof ReviewDiff>;

/** What main found on this machine when it went looking for a review's diff — the one input
 * the pin below cannot compute, because answering it spawns git (`main/review/source.ts`). Main
 * asks; this decides. Split that way so the decision is a table a test reads (`review.test.ts`),
 * not a branch inside an IPC handler.
 *
 * - `repoMissing` — no path this review could live at is a git work tree here; `failure` is
 *   git's own answer, so a refusal can still name the path it refused.
 * - `refsMissing` — a work tree, but `missing` (in `[base, head]` order) are not commits in it:
 *   a checkout that has not fetched the branch yet.
 * - `patchDiffers` — both refs resolve, but the diff they spell is not the embedded patch.
 * - `live` — both refs resolve and, when a patch rides along, reproduce it byte for byte. */
export type ReviewSourceCheck =
  | { kind: "repoMissing"; failure: GitFailure }
  | { kind: "refsMissing"; repo: RepoInfo; missing: ReviewRef[] }
  | { kind: "patchDiffers"; repo: RepoInfo }
  | { kind: "live"; repo: RepoInfo };

/** Why a review has no diff to show on this machine at all — only ever a review with no patch to
 * fall back to. The codes are `ReviewOpenFailure`'s, which carries them across IPC. */
export type ReviewPinFailure =
  | { code: "repoUnavailable"; reason: GitFailure }
  | { code: "refsUnavailable"; missing: ReviewRef[] };

/** A review seated on this machine: the repo its session reads, and the diff it pins. `repo` is
 * the checked work tree whenever there is one. Only a frozen review with no repo here keeps the
 * authored path, and nothing git-backed reads it — `deriveSession` skips git for a frozen pin and
 * context expansion refuses one — until a later check validates a path and thaws the review. */
export type ReviewPin =
  | { ok: true; repo: RepoInfo; reviewDiff: ReviewDiff }
  | { ok: false; failure: ReviewPinFailure };

/** The pin a review binds to its session, chosen by what this machine has rather than by what the
 * artifact carries: live refs whenever the repo and refs are here (and reproduce any embedded
 * patch), the embedded patch when they are not, and a failure only when there is neither.
 *
 * Presence used to decide it — a patch meant frozen, always — which is how an artifact emitted
 * with `--embed-patch` lost context expansion and the commit brush even beside its own checkout.
 * An empty embedded patch is not a usable frozen diff, so it counts as no patch at all. `review`
 * is the authored origin because a session re-pinned on launch has no `ImportedReview` left. */
export function pinReview(review: ReviewOrigin, check: ReviewSourceCheck): ReviewPin {
  const refs: ReviewDiff = { kind: "refs", base: review.base, head: review.head };
  const frozen: ReviewDiff | null =
    review.patch !== null && review.patch.length > 0
      ? { kind: "frozenPatch", patch: review.patch }
      : null;
  switch (check.kind) {
    case "live":
      return { ok: true, repo: check.repo, reviewDiff: refs };
    case "patchDiffers":
      // Only a review carrying a patch is ever compared, so `frozen` is set here; a patchless one
      // would have nothing but its refs to show anyway.
      return { ok: true, repo: check.repo, reviewDiff: frozen ?? refs };
    case "refsMissing":
      return frozen === null
        ? { ok: false, failure: { code: "refsUnavailable", missing: check.missing } }
        : { ok: true, repo: check.repo, reviewDiff: frozen };
    case "repoMissing":
      return frozen === null
        ? { ok: false, failure: { code: "repoUnavailable", reason: check.failure } }
        : { ok: true, repo: review.repo, reviewDiff: frozen };
  }
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
  /** The commit the review was written against, or null for an artifact that predates the
   * field — modelled as a real value, like `patch` and `overview` beside it. */
  reviewedHead: CommitSha | null;
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
 * authored repo, refs, and patch verbatim, whatever diff is on screen. `repo` is the
 * path the artifact named even when the session reads a relocated checkout (`rvw open
 * --repo`, Locate Repository…), so an export still names the machine the review was written
 * on. `patch` models absence as null (no optional key) so the serializer branches on a real
 * value.
 * Null for a plain repo session: there is no authored review to export. */
export const ReviewOrigin = z.object({
  repo: RepoInfo,
  base: ReviewRef,
  head: ReviewRef,
  patch: z.string().nullable(),
  /** The commit the artifact said it was written against. It rides on the origin rather
   * than being re-read from the file because the origin *is* what the session keeps of the
   * artifact — the drift line and the round-trip export both read it from here, and neither
   * has the bytes any more. `.default(null)` so a session persisted before this field
   * existed still parses strictly rather than falling to the salvage tier, which would take
   * the whole origin with it and strand an open review with nothing to export. */
  reviewedHead: CommitSha.nullable().default(null),
});
export type ReviewOrigin = z.infer<typeof ReviewOrigin>;

/** The origin an imported review pins onto its session — the fields the round-trip
 * export needs that the `reviewDiff` render pin cannot retain (a frozen pin drops
 * the refs; a cleared pin drops everything). */
export function reviewOriginFor(review: ImportedReview): ReviewOrigin {
  return {
    repo: review.repo,
    base: review.base,
    head: review.head,
    patch: review.patch,
    reviewedHead: review.reviewedHead,
  };
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
      // The absent-key rule the optionals either side of it take: a layer nobody marked
      // arrives without the key, never with a `false` the schema would refuse anyway.
      ...(input.skim === undefined ? {} : { skim: input.skim }),
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
      reviewedHead: artifact.reviewedHead ?? null,
      overview: artifact.overview ?? null,
      comments,
      layers: flattenLayers(artifact.layers, stamp),
    },
  };
}
