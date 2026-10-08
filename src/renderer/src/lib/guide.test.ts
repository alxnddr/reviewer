import { describe, expect, it } from "vitest";
import type { FlowVisual, ReviewLayer, SkeletonVisual } from "../../../shared/review";
import { OUTLINE_PATCH } from "../../../shared/diff/fixtures";
import { parsePatch } from "../../../shared/diff/patch";
import { outlineDiff } from "../../../shared/diff/outline";
import {
  badgeText,
  badgeWidth,
  chapterCounter,
  chapterFigure,
  chapterPartFigure,
  chapterRows,
  chapterSlots,
  chapterSymbols,
  chapterTint,
  CHAPTER_HUE_TURNS,
  createBadgeLookup,
  edgeTagPoint,
  edgeTagPoints,
  flowDrawing,
  flowOptions,
  frontArrangement,
  guideSymbols,
  mapHeight,
  shapeGroups,
  symbolMarker,
  tileTone,
  TWO_COLUMN_MIN,
  visualAnchors,
  visualCounts,
  visualNaturalWidth,
} from "./guide";
import type { ModuleMapFile } from "./module-map";
import { buildOverview } from "./overview";
import { NO_READ_FILES } from "./read-progress";

// The guide's decisions, held without a document. `OUTLINE_PATCH` is the real six-file capture
// the outline is tested against; the layers below are cut to its line numbers.

const FILES = parsePatch(OUTLINE_PATCH, "guide-test");

function layer(id: string, ranges: ReviewLayer["ranges"], extra: Partial<ReviewLayer> = {}) {
  return { id, label: `${id} label`, ranges, ...extra };
}

const blob = (side: "additions" | "deletions", startLine: number, endLine: number) =>
  ({ file: "src/blob.ts", side, startLine, endLine }) as const;

// `retry` (1) owns blob.ts's top; the group `server` (2) owns nothing itself, its part `name`
// (2.1) owns server.go's first hunk; `docs` (3) is skim and owns the README line.
const LAYERS: ReviewLayer[] = [
  layer("retry", [blob("additions", 2, 5), blob("deletions", 3, 13)]),
  layer("server", []),
  layer("name", [{ file: "cmd/server.go", side: "additions", startLine: 5, endLine: 10 }], {
    parent: "server",
  }),
  layer("docs", [{ file: "README.md", side: "additions", startLine: 4, endLine: 4 }], {
    skim: true,
  }),
];

const badgeOf = createBadgeLookup(LAYERS);

describe("badges", () => {
  it("pads the top-level number so a column of badges is one width", () => {
    expect(badgeText("1")).toBe("01");
    expect(badgeText("4.2")).toBe("04.2");
    expect(badgeText("12")).toBe("12");
    expect(chapterCounter("2.1", 6)).toBe("02 / 06");
  });

  it("derives an element's chapter from the layer that owns its anchor — the deepest", () => {
    expect(badgeOf(blob("additions", 4, 4))).toEqual({
      layerId: "retry",
      ordinal: "1",
      text: "01",
      topId: "retry",
      skim: false,
    });
    expect(
      badgeOf({ file: "cmd/server.go", side: "additions", startLine: 9, endLine: 9 }),
    ).toMatchObject({ layerId: "name", ordinal: "2.1", text: "02.1", topId: "server" });
  });

  it("wears no badge with no anchor, or for code no chapter explains", () => {
    expect(badgeOf(undefined)).toBeNull();
    expect(badgeOf(blob("additions", 15, 16))).toBeNull();
  });

  it("badges a line range over an earlier sibling's whole-file range on the same file", () => {
    // `whole` claims all of blob.ts and comes first; `lines` claims four of its lines. Before the
    // tie-break, `whole` took those four too, and `lines`' own elements wore `01`.
    const siblings = [
      layer("whole", [{ file: "src/blob.ts" }]),
      layer("lines", [blob("additions", 2, 5)]),
    ];
    const lookup = createBadgeLookup(siblings);
    expect(lookup(blob("additions", 4, 4))?.layerId).toBe("lines");
    expect(lookup(blob("additions", 9, 9))?.layerId).toBe("whole");
    expect(lookup(blob("deletions", 4, 4))?.layerId).toBe("whole");
  });

  it("carries skim down from the chapter that was marked", () => {
    expect(badgeOf({ file: "README.md", side: "additions", startLine: 4, endLine: 4 })?.skim).toBe(
      true,
    );
  });

  it("sizes a badge from its text", () => {
    expect(badgeWidth(null)).toBe(0);
    expect(badgeWidth(badgeOf(blob("additions", 4, 4)))).toBeGreaterThan(0);
  });
});

describe("tints", () => {
  it("gives each top-level chapter a slot in authored order, cycling", () => {
    const many = Array.from({ length: CHAPTER_HUE_TURNS.length + 1 }, (_, index) =>
      layer(`c${index}`, []),
    );
    const slots = chapterSlots([...many, layer("child", [], { parent: "c0" })]);
    expect(slots.get("c0")).toBe(0);
    expect(slots.get("c1")).toBe(1);
    expect(slots.get(`c${CHAPTER_HUE_TURNS.length}`)).toBe(0);
    expect(slots.has("child")).toBe(false);
  });

  it("turns the theme's primary, faded in a space with no hue to drift through", () => {
    expect(chapterTint(1, "ground")).toBe(
      `color-mix(in oklab, oklch(from var(--primary) l c calc(h + ${CHAPTER_HUE_TURNS[1]})) 22%, var(--diff-surface))`,
    );
    expect(chapterTint(CHAPTER_HUE_TURNS.length, "strong")).toBe(chapterTint(0, "strong"));
  });

  it("tones a tile by its chapter, skim neutral, uncovered flagged, nothing to explain plain", () => {
    const slots = chapterSlots(LAYERS);
    const file = (extra: Partial<ModuleMapFile>): ModuleMapFile => ({
      kind: "file",
      path: "a.ts",
      name: "a.ts",
      status: "modified",
      additions: 1,
      deletions: 0,
      changed: 1,
      weight: 1,
      chapter: null,
      uncoveredLines: 0,
      uncovered: false,
      ...extra,
    });
    const chapter = { id: "name", ordinal: "2.1", topId: "server", skim: false };
    expect(tileTone(file({ chapter }), slots)).toEqual({ kind: "chapter", slot: 1 });
    expect(tileTone(file({ chapter: { ...chapter, skim: true } }), slots)).toEqual({
      kind: "skim",
    });
    expect(tileTone(file({ uncovered: true }), slots)).toEqual({ kind: "uncovered" });
    expect(tileTone(file({}), slots)).toEqual({ kind: "none" });
  });
});

const FLOW: FlowVisual = {
  kind: "flow",
  caption: "How a read reaches the network",
  nodes: [
    { id: "load", label: "loadBlob()", status: "changed", at: blob("additions", 4, 4) },
    { id: "retry", label: "withRetry()", status: "added", at: blob("additions", 5, 5) },
    { id: "cache", label: "blobCache", status: "removed", at: blob("deletions", 3, 3) },
    { id: "fetch", label: "fetchBlob()", status: "same" },
  ],
  edges: [
    { from: "load", to: "retry", status: "added", label: "path" },
    { from: "load", to: "cache", status: "removed", at: blob("deletions", 6, 6) },
    { from: "retry", to: "fetch", status: "added" },
    // Hand-edited breakage the gate would refuse: the app draws around it.
    { from: "retry", to: "nowhere" },
    { from: "fetch", to: "fetch" },
  ],
};

const SKELETON: SkeletonVisual = {
  kind: "skeleton",
  caption: "What a read now does",
  lines: [
    { depth: 0, code: "loadBlob(path)", status: "same" },
    { depth: 1, code: "blobCache.get(path)", status: "removed", at: blob("deletions", 6, 6) },
    {
      depth: 1,
      code: "withRetry(() => fetchBlob(path))",
      status: "added",
      note: "backs off",
      at: blob("additions", 5, 5),
    },
  ],
};

describe("visuals", () => {
  it("counts nodes and lines by status, never edges", () => {
    expect(visualCounts(FLOW)).toEqual({ added: 1, removed: 1, changed: 1 });
    expect(visualCounts(SKELETON)).toEqual({ added: 1, removed: 1, changed: 0 });
  });

  it("lists every anchor a visual carries, edges included", () => {
    expect(visualAnchors(FLOW)).toHaveLength(4);
    expect(visualAnchors(SKELETON)).toHaveLength(2);
  });

  it("lays a flow out, badges its boxes, and pairs each drawn route back to its edge", () => {
    const drawing = flowDrawing(FLOW, badgeOf);
    expect(drawing.nodes.get("load")?.badge?.text).toBe("01");
    expect(drawing.nodes.get("fetch")?.badge).toBeNull();
    // The dangling edge and the self-loop are not drawn; the rest keep their status.
    expect(
      drawing.edges.map((drawn) => [drawn.edge.from, drawn.edge.to, drawn.edge.status]),
    ).toEqual([
      ["load", "retry", "added"],
      ["load", "cache", "removed"],
      ["retry", "fetch", "added"],
    ]);
    // An anchored edge is badged like a node.
    expect(drawing.edges[1]?.badge?.text).toBe("01");
    // A badged box is wider than the same label would be bare.
    const bare = flowDrawing(FLOW, () => null);
    const width = (layout: typeof drawing, id: string) =>
      layout.layout.boxes.find((box) => box.id === id)?.width ?? 0;
    expect(width(drawing, "load")).toBeGreaterThan(width(bare, "load"));
  });

  it("puts an edge's tag on its label, else mid-entry for an anchored edge, else nowhere", () => {
    const drawing = flowDrawing(FLOW, badgeOf);
    const [labelled, anchored, plain] = drawing.edges;
    expect(edgeTagPoint(labelled!)).toEqual({
      x: labelled!.route.label!.x,
      y: labelled!.route.label!.y,
    });
    const end = anchored!.route.points.at(-1)!;
    const before = anchored!.route.points.at(-2)!;
    expect(edgeTagPoint(anchored!)).toEqual({ x: (end.x + before.x) / 2, y: end.y });
    expect(edgeTagPoint(plain!)).toBeNull();
  });

  it("pushes apart edge tags that would print over one another", () => {
    // The layout keeps labels apart (`flow-layout.test.ts` checks it on the real sample); this
    // is the fallback for the case it states it does not cover — two labels from opposite bands
    // of one gap landing on one line — so the collision is built by hand: both tags on one spot.
    const fan: FlowVisual = {
      kind: "flow",
      caption: "Two tags on one spot",
      nodes: [
        { id: "a", label: "aaaaaaaaaa", status: "same" },
        { id: "b", label: "bbbbbbbbbb", status: "same" },
        { id: "c", label: "cccccccccc", status: "same" },
      ],
      edges: [
        { from: "a", to: "b", label: "attempt" },
        { from: "a", to: "c", label: "delay" },
      ],
    };
    const drawing = flowDrawing(fan, () => null);
    const stacked = drawing.edges.map((drawn) => ({
      ...drawn,
      route: {
        ...drawn.route,
        label: drawn.route.label === null ? null : { text: drawn.route.label.text, x: 100, y: 50 },
      },
    }));
    const [first, second] = edgeTagPoints(stacked, 6.6);
    const half = (text: string) => (text.length * 6.6) / 2;
    expect(second!.x - half("delay")).toBeGreaterThanOrEqual(first!.x + half("attempt"));
    // Tags that do not collide stay where the layout put them.
    const apart = flowDrawing(FLOW, badgeOf);
    expect(edgeTagPoints(apart.edges, 6.6)[0]).toEqual(edgeTagPoint(apart.edges[0]!));
  });

  it("puts the picture beside the lede only when it fits the column unwrapped", () => {
    expect(frontArrangement(400, 1100)).toBe("beside");
    expect(frontArrangement(900, 1100)).toBe("below");
    expect(frontArrangement(2000, 1100)).toBe("below");
    expect(frontArrangement(200, TWO_COLUMN_MIN - 1)).toBe("below");
    expect(visualNaturalWidth(FLOW, badgeOf)).toBe(
      flowDrawing(FLOW, badgeOf, flowOptions(false, Number.POSITIVE_INFINITY)).layout.width,
    );
    const wider: SkeletonVisual = {
      ...SKELETON,
      lines: [...SKELETON.lines, { depth: 3, code: "x".repeat(80), status: "same" }],
    };
    expect(visualNaturalWidth(wider, badgeOf)).toBeGreaterThan(
      visualNaturalWidth(SKELETON, badgeOf),
    );
  });

  it("grows the map with the file count, between bounds", () => {
    expect(mapHeight(1)).toBe(180);
    expect(mapHeight(10)).toBe(280);
    expect(mapHeight(100)).toBe(360);
  });
});

describe("changed symbols", () => {
  const outline = outlineDiff(FILES);
  const symbols = guideSymbols(outline, badgeOf);

  it("anchors each symbol at its line and badges it by owner", () => {
    const load = symbols.find((symbol) => symbol.name === "loadBlob");
    expect(load?.anchor).toEqual({
      file: "src/blob.ts",
      side: load?.side,
      startLine: load?.line,
      endLine: load?.line,
    });
    expect(load?.badge?.layerId).toBe("retry");
    expect(symbolMarker("modified")).toBe("~");
  });

  it("gives a chapter the symbols its extent owns", () => {
    const group = chapterSymbols(symbols, new Set(["server", "name"]));
    expect(group.map((symbol) => symbol.path)).toEqual(group.map(() => "cmd/server.go"));
    expect(group.length).toBeGreaterThan(0);
    expect(chapterSymbols(symbols, new Set(["docs"]))).toEqual([]);
  });

  it("groups the Shape tab by directory in diff order", () => {
    const groups = shapeGroups(outline, symbols);
    expect(groups.map((group) => group.dir)).toEqual([
      ...new Set(outline.map((file) => file.path.split("/").slice(0, -1).join("/"))),
    ]);
    const src = groups.find((group) => group.dir === "src");
    expect(src?.files.map((file) => file.name)).toEqual(["blob.ts", "handlers.ts"]);
  });
});

describe("chapter rows", () => {
  const model = buildOverview({
    layers: LAYERS,
    files: FILES,
    comments: [],
    frozen: false,
    readFiles: NO_READ_FILES,
  });

  it("folds nested chapters into their top-level row, the inferred one on its own", () => {
    const rows = chapterRows(model.chapters);
    expect(
      rows.map((row) => [row.chapter.layer.id, row.children.map((child) => child.layer.id)]),
    ).toEqual([
      ["retry", []],
      ["server", ["name"]],
      ["docs", []],
      ["reviewer:uncovered", []],
    ]);
  });

  it("shows the picture, else the card, and nothing for a skim chapter", () => {
    const [retry, , docs] = model.chapters.filter((chapter) => chapter.depth === 0);
    expect(chapterFigure(retry!).kind).toBe("snippet");
    expect(chapterFigure({ ...retry!, layer: { ...retry!.layer, visual: SKELETON } })).toEqual({
      kind: "visual",
      visual: SKELETON,
    });
    expect(chapterFigure(docs!).kind).toBe("none");
    expect(chapterFigure({ ...retry!, snippet: null }).kind).toBe("none");
  });

  it("draws a nested chapter's authored picture or key hunk, and never the app's own pick", () => {
    const focus = { file: "cmd/server.go", side: "additions", startLine: 5, endLine: 10 } as const;
    const nested = (extra: Partial<ReviewLayer>) =>
      buildOverview({
        layers: LAYERS.map((each) => (each.id === "name" ? { ...each, ...extra } : each)),
        files: FILES,
        comments: [],
        frozen: false,
        readFiles: NO_READ_FILES,
      }).chapters.find((chapter) => chapter.layer.id === "name")!;

    // No focus: the model still carries the computed card (the top-level row's fallback), but a
    // part does not draw it.
    const bare = nested({});
    expect(bare.snippet?.source).toBe("range");
    expect(chapterPartFigure(bare)).toEqual({ kind: "none" });

    const focused = nested({ focus });
    expect(chapterPartFigure(focused)).toEqual({ kind: "snippet", snippet: focused.snippet });
    expect(focused.snippet?.source).toBe("focus");

    // A picture outranks the hunk, as it does on a top-level row; skim draws nothing at all.
    expect(chapterPartFigure(nested({ focus, visual: SKELETON }))).toEqual({
      kind: "visual",
      visual: SKELETON,
    });
    expect(chapterPartFigure({ ...focused, skim: true })).toEqual({ kind: "none" });
  });
});
