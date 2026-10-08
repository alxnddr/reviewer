import { describe, expect, it } from "vitest";
import type { ReviewLayer } from "../../../shared/review";
import { buildPathsPatch, MULTI_STATUS_PATCH, RENAMES_PATCH } from "../../../shared/diff/fixtures";
import { parsePatch } from "../../../shared/diff/patch";
import {
  buildModuleMap,
  layoutTreemap,
  lineOwnership,
  type ModuleMapDir,
  type ModuleMapFile,
  type ModuleMapNode,
  type TreemapRect,
} from "./module-map";

// Real parses of generated new files: `buildPathsPatch` gives every file `n` added lines
// numbered 1..n, so a range's coverage is its line count and every figure below is countable by
// eye. Two batches so the files differ in size.
const FILES = parsePatch(
  buildPathsPatch(
    ["src/renderer/src/lib/a.ts", "src/renderer/src/lib/b.ts", "src/main/index.ts"],
    10,
  ) + buildPathsPatch(["src/renderer/src/App.tsx", "README.md"], 4),
  "module-map-test",
);

function layer(id: string, ranges: ReviewLayer["ranges"], extra: Partial<ReviewLayer> = {}) {
  return { id, label: id, summary: `${id} summary`, ranges, ...extra };
}

function additions(file: string, startLine: number, endLine: number) {
  return { file, side: "additions" as const, startLine, endLine };
}

function walk(node: ModuleMapNode, visit: (node: ModuleMapNode) => void): void {
  visit(node);
  if (node.kind === "dir") {
    for (const child of node.children) {
      walk(child, visit);
    }
  }
}

function fileNode(map: ModuleMapDir, path: string): ModuleMapFile {
  let found: ModuleMapFile | undefined;
  walk(map, (node) => {
    if (node.kind === "file" && node.path === path) {
      found = node;
    }
  });
  if (found === undefined) {
    throw new Error(`no ${path}`);
  }
  return found;
}

describe("buildModuleMap", () => {
  it("groups files by directory and compresses a chain of single-directory parents", () => {
    const map = buildModuleMap(FILES, []);
    const shape = (node: ModuleMapNode): unknown =>
      node.kind === "file" ? node.name : { [node.label]: node.children.map(shape) };
    expect(shape(map)).toEqual({
      "": [
        {
          src: [{ main: ["index.ts"] }, { "renderer/src": [{ lib: ["a.ts", "b.ts"] }, "App.tsx"] }],
        },
        "README.md",
      ],
    });
    expect(map).toMatchObject({ changed: 38, weight: 38, files: 5 });
  });

  it("assigns the deepest layer owning the most lines, flags skim by inheritance, and flags uncovered", () => {
    const parent = layer("parent", [additions("src/renderer/src/lib/a.ts", 1, 10)], {
      skim: true,
    });
    // Nested under `parent` and narrower: owns 1..3 of a.ts by depth, and a.ts's other seven
    // lines stay `parent`'s — so `parent` wins a.ts on count.
    const child = layer("child", [additions("src/renderer/src/lib/a.ts", 1, 3)], {
      parent: "parent",
    });
    // b.ts: 6 lines to `other`, 4 to `third`; App.tsx: 2 of 4 lines covered.
    const other = layer("other", [additions("src/renderer/src/lib/b.ts", 1, 6)]);
    const third = layer("third", [
      additions("src/renderer/src/lib/b.ts", 7, 10),
      additions("src/renderer/src/App.tsx", 1, 2),
    ]);
    const layers = [parent, child, other, third];
    const map = buildModuleMap(FILES, layers);

    expect(fileNode(map, "src/renderer/src/lib/a.ts").chapter).toEqual({
      id: "parent",
      ordinal: "1",
      topId: "parent",
      skim: true,
    });
    expect(lineOwnership(FILES[0]!, layers).byLayer).toEqual(
      new Map([
        ["child", 3],
        ["parent", 7],
      ]),
    );
    expect(fileNode(map, "src/renderer/src/lib/b.ts").chapter?.id).toBe("other");
    expect(fileNode(map, "src/renderer/src/App.tsx")).toMatchObject({
      chapter: { id: "third", ordinal: "3", skim: false },
      uncoveredLines: 2,
      uncovered: false,
    });
    expect(fileNode(map, "src/main/index.ts")).toMatchObject({
      chapter: null,
      uncoveredLines: 10,
      uncovered: true,
    });
  });

  it("gives a deeper layer its lines and its badge when it owns the most of a file", () => {
    const parent = layer("parent", [additions("src/main/index.ts", 1, 10)]);
    const child = layer("child", [additions("src/main/index.ts", 2, 9)], { parent: "parent" });
    const map = buildModuleMap(FILES, [parent, child]);
    expect(fileNode(map, "src/main/index.ts").chapter).toEqual({
      id: "child",
      ordinal: "1.1",
      topId: "parent",
      skim: false,
    });
  });

  it("splits a parent's whole-file range with a child's line range, deepest first", () => {
    const parent = layer("parent", [{ file: "src/main/index.ts" }]);
    const child = layer("child", [additions("src/main/index.ts", 4, 6)], { parent: "parent" });
    expect(lineOwnership(FILES[2]!, [parent, child])).toMatchObject({
      byLayer: new Map([
        ["parent", 7],
        ["child", 3],
      ]),
      uncovered: 0,
    });
  });

  it("splits an earlier sibling's whole-file range with a later sibling's line range", () => {
    // Equal depth: the line range is the narrower claim (`layerOwning`), so the map counts the
    // three lines to the sibling that wrote them, not to whichever came first.
    const whole = layer("whole", [{ file: "src/main/index.ts" }]);
    const lines = layer("lines", [additions("src/main/index.ts", 4, 6)]);
    expect(lineOwnership(FILES[2]!, [whole, lines])).toMatchObject({
      byLayer: new Map([
        ["whole", 7],
        ["lines", 3],
      ]),
      uncovered: 0,
    });
  });

  it("keeps a binary and a pure rename on the map at weight one, never flagged uncovered", () => {
    const map = buildModuleMap(parsePatch(MULTI_STATUS_PATCH, "module-map-test"), []);
    expect(fileNode(map, "img.png")).toMatchObject({ changed: 0, weight: 1, uncovered: false });
    expect(fileNode(map, "newname.txt")).toMatchObject({ changed: 0, weight: 1, uncovered: false });
  });

  it("counts a range authored against a renamed file's old path", () => {
    const files = parsePatch(RENAMES_PATCH, "module-map-test");
    const renamed = files.find((file) => file.previousPath === "src/old-edit.txt")!;
    const changed = lineOwnership(renamed, []);
    const total = changed.additions + changed.deletions;
    const old = layer("old", [
      { file: "src/old-edit.txt", side: "deletions", startLine: 1, endLine: 100 },
      { file: "src/old-edit.txt", side: "additions", startLine: 1, endLine: 100 },
    ]);
    expect(lineOwnership(renamed, [old])).toMatchObject({
      byLayer: new Map([["old", total]]),
      uncovered: 0,
    });
  });
});

describe("layoutTreemap", () => {
  const leaf = (path: string, weight: number): ModuleMapFile => ({
    kind: "file",
    path,
    name: path,
    status: "added",
    additions: weight,
    deletions: 0,
    changed: weight,
    weight,
    chapter: null,
    uncoveredLines: weight,
    uncovered: true,
  });
  const flat = { header: 0, padding: 0, gap: 0 };
  const area = (rect: TreemapRect) => rect.width * rect.height;

  it("tiles the box exactly, in proportion to weight, with no overlap", () => {
    const nodes = [
      leaf("a", 6),
      leaf("b", 6),
      leaf("c", 4),
      leaf("d", 3),
      leaf("e", 2),
      leaf("f", 2),
      leaf("g", 1),
    ];
    const rects = layoutTreemap(nodes, 600, 400, flat);
    const total = rects.reduce((sum, rect) => sum + area(rect), 0);
    expect(total).toBeCloseTo(600 * 400, 6);
    for (const rect of rects) {
      expect(area(rect)).toBeCloseTo((rect.node.weight / 24) * 600 * 400, 6);
      expect(rect.x).toBeGreaterThanOrEqual(-1e-9);
      expect(rect.y).toBeGreaterThanOrEqual(-1e-9);
      expect(rect.x + rect.width).toBeLessThanOrEqual(600 + 1e-9);
      expect(rect.y + rect.height).toBeLessThanOrEqual(400 + 1e-9);
    }
    for (const [index, a] of rects.entries()) {
      for (const b of rects.slice(index + 1)) {
        const overlapX = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
        const overlapY = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
        expect(overlapX <= 1e-9 || overlapY <= 1e-9).toBe(true);
      }
    }
  });

  it("squares equal weights into a grid", () => {
    const rects = layoutTreemap(
      [leaf("a", 1), leaf("b", 1), leaf("c", 1), leaf("d", 1)],
      200,
      200,
      flat,
    );
    expect(rects.map((rect) => [rect.node.path, rect.x, rect.y, rect.width, rect.height])).toEqual([
      ["a", 0, 0, 100, 100],
      ["b", 0, 100, 100, 100],
      ["c", 100, 0, 100, 100],
      ["d", 100, 100, 100, 100],
    ]);
  });

  it("is deterministic: equal weights are placed by path, whatever the input order", () => {
    const forward = layoutTreemap([leaf("a", 2), leaf("b", 2), leaf("c", 2)], 300, 100);
    const backward = layoutTreemap([leaf("c", 2), leaf("b", 2), leaf("a", 2)], 300, 100);
    expect(backward).toEqual(forward);
  });

  it("nests a directory's tiles inside its frame, below its header band", () => {
    const map = buildModuleMap(FILES, []);
    const options = { header: 18, padding: 3, gap: 2, minHeaderWidth: 48 };
    const rects = layoutTreemap(map.children, 400, 300, options);
    // Pre-order: every frame precedes the tiles inside it.
    expect(rects[0]?.node.kind).toBe("dir");
    const src = rects.find((rect) => rect.node.kind === "dir" && rect.node.label === "src")!;
    expect(src).toMatchObject({ depth: 0, header: true });
    const inside = rects.filter((rect) => rect.depth > 0);
    expect(inside.length).toBeGreaterThan(0);
    for (const rect of inside) {
      if (!rect.node.path.startsWith("src/")) {
        continue;
      }
      expect(rect.y).toBeGreaterThanOrEqual(src.y + options.header - 1e-9);
      expect(rect.x).toBeGreaterThanOrEqual(src.x + options.padding - 1e-9);
      expect(rect.x + rect.width).toBeLessThanOrEqual(src.x + src.width - options.padding + 1e-9);
      expect(rect.y + rect.height).toBeLessThanOrEqual(src.y + src.height - options.padding + 1e-9);
    }
    // Every file appears exactly once.
    expect(rects.filter((rect) => rect.node.kind === "file")).toHaveLength(5);
  });

  it("drops a header that would not fit, and lays out nothing in an empty box", () => {
    const map = buildModuleMap(FILES, []);
    const tiny = layoutTreemap(map.children, 40, 30);
    expect(tiny.filter((rect) => rect.node.kind === "dir").every((rect) => !rect.header)).toBe(
      true,
    );
    expect(layoutTreemap(map.children, 0, 300).every((rect) => rect.width === 0)).toBe(true);
  });
});
