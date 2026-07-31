import type { ReviewLayer } from "../../../shared/review";
import { coverageSummary, effectiveLayers, type CoverageSummary } from "./coverage";
import type { PatchFile } from "../../../shared/diff/patch";
import { findLayer, soloFiles } from "../../../shared/layers";

// The one derivation of "what the reader is actually looking at": the effective layer list,
// the resolved active layer, and the file subset a solo leaves on screen. Every surface and
// every store action reads it from here, so there is exactly one definition of a layer's
// file set — the same rule `soloFiles` states, held to across the rail, the code view and
// keyboard navigation rather than re-derived three times and trusted to agree.
//
// It is memoised on the *identity* of its inputs, not their contents, which is what lets it
// be called freely: in a render body, inside a zustand selector that runs on every store
// change, or in an action handler. `slice.diff.files` and `slice.layers` are replaced
// wholesale on load and on import and never mutated in place, so identity is the honest key
// — the same assumption the component `useMemo`s this replaces were already making, now
// made once and shared instead of once per consumer.
//
// The cache is a `WeakMap` on the file list, so a closed session's derivation is collected
// with the diff it was about; nothing here needs eviction.

/** The diff as a solo leaves it, derived once per `(files, layers, activeLayerId)`. */
export type SoloedDiff = {
  /** The authored layers plus the inferred "not covered by layers" layer — the list the
   * active id resolves against, so the synthetic row steps and solos like an authored one. */
  layers: ReviewLayer[];
  /** `activeLayerId` resolved against `layers`; null when nothing is soloed, or when the
   * id names a layer this diff's list no longer carries. */
  activeLayer: ReviewLayer | null;
  /** The diff restricted to the active layer's extent, in diff order — the full set when
   * nothing is soloed. Stable across renders that change neither input, which is what keeps
   * the tree's and the code view's own memos from rebuilding underneath it. */
  files: PatchFile[];
};

/** A stable empty file list for the diff phases that have none (idle, loading, failed).
 * A fresh `[]` per call would miss the cache — and key an entry — on every render. */
export const NO_FILES: readonly PatchFile[] = [];

/** Everything derived from one `(files, layers)` pair: the coverage walk, done once, and
 * the solo of each layer that has been asked for since. `solos` is bounded by the layer
 * count and lives and dies with its cache entry. */
type Derived = {
  summary: CoverageSummary;
  layers: ReviewLayer[];
  solos: Map<string | null, SoloedDiff>;
};

const cache = new WeakMap<readonly PatchFile[], WeakMap<readonly ReviewLayer[], Derived>>();

function derived(files: readonly PatchFile[], layers: readonly ReviewLayer[]): Derived {
  let byLayers = cache.get(files);
  if (byLayers === undefined) {
    byLayers = new WeakMap();
    cache.set(files, byLayers);
  }
  const hit = byLayers.get(layers);
  if (hit !== undefined) {
    return hit;
  }
  // The one walk of the diff. `effectiveLayers` takes the summary rather than re-deriving
  // it, so the coverage core sees these files exactly once per input change.
  const summary = coverageSummary(files, layers);
  const entry: Derived = {
    summary,
    layers: effectiveLayers(files, layers, summary),
    solos: new Map(),
  };
  byLayers.set(layers, entry);
  return entry;
}

/** The coverage of these files by these layers — the headline numbers and the inferred
 * remainder — sharing the one walk with the effective layer list. */
export function coverageFor(
  files: readonly PatchFile[],
  layers: readonly ReviewLayer[],
): CoverageSummary {
  return derived(files, layers).summary;
}

/** The soloed diff for an active layer id. Same inputs, same object — including the same
 * `files` array — so a consumer can key a memo, a remount or a reconcile on it. */
export function soloedDiff(
  files: readonly PatchFile[],
  layers: readonly ReviewLayer[],
  activeLayerId: string | null,
): SoloedDiff {
  const entry = derived(files, layers);
  const hit = entry.solos.get(activeLayerId);
  if (hit !== undefined) {
    return hit;
  }
  const activeLayer = findLayer(entry.layers, activeLayerId);
  const solo: SoloedDiff = {
    layers: entry.layers,
    activeLayer,
    files: soloFiles(files, activeLayer, entry.layers),
  };
  entry.solos.set(activeLayerId, solo);
  return solo;
}
