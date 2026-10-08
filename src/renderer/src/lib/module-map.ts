import type { ReviewLayer, ReviewSide } from "../../../shared/review";
import type { FileChangeStatus, PatchFile } from "../../../shared/diff/patch";
import { layerOutline, layerOwning } from "../../../shared/layers";
import { changedLines } from "../../../tools/review-coverage";

// The module map: the change's files grouped into their directories, each sized by the lines it
// changed and tinted by the chapter that explains it, plus the pure geometry that draws it as a
// treemap. Like every figure the guide shows, nothing here is read from the artifact but the
// layers' ranges — the sizes are the loaded diff's own changed lines (`changedLines`, the
// coverage universe), and a file's chapter is *derived* from which layer owns those lines.
//
// **A file's chapter is the layer that owns most of its changed lines.** Ownership is
// `layerOwning`'s — the deepest layer whose own ranges cover a line, the rule a comment's badge
// already follows — counted line by line, and the layer with the most lines wins (ties to the
// first in document order). "Most lines" rather than "first range" because a file two chapters
// share is tinted by the one that explains the bulk of it, and the deepest owner rather than the
// top-level chapter because the map's label is the section a reader would open (`4.2`); the
// top-level chapter rides along (`topId`) for a palette that has only one hue per chapter.
//
// Asking `layerOwning` once per changed line would re-derive the outline per line — a
// 10,000-line diff is 10,000 outline builds — so the lines are first cut at every range
// boundary on their file and side, and it is asked once per run between boundaries: inside one
// such run every line is covered by exactly the same ranges, so it has the same owner. The rule
// stays `layerOwning`'s; only the number of times it is asked changes.
//
// Pure and DOM-free: the component measures its box and hands the numbers in.

/** The chapter a file is tinted by. */
export type ModuleMapChapter = {
  /** The owning layer: the deepest layer covering the most of the file's changed lines. */
  id: string;
  /** Its section number (`"4.2"`), identical to the rail's. */
  ordinal: string;
  /** The top-level chapter it sits under — itself when it is top-level. */
  topId: string;
  /** Marked `skim`, by itself or an ancestor (inherited, as `buildOverview` reads it). */
  skim: boolean;
};

export type ModuleMapFile = {
  kind: "file";
  path: string;
  /** The last path segment — what a tile is labelled. */
  name: string;
  status: FileChangeStatus;
  additions: number;
  deletions: number;
  /** `additions + deletions`: the file's changed lines. Zero for a binary or a pure rename. */
  changed: number;
  /** The tile's area weight: `changed`, floored at one so a binary or a pure rename — a change
   * the reader may still want to open — keeps a tile rather than vanishing. */
  weight: number;
  /** Null when no layer covers any of its changed lines (or it has none). */
  chapter: ModuleMapChapter | null;
  /** Changed lines no layer covers. */
  uncoveredLines: number;
  /** It has changed lines and no layer covers a single one of them — the file-level "forgot a
   * whole file" signal, the same set `uncoveredLayerFrom` solos. */
  uncovered: boolean;
};

export type ModuleMapDir = {
  kind: "dir";
  /** The directory's full path, no trailing slash; `""` for the root. */
  path: string;
  /** What the group is labelled: its own segment, or a compressed chain (`src/renderer/src`)
   * when its parents held nothing but it. `""` for the root. */
  label: string;
  /** Directories first, then files, each by name. */
  children: ModuleMapNode[];
  changed: number;
  weight: number;
  /** Files anywhere under it. */
  files: number;
};

export type ModuleMapNode = ModuleMapDir | ModuleMapFile;

/** One file's changed lines, attributed: per owning layer id, and the remainder no layer
 * covers. Exported because the chapter strip partitions the whole change by the same
 * attribution — one rule, so a tile's tint and a strip segment's width cannot disagree. */
export type FileLineOwnership = {
  byLayer: ReadonlyMap<string, number>;
  uncovered: number;
  additions: number;
  deletions: number;
};

/** Sorted unique cut points for one file+side: every line range starts a run, and every line
 * range's end starts the next one. A whole-file range cuts nothing — it covers the file
 * uniformly, so it never changes owner mid-file and `layerOwning` answers for it per run. */
function boundaries(layers: readonly ReviewLayer[], names: ReadonlySet<string>, side: ReviewSide) {
  const points = new Set<number>();
  for (const layer of layers) {
    for (const range of layer.ranges) {
      if (range.side === side && names.has(range.file)) {
        points.add(range.startLine);
        points.add(range.endLine + 1);
      }
    }
  }
  return [...points].toSorted((a, b) => a - b);
}

/** Attribute every changed line of `file` to the layer that owns it (`layerOwning`), once per
 * run of lines no range boundary splits — see the module header. A range authored against a
 * renamed file's old path counts for it, as it does for a comment (`filesByAnchorPath`); the
 * current path is asked first. */
export function lineOwnership(file: PatchFile, layers: readonly ReviewLayer[]): FileLineOwnership {
  const changed = changedLines(file);
  const names = new Set([file.path, ...(file.previousPath === null ? [] : [file.previousPath])]);
  const byLayer = new Map<string, number>();
  let uncovered = 0;
  for (const side of ["deletions", "additions"] as const) {
    const cuts = boundaries(layers, names, side);
    const lines = [...changed[side]].toSorted((a, b) => a - b);
    let cut = 0;
    let index = 0;
    while (index < lines.length) {
      const first = lines[index] ?? 0;
      while (cut < cuts.length && (cuts[cut] ?? 0) <= first) {
        cut += 1;
      }
      // The run ends at the next cut point; every line before it shares `first`'s owner.
      const next = cuts[cut] ?? Number.POSITIVE_INFINITY;
      let count = 0;
      while (index < lines.length && (lines[index] ?? 0) < next) {
        count += 1;
        index += 1;
      }
      const at = { side, startLine: first, endLine: first };
      const owner =
        layerOwning(layers, { file: file.path, ...at }) ??
        (file.previousPath === null
          ? null
          : layerOwning(layers, { file: file.previousPath, ...at }));
      if (owner === null) {
        uncovered += count;
      } else {
        byLayer.set(owner.id, (byLayer.get(owner.id) ?? 0) + count);
      }
    }
  }
  return {
    byLayer,
    uncovered,
    additions: changed.additions.size,
    deletions: changed.deletions.size,
  };
}

/** The layer owning the most of a file's lines; ties go to the first in document order. */
function dominantLayer(
  ownership: FileLineOwnership,
  layers: readonly ReviewLayer[],
): ReviewLayer | null {
  let best: ReviewLayer | null = null;
  let bestCount = 0;
  for (const layer of layers) {
    const count = ownership.byLayer.get(layer.id) ?? 0;
    if (count > bestCount) {
      best = layer;
      bestCount = count;
    }
  }
  return best;
}

function byName(a: string, b: string): number {
  if (a === b) {
    return 0;
  }
  return a < b ? -1 : 1;
}

type DirBuilder = { path: string; dirs: Map<string, DirBuilder>; files: ModuleMapFile[] };

/** Finish a directory: order its children, compress a chain of single-directory parents into
 * one label, and total it. */
function finish(builder: DirBuilder, label: string): ModuleMapDir {
  // A directory whose only child is a directory says nothing of its own: `src` → `renderer` →
  // `src` is one place to a reader, and three nested frames would spend two headers' height on
  // it. The root is never folded into its child — it is not drawn.
  let current = builder;
  let currentLabel = label;
  while (current.path !== "" && current.files.length === 0 && current.dirs.size === 1) {
    const [only] = current.dirs.values();
    if (only === undefined) {
      break;
    }
    currentLabel = `${currentLabel}/${only.path.split("/").at(-1) ?? ""}`;
    current = only;
  }
  const dirs = [...current.dirs.entries()]
    .toSorted(([a], [b]) => byName(a, b))
    .map(([name, child]) => finish(child, name));
  const files = current.files.toSorted((a, b) => byName(a.name, b.name));
  const children: ModuleMapNode[] = [...dirs, ...files];
  return {
    kind: "dir",
    path: current.path,
    label: currentLabel,
    children,
    changed: children.reduce((sum, child) => sum + child.changed, 0),
    weight: children.reduce((sum, child) => sum + child.weight, 0),
    files: dirs.reduce((sum, dir) => sum + dir.files, 0) + files.length,
  };
}

/** The changed files as a directory tree, each file sized and assigned its chapter. `layers` are
 * the *authored* layers — not `effectiveLayers`: the inferred "not covered" layer would own the
 * uncovered files and hide the very flag this map exists to show. */
export function buildModuleMap(
  files: readonly PatchFile[],
  layers: readonly ReviewLayer[],
): ModuleMapDir {
  const outline = new Map(layerOutline(layers).map((entry) => [entry.layer.id, entry]));
  const root: DirBuilder = { path: "", dirs: new Map(), files: [] };
  for (const file of files) {
    const ownership = lineOwnership(file, layers);
    const owner = dominantLayer(ownership, layers);
    const entry = owner === null ? undefined : outline.get(owner.id);
    const changed = ownership.additions + ownership.deletions;
    const segments = file.path.split("/");
    const name = segments.pop() ?? file.path;
    let dir = root;
    for (const segment of segments) {
      let next = dir.dirs.get(segment);
      if (next === undefined) {
        next = {
          path: dir.path === "" ? segment : `${dir.path}/${segment}`,
          dirs: new Map(),
          files: [],
        };
        dir.dirs.set(segment, next);
      }
      dir = next;
    }
    dir.files.push({
      kind: "file",
      path: file.path,
      name,
      status: file.status,
      additions: ownership.additions,
      deletions: ownership.deletions,
      changed,
      weight: Math.max(changed, 1),
      chapter:
        owner === null || entry === undefined
          ? null
          : {
              id: owner.id,
              ordinal: entry.ordinal,
              topId: entry.ancestors[0]?.id ?? owner.id,
              skim: owner.skim === true || entry.ancestors.some((a) => a.skim === true),
            },
      uncoveredLines: ownership.uncovered,
      uncovered: changed > 0 && ownership.byLayer.size === 0,
    });
  }
  return finish(root, "");
}

// ---------------------------------------------------------------------------------------------
// Treemap
// ---------------------------------------------------------------------------------------------

export type TreemapOptions = {
  /** Height reserved at the top of a directory's frame for its label. */
  header: number;
  /** Inset between a directory's frame and the tiles inside it. */
  padding: number;
  /** Space between sibling rectangles. */
  gap: number;
  /** A frame narrower than this, or shorter than two headers, gets no header: its label would
   * not fit, and the space is worth more as tile. */
  minHeaderWidth: number;
};

export const DEFAULT_TREEMAP_OPTIONS: TreemapOptions = {
  header: 18,
  padding: 3,
  gap: 2,
  minHeaderWidth: 48,
};

export type TreemapRect = {
  node: ModuleMapNode;
  x: number;
  y: number;
  width: number;
  height: number;
  /** 0 for the nodes passed in, one more per directory level below. */
  depth: number;
  /** Whether a directory's frame reserved its header band (always false for a file). */
  header: boolean;
};

type Box = { x: number; y: number; width: number; height: number };
type Item = { node: ModuleMapNode; area: number };

/** The worst aspect ratio a row would have laid along a side of length `side` — Bruls, Huizing
 * and van Wijk's squarify criterion: a row keeps growing while adding the next item does not make
 * its worst rectangle worse. */
function worst(row: readonly Item[], side: number): number {
  let sum = 0;
  let max = 0;
  let min = Number.POSITIVE_INFINITY;
  for (const item of row) {
    sum += item.area;
    max = Math.max(max, item.area);
    min = Math.min(min, item.area);
  }
  const sideSquared = side * side;
  const sumSquared = sum * sum;
  return Math.max((sideSquared * max) / sumSquared, sumSquared / (sideSquared * min));
}

/** Lay one finished row along the box's shorter side and return the box that is left. */
function placeRow(row: readonly Item[], box: Box, out: { node: ModuleMapNode; box: Box }[]): Box {
  const sum = row.reduce((total, item) => total + item.area, 0);
  if (box.width >= box.height) {
    // Wide: the row is a column at the left edge, as wide as its area needs.
    const width = box.height > 0 ? sum / box.height : 0;
    let y = box.y;
    for (const item of row) {
      const height = width > 0 ? item.area / width : 0;
      out.push({ node: item.node, box: { x: box.x, y, width, height } });
      y += height;
    }
    return {
      x: box.x + width,
      y: box.y,
      width: Math.max(0, box.width - width),
      height: box.height,
    };
  }
  const height = box.width > 0 ? sum / box.width : 0;
  let x = box.x;
  for (const item of row) {
    const width = height > 0 ? item.area / height : 0;
    out.push({ node: item.node, box: { x, y: box.y, width, height } });
    x += width;
  }
  return {
    x: box.x,
    y: box.y + height,
    width: box.width,
    height: Math.max(0, box.height - height),
  };
}

/** Squarified layout of one level: sibling nodes into one box, areas proportional to weight.
 * Sorted by weight descending, then by path, so equal weights land in the same places every
 * time — a map that reshuffles between two renders of the same diff cannot be learned. */
function squarify(nodes: readonly ModuleMapNode[], box: Box): { node: ModuleMapNode; box: Box }[] {
  const sorted = nodes.toSorted((a, b) => b.weight - a.weight || byName(a.path, b.path));
  const total = sorted.reduce((sum, node) => sum + node.weight, 0);
  const area = box.width * box.height;
  if (area <= 0 || total <= 0) {
    return sorted.map((node) => ({ node, box: { x: box.x, y: box.y, width: 0, height: 0 } }));
  }
  const items = sorted.map((node) => ({ node, area: (node.weight / total) * area }));
  const out: { node: ModuleMapNode; box: Box }[] = [];
  let remaining = box;
  let row: Item[] = [];
  let index = 0;
  while (index < items.length) {
    const item = items[index];
    if (item === undefined) {
      break;
    }
    const side = Math.min(remaining.width, remaining.height);
    if (row.length === 0 || worst([...row, item], side) <= worst(row, side)) {
      row.push(item);
      index += 1;
    } else {
      remaining = placeRow(row, remaining, out);
      row = [];
    }
  }
  if (row.length > 0) {
    placeRow(row, remaining, out);
  }
  return out;
}

function inset(box: Box, by: number): Box {
  const width = Math.max(0, box.width - 2 * by);
  const height = Math.max(0, box.height - 2 * by);
  return {
    x: box.x + Math.min(by, box.width / 2),
    y: box.y + Math.min(by, box.height / 2),
    width,
    height,
  };
}

/** The treemap of `nodes` in a `width` × `height` box: one rectangle per node, nested — a
 * directory is a frame (with a header band for its label when it fits) and its children are laid
 * out inside it. Pre-order, so painting in array order puts every frame under its tiles. Pass the
 * root's `children`: the root is not drawn. */
export function layoutTreemap(
  nodes: readonly ModuleMapNode[],
  width: number,
  height: number,
  options: Partial<TreemapOptions> = {},
): TreemapRect[] {
  const settings = { ...DEFAULT_TREEMAP_OPTIONS, ...options };
  const out: TreemapRect[] = [];
  const level = (siblings: readonly ModuleMapNode[], box: Box, depth: number): void => {
    for (const placed of squarify(siblings, box)) {
      const own = inset(placed.box, settings.gap / 2);
      const node = placed.node;
      if (node.kind === "file") {
        out.push({ node, ...own, depth, header: false });
        continue;
      }
      const header = own.height >= settings.header * 2 && own.width >= settings.minHeaderWidth;
      out.push({ node, ...own, depth, header });
      const top = header ? settings.header : settings.padding;
      const inner: Box = {
        x: own.x + settings.padding,
        y: own.y + top,
        width: Math.max(0, own.width - 2 * settings.padding),
        height: Math.max(0, own.height - top - settings.padding),
      };
      level(node.children, inner, depth + 1);
    }
  };
  level(nodes, { x: 0, y: 0, width, height }, 0);
  return out;
}
