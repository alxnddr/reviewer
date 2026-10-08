import { describe, expect, it } from "vitest";
import {
  buildPathsPatch,
  GUIDE_DEPS_PATCH,
  IMPORTS_PATCH,
  OUTLINE_PATCH,
} from "../../../shared/diff/fixtures";
import { dependencyDiff, type FileDependencies } from "../../../shared/diff/imports";
import { parsePatch, type PatchFile } from "../../../shared/diff/patch";
import {
  buildDepsGraph,
  DEFAULT_MAX_DEPS_EDGES,
  DEFAULT_MAX_DEPS_NODES,
  edgeCountLabel,
  type DepsGraph,
} from "./deps-graph";
import { layoutFlow } from "./flow-layout";
import { flowOptions } from "./guide";
import { buildModuleMap } from "./module-map";

// The module graph over the dependency diff. Real parses throughout: the guide's own two patches
// (the picture the preview draws), the eight-language fixture (the cap), and a cut of this app's
// own layout for the labels.

function graphOf(patch: string, maxNodes?: number): DepsGraph {
  const files = parsePatch(patch, "deps-graph-test");
  return buildDepsGraph(dependencyDiff(files), files, buildModuleMap(files, []), maxNodes);
}

/** Edges as `from → to status +a −r`, by label. */
function edges(graph: DepsGraph): string[] {
  const label = new Map(graph.nodes.map((node) => [node.id, node.label]));
  return graph.edges.map(
    (edge) =>
      `${label.get(edge.from)} → ${label.get(edge.to)} ${edge.status} ${edgeCountLabel(edge)}`,
  );
}

describe("buildDepsGraph over the guide's patches", () => {
  const graph = graphOf(OUTLINE_PATCH + GUIDE_DEPS_PATCH);

  it("folds statements to module edges, dropping imports within one module", () => {
    // `src/blob.ts` → `./retry` stays inside `src/`, so it is not drawn.
    expect(edges(graph)).toEqual([
      "src/ → lru-cache removed −1",
      "src/ → p-retry added +1",
      "src/ → lib/ added +1",
      "web/ → src/ changed +1 −1",
    ]);
  });

  it("names modules and packages, in first-appearance order", () => {
    expect(graph.nodes.map((node) => [node.label, node.kind, node.status])).toEqual([
      ["src/", "module", "same"],
      ["lru-cache", "package", "same"],
      ["p-retry", "package", "same"],
      ["lib/", "module", "same"],
      ["web/", "module", "same"],
    ]);
    expect(graph.statements).toBe(5);
    expect(graph.hidden).toEqual({ nodes: 0, edges: 0 });
  });

  it("anchors an edge on its statements in diff order, removed before added on one line", () => {
    const web = graph.edges.find((edge) => edge.status === "changed");
    expect(web?.statements.map((statement) => [statement.change, statement.anchor])).toEqual([
      ["removed", { file: "web/viewer.ts", side: "deletions", startLine: 1, endLine: 1 }],
      ["added", { file: "web/viewer.ts", side: "additions", startLine: 1, endLine: 1 }],
    ]);
  });
});

describe("node status", () => {
  it("marks a module whose changed files are all new as added, all deleted as removed", () => {
    const graph = graphOf(IMPORTS_PATCH);
    const status = new Map(graph.nodes.map((node) => [node.title, node.status]));
    expect(status.get("internal/store")).toBe("added");
    expect(status.get("internal/cache")).toBe("removed");
    expect(status.get("cmd")).toBe("same");
    expect(status.get("net/http")).toBe("same");
  });
});

describe("kept edges", () => {
  it("calls an edge kept when a context line in the same module already imports its target", () => {
    const files: PatchFile[] = parsePatch(buildPathsPatch(["web/a.ts", "web/b.ts"], 1), "kept");
    const statement = (line: number) => ({
      specifier: "../src/x",
      target: { kind: "internal" as const, path: "src/x.ts", directory: false, inDiff: false },
      side: "additions" as const,
      line,
    });
    const dependencies: FileDependencies[] = [
      { path: "web/a.ts", added: [statement(1)], removed: [], unchanged: [] },
      { path: "web/b.ts", added: [], removed: [], unchanged: [statement(1)] },
    ];
    const graph = buildDepsGraph(dependencies, files, buildModuleMap(files, []));
    expect(edges(graph)).toEqual(["web/ → src/ kept +1"]);
  });
});

describe("labels", () => {
  it("cuts each module to the shortest tail of its map frames no other node shares", () => {
    const files = parsePatch(
      buildPathsPatch(
        [
          "src/renderer/src/components/a.ts",
          "src/renderer/src/lib/b.ts",
          "src/main/lib/c.ts",
          "src/renderer/src/App.ts",
        ],
        1,
      ),
      "labels",
    );
    const at = (path: string, line = 1) => ({
      specifier: "x",
      target: { kind: "internal" as const, path, directory: false, inDiff: true },
      side: "additions" as const,
      line,
    });
    const dependencies: FileDependencies[] = [
      {
        path: "src/renderer/src/components/a.ts",
        added: [at("src/renderer/src/lib/b.ts"), at("src/main/lib/c.ts")],
        removed: [],
        unchanged: [],
      },
      {
        path: "src/renderer/src/App.ts",
        added: [at("src/renderer/src/components/a.ts")],
        removed: [],
        unchanged: [],
      },
    ];
    const graph = buildDepsGraph(dependencies, files, buildModuleMap(files, []));
    expect(graph.nodes.map((node) => node.label)).toEqual([
      "components/",
      // `src/main` holds nothing but `lib`, so the map draws `main/lib` as one frame and the
      // two `lib`s are already told apart at one frame each.
      "lib/",
      "main/lib/",
      // `src/renderer/src` is one frame of the map, so it is named whole — never a bare `src/`.
      "renderer/src/",
    ]);
  });
});

describe("the cap", () => {
  it("draws the heaviest edges whose endpoints fit and counts the rest", () => {
    const full = graphOf(IMPORTS_PATCH, 100);
    const capped = graphOf(IMPORTS_PATCH, 8);
    expect(capped.nodes.length).toBeLessThanOrEqual(8);
    expect(capped.hidden.edges).toBe(full.edges.length - capped.edges.length);
    expect(capped.hidden.nodes).toBe(full.nodes.length - capped.nodes.length);
    expect(capped.statements).toBe(full.statements);
    // The only two-statement edge survives any cap that can hold two nodes.
    expect(edges(capped)).toContain("web/ → src/ changed +1 −1");
    const shown = new Set(capped.nodes.map((node) => node.id));
    expect(capped.edges.every((edge) => shown.has(edge.from) && shown.has(edge.to))).toBe(true);
  });

  it("caps the edges too, so a densely wired graph still lays out as a picture", () => {
    // Twenty-four modules, each importing every other: 552 edges, every one inside the node cap.
    // Uncapped, `layoutFlow` drew this 48,624 px tall.
    const modules = Array.from({ length: DEFAULT_MAX_DEPS_NODES }, (_, index) => `m${index}`);
    const files = parsePatch(
      buildPathsPatch(
        modules.map((module) => `src/${module}/index.ts`),
        1,
      ),
      "dense",
    );
    const dependencies: FileDependencies[] = modules.map((from) => ({
      path: `src/${from}/index.ts`,
      added: modules
        .filter((to) => to !== from)
        .map((to, line) => ({
          specifier: `../${to}`,
          target: {
            kind: "internal" as const,
            path: `src/${to}/index.ts`,
            directory: false,
            inDiff: true,
          },
          side: "additions" as const,
          line: line + 1,
        })),
      removed: [],
      unchanged: [],
    }));
    const graph = buildDepsGraph(dependencies, files, buildModuleMap(files, []));
    expect(graph.edges).toHaveLength(DEFAULT_MAX_DEPS_EDGES);
    expect(graph.hidden.edges).toBe(552 - DEFAULT_MAX_DEPS_EDGES);
    const layout = layoutFlow(
      {
        nodes: graph.nodes.map((node) => ({ id: node.id, label: node.label })),
        edges: graph.edges.map((edge) => ({
          from: edge.from,
          to: edge.to,
          label: edgeCountLabel(edge),
        })),
      },
      flowOptions(false, 720),
    );
    expect(layout.height).toBeLessThan(2000);
  });

  it("draws nothing for a diff with no import change", () => {
    const graph = graphOf(buildPathsPatch(["src/a.ts"], 3));
    expect(graph).toEqual({ nodes: [], edges: [], hidden: { nodes: 0, edges: 0 }, statements: 0 });
  });
});

describe("edgeCountLabel", () => {
  it("prints the counts it has", () => {
    expect(edgeCountLabel({ added: 2, removed: 0 })).toBe("+2");
    expect(edgeCountLabel({ added: 0, removed: 1 })).toBe("−1");
    expect(edgeCountLabel({ added: 1, removed: 3 })).toBe("+1 −3");
  });
});
