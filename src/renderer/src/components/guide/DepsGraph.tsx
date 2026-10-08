import { useMemo, useRef, type ReactElement, type ReactNode } from "react";
import type { AnchorSpan } from "../../../../shared/review";
import { countLabel } from "../../../../shared/plural";
import {
  anchorLabel,
  edgeTagPoints,
  flowOptions,
  FLOW_MARKER_WIDTH,
  FLOW_METRICS,
  type ChapterBadge as Badge,
  type FlowDrawingEdge,
} from "@/lib/guide";
import { layoutFlow, type FlowLayout, type FlowPoint } from "@/lib/flow-layout";
import {
  edgeCountLabel,
  type DepsEdge,
  type DepsEdgeStatus,
  type DepsGraph as DepsGraphModel,
  type DepsNode,
} from "@/lib/deps-graph";
import { useElementWidth } from "@/lib/use-element-width";
import { cn } from "@/lib/utils";
import { AnchorTarget, canOpen, CODE_FACE, type AnchorDoor } from "@/components/guide/anchor-door";

// The Deps tab: the change's dependency diff as a module graph (`lib/deps-graph.ts`), laid out by
// the same `layoutFlow` as an authored flow visual and drawn in the same grammar as
// `FlowDiagram` — HTML boxes over one SVG of orthogonal edges, colour spent on change and nothing
// else. Not drawn *through* `FlowDiagram`: that renders an authored `FlowVisual`, whose schema has
// no "both added and removed" edge, no external-package box and a 14-node cap, and bending the
// artifact's contract to fit a computed picture would put a computed shape into a format agents
// write. The layout is the shared part; the look is mirrored, class for class, below.
//
// Edges: imports added green, removed red and dashed, both on one edge amber, and grey when a
// context line proves the edge was there all along (the change only added or dropped imports on
// it). Each edge's tag prints its statement counts and is a door — through `AnchorTarget`, the `focusReference` door every guide element uses — to
// its first statement's line; the line itself is clickable too, for the pointer. The chapter that
// owns that statement is named in the tag's hint, not printed beside it as a flow's edge badge is:
// the layout widens a column gap for the label text only, and a badge per edge collided with the
// box it points into on every fan-out (tried; the counts are what the picture is about). Boxes: a module is a
// mono box, green-barred when every changed file in it is new and struck when every one is
// deleted; an external package is a dashed, muted box with no ground, so the eye separates the
// repository from what it depends on; an alias no file explained is dashed and italic. Boxes are
// not doors: a module is a directory, and the Map tab beside this one is where directories open.

/** A module box's tone by status — the diff's own pale grounds and bars (`FlowDiagram.tsx`'s
 * `nodeTone`, mirrored rather than imported: that function is the authored flow's and keyed on
 * its schema's statuses). */
function nodeTone(node: DepsNode): { box: string; marker: string; glyph: string } {
  if (node.kind !== "module") {
    return {
      box: cn(
        "border-dashed border-border-strong bg-transparent text-text-muted",
        node.kind === "alias" && "italic",
      ),
      marker: "",
      glyph: "",
    };
  }
  switch (node.status) {
    case "added":
      return {
        box: "border-diff-add-fg/30 border-l-[3px] border-l-diff-add-fg bg-diff-add-bg text-foreground",
        marker: "text-diff-add-fg",
        glyph: "+",
      };
    case "removed":
      return {
        box: "border-diff-del-fg/30 border-l-[3px] border-l-diff-del-fg bg-diff-del-bg text-foreground",
        marker: "text-diff-del-fg",
        glyph: "−",
      };
    case "same":
      return { box: "border-border-strong bg-diff-surface text-foreground", marker: "", glyph: "" };
  }
}

function edgeStroke(status: DepsEdgeStatus): { stroke: string; dash?: string; text: string } {
  switch (status) {
    case "added":
      return { stroke: "var(--diff-add-fg)", text: "text-diff-add-fg" };
    case "removed":
      return { stroke: "var(--diff-del-fg)", dash: "4 3", text: "text-diff-del-fg" };
    case "changed":
      return { stroke: "var(--warning)", text: "text-warning" };
    case "kept":
      return { stroke: "var(--text-faint)", text: "text-text-muted" };
  }
}

const LEGEND: { status: DepsEdgeStatus; text: string }[] = [
  { status: "added", text: "imports added" },
  { status: "removed", text: "imports removed" },
  { status: "changed", text: "both" },
  { status: "kept", text: "edge already there" },
];

/** The arrowhead at a route's end (as `FlowDiagram` draws it): every route enters its target
 * from the left, so it points along the last segment. */
function arrowHead(points: readonly FlowPoint[]): string | null {
  const end = points.at(-1);
  const before = points.at(-2);
  if (end === undefined || before === undefined) {
    return null;
  }
  const dx = Math.sign(end.x - before.x);
  const dy = Math.sign(end.y - before.y);
  const size = 5;
  const back = { x: end.x - dx * size, y: end.y - dy * size };
  const side = { x: -dy * (size * 0.7), y: dx * (size * 0.7) };
  return `M ${back.x + side.x} ${back.y + side.y} L ${end.x} ${end.y} L ${back.x - side.x} ${back.y - side.y}`;
}

/** How many statements an edge's hint lists before it counts the rest. */
const HINT_STATEMENTS = 6;

/** The statements behind an edge, each with the chapter that owns it and where it is. */
function edgeHint(
  edge: DepsEdge,
  badgeOf: (anchor: AnchorSpan | undefined) => Badge | null,
): ReactNode {
  const shown = edge.statements.slice(0, HINT_STATEMENTS);
  const rest = edge.statements.length - shown.length;
  return (
    <span className="flex flex-col gap-0.5">
      {shown.map((statement, index) => {
        const badge = badgeOf(statement.anchor);
        return (
          <span key={index} className="font-mono text-[11px]">
            {statement.change === "added" ? "+ " : "− "}
            {statement.specifier}
            <span className="opacity-75">
              {"  "}
              {badge === null ? "" : `chapter ${badge.ordinal} · `}
              {anchorLabel(statement.anchor)}
            </span>
          </span>
        );
      })}
      {rest > 0 && <span className="text-[11px] opacity-75">and {rest} more</span>}
    </span>
  );
}

type Drawn = { edge: DepsEdge; route: FlowLayout["routes"][number] };

type DepsGraphProps = {
  graph: DepsGraphModel;
  badgeOf: (anchor: AnchorSpan | undefined) => Badge | null;
  door: AnchorDoor;
};

export function DepsGraph({ graph, badgeOf, door }: DepsGraphProps): ReactElement {
  const ref = useRef<HTMLDivElement>(null);
  const width = useElementWidth(ref);
  const metrics = FLOW_METRICS.regular;
  const nodes = useMemo(() => new Map(graph.nodes.map((node) => [node.id, node])), [graph]);
  const drawing = useMemo(() => {
    if (width === 0 || graph.edges.length === 0) {
      return null;
    }
    const layout = layoutFlow(
      {
        nodes: graph.nodes.map((node) => ({
          id: node.id,
          label: node.label,
          extraWidth: FLOW_MARKER_WIDTH,
        })),
        edges: graph.edges.map((edge) => ({
          from: edge.from,
          to: edge.to,
          label: edgeCountLabel(edge),
        })),
      },
      flowOptions(false, width),
    );
    // Routes come back in edge order without the ones the layout refused (none here: the model
    // draws no self-loop and names only nodes it lists); pair by endpoints all the same.
    const used = new Set<DepsEdge>();
    const edges: Drawn[] = layout.routes.flatMap((route) => {
      const edge = graph.edges.find(
        (candidate) =>
          !used.has(candidate) && candidate.from === route.from && candidate.to === route.to,
      );
      if (edge === undefined) {
        return [];
      }
      used.add(edge);
      return [{ edge, route }];
    });
    return { layout, edges };
  }, [graph, width]);
  const tags = useMemo(() => {
    if (drawing === null) {
      return [];
    }
    // `edgeTagPoints` spreads tags that would print over one another; it reads only the route,
    // the badge (none here) and the anchor, so a computed edge is handed in under the authored
    // edge's shape.
    const asFlow: FlowDrawingEdge[] = drawing.edges.map(({ edge, route }) => ({
      edge: { from: edge.from, to: edge.to },
      route,
      badge: null,
      anchor: edge.statements[0]?.anchor,
    }));
    return edgeTagPoints(asFlow, metrics.labelCharWidth);
  }, [drawing, metrics]);
  const present = new Set(graph.edges.map((edge) => edge.status));

  if (graph.edges.length === 0) {
    return <p className="py-6 text-center text-sm text-text-muted">No dependency changes</p>;
  }

  return (
    <div>
      <div ref={ref} data-deps-graph="" className="w-full overflow-x-auto">
        {drawing !== null && (
          <div
            className="relative"
            style={{ width: drawing.layout.width, height: drawing.layout.height }}
          >
            <svg
              aria-hidden="true"
              className="pointer-events-none absolute inset-0 overflow-visible"
              width={drawing.layout.width}
              height={drawing.layout.height}
            >
              {drawing.edges.map(({ edge, route }, index) => {
                const { stroke, dash } = edgeStroke(edge.status);
                const head = arrowHead(route.points);
                const points = route.points.map((point) => `${point.x},${point.y}`).join(" ");
                const first = edge.statements[0]?.anchor;
                const open = canOpen(door, first);
                return (
                  <g key={index} fill="none" stroke={stroke} strokeWidth={1.25}>
                    <polyline points={points} strokeDasharray={dash} strokeLinejoin="round" />
                    {head !== null && (
                      <path d={head} strokeLinecap="round" strokeLinejoin="round" />
                    )}
                    {/* The pointer's wider target along the line; the keyboard's is the tag. */}
                    {open && (
                      <polyline
                        points={points}
                        stroke="transparent"
                        strokeWidth={10}
                        className="cursor-pointer"
                        style={{ pointerEvents: "stroke" }}
                        onClick={() => door.open(first)}
                      />
                    )}
                  </g>
                );
              })}
            </svg>
            {drawing.layout.boxes.map((box) => {
              const node = nodes.get(box.id);
              if (node === undefined) {
                return null;
              }
              const tone = nodeTone(node);
              return (
                <div
                  key={box.id}
                  title={node.title}
                  style={{
                    left: box.x,
                    top: box.y,
                    width: box.width,
                    height: box.height,
                    fontSize: metrics.font,
                    paddingInline: 12 - 3,
                  }}
                  className={cn(
                    "absolute flex items-center rounded-md border whitespace-nowrap",
                    CODE_FACE,
                    tone.box,
                  )}
                >
                  <span
                    aria-hidden="true"
                    className={cn("shrink-0", tone.marker)}
                    style={{ width: FLOW_MARKER_WIDTH }}
                  >
                    {tone.glyph}
                  </span>
                  <span
                    className={cn(
                      "min-w-0",
                      node.kind === "module" &&
                        node.status === "removed" &&
                        "line-through decoration-diff-del-fg/60",
                    )}
                  >
                    {node.label}
                  </span>
                </div>
              );
            })}
            {drawing.edges.map(({ edge }, index) => {
              const at = tags[index] ?? null;
              if (at === null) {
                return null;
              }
              const first = edge.statements[0]?.anchor;
              const text = edgeCountLabel(edge);
              const open = canOpen(door, first);
              return (
                <AnchorTarget
                  key={index}
                  door={door}
                  anchor={first}
                  hint={edgeHint(edge, badgeOf)}
                  label={
                    open
                      ? `${nodes.get(edge.from)?.label ?? ""} to ${nodes.get(edge.to)?.label ?? ""}, ${text}, open the first import`
                      : undefined
                  }
                  style={{ left: at.x, top: at.y, fontSize: metrics.font - 2 }}
                  className={cn(
                    "absolute flex -translate-x-1/2 -translate-y-full items-center gap-1 rounded px-0.5 pb-0.5 font-mono leading-none whitespace-nowrap tabular-nums",
                    edgeStroke(edge.status).text,
                    open && "hover:bg-border/50",
                  )}
                >
                  {text}
                </AnchorTarget>
              );
            })}
          </div>
        )}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-text-faint">
        {LEGEND.filter((entry) => present.has(entry.status)).map((entry) => {
          const { stroke, dash } = edgeStroke(entry.status);
          return (
            <span key={entry.status} className="flex items-center gap-1.5">
              <svg aria-hidden="true" width={18} height={6}>
                <line
                  x1={0}
                  y1={3}
                  x2={18}
                  y2={3}
                  stroke={stroke}
                  strokeWidth={1.5}
                  strokeDasharray={dash}
                />
              </svg>
              {entry.text}
            </span>
          );
        })}
        {graph.nodes.some((node) => node.kind !== "module") && (
          <span className="flex items-center gap-1.5">
            <span
              aria-hidden="true"
              className="h-2.5 w-4 rounded-[3px] border border-dashed border-border-strong"
            />
            external
          </span>
        )}
        {graph.hidden.edges > 0 && (
          <span className="ml-auto">
            +{countLabel(graph.hidden.edges, "more edge")}
            {graph.hidden.nodes > 0 ? ` across ${countLabel(graph.hidden.nodes, "more node")}` : ""}
            , not drawn
          </span>
        )}
      </div>
    </div>
  );
}
