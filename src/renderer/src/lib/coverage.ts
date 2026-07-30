import type { ReviewLayer } from "../../../shared/review";
import { coverageOfFiles, type CoverageReport } from "../../../tools/review-coverage";
import type { PatchFile } from "./diff/patch";

// Layer coverage for the app, computed — never read from an artifact field. The
// numbers come from the *same* `coverageOfFiles` core the `rvw check --coverage` CLI uses, run
// against the diff already on screen (`slice.diff.files`), so what the reviewer reads
// matches what the CLI reports with no re-parse and no drift. On top of the raw report
// this adds the two view concerns the surfaces need: the headline counts, and the
// uncovered remainder projected as a synthetic, soloable `ReviewLayer` so the existing
// layer machinery (`soloFiles`, `layerFilePaths`, `resolveLayerScroll`) filters the tree
// and diff to exactly the skipped files with no new plumbing.

/** The id of the inferred "not covered by layers" layer. Collision-free by construction:
 * every real layer's id is app-stamped on import, never authored, so nothing on the wire
 * can name this one. Never persisted or exported — it only ever lives in the derived
 * `effectiveLayers` list and, transiently, in the ephemeral `activeLayerId`. */
export const UNCOVERED_LAYER_ID = "reviewer:uncovered";

/** The headline + the inferred remainder. `uncoveredLayer` is null exactly when every
 * coverable file is walked by some layer (or there is nothing coverable) — the "only if it
 * exists" rule the UI keys the whole not-covered treatment on.
 *
 * The headline numbers stay *line*-based (they are the coverage-quality readout, and the
 * same ones `rvw check --coverage` prints); the remainder is *file*-based, because soloing is
 * file-granular — see `uncoveredLayerFrom`. */
export type CoverageSummary = {
  report: CoverageReport;
  /** Coverable changed lines a layer spans, and the coverable universe. */
  coveredLines: number;
  coverableLines: number;
  /** Whole-number covered %; a diff with nothing coverable reads 100 (the CLI's rule). */
  linePct: number;
  /** Fully-covered files over the coverable files (non-coverable files excluded). */
  coveredFiles: number;
  coverableFiles: number;
  /** The remainder: coverable files no layer references at all. Zero / null when every
   * coverable file is walked. */
  uncoveredFiles: number;
  uncoveredLayer: ReviewLayer | null;
};

/** Whole-number percentage; nothing coverable is complete by definition (mirrors
 * `coverage-report.ts`'s `percent`), so 0-of-0 reads 100, never NaN. */
function percent(covered: number, coverable: number): number {
  return coverable === 0 ? 100 : Math.round((covered / coverable) * 100);
}

/** The report re-shaped into the covered/uncovered numbers and the synthetic layer the
 * surfaces read. Pure and re-parse-free: it measures the parsed files as-is. */
export function coverageSummary(
  files: readonly PatchFile[],
  layers: readonly ReviewLayer[],
): CoverageSummary {
  const report = coverageOfFiles(files, layers);
  const { coveredChangedLines, coverableChangedLines } = report.headline;

  let coveredFiles = 0;
  let coverableFiles = 0;
  for (const file of report.files) {
    if (file.status === "nonCoverable") {
      continue;
    }
    coverableFiles += 1;
    if (file.status === "covered") {
      coveredFiles += 1;
    }
  }

  const uncoveredLayer = uncoveredLayerFrom(report, layers);
  const uncoveredFiles =
    uncoveredLayer === null ? 0 : new Set(uncoveredLayer.ranges.map((r) => r.file)).size;

  return {
    report,
    coveredLines: coveredChangedLines,
    coverableLines: coverableChangedLines,
    linePct: percent(coveredChangedLines, coverableChangedLines),
    coveredFiles,
    coverableFiles,
    uncoveredFiles,
    uncoveredLayer,
  };
}

/** The inferred remainder as a `ReviewLayer`: the coverable files **no layer references at
 * all**, anchored so soloing it filters to exactly those files.
 *
 * File membership — not uncovered lines — is the right unit here because soloing is
 * file-granular (`soloFiles` keeps whole files). Deriving the layer from
 * `report.uncoveredSpans` would pull in files a layer only *partly* walks, and those files
 * would then show under both that layer's solo and this one — a file cannot sensibly be
 * both in a layer and not covered by layers. The headline % stays line-based; that is the
 * coverage-*quality* question, and it is a different one.
 *
 * Null when every coverable file is walked.
 *
 * Exported so a caller that already holds a report never pays for a second walk to get the
 * layer out of it — the report *is* the expensive part. */
export function uncoveredLayerFrom(
  report: CoverageReport,
  layers: readonly ReviewLayer[],
): ReviewLayer | null {
  // Every file any layer references. A bare parent rollup contributes nothing here, which
  // is correct — its descendants carry the ranges.
  const walked = new Set(layers.flatMap((layer) => layer.ranges.map((range) => range.file)));
  // Non-coverable files (binary / pure rename / no changed lines) are never a gap.
  // `report.files` preserves diff order, so the ranges stay deterministic.
  const unwalked = report.files.filter(
    (file) => file.status !== "nonCoverable" && !walked.has(file.file),
  );
  if (unwalked.length === 0) {
    return null;
  }
  const wanted = new Set(unwalked.map((file) => file.file));
  // A wholly-unwalked coverable file has every changed line uncovered, so its own
  // `uncoveredSpans` already span the file — reuse them as the layer's ranges so
  // `resolveLayerScroll` places, and `soloFiles` filters to, exactly these files.
  const ranges = report.uncoveredSpans
    .filter((span) => wanted.has(span.file))
    .map((span) => ({
      file: span.file,
      side: span.side,
      startLine: span.startLine,
      endLine: span.endLine,
    }));
  return {
    id: UNCOVERED_LAYER_ID,
    label: "Not covered by layers",
    // The reading-band body (LayerIntro falls back to `summary` since there is no
    // authored `description`): a plain sentence, no file links to resolve.
    summary: `${count(unwalked.length, "file")} that no layer covers.`,
    ranges,
  };
}

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

/** The authored layers plus the inferred remainder — the single ordered list every
 * consumer (the store's navigation, the sidebar tree, the diff surface) resolves the
 * active layer against, so the synthetic layer solos and steps exactly like a real one.
 * A fully-covered review adds no row — just the authored layers, copied out. The result is
 * a fresh array either way, which is why `soloed-diff.ts` holds one per input change rather
 * than letting each consumer key its memos on a new list every render.
 *
 * `summary` is the same derivation already in hand: a caller that needed the headline
 * numbers too passes its `CoverageSummary` and the diff is walked once for both, instead of
 * once here and once there. It must have been computed from *these* `files` and `layers` —
 * it is a shortcut past the walk, not a different question. `soloed-diff.ts` is the one
 * place that pairs them for the surfaces; everything else can pass nothing. */
export function effectiveLayers(
  files: readonly PatchFile[],
  layers: readonly ReviewLayer[],
  summary?: CoverageSummary,
): ReviewLayer[] {
  const uncovered =
    summary === undefined
      ? uncoveredLayerFrom(coverageOfFiles(files, layers), layers)
      : summary.uncoveredLayer;
  return uncovered === null ? [...layers] : [...layers, uncovered];
}
