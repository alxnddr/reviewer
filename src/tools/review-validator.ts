import { ReviewArtifact, type ReviewLayer, type ReviewSide } from "../shared/review";
import { resolveAnchor } from "../renderer/src/lib/diff/anchor";
import { parsePatch } from "../renderer/src/lib/diff/patch";
import { blockInlineRuns, parseLayerDescription } from "../renderer/src/lib/layer-description";
import { layerDocumentOrder, MAX_LAYER_DEPTH } from "../renderer/src/lib/layers";

// The pre-handoff check an agent runs on a `.reviewer.json` before giving it over. It reuses
// the review domain rather than re-deriving it: the *same* `resolveAnchor`/`parsePatch`/
// `parseLayerDescription` the app anchors and renders with — run in **derived** mode against
// the review's diff, so a pass provably implies "it opens in Reviewer with zero manual
// fixing"; a re-implemented checker would drift and break that guarantee. Split into two pure
// steps: `parseReviewArtifact` turns untrusted bytes into a typed artifact (or schema
// problems), and `validatePlacement` places every anchor against a diff the caller supplies —
// the CLI captures it at emit time and re-derives it from the artifact's `source` afterward,
// so the same check runs whether the diff is embedded/frozen or freshly derived. Pure and
// I/O-free: the CLI shell owns the filesystem read, the git spawn, and `process.exit`; this
// module only decides.

/** One reason an artifact is not ready to hand over. Each variant carries enough
 * locator for the authoring agent to find and fix the offending anchor, range, or
 * link — illegal states (e.g. a comment problem with no line range) can't be built. */
export type ValidationProblem =
  | { kind: "invalidJson"; message: string }
  | { kind: "schema"; path: string; message: string }
  | { kind: "missingPatch" }
  | { kind: "commentAnchorOutdated"; anchor: ProblemAnchor }
  | { kind: "commentFileAbsent"; anchor: ProblemAnchor }
  | { kind: "layerRangeOutdated"; layerId: string; anchor: ProblemAnchor }
  /** The outline contract, one variant per way to break it: `layers` is a tree, written in
   * document order, no deeper than the reader can follow, and every layer in it reaches
   * some code — its own, or its children's. */
  | { kind: "parentNotFound"; layerId: string; parent: string }
  | { kind: "parentCycle"; layerId: string }
  | { kind: "nestingTooDeep"; layerId: string; depth: number }
  | { kind: "layerWalksNothing"; layerId: string }
  | { kind: "outOfDocumentOrder"; layerId: string }
  | { kind: "unresolvedLink"; layerId: string; label: string; path: string }
  /** The same dead-link rule applied to the overview's prose, which has no layer id to
   * name — a separate variant rather than a nullable `layerId`, so neither locator can
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
 * (`validatePlacement`), which the CLI re-derives from `artifact.source`. */
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

/** The outline contract:
 *
 * - a `parent` names a layer that exists and is not itself (no dangling links),
 * - the `parent` chain terminates (no cycles),
 * - it is at most `MAX_LAYER_DEPTH` levels deep,
 * - every layer reaches some code — its own ranges, or a descendant's, and
 * - the array **is** the document: a subtree is contiguous and follows its parent.
 *
 * The last one is what lets every surface treat the array as the reading order without
 * re-sorting it, and the depth-and-reach rules are what keep a group meaningful: a layer
 * that walks nothing at all is an outline entry with no review behind it. Ranges on a
 * parent are *allowed* — a layer's extent is its own ranges plus its descendants', one
 * rule at every level — so nothing here has to arbitrate between the two. */
export function validateOutline(layers: readonly ReviewLayer[]): ValidationProblem[] {
  const byId = new Map(layers.map((layer) => [layer.id, layer]));
  const problems: ValidationProblem[] = [];
  const childrenOf = new Map<string, ReviewLayer[]>();
  let linksAreSound = true;

  for (const layer of layers) {
    if (layer.parent === undefined) {
      continue;
    }
    const parent = byId.get(layer.parent);
    if (parent === undefined || parent.id === layer.id) {
      problems.push({ kind: "parentNotFound", layerId: layer.id, parent: layer.parent });
      linksAreSound = false;
      continue;
    }
    const siblings = childrenOf.get(parent.id);
    if (siblings === undefined) {
      childrenOf.set(parent.id, [layer]);
    } else {
      siblings.push(layer);
    }

    // Depth is measured by walking up; the visited guard turns a cycle into a reported
    // problem instead of a hang.
    const seen = new Set<string>([layer.id]);
    let depth = 1;
    let current: ReviewLayer | undefined = parent;
    while (current !== undefined) {
      if (seen.has(current.id)) {
        problems.push({ kind: "parentCycle", layerId: layer.id });
        linksAreSound = false;
        depth = 0;
        break;
      }
      seen.add(current.id);
      depth += 1;
      current = current.parent === undefined ? undefined : byId.get(current.parent);
    }
    if (depth > MAX_LAYER_DEPTH) {
      problems.push({ kind: "nestingTooDeep", layerId: layer.id, depth });
      linksAreSound = false;
    }
  }

  // Reach: a layer with no ranges must have a descendant that does, or it names a part of
  // the review that does not exist.
  const reaches = (layer: ReviewLayer, seen = new Set<string>()): boolean => {
    if (seen.has(layer.id)) {
      return false;
    }
    seen.add(layer.id);
    return (
      layer.ranges.length > 0 ||
      (childrenOf.get(layer.id) ?? []).some((child) => reaches(child, seen))
    );
  };
  for (const layer of layers) {
    if (!reaches(layer)) {
      problems.push({ kind: "layerWalksNothing", layerId: layer.id });
    }
  }

  // Order: only worth checking once the links themselves hold — a dangling or cyclic
  // parent would report every following layer as misplaced, burying the real problem.
  if (linksAreSound) {
    const expected = layerDocumentOrder(layers);
    for (const [index, layer] of layers.entries()) {
      if (expected[index]?.id !== layer.id) {
        problems.push({ kind: "outOfDocumentOrder", layerId: layer.id });
        break;
      }
    }
  }

  return problems;
}

/** Every reason a parsed artifact's anchors would not place against `patch`, or `[]` when
 * they all do. The `patch` is the review's diff — captured at emit time, re-derived from the
 * artifact's `source` afterward, or a rare embedded frozen patch; this places against
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

  for (const layer of artifact.layers) {
    // Empty `ranges` is a valid parent rollup, not a "nothing
    // placed" failure: the loop simply has no range to check.
    for (const range of layer.ranges) {
      const file = byPath.get(range.file) ?? null;
      const resolution = resolveAnchor(range, { kind: "derived", file: file?.fileDiff ?? null });
      if (resolution.status === "outdated") {
        problems.push({ kind: "layerRangeOutdated", layerId: layer.id, anchor: anchorOf(range) });
      }
    }
    collectUnresolvedLinks(layer.id, layer.description, diffFiles, problems);
  }

  return problems;
}

/** A `[label](path)` link is an explicit navigation target; a path not in the diff
 * renders muted and dead, which the validator promotes to a hard error. A
 * `` `code` `` span is *not* checked: inline code is ordinarily prose (a symbol
 * name), and its file-chip promotion is an opt-in nicety — flagging every non-file
 * span would reject legitimate descriptions, breaking the "zero manual fixing" bar. */
function collectUnresolvedLinks(
  layerId: string,
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
        problems.push({ kind: "unresolvedLink", layerId, label: run.label, path: run.path });
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
      return `layer "${problem.layerId}" range does not place in the diff: ${locator(problem.anchor)}`;
    case "parentNotFound":
      return `layer "${problem.layerId}" names parent "${problem.parent}", which is not a layer in this review`;
    case "parentCycle":
      return `layer "${problem.layerId}" sits in a parent cycle — the chain up from it never reaches a top-level layer`;
    case "nestingTooDeep":
      return `layer "${problem.layerId}" is ${problem.depth} levels deep — nesting stops at ${MAX_LAYER_DEPTH}`;
    case "layerWalksNothing":
      return `layer "${problem.layerId}" walks no code: it has no ranges, and nothing under it has any`;
    case "outOfDocumentOrder":
      return `layer "${problem.layerId}" is out of document order — a layer's descendants must follow it, together, before the next layer at its level`;
    case "unresolvedLink":
      return `layer "${problem.layerId}" description links [${problem.label}](${problem.path}) — path is not in the diff`;
    case "overviewUnresolvedLink":
      return `overview body links [${problem.label}](${problem.path}) — path is not in the diff`;
  }
}

function locator(anchor: ProblemAnchor): string {
  return `${anchor.file} ${anchor.side} ${anchor.startLine}-${anchor.endLine}`;
}
