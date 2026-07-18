import type { SelectedLineRange } from "@pierre/diffs";
import type { ReviewLayer } from "../../../shared/review";
import { resolveAnchor } from "./diff/anchor";
import type { PatchFile } from "./diff/patch";

// Ordered-layer navigation: pure stepping + solo derivation.
// The authored `layers` order *is* reading order — nothing here sorts or ranks;
// it only steps the array and projects each layer to the view state the surfaces
// need (its file subset, its first-range drift flag). Layers are not mutually
// exclusive: a file may belong to many layers, so a subset is always derived from
// one layer's own ranges, never a partition. All derivation is against the loaded
// (git-re-derived) diff, so a range that drifted resolves to `outdated` here and
// fails soft at the call site — never a dropped layer or a mislabeled range.

/** The authored-order neighbour of the active layer, clamped at both ends: a
 * walkthrough has a first and last step, not a cycle, so stepping past an edge
 * stays on the edge. A null active layer enters at the first (forward) or last
 * (backward). Returns null only for an empty layer set. */
export function stepLayer(
  layers: readonly ReviewLayer[],
  activeId: string | null,
  direction: 1 | -1,
): string | null {
  if (layers.length === 0) {
    return null;
  }
  const index = activeId === null ? -1 : layers.findIndex((layer) => layer.id === activeId);
  if (index === -1) {
    return (direction === 1 ? layers[0] : layers[layers.length - 1])?.id ?? null;
  }
  const next = Math.min(Math.max(index + direction, 0), layers.length - 1);
  return layers[next]?.id ?? null;
}

/** The layer named by `activeId`, or null when nothing is active or the id names
 * no layer (a cleared solo, or stale state after the review changed). */
export function findLayer(
  layers: readonly ReviewLayer[],
  activeId: string | null,
): ReviewLayer | null {
  if (activeId === null) {
    return null;
  }
  return layers.find((layer) => layer.id === activeId) ?? null;
}

/** The transitive descendants of `layer`, in authored order — every layer whose
 * `parent` chain reaches it. Used to roll a bare parent node up to the union of
 * what sits under it; a `parent` cycle in a tampered artifact terminates via the
 * visited guard rather than looping. */
function descendantLayers(layer: ReviewLayer, layers: readonly ReviewLayer[]): ReviewLayer[] {
  const byId = new Map(layers.map((candidate) => [candidate.id, candidate]));
  const reachesLayer = (start: ReviewLayer): boolean => {
    const seen = new Set<string>();
    let current = start.parent;
    while (current !== undefined && !seen.has(current)) {
      if (current === layer.id) {
        return true;
      }
      seen.add(current);
      current = byId.get(current)?.parent;
    }
    return false;
  };
  return layers.filter(reachesLayer);
}

/** The unique files a layer touches, in first-appearance order. A leaf owns its
 * footprint — its own ranges' files, one entry per file (overlap with other
 * layers is irrelevant here; this is one layer's footprint). A layer with
 * *no* ranges is a parent rollup (`shared/review.ts`): its files are the union of
 * its descendants', so a bare parent projects to what sits under it rather than to
 * nothing. */
export function layerFilePaths(layer: ReviewLayer, layers: readonly ReviewLayer[]): string[] {
  const sources = layer.ranges.length > 0 ? [layer] : descendantLayers(layer, layers);
  const seen = new Set<string>();
  const paths: string[] = [];
  for (const source of sources) {
    for (const range of source.ranges) {
      if (!seen.has(range.file)) {
        seen.add(range.file);
        paths.push(range.file);
      }
    }
  }
  return paths;
}

/** Solo: the diff restricted to the active layer's files, in diff order (never
 * re-ordered to the layer's). A null layer restores the full set — the identity
 * both surfaces key their remount/reconcile on. File-granularity: the
 * `collapsed` item flag is evaluated and unused, because a shared "exactly this
 * subset" contract across the tree and the code view can't also carry the
 * non-layer files a `collapsed` dim would keep present. */
export function soloFiles(
  files: readonly PatchFile[],
  layer: ReviewLayer | null,
  layers: readonly ReviewLayer[],
): PatchFile[] {
  if (layer === null) {
    return [...files];
  }
  const wanted = new Set(layerFilePaths(layer, layers));
  return files.filter((file) => wanted.has(file.path));
}

/** Why a soloed layer resolves to no visible files, so both surfaces pick copy
 * from one pure rule instead of each conflating the two. `drifted`: the
 * layer names files but the loaded diff holds none of them — its anchors moved on.
 * `rollup`: a bare parent node with no ranges of its own and nothing
 * under it to union, so it never had files to drift — a distinct empty state, not
 * a broken one. Only meaningful once `soloFiles` is empty. */
export type EmptySoloReason = "drifted" | "rollup";

export function emptySoloReason(
  layer: ReviewLayer,
  layers: readonly ReviewLayer[],
): EmptySoloReason {
  return layerFilePaths(layer, layers).length === 0 ? "rollup" : "drifted";
}

/** How a layer's first range resolves against the loaded diff — the layer list reads
 * it to flag a drifted layer (LayerList). `placed` carries the resolved location;
 * `outdated` means the range no longer resolves (missing file or a range no same-side
 * hunk covers); `none` is a layer with no ranges (a parent rollup). */
export type LayerScroll =
  | { kind: "placed"; fileId: string; range: SelectedLineRange }
  | { kind: "outdated" }
  | { kind: "none" };

/** Whether the diff surface should persist its scroll position. A soloed layer's
 * scroll — the reset to the top plus the reflow to a filtered item set — is derived
 * view state, never the reader's place in the full diff, so capture is gated to the
 * un-soloed view: layer navigation must not rewrite or write-back the session's
 * `scrollTop`. Read at notify time (not commit) so a solo→clear inside the
 * capture debounce still can't leak the layer position. */
export function capturesScroll(activeLayerId: string | null): boolean {
  return activeLayerId === null;
}

export function resolveLayerScroll(
  layer: ReviewLayer,
  files: readonly PatchFile[],
  frozen: boolean,
): LayerScroll {
  const first = layer.ranges[0];
  if (first === undefined) {
    return { kind: "none" };
  }
  // A frozen embedded patch places every anchor: a layer range resolves
  // against the same frozen diff its comments do, so the two surfaces never
  // disagree — a review that pins its own patch shows no layer as outdated. The
  // frozen sidestep still requires the file to be in the diff, matching the
  // comment surface (which only annotates files it renders): a layer pointing at a
  // file the patch lacks fails soft rather than scrolling to a row that never mounts.
  const file = files.find((candidate) => candidate.path === first.file) ?? null;
  const resolution =
    frozen && file !== null
      ? resolveAnchor(first, { kind: "frozen" })
      : resolveAnchor(first, { kind: "derived", file: file?.fileDiff ?? null });
  if (resolution.status === "outdated") {
    return { kind: "outdated" };
  }
  return {
    kind: "placed",
    fileId: first.file,
    range: { start: first.startLine, end: first.endLine, side: first.side },
  };
}
