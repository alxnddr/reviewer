import type { SelectedLineRange } from "@pierre/diffs";
import type { ReviewAnchor, ReviewLayer } from "../../../shared/review";
import { resolveAnchor } from "./diff/anchor";
import type { PatchFile } from "./diff/patch";

// The layer outline: `layers` is a **tree in document order**, and this is the one place
// that reads it. A layer hangs off another through the `parent` id `importReview` stamped;
// the array order is the order it is read, and it is a pre-order walk of that tree by
// construction — the flatten that produced it walked the authored `children` depth-first,
// so a subtree is contiguous and follows its parent with nothing left to enforce.
//
// One rule governs the whole model: **a layer's footprint is its own ranges plus
// everything under it.** A parent is not a special kind of node with special rules — it is
// a layer whose footprint happens to include its children's, exactly like a directory in a
// file tree. That is what makes a parent a real place to stand: soloing it shows the whole
// group, soloing a child narrows to a section of it, and no surface ever has to ask which
// of two file sets a group "really" means. Counts aggregate the same way; only *ownership*
// (which layer a comment belongs to) is exclusive, and that is the deepest layer whose own
// ranges cover it.
//
// Nothing here sorts or ranks — the artifact's order is reading order. All derivation runs
// against the loaded (git-re-derived) diff, so a range that drifted resolves to `outdated`
// here and fails soft at the call site: never a dropped layer, never a mislabeled range.

/** How deep nesting may go, counting the top level as 1. Five is far more outline than a
 * readable review needs; the cap exists so a pathological artifact cannot indent the rail
 * off its own edge or produce a section number nobody can hold in their head. The CLI gate
 * refuses a deeper artifact; here a layer past the cap simply reads as un-nested. */
export const MAX_LAYER_DEPTH = 5;

/** One layer's place in the outline — its depth, its section number, and its relatives.
 * Every surface (the rail, the doc, the band) renders from this, so a layer is numbered
 * and nested identically in all three or in none. */
export type LayerOutlineEntry = {
  layer: ReviewLayer;
  /** 0-based nesting depth: 0 is a top-level layer, capped at `MAX_LAYER_DEPTH - 1`. */
  depth: number;
  /** `"4"`, `"4.2"`, `"4.2.1"` — the section number, the same string wherever it is read. */
  ordinal: string;
  parent: ReviewLayer | null;
  /** Its ancestors, outermost first, excluding itself — the breadcrumb trail. */
  ancestors: ReviewLayer[];
  /** Its direct children, in document order. */
  children: ReviewLayer[];
  /** Itself and everything under it, in document order — the layer's real extent. */
  subtree: ReviewLayer[];
};

/** The resolved tree: the `parent` links the app is willing to honour, plus the derived
 * shape everything else reads. Built once per `layers` array. */
type LayerTree = {
  byId: Map<string, ReviewLayer>;
  parentOf: Map<string, ReviewLayer>;
  childrenOf: Map<string, ReviewLayer[]>;
  roots: ReviewLayer[];
  depthOf: Map<string, number>;
};

/** The chain from a layer up to its root, outermost first — or null when the chain is
 * illegal (a missing parent, a self-link, a cycle, or deeper than the cap). An illegal
 * link is *ignored* rather than fatal: the layer still opens and still reads in place,
 * just flat. Only the depth cap is reachable from an artifact — the stamped `id`/`parent`
 * pair comes from walking an authored tree, so a dangling link or a cycle would take a bug
 * in this app, not a bad file — and the CLI gate refuses a too-deep artifact upstream. */
function ancestorChain(
  layer: ReviewLayer,
  byId: ReadonlyMap<string, ReviewLayer>,
): ReviewLayer[] | null {
  const chain: ReviewLayer[] = [];
  const seen = new Set<string>([layer.id]);
  let parentId = layer.parent;
  while (parentId !== undefined) {
    if (seen.has(parentId)) {
      return null; // a cycle, including a self-link
    }
    const parent = byId.get(parentId);
    if (parent === undefined) {
      return null; // names a layer this review does not carry
    }
    seen.add(parentId);
    chain.unshift(parent);
    if (chain.length >= MAX_LAYER_DEPTH) {
      return null; // deeper than the outline is allowed to go
    }
    parentId = parent.parent;
  }
  return chain;
}

function buildTree(layers: readonly ReviewLayer[]): LayerTree {
  const byId = new Map(layers.map((layer) => [layer.id, layer]));
  const parentOf = new Map<string, ReviewLayer>();
  const depthOf = new Map<string, number>();
  const childrenOf = new Map<string, ReviewLayer[]>();
  const roots: ReviewLayer[] = [];

  for (const layer of layers) {
    const chain = ancestorChain(layer, byId);
    const parent = chain === null ? undefined : chain.at(-1);
    depthOf.set(layer.id, chain === null ? 0 : chain.length);
    if (parent === undefined) {
      roots.push(layer);
      continue;
    }
    parentOf.set(layer.id, parent);
    const siblings = childrenOf.get(parent.id);
    if (siblings === undefined) {
      childrenOf.set(parent.id, [layer]);
    } else {
      siblings.push(layer);
    }
  }

  return { byId, parentOf, childrenOf, roots, depthOf };
}

/** The outline, in the artifact's own order. */
export function layerOutline(layers: readonly ReviewLayer[]): LayerOutlineEntry[] {
  const tree = buildTree(layers);

  // Numbering walks the tree rather than the array so a section number always reflects the
  // shape (`4.2.1`), never the row's happenstance position in a mis-ordered artifact.
  const ordinals = new Map<string, string>();
  const number = (siblings: readonly ReviewLayer[], prefix: string): void => {
    for (const [index, layer] of siblings.entries()) {
      const ordinal = prefix === "" ? String(index + 1) : `${prefix}.${index + 1}`;
      ordinals.set(layer.id, ordinal);
      number(tree.childrenOf.get(layer.id) ?? [], ordinal);
    }
  };
  number(tree.roots, "");

  const subtrees = new Map<string, ReviewLayer[]>();
  const subtreeOf = (layer: ReviewLayer): ReviewLayer[] => {
    const cached = subtrees.get(layer.id);
    if (cached !== undefined) {
      return cached;
    }
    const collected = [layer];
    for (const child of tree.childrenOf.get(layer.id) ?? []) {
      collected.push(...subtreeOf(child));
    }
    subtrees.set(layer.id, collected);
    return collected;
  };

  const ancestorsOf = (layer: ReviewLayer): ReviewLayer[] => {
    const chain: ReviewLayer[] = [];
    let current = tree.parentOf.get(layer.id);
    while (current !== undefined) {
      chain.unshift(current);
      current = tree.parentOf.get(current.id);
    }
    return chain;
  };

  return layers.map((layer) => ({
    layer,
    depth: tree.depthOf.get(layer.id) ?? 0,
    ordinal: ordinals.get(layer.id) ?? "",
    parent: tree.parentOf.get(layer.id) ?? null,
    ancestors: ancestorsOf(layer),
    children: tree.childrenOf.get(layer.id) ?? [],
    subtree: subtreeOf(layer),
  }));
}

/** Every layer under `layer`, itself included, in document order. */
export function layerSubtree(layer: ReviewLayer, layers: readonly ReviewLayer[]): ReviewLayer[] {
  const tree = buildTree(layers);
  const collect = (current: ReviewLayer): ReviewLayer[] => [
    current,
    ...(tree.childrenOf.get(current.id) ?? []).flatMap((child) => collect(child)),
  ];
  // A layer the array does not carry (the inferred not-covered layer, resolved against the
  // authored set) stands for itself.
  return tree.byId.has(layer.id) ? collect(layer) : [layer];
}

/** A layer's ancestors, outermost first — the breadcrumb the band shows. */
export function layerAncestors(layer: ReviewLayer, layers: readonly ReviewLayer[]): ReviewLayer[] {
  const tree = buildTree(layers);
  const chain: ReviewLayer[] = [];
  let current = tree.parentOf.get(layer.id);
  while (current !== undefined) {
    chain.unshift(current);
    current = tree.parentOf.get(current.id);
  }
  return chain;
}

/** A layer's real extent: its own ranges and every range under it, in document order. The
 * single definition of "what this layer covers" — files, counts, solo subset and drift all
 * read it, so a parent and its children can never disagree about what the group is. */
export function layerRanges(layer: ReviewLayer, layers: readonly ReviewLayer[]): ReviewAnchor[] {
  return layerSubtree(layer, layers).flatMap((current) => current.ranges);
}

/** The unique files a layer covers, in first-appearance order — one entry per file
 * (overlap with *other* layers is irrelevant here; this is one layer's extent). */
export function layerFilePaths(layer: ReviewLayer, layers: readonly ReviewLayer[]): string[] {
  const seen = new Set<string>();
  const paths: string[] = [];
  for (const range of layerRanges(layer, layers)) {
    if (!seen.has(range.file)) {
      seen.add(range.file);
      paths.push(range.file);
    }
  }
  return paths;
}

type AnchorLike = {
  file: string;
  side: ReviewAnchor["side"];
  startLine: number;
  endLine: number;
};

function rangeCovers(range: ReviewAnchor, anchor: AnchorLike): boolean {
  return (
    range.file === anchor.file &&
    range.side === anchor.side &&
    range.startLine <= anchor.endLine &&
    anchor.startLine <= range.endLine
  );
}

/** Whether a layer's **own** ranges cover an anchor. Ownership is exclusive and belongs at
 * the leaf: this is the predicate `layerOwning` resolves with. */
export function layerOwnsAnchor(layer: ReviewLayer, anchor: AnchorLike): boolean {
  return layer.ranges.some((range) => rangeCovers(range, anchor));
}

/** Whether a layer's **extent** covers an anchor — its own ranges or any under it. What a
 * group's aggregate counts are measured with. */
export function layerCoversAnchor(
  layer: ReviewLayer,
  layers: readonly ReviewLayer[],
  anchor: AnchorLike,
): boolean {
  return layerRanges(layer, layers).some((range) => rangeCovers(range, anchor));
}

/** The one layer an anchor belongs to: the **deepest** layer whose own ranges cover it,
 * and among equals the first in document order. Deepest wins because that is the most
 * specific claim anyone made about those lines — an ancestor still counts it, by
 * aggregation, without taking it away from the section that actually explains it. */
export function layerOwning(
  layers: readonly ReviewLayer[],
  anchor: AnchorLike,
): ReviewLayer | null {
  const outline = layerOutline(layers);
  let best: LayerOutlineEntry | null = null;
  for (const entry of outline) {
    if (!layerOwnsAnchor(entry.layer, anchor)) {
      continue;
    }
    if (best === null || entry.depth > best.depth) {
      best = entry;
    }
  }
  return best?.layer ?? null;
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

/** The document-order neighbour of the active layer, clamped at both ends: a review has a
 * first and last stop, not a cycle, so stepping past an edge stays on the edge. Every
 * layer is a stop — a parent included, where the stop is the whole group — so this walks
 * the array as authored. A null active layer enters at the first (forward) or last
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
    return (direction === 1 ? layers[0] : layers.at(-1))?.id ?? null;
  }
  const next = Math.min(Math.max(index + direction, 0), layers.length - 1);
  return layers[next]?.id ?? null;
}

/** Solo: the diff restricted to the active layer's extent, in diff order (never re-ordered
 * to the layer's). Soloing a parent shows the whole group; soloing one of its children
 * narrows to that section — one gesture, two scopes, no special case. A null layer
 * restores the full set — the identity both surfaces key their remount/reconcile on.
 * File-granularity: the `collapsed` item flag is evaluated and unused, because a shared
 * "exactly this subset" contract across the tree and the code view can't also carry the
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

/** Why a soloed layer resolves to no visible files, so both surfaces pick copy from one
 * pure rule instead of each conflating the two. `drifted`: the layer names files but the
 * loaded diff holds none of them — its anchors moved on. `empty`: its whole extent names
 * no file at all, which the gate refuses (a layer with no ranges must have children that
 * do) but a hand-written artifact can still carry — a distinct empty state, not a broken
 * one. Only meaningful once `soloFiles` is empty. */
export type EmptySoloReason = "drifted" | "empty";

export function emptySoloReason(
  layer: ReviewLayer,
  layers: readonly ReviewLayer[],
): EmptySoloReason {
  return layerFilePaths(layer, layers).length === 0 ? "empty" : "drifted";
}

/** How a layer's first range resolves against the loaded diff — the rail reads it to flag
 * a drifted layer. `placed` carries the resolved location; `outdated` means the range no
 * longer resolves (missing file, or a range no same-side hunk covers); `none` is a layer
 * whose whole extent carries no range at all. A parent resolves through its extent, so a
 * group reads as placed when the sections under it are. */
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
  layers: readonly ReviewLayer[],
  files: readonly PatchFile[],
  frozen: boolean,
): LayerScroll {
  const first = layerRanges(layer, layers)[0];
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
