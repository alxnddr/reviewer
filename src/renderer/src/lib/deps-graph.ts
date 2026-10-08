import type { AnchorSpan } from "../../../shared/review";
import type { PatchFile } from "../../../shared/diff/patch";
import {
  dirnameOf,
  type DependencyChange,
  type DependencyTarget,
  type FileDependencies,
} from "../../../shared/diff/imports";
import type { ModuleMapDir } from "./module-map";

// The Deps tab's model: the dependency diff (`shared/diff/imports.ts`, per file, per statement)
// folded up to modules — "the diff of modules", how the change rewires who depends on whom. Pure
// and DOM-free; `components/guide/DepsGraph.tsx` lays it out with `layoutFlow` and draws it.
//
// **A module is a directory**, the grouping the Map tab draws a frame for: a file's module is the
// directory it sits in, and a node is labelled the way the Map labels that frame — the module
// map's compressed chain (`src/renderer/src` is one name, not three) — cut to the shortest tail
// that is unique among the nodes on screen, so `components/` and `lib/` read as themselves and
// two `lib/`s grow a parent each. A target the diff does not carry (`../lib/clock`) is still a
// directory of the repository, named relative to the deepest frame the map has above it.
// External packages are one node per package root (`@scope/pkg`, `zod`), an alias no changed file
// explained one node per alias directory (`@/lib`). An import within one module is not drawn: the
// tab answers what crosses a module boundary, and a self-loop says nothing a reader can follow.
//
// **An edge's status is what the diff did to it**, not a claim about the whole repository, which
// the diff cannot see: `added` — the change adds imports along it and removes none; `removed` —
// the reverse; `changed` — both, in one file or several (the viewer swapping `../src/cache` for
// `../src/blob` is web → src both ways). And `kept` when a *context* line in the same source
// module already imports the same target module: the edge provably existed before and still
// does, so its imports changed but the wiring did not — the one case the diff can prove, and the
// one that would otherwise draw an old dependency as new. Without that proof an `added` edge may
// still be one more import on an edge that existed out of sight; the tab says "imports added",
// never "new dependency".
//
// **A node's status** is the module's, from its own changed files: `added` when every one of them
// is a new file (the diff cannot see unchanged files beside them, so a new file in an old
// directory of only-new changes reads as a new module — the stated limit), `removed` when every
// one is deleted, `same` otherwise and for a module the diff only points at.
//
// Every edge carries the statements behind it as anchors on their own `+`/`-` lines, in diff
// order; the first is what clicking the edge opens.
//
// **Capped, in nodes and in edges.** Past `maxNodes` the picture stops being one: the edges are
// ranked by how many statements they carry and taken while their endpoints fit, and what was left
// is counted in `hidden` for a "+N more" line rather than drawn. Nodes alone do not bound it:
// `layoutFlow` gives every edge its own track and label room, so twenty-four nodes wired densely
// (276 edges) laid out 48,624 px tall — a picture nobody can read and the window has to paint.
// `maxEdges` stops the ranked walk at the heaviest few dozen, which keeps the drawing within a
// couple of screens (`deps-graph.test.ts` holds a dense graph's layout to that).

export type DepsNodeKind = "module" | "package" | "alias";
export type DepsNodeStatus = "added" | "removed" | "same";

export type DepsNode = {
  id: string;
  kind: DepsNodeKind;
  /** What the box prints: a module's unique tail with a trailing `/`, a package's name, an alias
   * directory as written. */
  label: string;
  /** The whole name, for the hint: the module's repository path, the package, the alias. */
  title: string;
  status: DepsNodeStatus;
};

export type DepsEdgeStatus = "added" | "removed" | "changed" | "kept";

export type DepsStatement = {
  anchor: AnchorSpan;
  specifier: string;
  change: "added" | "removed";
};

export type DepsEdge = {
  from: string;
  to: string;
  status: DepsEdgeStatus;
  added: number;
  removed: number;
  /** In diff order: by file as the diff lists them, then by line. Never empty. */
  statements: DepsStatement[];
};

export type DepsGraph = {
  nodes: DepsNode[];
  edges: DepsEdge[];
  /** What the cap left out. */
  hidden: { nodes: number; edges: number };
  /** Changed import statements behind every edge, drawn or not. */
  statements: number;
};

export const DEFAULT_MAX_DEPS_NODES = 24;
export const DEFAULT_MAX_DEPS_EDGES = 32;

const ROOT_MODULE = "";

function moduleNodeId(path: string): string {
  return `module:${path}`;
}

function targetNode(target: DependencyTarget): { id: string; kind: DepsNodeKind; name: string } {
  switch (target.kind) {
    case "internal": {
      const path = target.directory ? target.path : dirnameOf(target.path);
      return { id: moduleNodeId(path), kind: "module", name: path };
    }
    case "package":
      return { id: `package:${target.name}`, kind: "package", name: target.name };
    case "unresolved": {
      const directory = dirnameOf(target.specifier);
      const name = directory === "" || directory.endsWith("@") ? target.specifier : directory;
      return { id: `alias:${name}`, kind: "alias", name };
    }
  }
}

/** Every directory the module map draws, by path → the chain of frame labels from the top
 * (`["src", "renderer/src", "components"]`). */
function frameChains(root: ModuleMapDir): Map<string, string[]> {
  const chains = new Map<string, string[]>();
  const visit = (dir: ModuleMapDir, chain: string[]): void => {
    const own = dir.path === "" ? chain : [...chain, dir.label];
    chains.set(dir.path, own);
    for (const child of dir.children) {
      if (child.kind === "dir") {
        visit(child, own);
      }
    }
  };
  visit(root, []);
  return chains;
}

/** A module's name as segments: the chain of the deepest frame at or above it, then whatever of
 * its path lies below that frame. */
function moduleChain(path: string, chains: ReadonlyMap<string, string[]>): string[] {
  for (let frame = path; ; frame = dirnameOf(frame)) {
    const chain = chains.get(frame);
    if (chain !== undefined) {
      const rest = frame === path ? "" : path.slice(frame === "" ? 0 : frame.length + 1);
      return rest === "" ? chain : [...chain, rest];
    }
    if (frame === "") {
      return path === "" ? [] : [path];
    }
  }
}

/** Labels for module paths: the shortest tail of each one's chain that no other module shares.
 * The tail is counted in the chain's *frames*, not in path segments, so a compressed frame stays
 * whole — `src/renderer/src` reads `renderer/src/`, the way the Map's frame header reads, and
 * never a bare `src/` that names a different directory. */
function moduleLabels(
  paths: readonly string[],
  chains: ReadonlyMap<string, string[]>,
): Map<string, string> {
  const segments = new Map(paths.map((path) => [path, moduleChain(path, chains)]));
  const labels = new Map<string, string>();
  for (const path of paths) {
    const own = segments.get(path) ?? [];
    if (path === ROOT_MODULE) {
      labels.set(path, "./");
      continue;
    }
    let take = 1;
    const tail = (parts: readonly string[], count: number): string =>
      parts.slice(Math.max(0, parts.length - count)).join("/");
    while (
      take < own.length &&
      paths.some(
        (other) => other !== path && tail(segments.get(other) ?? [], take) === tail(own, take),
      )
    ) {
      take += 1;
    }
    labels.set(path, `${tail(own, take)}/`);
  }
  return labels;
}

function moduleStatus(path: string, files: readonly PatchFile[]): DepsNodeStatus {
  const own = files.filter((file) => dirnameOf(file.path) === path);
  if (own.length === 0) {
    return "same";
  }
  if (own.every((file) => file.status === "added")) {
    return "added";
  }
  return own.every((file) => file.status === "deleted") ? "removed" : "same";
}

function edgeStatus(added: number, removed: number, kept: boolean): DepsEdgeStatus {
  if (kept) {
    return "kept";
  }
  if (added > 0 && removed > 0) {
    return "changed";
  }
  return added > 0 ? "added" : "removed";
}

type EdgeBuilder = {
  from: string;
  to: string;
  statements: (DepsStatement & { order: number })[];
};

function nodeOf(
  id: string,
  known: { kind: DepsNodeKind; name: string },
  labels: ReadonlyMap<string, string>,
  files: readonly PatchFile[],
): DepsNode {
  switch (known.kind) {
    case "module":
      return {
        id,
        kind: "module",
        label: labels.get(known.name) ?? `${known.name}/`,
        title: known.name === ROOT_MODULE ? "the repository root" : known.name,
        status: moduleStatus(known.name, files),
      };
    case "package":
      return { id, kind: "package", label: known.name, title: known.name, status: "same" };
    case "alias":
      return { id, kind: "alias", label: known.name, title: known.name, status: "same" };
  }
}

/** The module graph of a dependency diff. `files` is the loaded diff (node statuses, diff
 * order); `root` is the module map built over it, whose frames name the modules. */
export function buildDepsGraph(
  dependencies: readonly FileDependencies[],
  files: readonly PatchFile[],
  root: ModuleMapDir,
  maxNodes: number = DEFAULT_MAX_DEPS_NODES,
  maxEdges: number = DEFAULT_MAX_DEPS_EDGES,
): DepsGraph {
  const fileOrder = new Map(files.map((file, index) => [file.path, index]));
  const byPath = new Map(files.map((file) => [file.path, file]));
  const kinds = new Map<string, { kind: DepsNodeKind; name: string }>();
  const builders = new Map<string, EdgeBuilder>();
  const kept = new Set<string>();

  const sourceOf = (path: string, change: DependencyChange): string => {
    const file = byPath.get(path);
    // A removed line was written at the file's old path, so it left the old directory.
    const at = change.side === "deletions" ? (file?.previousPath ?? path) : path;
    const module = dirnameOf(at);
    kinds.set(moduleNodeId(module), { kind: "module", name: module });
    return moduleNodeId(module);
  };

  for (const entry of dependencies) {
    for (const change of entry.unchanged) {
      const from = sourceOf(entry.path, change);
      const to = targetNode(change.target).id;
      kept.add(`${from}\u0000${to}`);
    }
    const changes = [
      ...entry.added.map((change) => ({ change, kind: "added" as const })),
      ...entry.removed.map((change) => ({ change, kind: "removed" as const })),
    ];
    for (const { change, kind } of changes) {
      const from = sourceOf(entry.path, change);
      const target = targetNode(change.target);
      if (target.id === from) {
        continue;
      }
      kinds.set(target.id, { kind: target.kind, name: target.name });
      const key = `${from}\u0000${target.id}`;
      const builder = builders.get(key) ?? { from, to: target.id, statements: [] };
      builder.statements.push({
        anchor: {
          file: entry.path,
          side: change.side,
          startLine: change.line,
          endLine: change.line,
        },
        specifier: change.specifier,
        change: kind,
        order:
          (fileOrder.get(entry.path) ?? files.length) * 1e7 +
          change.line * 2 +
          (kind === "removed" ? 0 : 1),
      });
      builders.set(key, builder);
    }
  }

  const allEdges: DepsEdge[] = [...builders.entries()]
    .map(([key, builder]) => {
      const statements = builder.statements.toSorted((a, b) => a.order - b.order);
      const added = statements.filter((statement) => statement.change === "added").length;
      const removed = statements.length - added;
      return {
        from: builder.from,
        to: builder.to,
        status: edgeStatus(added, removed, kept.has(key)),
        added,
        removed,
        statements: statements.map(({ order: _order, ...statement }) => statement),
        first: statements[0]?.order ?? 0,
      };
    })
    .toSorted((a, b) => a.first - b.first)
    .map(({ first: _first, ...edge }) => edge);

  // The cap: heaviest edges first (ties keep diff order), each taken only while its endpoints
  // still fit — an edge whose endpoints are both already drawn always fits — and only until
  // `maxEdges` are taken.
  const drawnNodes = new Set<string>();
  const drawn = new Set<DepsEdge>();
  const ranked = allEdges
    .map((edge, index) => ({ edge, index }))
    .toSorted((a, b) => b.edge.statements.length - a.edge.statements.length || a.index - b.index);
  for (const { edge } of ranked) {
    if (drawn.size >= maxEdges) {
      break;
    }
    const extra = [edge.from, edge.to].filter((id) => !drawnNodes.has(id)).length;
    if (drawnNodes.size + extra > maxNodes) {
      continue;
    }
    drawnNodes.add(edge.from);
    drawnNodes.add(edge.to);
    drawn.add(edge);
  }
  const edges = allEdges.filter((edge) => drawn.has(edge));
  const allNodeIds = new Set(allEdges.flatMap((edge) => [edge.from, edge.to]));

  // Nodes in order of first appearance along the drawn edges — sources before what they import,
  // which is the order the layout's columns read in.
  const order: string[] = [];
  for (const edge of edges) {
    for (const id of [edge.from, edge.to]) {
      if (!order.includes(id)) {
        order.push(id);
      }
    }
  }
  const chains = frameChains(root);
  const modulePaths = order.flatMap((id) => {
    const known = kinds.get(id);
    return known?.kind === "module" ? [known.name] : [];
  });
  const labels = moduleLabels(modulePaths, chains);
  const nodes = order.map((id) =>
    nodeOf(id, kinds.get(id) ?? { kind: "module", name: id }, labels, files),
  );

  return {
    nodes,
    edges,
    hidden: { nodes: allNodeIds.size - nodes.length, edges: allEdges.length - edges.length },
    statements: allEdges.reduce((sum, edge) => sum + edge.statements.length, 0),
  };
}

/** What an edge's tag prints: its statement counts, `+2`, `−1`, `+1 −1`. */
export function edgeCountLabel(edge: Pick<DepsEdge, "added" | "removed">): string {
  return [edge.added > 0 ? `+${edge.added}` : "", edge.removed > 0 ? `−${edge.removed}` : ""]
    .filter((part) => part !== "")
    .join(" ");
}
