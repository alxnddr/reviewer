// The layout of a flow visual — boxes joined by arrows, "who calls whom" — as pure geometry. The
// renderer draws what this returns as SVG and decides nothing about placement itself, so a flow
// is laid out the same way on every render, in tests, and in the preview harness.
//
// A layered (Sugiyama-style) layout cut down to what a picture of a couple of dozen boxes needs:
//
//   1. **Rank** every node by its longest path from a source, so a chain reads in order and a
//      node sits one rank after the furthest thing that leads to it. A cycle has no longest path,
//      so it is broken first: a depth-first walk in *input order* marks each edge that closes a
//      loop as a back edge, and ranking ignores those. Then every source is pulled forward to sit
//      one rank before the nearest thing it leads to — a second entry point (a title-bar button
//      beside a menu command that reach the same store) belongs beside the other caller, not at
//      rank 0 with an edge that has to skip a column to get anywhere. Input order is the only
//      tie-break anywhere in this file — the author's order is the one thing about a flow that
//      is stable and meaningful, and a layout that changes when nothing in the input did cannot
//      be learned.
//   2. **Dummy nodes**: an edge that still spans several ranks is cut into one-rank pieces, with
//      a zero-length slot in each rank between. The slot is ordered and placed like a box, so a
//      long edge has its own lane through every rank it crosses and never runs through a box —
//      the defect the first version of this file stated as a limit and shipped.
//   3. **Order** each rank by a few barycenter sweeps (a node moves toward the mean position of
//      its neighbours in the adjacent rank), which removes the crossings a fan-out authored in an
//      awkward order would otherwise draw. Two down-and-up passes; more buys nothing at this size.
//   4. **Place** ranks along the main axis and boxes across it, each box aligned with its first
//      predecessor where the boxes above it allow, so a chain is a straight line and a fan-out's
//      first branch continues it.
//   5. **Route** every piece orthogonally through the gap between two ranks. Edges that share a
//      source share one trunk (a fan-out leaves once and splits); edges that share a target share
//      one (a fan-in merges, then arrives once). Each trunk is a track in the gap: fan-outs near
//      the source, fan-ins near the target, and the tracks of one gap are ordered by trying every
//      order and keeping the one that crosses least — exhaustive is cheap at five tracks a gap.
//      What is left between the two bands of tracks is where the labels go.
//
// **Orientation.** Left to right is the default and the look Capy's guide set: a chain reads as
// a sentence, and when it is wider than the card it wraps onto a next row — only ever at a rank
// boundary, through one trunk that leaves the last rank, runs back under the row and enters the
// next row's first rank from the left. The break is chosen, not just taken where the row ran
// out: of the boundaries that leave the row at least half full, the one crossed by fewest edges
// (and never, if it can be helped, a many-to-many crossing a shared trunk would make ambiguous).
// A *branching* flow that would wrap more than once, or through more than one edge, reads as a
// maze, though, so in `auto` it is laid out top to bottom instead — ranks as rows, each fan a
// spread under its source — whenever that fits the width. A chain keeps wrapping: a column of
// ten boxes is a worse picture than three lines of them.
//
// **Labels** sit on a segment that belongs to their edge alone: a fan-out's label on the branch
// that arrives (set against its target — it names what arrives), a fan-in's on the branch that
// leaves (its source's segment, before the merge), a wrap's on the lane when one edge crosses
// and against its target when several do. Every gap is widened until its labels fit between the
// two bands of tracks, so a label never sits on another edge's line.
//
// **Why not a library.** `@dagrejs/dagre` is synchronous and would do steps 1–4 (network-simplex
// ranking, dummies, ordering), but it lays a graph out on one strip — no wrap — routes edges as
// spline control points rather than orthogonal trunks, and places labels as extra nodes; the wrap,
// the trunks and the label rules above would all be rebuilt around it, for a dependency in the
// renderer's entry chunk. `elkjs` routes orthogonally and well, but is over a megabyte and
// asynchronous (a Promise, normally a worker), which neither the synchronous contract below nor a
// render-time `useMemo` can take. At the sizes it is handed the hand layout is a few hundred lines
// that tests can pin to the pixel — and those sizes are capped upstream, because nothing in here
// is: an authored flow is at most fourteen nodes (the schema's cap), and the Deps tab's computed
// graph at most `DEFAULT_MAX_DEPS_NODES` and `DEFAULT_MAX_DEPS_EDGES` (`lib/deps-graph.ts`). The
// edge cap matters as much as the node one: every edge gets its own track and label room, and
// twenty-four nodes wired densely (276 edges) laid out 48,624 px tall before it existed.
//
// What this still does not do: an edge closing a cycle (`back`) runs along a lane outside the
// boxes and may cross other edges' lines; and two labels from opposite bands of one gap that
// land on the same line can collide — `edgeTagPoints` (`lib/guide.ts`) pushes such tags apart.
//
// Structural input (`id`, `label`, edges): no dependency on the artifact's flow schema, so the
// layout is testable on bare data, the schema can grow fields without touching it, and any other
// graph (a dependency graph) can be laid out with it. Every output coordinate is in px, from the
// top-left of the drawing.

export type FlowLayoutNode = {
  id: string;
  /** Drawn monospace, so its width is `label.length × charWidth`. */
  label: string;
  /** Extra px the renderer draws inside the box beside the label — a status glyph, a chapter
   * badge. The layout only needs to know it is there. */
  extraWidth?: number;
};

export type FlowLayoutEdge = { from: string; to: string; label?: string };

export type FlowLayoutInput = {
  nodes: readonly FlowLayoutNode[];
  edges: readonly FlowLayoutEdge[];
};

/** `lr`: ranks are columns, arrows run left to right, rows wrap. `tb`: ranks are rows, arrows
 * run top to bottom, nothing wraps. */
export type FlowOrientation = "lr" | "tb";

export type FlowLayoutOptions = {
  /** `auto` picks per graph (the module header says how); the others force one. */
  orientation: FlowOrientation | "auto";
  /** Px per character of a node label (monospace). */
  charWidth: number;
  /** Px per character of an edge label. */
  labelCharWidth: number;
  /** The height an edge label's text takes — what a top-to-bottom gap must leave beside a line. */
  labelHeight: number;
  /** Inner space either side of a node's label. */
  paddingX: number;
  boxHeight: number;
  /** The least space between two ranks; widened where tracks or a label need it. */
  rankGap: number;
  /** Left to right: vertical space between two boxes of one rank. */
  nodeGap: number;
  /** Top to bottom: horizontal space between two boxes of one rank. */
  siblingGap: number;
  /** Space between two tracks (trunks) running through one gap. */
  trackGap: number;
  /** Vertical space between wrapped rows — where the wrap connector and the back lanes run. */
  rowGap: number;
  /** The width a row may not pass, margins included. A single rank wider than this is placed
   * anyway, overflowing: there is nothing narrower to wrap it to. */
  maxWidth: number;
  /** Space around the drawing — the wrap connector descends inside the left one. */
  margin: number;
  /** Room either side of an edge label within its segment. */
  labelPadding: number;
};

export const DEFAULT_FLOW_LAYOUT_OPTIONS: FlowLayoutOptions = {
  orientation: "auto",
  charWidth: 8,
  labelCharWidth: 7,
  labelHeight: 12,
  paddingX: 12,
  boxHeight: 32,
  rankGap: 40,
  nodeGap: 16,
  siblingGap: 24,
  trackGap: 6,
  rowGap: 40,
  maxWidth: 720,
  margin: 16,
  labelPadding: 6,
};

/** How far apart two back edges sharing a lane are drawn. */
const LANE_STEP = 4;
/** The across-the-rank size of a dummy's slot: the room a long edge's line takes in a rank. */
const DUMMY_CROSS = 8;
/** Above this many tracks in one band, their order is not searched exhaustively (5! = 120). */
const MAX_SEARCHED_TRACKS = 5;

export type FlowPoint = { x: number; y: number };

export type FlowBox = {
  id: string;
  label: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /** The longest path from a source, back edges ignored (sources pulled forward). */
  rank: number;
  /** Which wrapped row the rank landed on, from 0 (always 0 top to bottom). */
  row: number;
  /** Position within its rank among the boxes, from 0 — top to bottom, or left to right. */
  order: number;
};

/** How an edge was routed: `adjacent` joins neighbouring ranks; `long` skips ranks through a lane
 * of its own in each; `wrap` continues onto a later row; `back` closes a cycle along a lane
 * outside the boxes. */
export type FlowRouteKind = "adjacent" | "long" | "wrap" | "back";

export type FlowRoute = {
  from: string;
  to: string;
  kind: FlowRouteKind;
  /** The polyline, from the source's outgoing side to the target's incoming side (right → left,
   * or bottom → top); every segment is horizontal or vertical, and no point repeats. */
  points: FlowPoint[];
  /** Where an edge label goes: the bottom centre of its text. Left to right that is on the
   * horizontal segment it labels (the text sits just above the line); top to bottom it is beside
   * the vertical one, to its right. Null for an unlabelled edge. */
  label: { text: string; x: number; y: number } | null;
};

export type FlowLayout = {
  orientation: FlowOrientation;
  width: number;
  height: number;
  /** In input order. */
  boxes: FlowBox[];
  /** In input order, without the edges that name an unknown node or loop on one. */
  routes: FlowRoute[];
};

type Graph = {
  nodes: FlowLayoutNode[];
  edges: FlowLayoutEdge[];
  index: Map<string, number>;
};

/** The input made consistent: the first node of a repeated id wins, and an edge naming a node
 * that is not there, or looping on one, is dropped. The artifact gate refuses all three; this
 * is the layout not trusting that it ran. */
function graphOf(input: FlowLayoutInput): Graph {
  const index = new Map<string, number>();
  const nodes: FlowLayoutNode[] = [];
  for (const node of input.nodes) {
    if (!index.has(node.id)) {
      index.set(node.id, nodes.length);
      nodes.push(node);
    }
  }
  const edges = input.edges.filter(
    (edge) => edge.from !== edge.to && index.has(edge.from) && index.has(edge.to),
  );
  return { nodes, edges, index };
}

/** Each node's rank, and which edges (by index into `graph.edges`) are back edges. Depth-first
 * from every node in input order, following edges in input order; an edge into a node still on
 * the walk's stack closes a cycle. Ranks are then longest paths over the remaining (acyclic)
 * edges, with each source pulled forward to just before its nearest target. */
function rankGraph(graph: Graph): { rank: number[]; back: Set<number> } {
  const outgoing = graph.nodes.map((): number[] => []);
  const targetOf = graph.edges.map((edge) => graph.index.get(edge.to) ?? 0);
  for (const [edgeIndex, edge] of graph.edges.entries()) {
    outgoing[graph.index.get(edge.from) ?? 0]?.push(edgeIndex);
  }
  const state = graph.nodes.map((): "new" | "open" | "done" => "new");
  const back = new Set<number>();
  /** Finish order; reversed, a topological order of the forward edges. */
  const finished: number[] = [];
  const visit = (node: number): void => {
    state[node] = "open";
    for (const edgeIndex of outgoing[node] ?? []) {
      const target = targetOf[edgeIndex] ?? 0;
      if (state[target] === "open") {
        back.add(edgeIndex);
      } else if (state[target] === "new") {
        visit(target);
      }
    }
    state[node] = "done";
    finished.push(node);
  };
  for (const node of graph.nodes.keys()) {
    if (state[node] === "new") {
      visit(node);
    }
  }

  const rank = graph.nodes.map(() => 0);
  const hasIncoming = graph.nodes.map(() => false);
  for (const node of finished.toReversed()) {
    for (const edgeIndex of outgoing[node] ?? []) {
      if (back.has(edgeIndex)) {
        continue;
      }
      const target = targetOf[edgeIndex] ?? 0;
      hasIncoming[target] = true;
      rank[target] = Math.max(rank[target] ?? 0, (rank[node] ?? 0) + 1);
    }
  }
  // A source's rank constrains nothing above it, so it can move to just before the nearest of
  // its targets; every target has a predecessor, so its rank is at least 1 and this stays ≥ 0.
  for (const node of graph.nodes.keys()) {
    const targets = (outgoing[node] ?? [])
      .filter((edgeIndex) => !back.has(edgeIndex))
      .map((edgeIndex) => rank[targetOf[edgeIndex] ?? 0] ?? 0);
    if (hasIncoming[node] !== true && targets.length > 0) {
      rank[node] = Math.min(...targets) - 1;
    }
  }
  return { rank, back };
}

/** The ranking alone, by id: each node's rank, and the edges set aside to break cycles. */
export function rankFlow(input: FlowLayoutInput): {
  ranks: Map<string, number>;
  backEdges: FlowLayoutEdge[];
} {
  const graph = graphOf(input);
  const { rank, back } = rankGraph(graph);
  return {
    ranks: new Map(graph.nodes.map((node, at) => [node.id, rank[at] ?? 0])),
    backEdges: graph.edges.filter((_, edgeIndex) => back.has(edgeIndex)),
  };
}

/** One rank's worth of a forward edge: vertex to vertex, where a vertex is a node or a dummy. */
type Piece = { from: number; to: number; edge: number; last: boolean };

/** Pieces in one gap that share a trunk. `near`: a fan-out (or a lone piece), its track near the
 * source; `far`: a fan-in, its track near the target. */
type Trunk = { band: "near" | "far"; pieces: number[] };

/** Everything about a flow that does not depend on which way it is drawn. */
type Prepared = {
  graph: Graph;
  back: Set<number>;
  /** Per vertex: the node it is, or null for a dummy. Nodes first, by index. */
  vertexNode: (number | null)[];
  vertexRank: number[];
  pieces: Piece[];
  /** Per forward edge, its pieces in order; empty for a back edge. */
  edgePieces: number[][];
  /** Vertices by rank, each rank ordered. */
  ranks: number[][];
  preds: number[][];
  /** Per gap (by the rank it follows): its pieces, and those grouped into trunks. */
  gapPieces: number[][];
  gapTrunks: Trunk[][];
  /** Some node has two forward edges out or two in. */
  branches: boolean;
};

/** Ranks of vertex indices, ordered by barycenter sweeps. */
function orderRanks(ranks: number[][], preds: number[][], succs: number[][]): void {
  const position = new Map<number, number>();
  const remember = (): void => {
    for (const rank of ranks) {
      for (const [at, vertex] of rank.entries()) {
        position.set(vertex, at);
      }
    }
  };
  remember();
  const sweep = (rank: number[], neighbours: number[][]): void => {
    const key = new Map<number, number>();
    for (const [at, vertex] of rank.entries()) {
      const linked = neighbours[vertex] ?? [];
      key.set(
        vertex,
        linked.length === 0
          ? at
          : linked.reduce((sum, other) => sum + (position.get(other) ?? 0), 0) / linked.length,
      );
    }
    // Stable by construction: equal keys keep their current order.
    const sorted = rank
      .map((vertex, at) => ({ vertex, at }))
      .toSorted((a, b) => (key.get(a.vertex) ?? 0) - (key.get(b.vertex) ?? 0) || a.at - b.at)
      .map((entry) => entry.vertex);
    rank.splice(0, rank.length, ...sorted);
    remember();
  };
  for (let pass = 0; pass < 2; pass += 1) {
    for (const rank of ranks.slice(1)) {
      sweep(rank, preds);
    }
    for (const rank of ranks.slice(0, -1).toReversed()) {
      sweep(rank, succs);
    }
  }
}

/** A gap's pieces as trunks: every source with two or more pieces is a fan-out; of the rest,
 * every target with two or more is a fan-in; what remains is a piece on its own. A piece that is
 * both (one branch of a fan-out that also arrives at a fan-in) rides its source's trunk. */
function trunksOf(pieces: readonly Piece[], inGap: readonly number[]): Trunk[] {
  const bySource = new Map<number, number[]>();
  for (const piece of inGap) {
    const from = pieces[piece]?.from ?? 0;
    bySource.set(from, [...(bySource.get(from) ?? []), piece]);
  }
  const trunks: Trunk[] = [];
  const rest: number[] = [];
  for (const list of bySource.values()) {
    if (list.length > 1) {
      trunks.push({ band: "near", pieces: list });
    } else {
      rest.push(...list);
    }
  }
  const byTarget = new Map<number, number[]>();
  for (const piece of rest) {
    const to = pieces[piece]?.to ?? 0;
    byTarget.set(to, [...(byTarget.get(to) ?? []), piece]);
  }
  for (const list of byTarget.values()) {
    trunks.push({ band: list.length > 1 ? "far" : "near", pieces: list });
  }
  return trunks;
}

function prepare(input: FlowLayoutInput): Prepared {
  const graph = graphOf(input);
  const { rank, back } = rankGraph(graph);
  const vertexNode: (number | null)[] = graph.nodes.map((_, node) => node);
  const vertexRank = [...rank];
  const pieces: Piece[] = [];
  const edgePieces: number[][] = graph.edges.map(() => []);
  const outDegree = graph.nodes.map(() => 0);
  const inDegree = graph.nodes.map(() => 0);
  for (const [edgeIndex, edge] of graph.edges.entries()) {
    if (back.has(edgeIndex)) {
      continue;
    }
    const from = graph.index.get(edge.from) ?? 0;
    const to = graph.index.get(edge.to) ?? 0;
    outDegree[from] = (outDegree[from] ?? 0) + 1;
    inDegree[to] = (inDegree[to] ?? 0) + 1;
    let previous = from;
    for (let at = (rank[from] ?? 0) + 1; at < (rank[to] ?? 0); at += 1) {
      const dummy = vertexNode.length;
      vertexNode.push(null);
      vertexRank.push(at);
      edgePieces[edgeIndex]?.push(pieces.length);
      pieces.push({ from: previous, to: dummy, edge: edgeIndex, last: false });
      previous = dummy;
    }
    edgePieces[edgeIndex]?.push(pieces.length);
    pieces.push({ from: previous, to, edge: edgeIndex, last: true });
  }

  const preds = vertexNode.map((): number[] => []);
  const succs = vertexNode.map((): number[] => []);
  for (const piece of pieces) {
    preds[piece.to]?.push(piece.from);
    succs[piece.from]?.push(piece.to);
  }
  const rankCount = Math.max(0, ...vertexRank.map((at) => at + 1));
  const ranks: number[][] = Array.from({ length: rankCount }, () => []);
  for (const [vertex, at] of vertexRank.entries()) {
    ranks[at]?.push(vertex);
  }
  orderRanks(ranks, preds, succs);

  const gapPieces: number[][] = Array.from({ length: Math.max(0, rankCount - 1) }, () => []);
  for (const [index, piece] of pieces.entries()) {
    gapPieces[vertexRank[piece.from] ?? 0]?.push(index);
  }
  return {
    graph,
    back,
    vertexNode,
    vertexRank,
    pieces,
    edgePieces,
    ranks,
    preds,
    gapPieces,
    gapTrunks: gapPieces.map((inGap) => trunksOf(pieces, inGap)),
    branches: graph.nodes.some(
      (_, node) => (outDegree[node] ?? 0) > 1 || (inDegree[node] ?? 0) > 1,
    ),
  };
}

function permutations<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) {
    return [[...items]];
  }
  return items.flatMap((item, at) =>
    permutations([...items.slice(0, at), ...items.slice(at + 1)]).map((rest) => [item, ...rest]),
  );
}

/** The order of each band's tracks that crosses least, trying every order of both (ties keep
 * the earlier, so the input order wins a draw). A band past `MAX_SEARCHED_TRACKS` keeps its
 * order rather than be searched factorially. */
function leastCrossing(
  near: readonly number[],
  far: readonly number[],
  score: (near: readonly number[], far: readonly number[]) => number,
): [readonly number[], readonly number[]] {
  if (near.length > MAX_SEARCHED_TRACKS || far.length > MAX_SEARCHED_TRACKS) {
    return [near, far];
  }
  let best: [readonly number[], readonly number[]] = [near, far];
  let bestScore = score(near, far);
  for (const nearOrder of permutations(near)) {
    for (const farOrder of permutations(far)) {
      const current = score(nearOrder, farOrder);
      if (current < bestScore) {
        bestScore = current;
        best = [nearOrder, farOrder];
      }
    }
  }
  return best;
}

/** A point in the layout's own frame: `a` along the ranks (x left to right, y top to bottom),
 * `c` across them. Routing is written once in this frame and turned into x/y at the end. */
type Frame = { a: number; c: number };

/** A segment in the frame, for counting crossings: `along` runs in `a` at a fixed `c`. */
type Segment = { trunk: number; along: boolean; at: number; from: number; to: number };

function segmentsOf(trunk: number, points: readonly Frame[]): Segment[] {
  const segments: Segment[] = [];
  for (const [index, point] of points.slice(1).entries()) {
    const previous = points[index];
    if (previous === undefined) {
      continue;
    }
    if (previous.c === point.c && previous.a !== point.a) {
      segments.push({
        trunk,
        along: true,
        at: point.c,
        from: Math.min(previous.a, point.a),
        to: Math.max(previous.a, point.a),
      });
    } else if (previous.a === point.a && previous.c !== point.c) {
      segments.push({
        trunk,
        along: false,
        at: point.a,
        from: Math.min(previous.c, point.c),
        to: Math.max(previous.c, point.c),
      });
    }
  }
  return segments;
}

/** How badly a gap's routes cross: one per line crossing another (a T counts — it reads as a
 * join), two per stretch where two trunks' lines lie on top of each other. Lines of one trunk
 * share their trunk by design and are not counted. */
function crossingScore(segments: readonly Segment[]): number {
  let score = 0;
  for (const [index, one] of segments.entries()) {
    for (const other of segments.slice(index + 1)) {
      if (one.trunk === other.trunk) {
        continue;
      }
      if (one.along === other.along) {
        if (one.at === other.at && Math.min(one.to, other.to) > Math.max(one.from, other.from)) {
          score += 2;
        }
        continue;
      }
      const flat = one.along ? one : other;
      const upright = one.along ? other : one;
      if (
        upright.at > flat.from &&
        upright.at < flat.to &&
        flat.at >= upright.from &&
        flat.at <= upright.to
      ) {
        score += 1;
      }
    }
  }
  return score;
}

/** Drop repeated points and the middle of three in a line. */
function simplify(points: readonly Frame[]): Frame[] {
  const out: Frame[] = [];
  for (const point of points) {
    const last = out.at(-1);
    if (last !== undefined && last.a === point.a && last.c === point.c) {
      continue;
    }
    const before = out.at(-2);
    if (
      last !== undefined &&
      before !== undefined &&
      ((before.a === last.a && last.a === point.a) || (before.c === last.c && last.c === point.c))
    ) {
      out.pop();
    }
    out.push(point);
  }
  return out;
}

type PieceRoute = { points: Frame[]; label: Frame | null; crossesRows: boolean };

type Placed = {
  layout: FlowLayout;
  rows: number;
  /** Every wrap is crossed by exactly one edge. */
  cleanWraps: boolean;
};

function place(
  prepared: Prepared,
  settings: FlowLayoutOptions,
  orientation: FlowOrientation,
): Placed {
  const lr = orientation === "lr";
  const { graph, pieces, ranks, gapPieces, gapTrunks, vertexNode, vertexRank } = prepared;
  const widthOf = (node: number): number => {
    const current = graph.nodes[node];
    return Math.ceil(
      2 * settings.paddingX +
        (current?.label.length ?? 0) * settings.charWidth +
        (current?.extraWidth ?? 0),
    );
  };
  const alongOf = (vertex: number): number => {
    const node = vertexNode[vertex];
    if (node === null || node === undefined) {
      return 0;
    }
    return lr ? widthOf(node) : settings.boxHeight;
  };
  const crossOf = (vertex: number): number => {
    const node = vertexNode[vertex];
    if (node === null || node === undefined) {
      return DUMMY_CROSS;
    }
    return lr ? settings.boxHeight : widthOf(node);
  };
  const crossGap = lr ? settings.nodeGap : settings.siblingGap;
  const stub = Math.min(settings.rankGap / 2, settings.margin);
  const step = settings.trackGap;
  const pad = settings.labelPadding;
  const textOf = (edge: number): string | null => {
    const text = graph.edges[edge]?.label;
    return text === undefined || text === "" ? null : text;
  };
  const textWidth = (text: string): number => text.length * settings.labelCharWidth;
  /** The length of segment a label needs along the ranks: its width when it lies on the line,
   * its height when it sits beside it. */
  const labelAlong = (text: string): number => (lr ? textWidth(text) : settings.labelHeight);
  const labelRoom = (inGap: readonly number[]): number =>
    Math.max(
      0,
      ...inGap.map((index) => {
        const piece = pieces[index];
        const text = piece?.last === true ? textOf(piece.edge) : null;
        return text === null ? 0 : labelAlong(text) + 2 * pad;
      }),
    );

  // ── Along the ranks ───────────────────────────────────────────────────────────────────────
  const rankAlong = ranks.map((rank) => Math.max(0, ...rank.map((vertex) => alongOf(vertex))));
  const gapSize = gapTrunks.map((trunks, gap) => {
    const near = trunks.filter((trunk) => trunk.band === "near").length;
    const far = trunks.length - near;
    const room = labelRoom(gapPieces[gap] ?? []);
    const need =
      (near > 0 ? stub + (near - 1) * step : 0) +
      (far > 0 ? stub + (far - 1) * step : 0) +
      Math.max(room, near > 0 && far > 0 ? step : 0);
    return Math.ceil(Math.max(settings.rankGap, need));
  });
  /** How far a wrapped row starts in, so several labelled pieces arriving from the wrap fit
   * between the spine and their targets. */
  const indentOf = (firstRank: number): number => {
    const inGap = gapPieces[firstRank - 1] ?? [];
    return inGap.length < 2 ? 0 : Math.ceil(Math.max(0, labelRoom(inGap) - stub));
  };
  /** Where the row's ranks end if `start..end` are laid on one row. */
  const rowEnd = (start: number, end: number): number => {
    let at = settings.margin + (start > 0 ? indentOf(start) : 0);
    for (let rank = start; rank <= end; rank += 1) {
      at += (rankAlong[rank] ?? 0) + (rank < end ? (gapSize[rank] ?? 0) : 0);
    }
    return at;
  };
  /** What breaking after rank `gap` costs: the edges the wrap carries, and more when its trunk
   * would join several sources to several targets — a bundle nobody can follow. */
  const wrapCost = (gap: number): number => {
    const inGap = gapPieces[gap] ?? [];
    const sources = new Set(inGap.map((piece) => pieces[piece]?.from));
    const targets = new Set(inGap.map((piece) => pieces[piece]?.to));
    return inGap.length + (sources.size > 1 && targets.size > 1 ? 4 : 0);
  };
  const rowStarts = ranks.length === 0 ? [] : [0];
  if (lr) {
    let start = 0;
    let next = 1;
    while (next < ranks.length) {
      if (rowEnd(start, next) + settings.margin <= settings.maxWidth) {
        next += 1;
        continue;
      }
      // Break before `next` unless an earlier boundary is cheaper and still leaves the row at
      // least half full; ties go to the later boundary.
      let best = next;
      let bestCost = wrapCost(next - 1);
      for (let candidate = next - 1; candidate > start; candidate -= 1) {
        const cost = wrapCost(candidate - 1);
        if (cost < bestCost && rowEnd(start, candidate - 1) >= settings.maxWidth / 2) {
          best = candidate;
          bestCost = cost;
        }
      }
      rowStarts.push(best);
      start = best;
      next = best + 1;
    }
  }
  const rankRow: number[] = [];
  const rankA: number[] = [];
  for (const [row, first] of rowStarts.entries()) {
    const last = (rowStarts[row + 1] ?? ranks.length) - 1;
    let at = settings.margin + (row > 0 ? indentOf(first) : 0);
    for (let rank = first; rank <= last; rank += 1) {
      rankRow[rank] = row;
      rankA[rank] = at;
      at += (rankAlong[rank] ?? 0) + (gapSize[rank] ?? 0);
    }
  }

  // ── Across them ───────────────────────────────────────────────────────────────────────────
  const vertexC: number[] = vertexNode.map(() => 0);
  const centerC = (vertex: number): number => (vertexC[vertex] ?? 0) + crossOf(vertex) / 2;
  const rowStartC: number[] = [];
  const rowEndC: number[] = [];
  for (const [row, first] of rowStarts.entries()) {
    const top = row === 0 ? settings.margin : (rowEndC[row - 1] ?? 0) + settings.rowGap;
    rowStartC[row] = top;
    let bottom = top;
    const last = (rowStarts[row + 1] ?? ranks.length) - 1;
    for (let rank = first; rank <= last; rank += 1) {
      let floor = top;
      for (const vertex of ranks[rank] ?? []) {
        // Aligned with its first predecessor (the upper median) when that rank is on this row.
        const centres =
          rank === first
            ? []
            : (prepared.preds[vertex] ?? [])
                .map((other) => centerC(other))
                .toSorted((one, two) => one - two);
        const wanted = centres[Math.floor((centres.length - 1) / 2)];
        const start = wanted === undefined ? floor : Math.max(floor, wanted - crossOf(vertex) / 2);
        vertexC[vertex] = start;
        floor = start + crossOf(vertex) + crossGap;
        bottom = Math.max(bottom, start + crossOf(vertex));
      }
    }
    rowEndC[row] = bottom;
  }
  const vertexA = (vertex: number): number => rankA[vertexRank[vertex] ?? 0] ?? 0;
  /** A dummy spans its whole rank, so a long edge passes straight through it. */
  const vertexAlong = (vertex: number): number =>
    vertexNode[vertex] === null ? (rankAlong[vertexRank[vertex] ?? 0] ?? 0) : alongOf(vertex);
  const outPort = (vertex: number): Frame => ({
    a: vertexA(vertex) + vertexAlong(vertex),
    c: centerC(vertex),
  });
  const inPort = (vertex: number): Frame => ({ a: vertexA(vertex), c: centerC(vertex) });

  // ── Routes, piece by piece ────────────────────────────────────────────────────────────────
  const pieceRoutes: PieceRoute[] = pieces.map(() => ({
    points: [],
    label: null,
    crossesRows: false,
  }));
  const labelledText = (index: number): string | null => {
    const piece = pieces[index];
    return piece?.last === true ? textOf(piece.edge) : null;
  };
  let cleanWraps = true;
  for (const [gap, trunks] of gapTrunks.entries()) {
    const inGap = gapPieces[gap] ?? [];
    const end = (rankA[gap] ?? 0) + (rankAlong[gap] ?? 0);
    const sourceRow = rankRow[gap] ?? 0;
    if (rankRow[gap + 1] !== sourceRow) {
      // A wrap: out past the row's last rank, down to halfway through the row gap, back along
      // it to the spine left of the next row, down that, and in — one trunk for every piece.
      cleanWraps &&= inGap.length === 1;
      const exit = end + stub;
      const lane = (rowEndC[sourceRow] ?? 0) + settings.rowGap / 2;
      const spine = settings.margin - stub;
      // Several pieces into one target arrive on one line, so the same word on each would be
      // printed twice in one place (`repo`, `repo`): it is printed once.
      const said = new Set<string>();
      for (const index of inGap) {
        const piece = pieces[index];
        if (piece === undefined) {
          continue;
        }
        const start = outPort(piece.from);
        const finish = inPort(piece.to);
        const spoken = labelledText(index);
        const text = spoken === null || said.has(`${piece.to}:${spoken}`) ? null : spoken;
        if (text !== null) {
          said.add(`${piece.to}:${text}`);
        }
        pieceRoutes[index] = {
          points: simplify([
            start,
            { a: exit, c: start.c },
            { a: exit, c: lane },
            { a: spine, c: lane },
            { a: spine, c: finish.c },
            finish,
          ]),
          label:
            text === null
              ? null
              : inGap.length === 1
                ? { a: (exit + spine) / 2, c: lane }
                : { a: finish.a - pad - labelAlong(text) / 2, c: finish.c },
          crossesRows: true,
        };
      }
      continue;
    }

    const next = rankA[gap + 1] ?? 0;
    const straight = (trunk: Trunk): boolean =>
      trunk.band === "near" &&
      trunk.pieces.length === 1 &&
      trunk.pieces.every((index) => {
        const piece = pieces[index];
        return piece !== undefined && centerC(piece.from) === centerC(piece.to);
      });
    const spanOf = (trunk: Trunk): number =>
      Math.min(
        ...trunk.pieces.map((index) => {
          const piece = pieces[index];
          return piece === undefined ? 0 : Math.min(centerC(piece.from), centerC(piece.to));
        }),
      );
    const byTop = (one: number, two: number): number =>
      spanOf(trunks[one] ?? { band: "near", pieces: [] }) -
        spanOf(trunks[two] ?? { band: "near", pieces: [] }) || one - two;
    const nearTrunks = [...trunks.keys()]
      .filter((trunk) => trunks[trunk]?.band === "near" && !straight(trunks[trunk]!))
      .toSorted(byTop);
    const farTrunks = [...trunks.keys()]
      .filter((trunk) => trunks[trunk]?.band === "far")
      .toSorted(byTop);
    const straightTrunks = [...trunks.keys()].filter((trunk) => straight(trunks[trunk]!));
    const nearEnd = nearTrunks.length > 0 ? end + stub + (nearTrunks.length - 1) * step : end;
    const farStart = farTrunks.length > 0 ? next - stub - (farTrunks.length - 1) * step : next;

    const routeTrunk = (trunk: number, track: number | null): Frame[][] =>
      (trunks[trunk]?.pieces ?? []).map((index) => {
        const piece = pieces[index];
        if (piece === undefined) {
          return [];
        }
        const start = outPort(piece.from);
        const finish = inPort(piece.to);
        return track === null
          ? [start, finish]
          : simplify([start, { a: track, c: start.c }, { a: track, c: finish.c }, finish]);
      });
    /** Every trunk's track for one order of each band. */
    const tracksFor = (near: readonly number[], far: readonly number[]): Map<number, number> =>
      new Map([
        ...near.map((trunk, at): [number, number] => [trunk, end + stub + at * step]),
        ...far.map((trunk, at): [number, number] => [trunk, farStart + at * step]),
      ]);
    const scoreOf = (tracks: ReadonlyMap<number, number>): number =>
      crossingScore(
        [...trunks.keys()].flatMap((trunk) =>
          routeTrunk(trunk, tracks.get(trunk) ?? null).flatMap((points) =>
            segmentsOf(trunk, points),
          ),
        ),
      );
    const [nearOrder, farOrder] = leastCrossing(nearTrunks, farTrunks, (near, far) =>
      scoreOf(tracksFor(near, far)),
    );
    const bestTracks = tracksFor(nearOrder, farOrder);
    for (const [trunk, { band, pieces: members }] of trunks.entries()) {
      const routes = routeTrunk(
        trunk,
        straightTrunks.includes(trunk) ? null : (bestTracks.get(trunk) ?? null),
      );
      for (const [at, index] of members.entries()) {
        const piece = pieces[index];
        const text = labelledText(index);
        let label: Frame | null = null;
        if (piece !== undefined && text !== null) {
          // A fan-out's (or a lone) label against its target, clear of the far band's tracks;
          // a fan-in's against its source, clear of the near band's.
          label =
            band === "near"
              ? { a: farStart - pad - labelAlong(text) / 2, c: centerC(piece.to) }
              : { a: nearEnd + pad + labelAlong(text) / 2, c: centerC(piece.from) };
        }
        pieceRoutes[index] = { points: routes[at] ?? [], label, crossesRows: false };
      }
    }
  }

  // ── Whole edges ───────────────────────────────────────────────────────────────────────────
  const laneUse = new Map<number, number>();
  const backLane = (row: number): number => {
    const used = laneUse.get(row) ?? 0;
    laneUse.set(row, used + 1);
    return (rowEndC[row] ?? 0) + settings.rowGap / 4 + used * LANE_STEP;
  };
  const toPoint = (frame: Frame): FlowPoint =>
    lr ? { x: frame.a, y: frame.c } : { x: frame.c, y: frame.a };
  const toLabel = (frame: Frame, text: string): { text: string; x: number; y: number } =>
    lr
      ? { text, x: frame.a, y: frame.c }
      : {
          text,
          x: frame.c + pad + textWidth(text) / 2,
          y: frame.a + settings.labelHeight / 2,
        };

  const routes: FlowRoute[] = graph.edges.map((edge, edgeIndex): FlowRoute => {
    const from = graph.index.get(edge.from) ?? 0;
    const to = graph.index.get(edge.to) ?? 0;
    const text = textOf(edgeIndex);
    if (prepared.back.has(edgeIndex)) {
      // Out a stub past the source's rank, out to a lane beyond the boxes, back along it to a
      // stub before the target, and in.
      const start = outPort(from);
      const finish = inPort(to);
      const exit = (rankA[vertexRank[from] ?? 0] ?? 0) + (rankAlong[vertexRank[from] ?? 0] ?? 0);
      const lane = backLane(
        Math.max(rankRow[vertexRank[from] ?? 0] ?? 0, rankRow[vertexRank[to] ?? 0] ?? 0),
      );
      const out = exit + stub;
      const into = finish.a - stub;
      const points = simplify([
        start,
        { a: out, c: start.c },
        { a: out, c: lane },
        { a: into, c: lane },
        { a: into, c: finish.c },
        finish,
      ]);
      return {
        from: edge.from,
        to: edge.to,
        kind: "back",
        points: points.map((point) => toPoint(point)),
        label: text === null ? null : toLabel({ a: (out + into) / 2, c: lane }, text),
      };
    }
    const chain = prepared.edgePieces[edgeIndex] ?? [];
    const points = simplify(chain.flatMap((index) => pieceRoutes[index]?.points ?? []));
    const labelled = pieceRoutes[chain.at(-1) ?? -1]?.label ?? null;
    const wraps = chain.some((index) => pieceRoutes[index]?.crossesRows === true);
    return {
      from: edge.from,
      to: edge.to,
      kind: wraps ? "wrap" : chain.length > 1 ? "long" : "adjacent",
      points: points.map((point) => toPoint(point)),
      label: text === null || labelled === null ? null : toLabel(labelled, text),
    };
  });

  const boxes: FlowBox[] = graph.nodes.map((node, at) => {
    const rank = vertexRank[at] ?? 0;
    const frame = { a: vertexA(at), c: vertexC[at] ?? 0 };
    const along = alongOf(at);
    const cross = crossOf(at);
    return {
      id: node.id,
      label: node.label,
      ...toPoint(frame),
      width: lr ? along : cross,
      height: lr ? cross : along,
      rank,
      row: rankRow[rank] ?? 0,
      order: (ranks[rank] ?? []).filter((vertex) => vertexNode[vertex] !== null).indexOf(at),
    };
  });

  // The drawing's extent: every box, route and label, plus the margin.
  let right = 0;
  let bottom = 0;
  for (const box of boxes) {
    right = Math.max(right, box.x + box.width);
    bottom = Math.max(bottom, box.y + box.height);
  }
  for (const route of routes) {
    for (const point of route.points) {
      right = Math.max(right, point.x);
      bottom = Math.max(bottom, point.y);
    }
    if (route.label !== null) {
      right = Math.max(right, route.label.x + textWidth(route.label.text) / 2);
      bottom = Math.max(bottom, route.label.y);
    }
  }
  return {
    layout: {
      orientation,
      width: Math.ceil(right + settings.margin),
      height: Math.ceil(bottom + settings.margin),
      boxes,
      routes,
    },
    rows: rowStarts.length,
    cleanWraps,
  };
}

/** Lay out a flow. Deterministic: the same input and options always produce the same numbers. */
export function layoutFlow(
  input: FlowLayoutInput,
  options: Partial<FlowLayoutOptions> = {},
): FlowLayout {
  const settings = { ...DEFAULT_FLOW_LAYOUT_OPTIONS, ...options };
  const prepared = prepare(input);
  if (settings.orientation !== "auto") {
    return place(prepared, settings, settings.orientation).layout;
  }
  const across = place(prepared, settings, "lr");
  // One row; or a chain, which wraps like a sentence; or one clean wrap — Capy's look.
  if (across.rows <= 1 || !prepared.branches || (across.rows === 2 && across.cleanWraps)) {
    return across.layout;
  }
  const down = place(prepared, settings, "tb");
  return down.layout.width <= settings.maxWidth ? down.layout : across.layout;
}
