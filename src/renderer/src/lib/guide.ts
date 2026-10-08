import type {
  AnchorSpan,
  FlowEdge,
  FlowNode,
  FlowNodeStatus,
  FlowVisual,
  ReviewLayer,
  ReviewVisual,
  SkeletonLine,
} from "../../../shared/review";
import type { FileOutline, OutlineSymbol } from "../../../shared/diff/outline";
import { layerOutline, layerOwning } from "../../../shared/layers";
import { assertNever } from "../../../shared/assert";
import { layoutFlow, type FlowLayout, type FlowLayoutOptions } from "./flow-layout";
import type { ModuleMapFile } from "./module-map";
import type { OverviewChapter } from "./overview";

// The guide's decisions, pure: which chapter a visual element, a changed symbol or a map tile
// belongs to, what badge it wears, which tint it takes, and how the overview's chapters fold
// into one row per top-level chapter. The components under `components/guide/` draw what this
// returns and decide nothing about it — so every rule here is tested without a document
// (the repo's no-DOM rule), and the overview card, the chapter rows, the Shape tab and the band
// above the diff cannot come to disagree about which chapter owns a line.
//
// **A badge is derived, never authored.** An element's chapter is `layerOwning` of its anchor —
// the deepest layer whose own ranges cover it, the rule a comment's chapter already follows —
// against the *authored* layers (never `effectiveLayers`: the inferred "not covered" layer is not
// a chapter anyone wrote, and an element pointing into uncovered code honestly wears no badge).
// So a diagram is a table of contents into the chapters that cannot name the wrong one.

/** The derived chapter of one element: the owning layer, its section number, and the
 * zero-padded text the badge prints. */
export type ChapterBadge = {
  layerId: string;
  /** The layer's section number as the rail prints it: `"4"`, `"4.2"`. */
  ordinal: string;
  /** What the badge reads: the top-level number padded to two digits, the rest as is —
   * `"04"`, `"04.2"`. Padded because a column of badges reads as a column only when `1` and
   * `12` are the same width, which is also why Capy's guide sets them that way. */
  text: string;
  /** The top-level chapter the owner sits under (itself when top-level) — what a tint keys on. */
  topId: string;
  /** Marked skim, by itself or an ancestor: a skim chapter's elements wear no colour. */
  skim: boolean;
};

/** `"4.2"` → `"04.2"`. */
export function badgeText(ordinal: string): string {
  const [top = "", ...rest] = ordinal.split(".");
  return [top.padStart(2, "0"), ...rest].join(".");
}

/** Where a guide element's anchor can be followed, and how: the surface's navigable files (the
 * whole diff on the overview, the soloed chapter in the band) and the store door that follows it
 * (`focusReference`). `components/guide/anchor-door.tsx` holds the argument. */
export type AnchorDoor = {
  paths: ReadonlySet<string>;
  open: (anchor: AnchorSpan) => void;
};

/** `NN / MM` for a top-level chapter row: its number and how many there are. */
export function chapterCounter(ordinal: string, total: number): string {
  const top = ordinal.split(".")[0] ?? ordinal;
  return `${top.padStart(2, "0")} / ${String(total).padStart(2, "0")}`;
}

/** A lookup from an anchor to its badge, built once per layer list. `layerOwning` does the
 * ownership; the outline is built here once so every element's ordinal is a map read. */
export function createBadgeLookup(
  layers: readonly ReviewLayer[],
): (anchor: AnchorSpan | undefined) => ChapterBadge | null {
  const outline = new Map(layerOutline(layers).map((entry) => [entry.layer.id, entry]));
  return (anchor) => {
    if (anchor === undefined) {
      return null;
    }
    const owner = layerOwning(layers, anchor);
    const entry = owner === null ? undefined : outline.get(owner.id);
    if (owner === null || entry === undefined) {
      return null;
    }
    return {
      layerId: owner.id,
      ordinal: entry.ordinal,
      text: badgeText(entry.ordinal),
      topId: entry.ancestors[0]?.id ?? owner.id,
      skim: owner.skim === true || entry.ancestors.some((ancestor) => ancestor.skim === true),
    };
  };
}

/** `file:12-20` — how an element's anchor is named in its hint. */
export function anchorLabel(anchor: AnchorSpan): string {
  const lines =
    anchor.startLine === anchor.endLine
      ? `${anchor.startLine}`
      : `${anchor.startLine}-${anchor.endLine}`;
  return `${anchor.file}:${lines}${anchor.side === "deletions" ? " (before)" : ""}`;
}

// ── Tints ───────────────────────────────────────────────────────────────────────────────────
//
// The map and the strip colour each top-level chapter so a tile and a segment of the same
// chapter are recognisably one thing. Green and red are the diff's — the guide spends them on
// *change* and nowhere else — so a chapter's colour cannot be one of them. And nothing here
// adds a token: six hand-kept themes (`design/globals.css`, pinned by `themes.test.ts`) would
// each need a categorical ramp. Instead every tint is the theme's own `--primary` with its hue
// turned (CSS relative colour syntax), mixed into the diff surface: it follows each theme's
// lightness and chroma, sits pale on a light theme and dim on a dark one, and a theme whose
// primary is violet gets a set that starts from violet. The turns keep clear of the diff's
// green (~150°) and red (~25°) for the default blue primary; past the fifth chapter they repeat,
// which the chapter number printed on every tile and segment disambiguates.

/** Hue turns from `--primary`, in degrees: blue, violet, cyan, magenta, ochre. */
export const CHAPTER_HUE_TURNS = [0, 48, -50, 92, -170] as const;

/** The palette slot a top-level chapter takes: its position among the top-level chapters, in
 * authored order, cycling. Null for an id that is not a top-level chapter. */
export function chapterSlots(layers: readonly ReviewLayer[]): ReadonlyMap<string, number> {
  const slots = new Map<string, number>();
  for (const entry of layerOutline(layers)) {
    if (entry.depth === 0) {
      slots.set(entry.layer.id, slots.size % CHAPTER_HUE_TURNS.length);
    }
  }
  return slots;
}

/** How strongly a tint is mixed into the surface: a tile's or a segment's ground, or the bar
 * that marks a read segment and a tile's edge. */
export type TintStrength = "ground" | "strong";

/** The CSS colour of a chapter slot at a strength — an inline style value, never a class:
 * relative colour syntax inside a Tailwind arbitrary value goes through Lightning CSS on a
 * packaged build, the trap `index.css`'s glass block documents, and a style attribute does not. */
export function chapterTint(slot: number, strength: TintStrength): string {
  const turn = CHAPTER_HUE_TURNS[slot % CHAPTER_HUE_TURNS.length] ?? 0;
  const amount = strength === "ground" ? 22 : 70;
  // Mixed in oklab, not oklch: the surface is an achromatic colour that still states a hue (0°
  // on the light themes), and a polar mix interpolates toward it — every chapter came out the
  // same pink. A rectangular space has no hue to interpolate, so the mix is a pure fade.
  return `color-mix(in oklab, oklch(from var(--primary) l c calc(h + ${turn})) ${amount}%, var(--diff-surface))`;
}

/** How a map tile is coloured. `chapter`: the top-level chapter's slot. `skim`: neutral — the
 * author said it needs a glance, so it does not compete for the eye. `uncovered`: changed lines
 * no layer explains, which the map exists partly to show. `none`: nothing to explain (a binary
 * or a pure rename, no changed lines). */
export type TileTone =
  | { kind: "chapter"; slot: number }
  | { kind: "skim" }
  | { kind: "uncovered" }
  | { kind: "none" };

export function tileTone(file: ModuleMapFile, slots: ReadonlyMap<string, number>): TileTone {
  if (file.uncovered) {
    return { kind: "uncovered" };
  }
  if (file.chapter === null) {
    return { kind: "none" };
  }
  if (file.chapter.skim) {
    return { kind: "skim" };
  }
  const slot = slots.get(file.chapter.topId);
  return slot === undefined ? { kind: "none" } : { kind: "chapter", slot };
}

/** The treemap's height for a change of `files` files: tall enough that a tile per file can
 * print its name, short enough that the map stays a figure beside the chapters rather than a
 * page of its own. Grows with the file count between the two bounds. */
export function mapHeight(files: number): number {
  return Math.round(Math.min(360, Math.max(180, 120 + files * 16)));
}

// ── Visuals ─────────────────────────────────────────────────────────────────────────────────

/** Elements of a visual by status — the `+N −M ~K` the card's header prints. Nodes and lines
 * only: an edge is wiring, and counting it would make a picture with one new box read `+3`. */
export type VisualCounts = { added: number; removed: number; changed: number };

/** One element's status, typed as the schema's union rather than widened to `string`: a skeleton
 * line's `VisualPresence` is a subset of a node's `FlowNodeStatus`, so one union covers both, and
 * `countedAs` closes over it. Widened, a new status read as none of three `if`s and went silently
 * uncounted. */
export function visualCounts(visual: ReviewVisual): VisualCounts {
  const counts: VisualCounts = { added: 0, removed: 0, changed: 0 };
  for (const status of visualStatuses(visual)) {
    const bucket = countedAs(status);
    if (bucket !== null) {
      counts[bucket] += 1;
    }
  }
  return counts;
}

/** Which count a status adds to, or null for one the header does not count. A value-returning
 * `switch` with no `default`: `noImplicitReturns` makes a status added to `FlowNodeStatus` a
 * compile error here until it says where it is counted. */
function countedAs(status: FlowNodeStatus): keyof VisualCounts | null {
  switch (status) {
    case "added":
      return "added";
    case "removed":
      return "removed";
    case "changed":
      return "changed";
    case "same":
      return null;
  }
}

function visualStatuses(visual: ReviewVisual): FlowNodeStatus[] {
  switch (visual.kind) {
    case "flow":
      return visual.nodes.map((node) => node.status);
    case "skeleton":
      return visual.lines.map((line) => line.status);
    default:
      return assertNever(visual);
  }
}

/** The anchors a visual's elements carry, in element order — what the band and the chapter rows
 * use to tell whether an element can navigate on a given surface. */
export function visualAnchors(visual: ReviewVisual): AnchorSpan[] {
  switch (visual.kind) {
    case "flow":
      return [
        ...visual.nodes.flatMap((node) => (node.at === undefined ? [] : [node.at])),
        ...visual.edges.flatMap((edge) => (edge.at === undefined ? [] : [edge.at])),
      ];
    case "skeleton":
      return visual.lines.flatMap((line) => (line.at === undefined ? [] : [line.at]));
    default:
      return assertNever(visual);
  }
}

/** Px the flow box reserves beside its label: the status marker, and the badge when there is
 * one. The badge's width is its text at the badge's own size plus its padding. */
export const FLOW_MARKER_WIDTH = 14;
const BADGE_CHAR_WIDTH = 6.6;
const BADGE_PADDING = 18;

export function badgeWidth(badge: ChapterBadge | null): number {
  return badge === null ? 0 : Math.ceil(badge.text.length * BADGE_CHAR_WIDTH + BADGE_PADDING);
}

/** The monospace metrics a flow is drawn and laid out with: Geist Mono's advance is 0.6 em, so
 * 7.8 px at the card's 13 px and 7.2 px at the band's 12 px. One table for the renderer and for
 * the arrangement below, so "does it fit" is asked of the drawing that will actually be drawn. */
export const FLOW_METRICS = {
  regular: { font: 13, charWidth: 7.8, labelCharWidth: 6.6, labelHeight: 13, boxHeight: 32 },
  compact: { font: 12, charWidth: 7.2, labelCharWidth: 6.2, labelHeight: 12, boxHeight: 28 },
} as const;

/** The layout options for a flow at a width. */
export function flowOptions(compact: boolean, maxWidth: number): Partial<FlowLayoutOptions> {
  const metrics = compact ? FLOW_METRICS.compact : FLOW_METRICS.regular;
  return {
    charWidth: metrics.charWidth,
    labelCharWidth: metrics.labelCharWidth,
    labelHeight: metrics.labelHeight,
    boxHeight: metrics.boxHeight,
    maxWidth,
    margin: compact ? 8 : 12,
    rankGap: compact ? 28 : 36,
    nodeGap: compact ? 10 : 14,
    rowGap: compact ? 32 : 40,
  };
}

/** The width a visual wants to be drawn unwrapped, in px: a flow's layout at no width limit; a
 * skeleton's longest row — indent, code, the gap, its note — plus the marker and badge columns. */
export function visualNaturalWidth(
  visual: ReviewVisual,
  badgeOf: (anchor: AnchorSpan | undefined) => ChapterBadge | null,
): number {
  switch (visual.kind) {
    case "flow":
      return flowDrawing(visual, badgeOf, flowOptions(false, Number.POSITIVE_INFINITY)).layout
        .width;
    case "skeleton": {
      const { charWidth } = FLOW_METRICS.regular;
      const widest = Math.max(
        0,
        ...visual.lines.map(
          (line) =>
            (line.depth * 2 + line.code.length) * charWidth +
            (line.note === undefined ? 0 : 12 + line.note.length * 6.6),
        ),
      );
      return Math.ceil(widest + 28 + 44);
    }
    default:
      return assertNever(visual);
  }
}

/** Where the overview's picture sits relative to the lede and steps. `beside`: the right column,
 * the default — the picture and the sentence that explains it read together. `below`: full width
 * under them, whenever the picture would have to wrap in the column — a flow that wraps a fan of
 * edges onto a second row reads far worse than one that sits a little lower, and a flow too wide
 * even for the page still wraps less at full width than in a column. On a container too narrow
 * for two columns everything stacks anyway, which is `below` too. */
export type FrontArrangement = "beside" | "below";

/** The share of the front's width the right column gets — `5fr 7fr` less the gap. */
const BESIDE_SHARE = 7 / 12;
const COLUMN_GAP = 48;
/** Under this container width the front is one column whatever the picture. */
export const TWO_COLUMN_MIN = 896;

export function frontArrangement(naturalWidth: number, containerWidth: number): FrontArrangement {
  if (containerWidth < TWO_COLUMN_MIN) {
    return "below";
  }
  const beside = (containerWidth - COLUMN_GAP) * BESIDE_SHARE;
  return naturalWidth > beside ? "below" : "beside";
}

export type FlowDrawingNode = { node: FlowNode; badge: ChapterBadge | null };
/** An edge as drawn: its route, and — when the edge carries its own anchor (a call site, an IPC
 * channel) — the badge and the anchor its label opens, like a node's box. */
export type FlowDrawingEdge = {
  edge: FlowEdge;
  route: FlowLayout["routes"][number];
  badge: ChapterBadge | null;
  anchor: AnchorSpan | undefined;
};

/** Where an edge's clickable tag sits: its layout label's place, or — for an anchored edge with
 * no label — the middle of the segment that enters the target, so the anchor still has somewhere
 * to be clicked. Null for an unlabelled edge with no anchor: there is nothing to say on it. */
export function edgeTagPoint(drawn: FlowDrawingEdge): { x: number; y: number } | null {
  if (drawn.route.label !== null) {
    return { x: drawn.route.label.x, y: drawn.route.label.y };
  }
  if (drawn.anchor === undefined) {
    return null;
  }
  const end = drawn.route.points.at(-1);
  const before = drawn.route.points.at(-2);
  return end === undefined || before === undefined
    ? null
    : { x: (end.x + before.x) / 2, y: (end.y + before.y) / 2 };
}

export type FlowDrawing = {
  layout: FlowLayout;
  nodes: ReadonlyMap<string, FlowDrawingNode>;
  edges: FlowDrawingEdge[];
};

/** A flow visual laid out (`layoutFlow`) with each box's badge and each route paired back to the
 * edge it draws. The layout drops an edge that names a missing node or loops on one — a
 * hand-edited artifact the gate would have refused — so routes are paired to edges by
 * `from`/`to`, in order, and an edge with no route is simply not drawn. A repeated node id keeps
 * its first node, as the layout does. */
export function flowDrawing(
  visual: FlowVisual,
  badgeOf: (anchor: AnchorSpan | undefined) => ChapterBadge | null,
  options: Partial<FlowLayoutOptions> = {},
): FlowDrawing {
  const nodes = new Map<string, FlowDrawingNode>();
  for (const node of visual.nodes) {
    if (!nodes.has(node.id)) {
      nodes.set(node.id, { node, badge: badgeOf(node.at) });
    }
  }
  const layout = layoutFlow(
    {
      nodes: [...nodes.values()].map(({ node, badge }) => ({
        id: node.id,
        label: node.label,
        extraWidth: FLOW_MARKER_WIDTH + badgeWidth(badge),
      })),
      edges: visual.edges.map((edge) => ({
        from: edge.from,
        to: edge.to,
        ...(edge.label === undefined ? {} : { label: edge.label }),
      })),
    },
    options,
  );
  const used = new Set<number>();
  const edges: FlowDrawingEdge[] = [];
  for (const route of layout.routes) {
    const index = visual.edges.findIndex(
      (edge, at) => !used.has(at) && edge.from === route.from && edge.to === route.to,
    );
    const edge = visual.edges[index];
    if (edge === undefined) {
      continue;
    }
    used.add(index);
    edges.push({ edge, route, anchor: edge.at, badge: badgeOf(edge.at) });
  }
  return { layout, nodes, edges };
}

/** Every drawn edge's tag point, with tags that would print over one another pushed apart.
 *
 * The layout already keeps labels off boxes and off each other (`lib/flow-layout.ts` — each
 * label rides a stretch of line that is its edge's alone). This is the fallback for what it
 * states it does not cover: two labels from opposite bands of one gap landing on one line, and
 * an anchored edge's unlabelled tag, which the layout never placed. Tags whose rows are closer
 * than a line of text and whose spans overlap are spread along x, later edges to the right of
 * earlier ones, in edge order (the author's, so the result is stable). The width of a tag is
 * estimated from its text at the label's character width plus its badge. */
export function edgeTagPoints(
  edges: readonly FlowDrawingEdge[],
  labelCharWidth: number,
): ({ x: number; y: number } | null)[] {
  const LINE = 12;
  const GAP = 8;
  const placed: { left: number; right: number; y: number }[] = [];
  return edges.map((drawn) => {
    const point = edgeTagPoint(drawn);
    if (point === null) {
      return null;
    }
    const width =
      (drawn.route.label?.text.length ?? 0) * labelCharWidth +
      (drawn.badge === null ? 0 : badgeWidth(drawn.badge));
    let center = point.x;
    for (let moved = true; moved; ) {
      moved = false;
      for (const other of placed) {
        const left = center - width / 2;
        const right = center + width / 2;
        if (
          Math.abs(other.y - point.y) < LINE &&
          left < other.right + GAP &&
          other.left < right + GAP
        ) {
          center = other.right + GAP + width / 2;
          moved = true;
        }
      }
    }
    placed.push({ left: center - width / 2, right: center + width / 2, y: point.y });
    return { x: center, y: point.y };
  });
}

export type SkeletonRow = { line: SkeletonLine; badge: ChapterBadge | null };

export function skeletonRows(
  lines: readonly SkeletonLine[],
  badgeOf: (anchor: AnchorSpan | undefined) => ChapterBadge | null,
): SkeletonRow[] {
  return lines.map((line) => ({ line, badge: badgeOf(line.at) }));
}

// ── Changed symbols ─────────────────────────────────────────────────────────────────────────

/** A symbol from the outline diff, with the anchor that opens it and the chapter it falls in. */
export type GuideSymbol = OutlineSymbol & {
  path: string;
  anchor: AnchorSpan;
  badge: ChapterBadge | null;
};

/** Every outlined symbol, in diff order, anchored at its line and badged by its owner. */
export function guideSymbols(
  outline: readonly FileOutline[],
  badgeOf: (anchor: AnchorSpan | undefined) => ChapterBadge | null,
): GuideSymbol[] {
  return outline.flatMap((file) =>
    file.symbols.map((symbol): GuideSymbol => {
      const anchor: AnchorSpan = {
        file: file.path,
        side: symbol.side,
        startLine: symbol.line,
        endLine: symbol.line,
      };
      return { ...symbol, path: file.path, anchor, badge: badgeOf(anchor) };
    }),
  );
}

/** The symbols one chapter row shows as chips: those owned by any layer in its extent. */
export function chapterSymbols(
  symbols: readonly GuideSymbol[],
  extentIds: ReadonlySet<string>,
): GuideSymbol[] {
  return symbols.filter((symbol) => symbol.badge !== null && extentIds.has(symbol.badge.layerId));
}

/** The glyph a symbol's status reads as: the diff's own `+` and `−`, and `~` for an edit. */
export function symbolMarker(status: OutlineSymbol["status"]): "+" | "−" | "~" {
  switch (status) {
    case "added":
      return "+";
    case "removed":
      return "−";
    case "modified":
      return "~";
    default:
      return assertNever(status);
  }
}

/** The Shape tab's grouping: files under their directory, directories in first-seen diff order,
 * so the list reads in the order the diff does. */
export type ShapeGroup = {
  dir: string;
  files: { path: string; name: string; symbols: GuideSymbol[]; omitted: number }[];
};

export function shapeGroups(
  outline: readonly FileOutline[],
  symbols: readonly GuideSymbol[],
): ShapeGroup[] {
  const byPath = new Map<string, GuideSymbol[]>();
  for (const symbol of symbols) {
    const list = byPath.get(symbol.path);
    if (list === undefined) {
      byPath.set(symbol.path, [symbol]);
    } else {
      list.push(symbol);
    }
  }
  const groups = new Map<string, ShapeGroup>();
  for (const file of outline) {
    const cut = file.path.lastIndexOf("/");
    const dir = cut === -1 ? "" : file.path.slice(0, cut);
    const name = cut === -1 ? file.path : file.path.slice(cut + 1);
    let group = groups.get(dir);
    if (group === undefined) {
      group = { dir, files: [] };
      groups.set(dir, group);
    }
    group.files.push({
      path: file.path,
      name,
      symbols: byPath.get(file.path) ?? [],
      omitted: file.omitted,
    });
  }
  return [...groups.values()];
}

// ── Chapter rows ────────────────────────────────────────────────────────────────────────────

/** One row of the guide's chapter list: a top-level chapter and the chapters nested under it,
 * flattened in document order. The inferred "not covered" chapter is a row of its own. */
export type GuideChapterRow = { chapter: OverviewChapter; children: OverviewChapter[] };

/** Fold the overview's chapters — every depth, in document order — into one row per top-level
 * chapter. A nested chapter whose parent never arrived (a depth the outline refused) opens a
 * row of its own rather than vanishing. */
export function chapterRows(chapters: readonly OverviewChapter[]): GuideChapterRow[] {
  const rows: GuideChapterRow[] = [];
  for (const chapter of chapters) {
    const current = rows.at(-1);
    if (chapter.depth > 0 && chapter.ordinal !== null && current !== undefined) {
      current.children.push(chapter);
    } else {
      rows.push({ chapter, children: [] });
    }
  }
  return rows;
}

/** What a chapter row draws in its right column: the authored picture, else the authored key
 * hunk, else the computed representative hunk (`representativeAnchors`) — or nothing, for a skim chapter (compact by design) and
 * for one with no code left to show. */
export type ChapterFigure =
  | { kind: "visual"; visual: ReviewVisual }
  | { kind: "snippet"; snippet: NonNullable<OverviewChapter["snippet"]> }
  | { kind: "none" };

export function chapterFigure(chapter: OverviewChapter): ChapterFigure {
  if (chapter.skim) {
    return { kind: "none" };
  }
  if (chapter.layer.visual !== undefined) {
    return { kind: "visual", visual: chapter.layer.visual };
  }
  return chapter.snippet === null
    ? { kind: "none" }
    : { kind: "snippet", snippet: chapter.snippet };
}

/** What a *nested* chapter draws, compactly, under its own prose inside its group's row: the
 * authored picture, else the authored key hunk — and nothing the app picked.
 *
 * Only what the author wrote, because the part sits in the group's left column, beside the
 * group's own figure: a computed excerpt under every part of a five-part group is five more
 * cards competing with the one the group chose, for hunks nobody said were the point. An
 * authored `visual` or `focus` is the opposite case — the gate proved it, the author asked for it
 * to be seen, and before this a nested chapter's were validated and then never drawn. A focus
 * that no longer places falls through to the app's pick in `chapterSnippet` (`source: "range"`),
 * which is exactly the computed card this leaves out. A skim part draws nothing, as a skim row
 * does. */
export function chapterPartFigure(chapter: OverviewChapter): ChapterFigure {
  if (chapter.skim) {
    return { kind: "none" };
  }
  if (chapter.layer.visual !== undefined) {
    return { kind: "visual", visual: chapter.layer.visual };
  }
  return chapter.snippet?.source === "focus"
    ? { kind: "snippet", snippet: chapter.snippet }
    : { kind: "none" };
}
