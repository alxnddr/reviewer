import {
  ReviewArtifact,
  walkLayerInputs,
  type ReviewLayerInput,
  type ReviewSide,
} from "../shared/review";
import { resolveAnchor } from "../renderer/src/lib/diff/anchor";
import { parsePatch } from "../renderer/src/lib/diff/patch";
import { blockInlineRuns, parseLayerDescription } from "../renderer/src/lib/layer-description";
import { MAX_LAYER_DEPTH } from "../renderer/src/lib/layers";

// The pre-handoff check an agent runs on a `.reviewer.json` before giving it over. It reuses
// the review domain rather than re-deriving it: the *same* `resolveAnchor`/`parsePatch`/
// `parseLayerDescription` the app anchors and renders with — run in **derived** mode against
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
  | { kind: "commentAnchorOutdated"; anchor: ProblemAnchor }
  | { kind: "commentFileAbsent"; anchor: ProblemAnchor }
  | { kind: "layerRangeOutdated"; layer: string; anchor: ProblemAnchor }
  /** What is left of the outline contract once `children` carries the shape: an outline no
   * deeper than the reader can follow, in which every layer reaches some code — its own, or
   * its children's. */
  | { kind: "nestingTooDeep"; layer: string; depth: number }
  | { kind: "layerWalksNothing"; layer: string }
  | { kind: "unresolvedLink"; layer: string; label: string; path: string }
  /** The same dead-link rule applied to the overview's prose, which sits under no layer to
   * name — a separate variant rather than a nullable `layer`, so neither locator can
   * be built empty. */
  | { kind: "overviewUnresolvedLink"; label: string; path: string };

/** The `file + side + range` locator shared by every anchor-shaped problem, so a
 * report points at the exact spot. */
export type ProblemAnchor = {
  file: string;
  side: ReviewSide;
  startLine: number;
  endLine: number;
};

export type ValidationReport = { ok: true } | { ok: false; problems: ValidationProblem[] };

/** Untrusted bytes turned into a typed artifact, or the schema problems that stopped it —
 * the parse-don't-trust step every CLI verb runs before it can place an anchor. */
export type ParsedArtifact =
  | { ok: true; artifact: ReviewArtifact }
  | { ok: false; problems: ValidationProblem[] };

// The prefix `parsePatch` requires to key its highlight cache; the validator never
// renders, so any stable non-empty value works — it just must not be omitted (an
// absent key collides equally-named files, per patch.ts).
const CACHE_KEY = "validate";

/** Untrusted artifact bytes → a typed artifact, or every reason it could not parse. Never
 * throws: malformed JSON and schema violations are reported as typed problems (the input is
 * untrusted). Placement is not checked here — the caller supplies the diff to place against
 * (`validatePlacement`), which the CLI re-derives from the artifact's own repo/refs. */
export function parseReviewArtifact(bytes: string): ParsedArtifact {
  let json: unknown;
  try {
    json = JSON.parse(bytes);
  } catch (error) {
    return { ok: false, problems: [{ kind: "invalidJson", message: errorMessage(error) }] };
  }

  const parsed = ReviewArtifact.safeParse(json);
  if (!parsed.success) {
    // Can't anchor an artifact we couldn't parse — report every schema issue and stop.
    return {
      ok: false,
      problems: parsed.error.issues.map((issue) => ({
        kind: "schema",
        path: issue.path.map(String).join("."),
        message: issue.message,
      })),
    };
  }

  // Structure is checked here, with the parse: it needs no diff, and an artifact whose
  // layers do not form a legal outline is not ready to hand over however well its anchors
  // place. The app reads a broken outline as flat rather than refusing to open — this is
  // the seam that keeps one from ever being emitted.
  const structural = validateOutline(parsed.data.layers);
  if (structural.length > 0) {
    return { ok: false, problems: structural };
  }

  return { ok: true, artifact: parsed.data };
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

  // Reach: a layer with no ranges of its own must have a descendant that has some.
  const reaches = (layer: ReviewLayerInput): boolean =>
    layer.ranges.length > 0 || layer.children.some(reaches);

  for (const { layer, ordinal, depth } of walkLayerInputs(layers)) {
    if (depth > MAX_LAYER_DEPTH) {
      problems.push({ kind: "nestingTooDeep", layer: ordinal, depth });
    }
    if (!reaches(layer)) {
      problems.push({ kind: "layerWalksNothing", layer: ordinal });
    }
  }

  return problems;
}

/** Every reason a parsed artifact's anchors would not place against `patch`, or `[]` when
 * they all do. The `patch` is the review's diff — captured at emit time, re-derived from the
 * artifact's own repo/refs afterward, or a rare embedded frozen patch; this places against
 * whichever the caller resolved. Carrying a diff is a property of the parsed content, not the
 * bytes' length: a patch that parses to no file describes no change (absent, empty, or prose
 * that was never a diff), so there is nothing to place against — the root `missingPatch`
 * problem, not a silent pass. */
export function validatePlacement(artifact: ReviewArtifact, patch: string): ValidationProblem[] {
  const files = parsePatch(patch, CACHE_KEY);
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
    for (const block of parseLayerDescription(artifact.overview.body, diffFiles)) {
      for (const run of blockInlineRuns(block)) {
        if (run.kind === "link" && run.file === null) {
          problems.push({ kind: "overviewUnresolvedLink", label: run.label, path: run.path });
        }
      }
    }
  }

  for (const comment of artifact.comments) {
    const file = byPath.get(comment.file);
    if (file === undefined) {
      problems.push({ kind: "commentFileAbsent", anchor: anchorOf(comment) });
      continue;
    }
    if (resolveAnchor(comment, { kind: "derived", file: file.fileDiff }).status === "outdated") {
      problems.push({ kind: "commentAnchorOutdated", anchor: anchorOf(comment) });
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
        problems.push({ kind: "layerRangeOutdated", layer: ordinal, anchor: anchorOf(range) });
      }
    }
    collectUnresolvedLinks(ordinal, layer.description, diffFiles, problems);
  }

  return problems;
}

/** A `[label](path)` link is an explicit navigation target; a path not in the diff
 * renders muted and dead, which the validator promotes to a hard error. A
 * `` `code` `` span is *not* checked: inline code is ordinarily prose (a symbol
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
  for (const block of parseLayerDescription(description, diffFiles)) {
    for (const run of blockInlineRuns(block)) {
      if (run.kind === "link" && run.file === null) {
        problems.push({ kind: "unresolvedLink", layer, label: run.label, path: run.path });
      }
    }
  }
}

function anchorOf(source: ProblemAnchor): ProblemAnchor {
  return {
    file: source.file,
    side: source.side,
    startLine: source.startLine,
    endLine: source.endLine,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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

function locator(anchor: ProblemAnchor): string {
  return `${anchor.file} ${anchor.side} ${anchor.startLine}-${anchor.endLine}`;
}
