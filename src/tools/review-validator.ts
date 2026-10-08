import type * as z from "zod";
import {
  ARTIFACT_JSON_FORMAT,
  artifactPath,
  parseArtifactBytes,
  walkLayerInputs,
  type AnchorSpan,
  type FlowNodeStatus,
  type ReviewArtifact,
  type ReviewAnchor,
  type ReviewLayer,
  type ReviewLayerInput,
  type ReviewOverview,
  type ReviewSide,
  type ReviewVisual,
} from "../shared/review";
import { resolveAnchor } from "../shared/diff/anchor";
import { hunkSpan } from "../shared/diff/walk";
import {
  ANALYSIS_CACHE_KEY,
  filesByAnchorPath,
  parsePatch,
  type PatchFile,
} from "../shared/diff/patch";
import {
  blockMarkup,
  inlineMarkup,
  proseReferences,
  type BlockMarkup,
  type InlineMarkup,
  type MalformedForm,
} from "../shared/markdown";
import { MAX_LAYER_DEPTH, layerOutline, layerOwning } from "../shared/layers";
import { changedLines, type ChangedLines } from "./review-coverage";

// The pre-handoff check an agent runs on a `.reviewer.json` before giving it over. It reuses
// the review domain rather than re-deriving it: the *same* `resolveAnchor`/`parsePatch`/
// `parseMarkdown` the app anchors and renders with — run in **derived** mode against
// the review's diff, so a pass provably implies "it opens in Reviewer with zero manual
// fixing"; a re-implemented checker would drift and break that guarantee. Split into two pure
// steps: `parseReviewArtifact` turns untrusted bytes into a typed artifact (or schema
// problems), and `validatePlacement` places every anchor against a diff the caller supplies —
// the CLI captures it at emit time and re-derives it from the artifact's own repo/refs
// afterward, so the same check runs whether the diff is embedded/frozen or freshly derived.
// Pure and I/O-free: the CLI shell owns the filesystem read, the git spawn, and
// `process.exit`; this module only decides.

/** Which prose a reference problem was found in: one of the overview's three prose parts,
 * which sit under no layer to name (its `body`, its `lede`, or one of its `steps`, numbered
 * from 1 as the guide numbers them); one layer's description or its summary — inline, like a
 * step, and a chip in the guide's heading row — named by the same ordinal path every other
 * layer problem uses; or one comment's `postable`, named by its anchor — the locator every
 * other comment problem reports, since a wire comment carries no identity of its own.
 *
 * A closed union rather than a nullable `layer`, so no locator can be built empty — the
 * reason the two link problems used to be two variants. One `site` on three rules is three
 * variants instead of nine, and every new rule about prose inherits every tier rather than
 * choosing to support one.
 *
 * A comment's `body` is deliberately not a site: the app draws every reference on a comment
 * inert (`CommentBody` passes `Markdown` no `links`), so a dead one there costs the reader
 * nothing a live one would have given them. Its `postable` is held to the artifact's rule
 * because it leaves the app — posted, a dead reference is a broken link in front of the
 * change's author. */
export type ProseSite =
  | { at: "overviewBody" }
  | { at: "overviewLede" }
  | { at: "overviewStep"; step: number }
  | { at: "layer"; layer: string }
  | { at: "layerSummary"; layer: string }
  | { at: "comment"; anchor: AnchorSpan };

/** The prose sites drawn *inline*, on one line inside a sentence-sized slot — the ones a block
 * construct breaks (`proseBlockMarkup`). The rest of `ProseSite` is block-level markdown, where
 * a heading or a list is welcome. */
export type InlineProseSite = Extract<
  ProseSite,
  { at: "overviewLede" } | { at: "overviewStep" } | { at: "layerSummary" }
>;

/** Which visual a visual problem was found in: the overview's, or one layer's, named by its
 * ordinal path like every other layer problem. Closed for `ProseSite`'s reason — no locator
 * can be built empty. */
export type VisualSite = { at: "overview" } | { at: "layer"; layer: string };

/** Which element of that visual: a flow node by its authored `id` (the name the author wrote
 * and will search for), an edge by the two ids it joins (`from→to`, which is how the author
 * reads it in their own draft — a position in `edges` was a number they had to count to), a
 * skeleton line by its 1-based position (lines have no name). */
export type VisualElement =
  | { kind: "node"; id: string }
  | { kind: "edge"; from: string; to: string }
  | { kind: "line"; line: number };

/** Which plain-text field of a visual: its caption, or one element's label, note or code. */
export type VisualText =
  | { field: "caption" }
  | { field: "label" | "note" | "code"; element: VisualElement };

/** The statuses that claim something about the lines an `at` names. `same` claims nothing —
 * an unchanged caller may point at its context lines or at a changed hunk it sits in. */
export type ClaimedStatus = Exclude<FlowNodeStatus, "same">;

/** One hunk an anchor could have been placed in: inclusive, in its side's own line numbers. */
export type PlaceableSpan = { startLine: number; endLine: number };

/** One reason an artifact is not ready to hand over. Each variant carries enough
 * locator for the authoring agent to find and fix the offending anchor, range, or
 * link — illegal states (e.g. a comment problem with no line range) can't be built.
 *
 * A layer is named by its **ordinal path** (`"4.2.1"`), not an id: layers are authored
 * nested and carry no identity, so the locator that helps is the position in the array the
 * author wrote — which is also the section number the app will show for that row. */
export type ValidationProblem =
  | { kind: "invalidJson"; message: string }
  | { kind: "schema"; path: string; message: string }
  | { kind: "missingPatch" }
  /** The three `…Outdated` kinds carry `nearestHunks` — where on that file and side an anchor
   * *would* place — because the locator alone says what is wrong and not what is right: the
   * author's next move was `rvw diff`, a whole round trip and the diff's bytes again, to read
   * off the two numbers that are already in hand here. On a layer range `null` means the file
   * is not in the diff at all, which is a different fix from moving the lines. */
  | { kind: "commentAnchorOutdated"; anchor: AnchorSpan; nearestHunks: PlaceableSpan[] }
  | { kind: "commentFileAbsent"; anchor: AnchorSpan }
  /** `range` is the range's 1-based position in that layer's own `ranges` — the ordinal
   * names the layer, and a layer of five ranges on one file would otherwise leave the author
   * matching line numbers to find which one to move. */
  | {
      kind: "layerRangeOutdated";
      layer: string;
      range: number;
      anchor: AnchorSpan;
      nearestHunks: PlaceableSpan[] | null;
    }
  /** A whole-file range (`{ file }`) naming a file the diff does not carry by its current
   * path. Its own kind rather than a `layerRangeOutdated`: there is no line locator to report,
   * and the fix is a path, so the hint is the changed paths nearest the one written
   * (`nearestPaths`) instead of hunks. */
  | { kind: "layerFileAbsent"; layer: string; range: number; file: string; nearestFiles: string[] }
  /** What is left of the outline contract once `children` carries the shape: an outline no
   * deeper than the reader can follow, in which every layer reaches some code — its own, or
   * its children's. A chain past the cap reports once, at its shallowest offender — the one
   * layer there is to unnest — so `depth` is always exactly one past the cap. */
  | { kind: "nestingTooDeep"; layer: string; depth: number }
  | { kind: "layerWalksNothing"; layer: string }
  /** A reference naming a file this diff does not carry: the app renders it muted and
   * dead, so the gate refuses it. `url` is the target as written, line suffix included, so the
   * report quotes the link the author has to find; `path` is the file it named. */
  | { kind: "unresolvedLink"; site: ProseSite; label: string; url: string; path: string }
  /** A reference whose *line* range no hunk covers. The file is here; the lines are not —
   * a distinct fix from the above, and the one thing no interchange format's "related
   * location" is: a second place in the change, proven to exist in it. */
  | {
      kind: "referenceOutdated";
      site: ProseSite;
      anchor: AnchorSpan;
      nearestHunks: PlaceableSpan[];
    }
  /** A target that reached for the line grammar and missed (`src/app.ts:abc`), or a path
   * behind a reference-style definition (`[r]: src/app.ts`), which no reader of references
   * resolves — `why` says which (`MalformedForm`), because the two are fixed differently.
   * Reported with the target as written, because the thing to fix is those characters —
   * reading the suffix as part of the filename instead would report a file the author never
   * named. */
  | {
      kind: "malformedReference";
      site: ProseSite;
      label: string;
      url: string;
      why: MalformedForm;
    }
  /** A layer's `focus` that does not place. Its own kind rather than a `layerRangeOutdated`
   * with a sentinel range number: the fix is the same, but "range 0" would be a locator that
   * names nothing the author wrote. Looked up by the file's current path only, a range's rule
   * — the excerpt beside the chapter finds its file the way the layer scroll does. */
  | {
      kind: "layerFocusOutdated";
      layer: string;
      anchor: AnchorSpan;
      nearestHunks: PlaceableSpan[] | null;
    }
  /** A visual element's `at` that does not place — the claim a box makes about the diff,
   * refused exactly as a layer range is, and looked up by current path for the same reason:
   * the element's chapter badge is `layerOwning(at)`, which compares against layer ranges, and
   * those are current paths. */
  | {
      kind: "visualAnchorOutdated";
      visual: VisualSite;
      element: VisualElement;
      anchor: AnchorSpan;
      nearestHunks: PlaceableSpan[] | null;
    }
  /** The structural rules a visual has that zod cannot state — checked with the outline, before
   * any diff, because none of them needs one. An element marked added, changed or removed
   * claims a change, and a claim with no `at` is the unverified picture visuals exist to rule
   * out. */
  | { kind: "visualElementUnanchored"; visual: VisualSite; element: VisualElement }
  | { kind: "flowNodeIdDuplicate"; visual: VisualSite; id: string }
  /** The edge is named `from→to`, and `id` is the endpoint that names no node — an edge with
   * two bad ends reports twice, once per thing to fix. */
  | { kind: "flowEdgeDangling"; visual: VisualSite; from: string; to: string; id: string }
  | { kind: "flowEdgeSelfLoop"; visual: VisualSite; id: string }
  /** Markdown in a plain-text field. Visual text is drawn literally, so `` `fetchBlob()` ``
   * would show its backticks in the box — and authors reach for them by habit, because every
   * other text in the artifact is markdown. Refused rather than stripped at draw time, the
   * line-break rule's reason: stripping rewrites what the author wrote. A problem and not a
   * warning because the CLI has no warnings channel for review problems (coverage's one
   * sentence is its own), and a warning nobody acts on is a box with backticks in it. */
  | { kind: "visualTextMarkup"; visual: VisualSite; text: VisualText; markup: InlineMarkup }
  /** Block markdown in a field drawn inline — a `lede`, a step, a layer `summary`. The guide
   * renders each through the block `Markdown` component inside a list item or a heading row,
   * so `1. Parse the config` became a numbered list inside the numbered step, `# Retries` a
   * heading in the middle of a sentence slot, `> x` a quote bar. Refused rather than stripped,
   * the `visualTextMarkup` reason: stripping rewrites what the author wrote. Checked with the
   * outline, before any diff — it is a claim about the text alone. */
  | { kind: "proseBlockMarkup"; site: InlineProseSite; markup: BlockMarkup }
  /** An `at` that places, on the wrong side for its status: an added element on `deletions`,
   * a removed one on `additions`. The anchor is real code, but not the code the claim is
   * about — a box marked new that points at the old file is the unverified picture again,
   * just with a valid line number on it. */
  | {
      kind: "visualStatusWrongSide";
      visual: VisualSite;
      element: VisualElement;
      status: "added" | "removed";
      anchor: AnchorSpan;
    }
  /** An `at` on the right side that holds none of the lines its status claims — all context.
   * Placement alone passes it, because a hunk's context lines are placeable; this is the rule
   * that makes "added" mean added. `changedRuns` are the nearest runs of changed lines on that
   * side, the `nearestHunks` of this rule: the numbers the fix needs, already in hand. */
  | {
      kind: "visualStatusOnContext";
      visual: VisualSite;
      element: VisualElement;
      status: ClaimedStatus;
      anchor: AnchorSpan;
      changedRuns: PlaceableSpan[];
    }
  /** A layer's `focus` whose lines belong to no layer in its extent — itself or a descendant —
   * by `layerOwning`, the rule the guide badges with. `owner` is the ordinal of the layer that
   * does own them, or null when no layer's ranges cover them at all: the two are fixed
   * differently (move the focus, or settle which chapter those lines are), so the report says
   * which. Checked with the outline, before any diff: it is a claim about the layers, not the
   * diff, and holds whether or not either side places. */
  | { kind: "layerFocusOutsideLayer"; layer: string; anchor: AnchorSpan; owner: string | null };

export type ValidationReport = { ok: true } | { ok: false; problems: ValidationProblem[] };

/** Untrusted bytes turned into a typed artifact, or the schema problems that stopped it —
 * the parse-don't-trust step every CLI verb runs before it can place an anchor. */
export type ParsedArtifact =
  | { ok: true; artifact: ReviewArtifact }
  | { ok: false; problems: ValidationProblem[] };

/** Untrusted artifact bytes → a typed artifact, or every reason it could not parse. Never
 * throws: malformed JSON and schema violations are reported as typed problems (the input is
 * untrusted). Placement is not checked here — the caller supplies the diff to place against
 * (`validatePlacement`), which the CLI re-derives from the artifact's own repo/refs.
 *
 * The parse itself is `parseArtifactBytes` (shared), the same seam the app's open path and the
 * recents lister read bytes through; this is the only one of the three that keeps every issue,
 * and projecting them here is what that seam exists for. */
export function parseReviewArtifact(bytes: string): ParsedArtifact {
  const parsed = parseArtifactBytes(bytes);
  if (!parsed.ok) {
    // Can't anchor an artifact we couldn't parse — report every issue and stop.
    return { ok: false, problems: parsed.issues.map(problemOfIssue) };
  }

  // Structure is checked here, with the parse: it needs no diff, and an artifact whose
  // layers do not form a legal outline is not ready to hand over however well its anchors
  // place. The app reads a broken outline as flat rather than refusing to open — this is
  // the seam that keeps one from ever being emitted.
  const structural = [
    ...validateOutline(parsed.artifact.layers),
    ...validateInlineProse(parsed.artifact),
    ...validateVisuals(parsed.artifact),
  ];
  if (structural.length > 0) {
    return { ok: false, problems: structural };
  }

  return { ok: true, artifact: parsed.artifact };
}

/** One parse issue in the report's own vocabulary. Bytes that were never a JSON document are
 * their own problem kind — an authoring agent that wrote a trailing comma has nothing to do
 * with a *path* in a document that does not exist, so it is told that plainly rather than
 * handed a schema problem rooted at `(root)`.
 *
 * The locator is `artifactPath` (`comments#1.side`), not zod's 0-based `toDotPath`: every
 * semantic problem below counts from 1 — layer `2.1`, range 3, skeleton line 4 — and a schema
 * problem beside them must name places the same way, or one report speaks two numberings. */
function problemOfIssue(issue: z.core.$ZodIssue): ValidationProblem {
  return issue.code === "invalid_format" && issue.format === ARTIFACT_JSON_FORMAT
    ? { kind: "invalidJson", message: issue.message }
    : { kind: "schema", path: artifactPath(issue.path), message: issue.message };
}

/** What is left of the outline contract once the outline is a real tree on the wire:
 *
 * - it is at most `MAX_LAYER_DEPTH` levels deep,
 * - every layer reaches some code — its own ranges, or a descendant's, and
 * - a layer's `focus` is lines that extent owns (`layerFocusOutsideLayer`).
 *
 * The three rules this used to also carry — a `parent` naming a real layer, a `parent`
 * chain that terminates, and the array being the tree in document order — are gone because
 * `children` makes all three unrepresentable, not because they stopped mattering. What
 * remains is what nesting cannot say: a depth a reader can still follow, and a group with
 * an actual review behind it (a layer that walks nothing at all is an outline entry naming
 * a part of the change that does not exist). Ranges on a parent are *allowed* — a layer's
 * extent is its own ranges plus its descendants', one rule at every level — so nothing here
 * has to arbitrate between the two. */
export function validateOutline(layers: readonly ReviewLayerInput[]): ValidationProblem[] {
  const problems: ValidationProblem[] = [];
  const reaching = reachingLayers(layers);
  const focusOwner = focusOwnership(layers);

  for (const [index, { layer, ordinal, depth }] of walkLayerInputs(layers).entries()) {
    // Only the *shallowest* layer past the cap, which is always the one at exactly
    // `MAX_LAYER_DEPTH + 1`: everything below it is too deep only because this one is, so
    // reporting each would turn one authoring mistake into a problem per layer for an agent
    // that has a single chain to unnest.
    if (depth === MAX_LAYER_DEPTH + 1) {
      problems.push({ kind: "nestingTooDeep", layer: ordinal, depth });
    }
    if (!reaching.has(layer)) {
      problems.push({ kind: "layerWalksNothing", layer: ordinal });
    }
    const verdict = layer.focus === undefined ? null : focusOwner(index, layer.focus);
    if (layer.focus !== undefined && verdict !== null && !verdict.own) {
      problems.push({
        kind: "layerFocusOutsideLayer",
        layer: ordinal,
        anchor: pickAnchor(layer.focus),
        owner: verdict.owner,
      });
    }
  }

  return problems;
}

/** Whether a focus is its layer's to show, asked exactly as the guide will answer it: the
 * layer that owns the focus's lines (`layerOwning`) must be this layer or one under it.
 * Returns a function of the layer's pre-order position (`walkLayerInputs`' index) and its
 * focus, answering `own` when the focus is the layer's, else the ordinal of the layer that
 * owns those lines — or null when none does.
 *
 * Ownership, not overlap. The rule used to be "overlaps a range in the extent", and that let
 * through a focus whose lines a sibling's line range claims while this layer covers them only
 * through a whole-file range — or one deeper in another subtree claims: the excerpt then sat
 * beside this chapter's prose wearing the other chapter's badge. Reusing `layerOwning` rather
 * than restating it is what makes the gate and the badge one rule.
 *
 * `layerOwning` reads the flattened, id-stamped shape the app does. The flatten is
 * `flattenLayers`' own walk with the ordinal as the id, so position `i` here is position `i`
 * in `walkLayerInputs` — both pre-order over `children` — and a too-deep chain reads flat
 * here exactly as it does in the app (it is refused above anyway). */
function focusOwnership(
  layers: readonly ReviewLayerInput[],
): (index: number, focus: AnchorSpan) => FocusOwnership {
  const entries = walkLayerInputs(layers);
  const parentOf = new Map<ReviewLayerInput, string>();
  for (const { layer, ordinal } of entries) {
    for (const child of layer.children) {
      parentOf.set(child, ordinal);
    }
  }
  const flat: ReviewLayer[] = entries.map(({ layer, ordinal }) => {
    const parent = parentOf.get(layer);
    return {
      id: ordinal,
      label: layer.label,
      ranges: layer.ranges,
      ...(parent === undefined ? {} : { parent }),
    };
  });
  const outline = layerOutline(flat);
  return (index, focus) => {
    const owner = layerOwning(flat, focus);
    const subtree = outline[index]?.subtree ?? [];
    return owner !== null && subtree.includes(owner)
      ? { own: true }
      : { own: false, owner: owner?.id ?? null };
  };
}

/** Whether a focus is its layer's; when not, the ordinal of the layer that owns it, if any. */
type FocusOwnership = { own: true } | { own: false; owner: string | null };

/** The inline prose fields — the overview's `lede` and `steps`, each layer's `summary` — held
 * to inline markdown: code spans, emphasis and references, never a block (`proseBlockMarkup`).
 * In the order the guide shows them: the lede, the steps, then the layers depth-first. */
export function validateInlineProse(artifact: ReviewArtifact): ValidationProblem[] {
  const sites: { site: InlineProseSite; text: string }[] = [];
  const { overview } = artifact;
  if (overview?.lede !== undefined) {
    sites.push({ site: { at: "overviewLede" }, text: overview.lede });
  }
  for (const [index, step] of (overview?.steps ?? []).entries()) {
    sites.push({ site: { at: "overviewStep", step: index + 1 }, text: step });
  }
  for (const { layer, ordinal } of walkLayerInputs(artifact.layers)) {
    if (layer.summary !== undefined) {
      sites.push({ site: { at: "layerSummary", layer: ordinal }, text: layer.summary });
    }
  }
  const problems: ValidationProblem[] = [];
  for (const { site, text } of sites) {
    const markup = blockMarkup(text);
    if (markup !== null) {
      problems.push({ kind: "proseBlockMarkup", site, markup });
    }
  }
  return problems;
}

/** Every visual in an artifact, located: the overview's first, then each layer's in the
 * depth-first order its ordinal names — so problems read in the order the guide shows them.
 * One walk shared by the structural pass and placement, so the two cannot locate the same
 * visual differently. */
function locatedVisuals(artifact: ReviewArtifact): { site: VisualSite; visual: ReviewVisual }[] {
  const located: { site: VisualSite; visual: ReviewVisual }[] = [];
  if (artifact.overview?.visual !== undefined) {
    located.push({ site: { at: "overview" }, visual: artifact.overview.visual });
  }
  for (const { layer, ordinal } of walkLayerInputs(artifact.layers)) {
    if (layer.visual !== undefined) {
      located.push({ site: { at: "layer", layer: ordinal }, visual: layer.visual });
    }
  }
  return located;
}

/** One visual element with its locator and its claim — what the anchored rules read, whatever
 * kind of visual the element came from. `anchorRequired` is false on an edge: its `at` is
 * optional on every status (`FlowEdge` says why), but held to the same rules when given. */
type LocatedElement = {
  element: VisualElement;
  status: FlowNodeStatus;
  anchorRequired: boolean;
  at: ReviewAnchor | undefined;
};

/** The elements of a visual that carry the anchored rules, flattened over its kind. A closed
 * `switch`, so a third kind of visual does not compile until it says which of its parts are
 * claims about the diff. */
function visualElements(visual: ReviewVisual): LocatedElement[] {
  switch (visual.kind) {
    case "flow":
      return [
        ...visual.nodes.map((node) => ({
          element: { kind: "node" as const, id: node.id },
          status: node.status,
          anchorRequired: node.status !== "same",
          at: node.at,
        })),
        ...visual.edges.map((edge) => ({
          element: { kind: "edge" as const, from: edge.from, to: edge.to },
          // Absent reads as `same`, as the schema publishes.
          status: edge.status ?? "same",
          anchorRequired: false,
          at: edge.at,
        })),
      ];
    case "skeleton":
      return visual.lines.map((line, index) => ({
        element: { kind: "line", line: index + 1 },
        status: line.status,
        anchorRequired: line.status !== "same",
        at: line.at,
      }));
  }
}

/** Every plain-text field of a visual, located — what the markup rule reads. Closed over the
 * kind for `visualElements`' reason: a third kind names its text fields or does not compile. */
function visualTexts(visual: ReviewVisual): { text: VisualText; value: string }[] {
  const texts: { text: VisualText; value: string }[] = [
    { text: { field: "caption" }, value: visual.caption },
  ];
  const push = (element: VisualElement, field: "label" | "note" | "code", value?: string) => {
    if (value !== undefined) {
      texts.push({ text: { field, element }, value });
    }
  };
  switch (visual.kind) {
    case "flow":
      for (const node of visual.nodes) {
        const element: VisualElement = { kind: "node", id: node.id };
        push(element, "label", node.label);
        push(element, "note", node.note);
      }
      for (const edge of visual.edges) {
        push({ kind: "edge", from: edge.from, to: edge.to }, "label", edge.label);
      }
      return texts;
    case "skeleton":
      for (const [index, line] of visual.lines.entries()) {
        const element: VisualElement = { kind: "line", line: index + 1 };
        push(element, "code", line.code);
        push(element, "note", line.note);
      }
      return texts;
  }
}

/** The rules a visual has that need no diff and that zod cannot state, run with the outline:
 *
 * - a node or line whose status is not `same` has an `at` — a changed element must point at
 *   its code, or the picture is an unverified claim;
 * - its text is plain: no code span, no bold (`visualTextMarkup`);
 * - a flow's node ids are unique, and every edge joins two different nodes that exist.
 *
 * Reported once per offence: a duplicated id once (at its second use), a dangling edge once
 * per missing end. A `same` element may still carry an `at` — the unchanged caller pointed at
 * its context lines — and placement checks it like any other. */
export function validateVisuals(artifact: ReviewArtifact): ValidationProblem[] {
  const problems: ValidationProblem[] = [];
  for (const { site, visual } of locatedVisuals(artifact)) {
    for (const { element, anchorRequired, at } of visualElements(visual)) {
      if (anchorRequired && at === undefined) {
        problems.push({ kind: "visualElementUnanchored", visual: site, element });
      }
    }
    for (const { text, value } of visualTexts(visual)) {
      // A skeleton's `code` is source, where a backtick inside the line is usually syntax;
      // only the habit's own shape — the whole line wrapped — is refused there.
      const markup = inlineMarkup(value, text.field === "code" ? "whole" : "any");
      if (markup !== null) {
        problems.push({ kind: "visualTextMarkup", visual: site, text, markup });
      }
    }
    if (visual.kind !== "flow") {
      continue;
    }
    const ids = new Set<string>();
    for (const node of visual.nodes) {
      if (ids.has(node.id)) {
        problems.push({ kind: "flowNodeIdDuplicate", visual: site, id: node.id });
      }
      ids.add(node.id);
    }
    for (const { from, to } of visual.edges) {
      if (from === to) {
        problems.push({ kind: "flowEdgeSelfLoop", visual: site, id: from });
        // A self-loop on a missing id is one mistake, not two: the loop is the shape to fix.
        continue;
      }
      for (const end of [from, to]) {
        if (!ids.has(end)) {
          problems.push({ kind: "flowEdgeDangling", visual: site, from, to, id: end });
        }
      }
    }
  }
  return problems;
}

/** The layers that reach code — their own ranges, or a descendant's — collected in one
 * post-order pass, so the answer for a parent is read off the answers its children already
 * recorded rather than re-walked from it. Asking each node to re-walk its own subtree instead
 * costs the sum of every subtree's size — one full walk per level of nesting — and the depth
 * cap is a rule this pass runs to *enforce*, not one it may assume holds, so the outline that
 * turns that into a quadratic walk is exactly the over-nested one it is here to diagnose. No
 * short-circuit on the children: every one of them has to be visited to record *its* answer,
 * which the caller needs too. */
function reachingLayers(layers: readonly ReviewLayerInput[]): ReadonlySet<ReviewLayerInput> {
  const reaching = new Set<ReviewLayerInput>();
  const visit = (layer: ReviewLayerInput): boolean => {
    let reaches = layer.ranges.length > 0;
    for (const child of layer.children) {
      reaches = visit(child) || reaches;
    }
    if (reaches) {
      reaching.add(layer);
    }
    return reaches;
  };
  for (const layer of layers) {
    visit(layer);
  }
  return reaching;
}

/** Every reason a parsed artifact's anchors would not place against `patch`, or `[]` when
 * they all do. The `patch` is the review's diff — captured at emit time, re-derived from the
 * artifact's own repo/refs afterward, or a rare embedded frozen patch; this places against
 * whichever the caller resolved. Carrying a diff is a property of the parsed content, not the
 * bytes' length: a patch that parses to no file describes no change (absent, empty, or prose
 * that was never a diff), so there is nothing to place against — the root `missingPatch`
 * problem, not a silent pass. */
export function validatePlacement(artifact: ReviewArtifact, patch: string): ValidationProblem[] {
  const files = parsePatch(patch, ANALYSIS_CACHE_KEY);
  if (files.length === 0) {
    return [{ kind: "missingPatch" }];
  }

  const byPath = new Map(files.map((file) => [file.path, file]));
  const problems: ValidationProblem[] = [];

  // The overview's prose runs through the same parser and the same reference rules as a
  // layer description — it is the same markdown tier, rendered by the same
  // component, so a link the app would render dead fails the gate here too.
  if (artifact.overview !== undefined) {
    collectOverviewProse(artifact.overview, byPath, problems);
  }

  // A comment places the way the app's comment surface places it, and there a file
  // answers to both of its names (`filesByAnchorPath`): an anchor authored before a
  // rename hosts on the renamed file, so calling its file absent would fail a review
  // the app renders correctly. Only the comments read through it — a layer range on a
  // pre-rename path is still a real failure, because the app's layer scroll finds a
  // layer's file by its current path alone, and a gate that passed what the app cannot
  // show would be worse than one that fails what it can.
  const commentFiles = filesByAnchorPath(files);
  for (const comment of artifact.comments) {
    const file = commentFiles.get(comment.file);
    if (file === undefined) {
      problems.push({ kind: "commentFileAbsent", anchor: pickAnchor(comment) });
      continue;
    }
    if (resolveAnchor(comment, { kind: "derived", file: file.fileDiff }).status === "outdated") {
      problems.push({
        kind: "commentAnchorOutdated",
        anchor: pickAnchor(comment),
        nearestHunks: nearestHunks(file, comment),
      });
    }
  }

  // A comment's `postable` is the one comment prose the gate reads (`ProseSite` says why).
  // Checked whether or not the comment itself placed: its references are their own claims
  // about the diff, and a draft that fixes one problem at a time should hear about both.
  for (const comment of artifact.comments) {
    if (comment.postable !== undefined) {
      collectReferenceProblems(
        { at: "comment", anchor: pickAnchor(comment) },
        comment.postable,
        byPath,
        problems,
      );
    }
  }

  // Depth-first, so a problem's ordinal names the layer the same way the outline will.
  for (const { layer, ordinal } of walkLayerInputs(artifact.layers)) {
    // Empty `ranges` is a valid parent rollup, not a "nothing
    // placed" failure: the loop simply has no range to check.
    for (const [index, range] of layer.ranges.entries()) {
      // A whole-file range places iff its file is in the diff by current path — the rule a
      // line range's file lookup follows — and then it places everywhere in it by definition.
      if (range.side === undefined) {
        if (!byPath.has(range.file)) {
          problems.push({
            kind: "layerFileAbsent",
            layer: ordinal,
            range: index + 1,
            file: range.file,
            nearestFiles: nearestPaths(range.file, [...byPath.keys()]),
          });
        }
        continue;
      }
      const misplaced = misplacement(range, byPath);
      if (misplaced !== null) {
        problems.push({
          kind: "layerRangeOutdated",
          layer: ordinal,
          range: index + 1,
          ...misplaced,
        });
      }
    }
    if (layer.summary !== undefined) {
      collectReferenceProblems(
        { at: "layerSummary", layer: ordinal },
        layer.summary,
        byPath,
        problems,
      );
    }
    if (layer.description !== undefined) {
      collectReferenceProblems(
        { at: "layer", layer: ordinal },
        layer.description,
        byPath,
        problems,
      );
    }
    if (layer.focus !== undefined) {
      const misplaced = misplacement(layer.focus, byPath);
      if (misplaced !== null) {
        problems.push({ kind: "layerFocusOutdated", layer: ordinal, ...misplaced });
      }
    }
  }

  // Every element's `at`, the overview's visual first and then the layers' in outline order.
  // Placed by the current path only, the layer-range rule rather than the comment one: an
  // element's badge is the layer that owns its anchor, and ownership compares against range
  // paths, so a pre-rename `at` would place here and then wear no badge in the app. Only an
  // `at` that places is then held to its status — one that does not has one thing to fix.
  const changedByFile = new Map<PatchFile, ChangedLines>();
  for (const { site, visual } of locatedVisuals(artifact)) {
    for (const { element, status, at } of visualElements(visual)) {
      if (at === undefined) {
        continue;
      }
      const misplaced = misplacement(at, byPath);
      if (misplaced !== null) {
        problems.push({ kind: "visualAnchorOutdated", visual: site, element, ...misplaced });
        continue;
      }
      const file = byPath.get(at.file);
      if (status === "same" || file === undefined) {
        continue;
      }
      let changed = changedByFile.get(file);
      if (changed === undefined) {
        changed = changedLines(file);
        changedByFile.set(file, changed);
      }
      const mismatch = statusMismatch(status, at, changed[at.side]);
      if (mismatch !== null) {
        problems.push({ visual: site, element, ...mismatch });
      }
    }
  }

  return problems;
}

/** Where a placed `at` contradicts its element's status, or null when it agrees:
 *
 * - `added` sits on `additions`, `removed` on `deletions` — the side the claimed lines exist on;
 * - the range holds at least one line of the claimed kind on its side: an added line, a removed
 *   line, or for `changed` either — whichever side it was written on.
 *
 * "At least one", not "only": a node's range is the function it names, and a changed function
 * is mostly context. `sideChanged` is the changed-line set of the anchor's own side, so the second rule
 * is one membership test per line of the range. */
function statusMismatch(
  status: ClaimedStatus,
  at: AnchorSpan,
  sideChanged: ReadonlySet<number>,
):
  | { kind: "visualStatusWrongSide"; status: "added" | "removed"; anchor: AnchorSpan }
  | {
      kind: "visualStatusOnContext";
      status: ClaimedStatus;
      anchor: AnchorSpan;
      changedRuns: PlaceableSpan[];
    }
  | null {
  if (status !== "changed" && at.side !== STATUS_SIDE[status]) {
    return { kind: "visualStatusWrongSide", status, anchor: pickAnchor(at) };
  }
  for (let line = at.startLine; line <= at.endLine; line += 1) {
    if (sideChanged.has(line)) {
      return null;
    }
  }
  return {
    kind: "visualStatusOnContext",
    status,
    anchor: pickAnchor(at),
    changedRuns: nearestSpans(contiguousRuns(sideChanged), at),
  };
}

/** The side whose lines an added or a removed element names. */
const STATUS_SIDE = { added: "additions", removed: "deletions" } as const satisfies Record<
  "added" | "removed",
  ReviewSide
>;

/** A side's changed lines as contiguous runs, in file order — the spans `visualStatusOnContext`
 * offers as the fix. */
function contiguousRuns(lines: ReadonlySet<number>): PlaceableSpan[] {
  const runs: PlaceableSpan[] = [];
  for (const line of [...lines].toSorted((a, b) => a - b)) {
    const last = runs.at(-1);
    if (last !== undefined && line === last.endLine + 1) {
      last.endLine = line;
    } else {
      runs.push({ startLine: line, endLine: line });
    }
  }
  return runs;
}

/** The overview's prose, part by part — `body`, `lede`, each step — each its own `ProseSite`
 * so a dead reference names the line of the guide it sits on. All three are the same markdown
 * tier with the same reference grammar; `lede` and `steps` are only *rendered* inline. */
function collectOverviewProse(
  overview: ReviewOverview,
  byPath: ReadonlyMap<string, PatchFile>,
  problems: ValidationProblem[],
): void {
  if (overview.lede !== undefined) {
    collectReferenceProblems({ at: "overviewLede" }, overview.lede, byPath, problems);
  }
  for (const [index, step] of (overview.steps ?? []).entries()) {
    collectReferenceProblems({ at: "overviewStep", step: index + 1 }, step, byPath, problems);
  }
  if (overview.body !== undefined) {
    collectReferenceProblems({ at: "overviewBody" }, overview.body, byPath, problems);
  }
}

/** Where an anchor looked up by its file's current path fails to place: its locator and the
 * nearest hunks (null when the file is not in the diff at all), or null when it places. The
 * one spelling of the layer-range rule, shared by the anchors that follow it — a range, a
 * focus, a visual's `at` — so the three cannot drift apart. */
function misplacement(
  anchor: AnchorSpan,
  byPath: ReadonlyMap<string, PatchFile>,
): { anchor: AnchorSpan; nearestHunks: PlaceableSpan[] | null } | null {
  const file = byPath.get(anchor.file) ?? null;
  if (
    resolveAnchor(anchor, { kind: "derived", file: file?.fileDiff ?? null }).status !== "outdated"
  ) {
    return null;
  }
  return {
    anchor: pickAnchor(anchor),
    nearestHunks: file === null ? null : nearestHunks(file, anchor),
  };
}

/** A `[label](path)` link whose target is a path is an explicit navigation target; a path
 * not in the diff renders muted and dead, which the validator promotes to a hard error. A
 * web link is not a file reference and is left alone — it opens in the browser. A
 * `` `code` `` span is *not* checked either: inline code is ordinarily prose (a symbol
 * name), and its file-chip promotion is an opt-in nicety — flagging every non-file
 * span would reject legitimate descriptions, breaking the "zero manual fixing" bar.
 *
 * A `path:12` reference is held to one rule more: the line range is placed by the *same*
 * `resolveAnchor` a comment anchor is, against the same file, in derived mode — so a
 * reference that survives this is a second location the reader can actually be sent to,
 * and the drift that strands a comment strands a reference identically rather than
 * scrolling the reader to a line that moved. The path is looked up by its current name
 * only, exactly as a layer range is: the reference chip navigates through the same
 * path-keyed item the layer scroll does, and a gate that passed what the app cannot show
 * would be worse than one that fails what it can. */
function collectReferenceProblems(
  site: ProseSite,
  prose: string,
  byPath: ReadonlyMap<string, PatchFile>,
  problems: ValidationProblem[],
): void {
  const { references, malformed } = proseReferences(prose);
  for (const reference of malformed) {
    problems.push({
      kind: "malformedReference",
      site,
      label: reference.label,
      url: reference.url,
      why: reference.why,
    });
  }
  for (const reference of references) {
    const file = byPath.get(reference.path);
    if (file === undefined) {
      problems.push({
        kind: "unresolvedLink",
        site,
        label: reference.label,
        url: reference.url,
        path: reference.path,
      });
      continue;
    }
    if (reference.span === null) {
      continue;
    }
    const anchor = { file: reference.path, ...reference.span };
    if (resolveAnchor(anchor, { kind: "derived", file: file.fileDiff }).status === "outdated") {
      problems.push({
        kind: "referenceOutdated",
        site,
        anchor: pickAnchor(anchor),
        nearestHunks: nearestHunks(file, anchor),
      });
    }
  }
}

/** How many hunks a problem names. A generated file can carry a hundred, and a hint that long
 * is the `rvw diff` output it exists to replace; the few nearest the authored lines are the
 * ones the author meant. */
const MAX_NEAREST_HUNKS = 4;

/** The same-side hunks closest to where the anchor was authored, in file order. Spans are
 * `hunkSpan`'s — the header geometry `resolveAnchor` itself asks — so every span named here
 * is one the gate will accept an anchor inside. A side with no lines in a hunk (additions on
 * a pure deletion) yields an empty span and is left out. */
function nearestHunks(file: PatchFile, anchor: AnchorSpan): PlaceableSpan[] {
  const side: ReviewSide = anchor.side;
  return nearestSpans(
    file.fileDiff.hunks
      .map((hunk) => hunkSpan(hunk, side))
      .filter((span) => span.end >= span.start)
      .map((span) => ({ startLine: span.start, endLine: span.end })),
    anchor,
  );
}

/** The few spans closest to where an anchor was authored, in file order — the one ranking the
 * hunk hint and the changed-run hint share, so both name the same few and in the same order. */
function nearestSpans(spans: readonly PlaceableSpan[], anchor: AnchorSpan): PlaceableSpan[] {
  const distance = (span: PlaceableSpan): number =>
    Math.max(0, span.startLine - anchor.endLine, anchor.startLine - span.endLine);
  return spans
    .toSorted((a, b) => distance(a) - distance(b))
    .slice(0, MAX_NEAREST_HUNKS)
    .toSorted((a, b) => a.startLine - b.startLine);
}

/** How many changed paths a `layerFileAbsent` hint names — the `MAX_NEAREST_HUNKS` reason. */
const MAX_NEAREST_FILES = 5;

/** The changed paths most like one the diff does not carry, best first: a path ending in the
 * same file name ranks above one that does not (a moved file, a wrong directory), then the
 * longer shared leading directory wins (a typo in the name), then diff order. The fix for a
 * wrong path is usually one of these, and the full list is `rvw diff`'s to print. */
function nearestPaths(path: string, changed: readonly string[]): string[] {
  const segments = path.split("/");
  const name = segments.at(-1);
  const score = (candidate: string): number => {
    const other = candidate.split("/");
    let shared = 0;
    while (shared < segments.length && segments[shared] === other[shared]) {
      shared += 1;
    }
    return (other.at(-1) === name ? 1000 : 0) + shared;
  };
  return changed
    .map((candidate, index) => ({ candidate, index, score: score(candidate) }))
    .toSorted((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, MAX_NEAREST_FILES)
    .map((entry) => entry.candidate);
}

/** The locator alone, picked out of whatever anchor-shaped value carried it: a comment also
 * carries its `body` and its `postable`, which are prose the report has no business repeating
 * back — `--json` serializes a problem whole. A layer range is already exactly these four
 * fields and goes through it anyway, so a problem's anchor is the locator and nothing else
 * however the anchor reached here. */
function pickAnchor(source: AnchorSpan): AnchorSpan {
  return {
    file: source.file,
    side: source.side,
    startLine: source.startLine,
    endLine: source.endLine,
  };
}

/** A one-line, human-readable rendering of a problem for the CLI's stderr report.
 * Pure so the effectful shell stays a thin `map` + `write`. */
export function describeProblem(problem: ValidationProblem): string {
  switch (problem.kind) {
    case "invalidJson":
      return `not valid JSON: ${problem.message}`;
    case "schema":
      return `schema: ${problem.path === "" ? "(root)" : problem.path} — ${problem.message}`;
    case "missingPatch":
      return "no diff to place anchors against — the range has no changes";
    case "commentAnchorOutdated":
      return `comment anchor does not place in the diff: ${locator(problem.anchor)}${hunkHint(problem.nearestHunks)}`;
    case "commentFileAbsent":
      return `comment references a file absent from the diff: ${locator(problem.anchor)}`;
    case "layerRangeOutdated":
      return `layer ${problem.layer}, range ${problem.range} does not place in the diff: ${locator(problem.anchor)}${hunkHint(problem.nearestHunks)}`;
    case "layerFileAbsent":
      return `layer ${problem.layer}, range ${problem.range} names ${problem.file}, which is not in the diff${problem.nearestFiles.length === 0 ? "" : `; changed files nearest that path: ${problem.nearestFiles.join(", ")}`}`;
    case "nestingTooDeep":
      return `layer ${problem.layer} is ${problem.depth} levels deep — nesting stops at ${MAX_LAYER_DEPTH}`;
    case "layerWalksNothing":
      return `layer ${problem.layer} walks no code: it has no ranges, and nothing under it has any`;
    case "unresolvedLink":
      return `${proseAt(problem.site)} links [${problem.label}](${problem.url}) — ${problem.path} is not in the diff`;
    case "referenceOutdated":
      return `${proseAt(problem.site)} references a line range that does not place in the diff: ${locator(problem.anchor)}${hunkHint(problem.nearestHunks)}`;
    case "malformedReference":
      return `${proseAt(problem.site)} ${malformedHint(problem.why, problem.label, problem.url)}`;
    case "layerFocusOutdated":
      return `layer ${problem.layer} focus does not place in the diff: ${locator(problem.anchor)}${hunkHint(problem.nearestHunks)}`;
    case "visualAnchorOutdated":
      return `${elementAt(problem.visual, problem.element)} has an \`at\` that does not place in the diff: ${locator(problem.anchor)}${hunkHint(problem.nearestHunks)}`;
    case "visualElementUnanchored":
      return `${elementAt(problem.visual, problem.element)} is marked as a change but has no \`at\` — a changed element must point at its code`;
    case "flowNodeIdDuplicate":
      return `${visualAt(problem.visual)} has two nodes with id "${problem.id}" — node ids must be unique`;
    case "flowEdgeDangling":
      return `${elementAt(problem.visual, { kind: "edge", from: problem.from, to: problem.to })} names node "${problem.id}", which is not in its nodes`;
    case "flowEdgeSelfLoop":
      return `${elementAt(problem.visual, { kind: "edge", from: problem.id, to: problem.id })} joins node "${problem.id}" to itself`;
    case "visualTextMarkup":
      return `${textAt(problem.visual, problem.text)} ${markupHint(problem.markup)}`;
    case "proseBlockMarkup":
      return `${proseAt(problem.site)} ${blockHint(problem.markup)} — it is drawn inline, on one line, where a block breaks the layout; keep it to text, code spans and references, or escape the marker with a backslash`;
    case "visualStatusWrongSide":
      return `${elementAt(problem.visual, problem.element)} is ${problem.status} but its \`at\` is on the ${problem.anchor.side} side — ${claimRule(problem.status, problem.element)}`;
    case "visualStatusOnContext":
      return `${elementAt(problem.visual, problem.element)} is ${problem.status} but ${locator(problem.anchor)} is all context — ${claimRule(problem.status, problem.element)}${runsHint(problem.status, problem.changedRuns)}`;
    case "layerFocusOutsideLayer":
      return problem.owner === null
        ? `layer ${problem.layer} focus ${locator(problem.anchor)} is outside the layer — no layer's ranges cover it; a focus must be lines this layer or one under it owns, so point it at this chapter's code, or add those lines to its ranges`
        : `layer ${problem.layer} focus ${locator(problem.anchor)} belongs to layer ${problem.owner}, whose ranges claim those lines more specifically (deeper, or a line range over a whole-file one) — the guide would badge it ${problem.owner}; point it at lines this layer owns, or move those lines into its ranges`;
  }
}

/** What an element's status requires of its `at`, as one teaching clause: "an added node must
 * point at added lines, on additions". */
function claimRule(status: ClaimedStatus, element: VisualElement): string {
  const noun = ELEMENT_NOUN[element.kind];
  switch (status) {
    case "added":
      return `an added ${noun} must point at added lines, on additions`;
    case "removed":
      return `a removed ${noun} must point at removed lines, on deletions`;
    case "changed":
      return `a changed ${noun} must point at a range holding at least one changed line`;
  }
}

const ELEMENT_NOUN = {
  node: "node",
  edge: "edge",
  line: "skeleton line",
} as const satisfies Record<VisualElement["kind"], string>;

/** The changed runs to move an all-context `at` onto, or why there are none on that side. */
function runsHint(status: ClaimedStatus, runs: readonly PlaceableSpan[]): string {
  if (runs.length === 0) {
    return status === "changed"
      ? "; that side of the file has no changed lines — try the other side"
      : "; that side of the file has no such lines";
  }
  return `; nearest changed lines on that side: ${runs.map((run) => spanText(run)).join(", ")}`;
}

/** Why visual text may not carry markup, by the markup found — closed, a sentence per form. */
function markupHint(markup: InlineMarkup): string {
  switch (markup) {
    case "code":
      return "has a `code` span — visual text is plain and drawn as-is, so the backticks would show; write the symbol bare";
    case "strong":
      return "has **bold** — visual text is plain and drawn as-is, so the asterisks would show; the status already marks what changed";
  }
}

/** What a block construct in inline prose was read as, and from what — closed, a clause per
 * form, so the author can see which characters to change. */
function blockHint(markup: BlockMarkup): string {
  switch (markup) {
    case "heading":
      return "starts with `#`, which makes it a heading";
    case "blockquote":
      return "starts with `>`, which makes it a block quote";
    case "list":
      return "starts with a list marker (`-`, `*`, `+`, `1.` or `1)`), which makes it a list — the app numbers steps itself";
    case "code":
      return "is a code block (a ``` fence, or four spaces of indent)";
    case "table":
      return "is a table";
    case "thematicBreak":
      return "is a horizontal rule (`---`, `***` or `___`)";
  }
}

/** One plain-text field of a visual, as the report names it. */
function textAt(site: VisualSite, text: VisualText): string {
  return text.field === "caption"
    ? `${visualAt(site)} caption`
    : `${elementAt(site, text.element)} ${text.field}`;
}

/** The visual a problem was found in, as the report names it. */
function visualAt(site: VisualSite): string {
  switch (site.at) {
    case "overview":
      return "overview visual";
    case "layer":
      return `layer ${site.layer} visual`;
  }
}

/** One element of a visual, as the report names it: a node by the id the author wrote, a line
 * by its position. */
function elementAt(site: VisualSite, element: VisualElement): string {
  switch (element.kind) {
    case "node":
      return `${visualAt(site)}, node "${element.id}"`;
    case "edge":
      return `${visualAt(site)}, edge ${element.from}→${element.to}`;
    case "line":
      return `${visualAt(site)}, line ${element.line}`;
  }
}

/** The malformed reference as written, and the fix — one sentence per form, closed so a third
 * form cannot reach the report without one. */
function malformedHint(why: MalformedForm, label: string, url: string): string {
  switch (why) {
    case "suffix":
      return `links [${label}](${url}) — a line reference reads path:12, path:12-20 or path:12-20@deletions`;
    case "definition":
      return `defines [${label}]: ${url} — write the reference inline: [label](path:lines)`;
  }
}

/** The prose a reference problem was found in, as the report names it — the phrase the two
 * link problems used to spell out in a message each. */
function proseAt(site: ProseSite): string {
  switch (site.at) {
    case "overviewBody":
      return "overview body";
    case "overviewLede":
      return "overview lede";
    case "overviewStep":
      return `overview step ${site.step}`;
    case "layer":
      return `layer ${site.layer} description`;
    case "layerSummary":
      return `layer ${site.layer} summary`;
    case "comment":
      return `postable of the comment at ${locator(site.anchor)}`;
  }
}

/** What to change the lines *to*, appended to an outdated locator. States the rule once (one
 * hunk, never two) because a range that straddles two hunks is the commonest way to miss. */
function hunkHint(hunks: readonly PlaceableSpan[] | null): string {
  if (hunks === null) {
    return " — that file is not in the diff";
  }
  if (hunks.length === 0) {
    return " — that file has no hunk on that side";
  }
  const spans = hunks.map((span) => spanText(span)).join(", ");
  return ` — it must sit inside one hunk; nearest on that side: ${spans}`;
}

function spanText(span: PlaceableSpan): string {
  return `${span.startLine}-${span.endLine}`;
}

function locator(anchor: AnchorSpan): string {
  return `${anchor.file} ${anchor.side} ${anchor.startLine}-${anchor.endLine}`;
}
