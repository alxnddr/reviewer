import { ReviewArtifact, type ReviewSide } from "../shared/review";
import { resolveAnchor } from "../renderer/src/lib/diff/anchor";
import { parsePatch } from "../renderer/src/lib/diff/patch";
import { parseLayerDescription } from "../renderer/src/lib/layer-description";

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
  | { kind: "unresolvedLink"; layerId: string; label: string; path: string };

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

  return { ok: true, artifact: parsed.data };
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
  for (const paragraph of parseLayerDescription(description, diffFiles)) {
    for (const run of paragraph.runs) {
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
    case "unresolvedLink":
      return `layer "${problem.layerId}" description links [${problem.label}](${problem.path}) — path is not in the diff`;
  }
}

function locator(anchor: ProblemAnchor): string {
  return `${anchor.file} ${anchor.side} ${anchor.startLine}-${anchor.endLine}`;
}
