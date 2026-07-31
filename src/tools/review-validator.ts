import * as z from "zod";
import {
  ARTIFACT_JSON_FORMAT,
  parseArtifactBytes,
  walkLayerInputs,
  type AnchorSpan,
  type ReviewArtifact,
  type ReviewLayerInput,
} from "../shared/review";
import { resolveAnchor } from "../shared/diff/anchor";
import { ANALYSIS_CACHE_KEY, filesByAnchorPath, parsePatch } from "../shared/diff/patch";
import { fileReferences } from "../shared/markdown";
import { MAX_LAYER_DEPTH } from "../shared/layers";

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
  | { kind: "commentAnchorOutdated"; anchor: AnchorSpan }
  | { kind: "commentFileAbsent"; anchor: AnchorSpan }
  | { kind: "layerRangeOutdated"; layer: string; anchor: AnchorSpan }
  /** What is left of the outline contract once `children` carries the shape: an outline no
   * deeper than the reader can follow, in which every layer reaches some code — its own, or
   * its children's. A chain past the cap reports once, at its shallowest offender — the one
   * layer there is to unnest — so `depth` is always exactly one past the cap. */
  | { kind: "nestingTooDeep"; layer: string; depth: number }
  | { kind: "layerWalksNothing"; layer: string }
  | { kind: "unresolvedLink"; layer: string; label: string; path: string }
  /** The same dead-link rule applied to the overview's prose, which sits under no layer to
   * name — a separate variant rather than a nullable `layer`, so neither locator can
   * be built empty. */
  | { kind: "overviewUnresolvedLink"; label: string; path: string };

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
  const structural = validateOutline(parsed.artifact.layers);
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
 * The locator is zod's own `toDotPath` rather than a `join(".")`: it brackets array indices
 * (`comments[0].side`) and escapes a key that contains a dot, so the path an authoring agent
 * reads back names exactly one place in the document. */
function problemOfIssue(issue: z.core.$ZodIssue): ValidationProblem {
  return issue.code === "invalid_format" && issue.format === ARTIFACT_JSON_FORMAT
    ? { kind: "invalidJson", message: issue.message }
    : { kind: "schema", path: z.core.toDotPath(issue.path), message: issue.message };
}

/** What is left of the outline contract once the outline is a real tree on the wire:
 *
 * - it is at most `MAX_LAYER_DEPTH` levels deep, and
 * - every layer reaches some code — its own ranges, or a descendant's.
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

  for (const { layer, ordinal, depth } of walkLayerInputs(layers)) {
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
  const diffFiles = new Set(files.map((file) => file.path));
  const problems: ValidationProblem[] = [];

  // The overview's prose runs through the same parser and the same dead-link rule as a
  // layer description — it is the same markdown tier, rendered by the same
  // component, so a link the app would render dead fails the gate here too.
  if (artifact.overview !== undefined) {
    for (const reference of fileReferences(artifact.overview.body)) {
      if (!diffFiles.has(reference.path)) {
        problems.push({
          kind: "overviewUnresolvedLink",
          label: reference.label,
          path: reference.path,
        });
      }
    }
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
      problems.push({ kind: "commentAnchorOutdated", anchor: pickAnchor(comment) });
    }
  }

  // Depth-first, so a problem's ordinal names the layer the same way the outline will.
  for (const { layer, ordinal } of walkLayerInputs(artifact.layers)) {
    // Empty `ranges` is a valid parent rollup, not a "nothing
    // placed" failure: the loop simply has no range to check.
    for (const range of layer.ranges) {
      const file = byPath.get(range.file) ?? null;
      const resolution = resolveAnchor(range, { kind: "derived", file: file?.fileDiff ?? null });
      if (resolution.status === "outdated") {
        problems.push({ kind: "layerRangeOutdated", layer: ordinal, anchor: pickAnchor(range) });
      }
    }
    collectUnresolvedLinks(ordinal, layer.description, diffFiles, problems);
  }

  return problems;
}

/** A `[label](path)` link whose target is a path is an explicit navigation target; a path
 * not in the diff renders muted and dead, which the validator promotes to a hard error. A
 * web link is not a file reference and is left alone — it opens in the browser. A
 * `` `code` `` span is *not* checked either: inline code is ordinarily prose (a symbol
 * name), and its file-chip promotion is an opt-in nicety — flagging every non-file
 * span would reject legitimate descriptions, breaking the "zero manual fixing" bar. */
function collectUnresolvedLinks(
  layer: string,
  description: string | undefined,
  diffFiles: ReadonlySet<string>,
  problems: ValidationProblem[],
): void {
  if (description === undefined) {
    return;
  }
  for (const reference of fileReferences(description)) {
    if (!diffFiles.has(reference.path)) {
      problems.push({
        kind: "unresolvedLink",
        layer,
        label: reference.label,
        path: reference.path,
      });
    }
  }
}

/** The locator alone, picked out of whatever anchor-shaped value carried it: a comment also
 * carries its `body`, which is prose the report has no business repeating back. A layer range
 * is already exactly these four fields and goes through it anyway, so a problem's anchor is
 * the locator and nothing else however the anchor reached here. */
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
      return `comment anchor does not place in the diff: ${locator(problem.anchor)}`;
    case "commentFileAbsent":
      return `comment references a file absent from the diff: ${locator(problem.anchor)}`;
    case "layerRangeOutdated":
      return `layer ${problem.layer} range does not place in the diff: ${locator(problem.anchor)}`;
    case "nestingTooDeep":
      return `layer ${problem.layer} is ${problem.depth} levels deep — nesting stops at ${MAX_LAYER_DEPTH}`;
    case "layerWalksNothing":
      return `layer ${problem.layer} walks no code: it has no ranges, and nothing under it has any`;
    case "unresolvedLink":
      return `layer ${problem.layer} description links [${problem.label}](${problem.path}) — path is not in the diff`;
    case "overviewUnresolvedLink":
      return `overview body links [${problem.label}](${problem.path}) — path is not in the diff`;
  }
}

function locator(anchor: AnchorSpan): string {
  return `${anchor.file} ${anchor.side} ${anchor.startLine}-${anchor.endLine}`;
}
