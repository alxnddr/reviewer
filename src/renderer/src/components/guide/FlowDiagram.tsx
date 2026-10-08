import { useMemo, useRef, type ReactElement } from "react";
import type {
  AnchorSpan,
  FlowNodeStatus,
  FlowVisual,
  VisualPresence,
} from "../../../../shared/review";
import {
  edgeTagPoints,
  flowDrawing,
  flowOptions,
  FLOW_MARKER_WIDTH,
  FLOW_METRICS,
  type ChapterBadge as Badge,
  type FlowDrawingEdge,
} from "@/lib/guide";
import type { FlowPoint } from "@/lib/flow-layout";
import { useElementWidth } from "@/lib/use-element-width";
import { cn } from "@/lib/utils";
import { ChapterBadge } from "@/components/guide/ChapterBadge";
import {
  AnchorTarget,
  canOpen,
  VISUAL_CODE_FACE,
  elementHint,
  type AnchorDoor,
} from "@/components/guide/anchor-door";

// A flow visual — boxes and arrows, who calls whom — drawn by the app's own renderer: HTML boxes
// over one SVG of edges, both placed by `layoutFlow` (`lib/flow-layout.ts`) and paired with their
// badges by `flowDrawing` (`lib/guide.ts`). Nothing here decides a position.
//
// Not mermaid, deliberately: every label here is the artifact's text rendered by React as text —
// no markup is produced from it, no `innerHTML`, no diagram language — and every box that claims
// a change carries an anchor the gate proved places, so the box is a door to that code (via
// `AnchorTarget`) and its badge is the chapter that owns it.
//
// The grammar is the diff's and only the diff's: an added box is the pale green of an added line
// with a green bar at its left edge and a `+`; a removed box the pale red with its label struck
// and a `−`; a changed box a neutral ground with the warning hue's bar and a `~`; an unchanged
// box plain. Edges follow suit — a new edge green, a removed one dashed red, the rest a quiet
// grey — so colour on the picture means "this changed" and nothing else.
//
// The layout is fitted to the card's measured width — left to right, wrapping a long chain onto
// a second line the way Capy's guide does, or top to bottom for a branching flow that would
// wrap more than once (`lib/flow-layout.ts` decides) — and re-run as the pane resizes.
//
// Monospace metrics are the layout's input, so a box's font is pinned to the size *and the
// family* `FLOW_METRICS` (`lib/guide.ts`) was measured at: the bundled Geist Mono, not the
// reader's code font. A box is exactly as wide as its label is long in that font; in a wider
// family a long label ran out of its box and over the arrow beyond it. The label also
// truncates, as the last line of defence should the font not have loaded.
//
// Edges are painted neutral last. Edges that share a source or a target share a trunk, so where
// a new branch and an unchanged one leave a box together the shared stretch is one line, and it
// should read as the path that was already there — the colour belongs to the stretch that is
// the new edge's alone.

function nodeTone(status: FlowNodeStatus): { box: string; marker: string; glyph: string } {
  switch (status) {
    case "added":
      return {
        box: "border-diff-add-fg/30 border-l-diff-add-fg bg-diff-add-bg",
        marker: "text-diff-add-fg",
        glyph: "+",
      };
    case "removed":
      return {
        box: "border-diff-del-fg/30 border-l-diff-del-fg bg-diff-del-bg",
        marker: "text-diff-del-fg",
        glyph: "−",
      };
    case "changed":
      return {
        box: "border-border-strong border-l-warning bg-diff-surface",
        marker: "text-warning",
        glyph: "~",
      };
    case "same":
      return { box: "border-border-strong bg-diff-surface", marker: "", glyph: "" };
  }
}

function edgeStroke(status: VisualPresence | undefined): { stroke: string; dash?: string } {
  switch (status) {
    case "added":
      return { stroke: "var(--diff-add-fg)" };
    case "removed":
      return { stroke: "var(--diff-del-fg)", dash: "4 3" };
    case "same":
    case undefined:
      return { stroke: "var(--text-faint)" };
  }
}

/** The arrowhead at a route's end, pointing along the last segment — right in a left-to-right
 * flow, down in a top-to-bottom one, left or up for an edge that closes a cycle. */
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

/** Paint order: removed, then added, then unchanged on top (the header says why). Stable. */
function paintRank(status: VisualPresence | undefined): number {
  switch (status) {
    case "removed":
      return 0;
    case "added":
      return 1;
    case "same":
    case undefined:
      return 2;
  }
}

/** The bundled face the flow metrics were measured in (`FLOW_METRICS`). */
const FLOW_FONT_FAMILY = '"Geist Mono Variable", "Geist Mono", monospace';

function EdgeLabel({
  drawn,
  at,
  door,
  fontSize,
}: {
  drawn: FlowDrawingEdge;
  at: { x: number; y: number } | null;
  door: AnchorDoor;
  fontSize: number;
}): ReactElement | null {
  const { route, badge, anchor, edge } = drawn;
  if (at === null) {
    return null;
  }
  const text = route.label?.text ?? "";
  const open = canOpen(door, anchor);
  return (
    <AnchorTarget
      door={door}
      anchor={anchor}
      hint={anchor === undefined ? null : elementHint(undefined, anchor, badge)}
      label={open ? `${text === "" ? "edge" : text}, open its code` : undefined}
      style={{
        left: at.x,
        top: at.y,
        fontSize: fontSize - 2,
      }}
      className={cn(
        "absolute flex -translate-x-1/2 -translate-y-full items-center gap-1 rounded px-0.5 pb-0.5 leading-none whitespace-nowrap",
        edge.status === "added"
          ? "text-diff-add-fg"
          : edge.status === "removed"
            ? "text-diff-del-fg line-through"
            : "text-text-muted",
        open && "hover:bg-border/50",
      )}
    >
      {text}
      {badge !== null && <ChapterBadge badge={badge} className="h-3.5 text-[10px]" />}
    </AnchorTarget>
  );
}

type FlowDiagramProps = {
  visual: FlowVisual;
  badgeOf: (anchor: AnchorSpan | undefined) => Badge | null;
  door: AnchorDoor;
  /** The band's smaller drawing: smaller boxes, tighter gaps. */
  compact?: boolean | undefined;
  className?: string;
};

export function FlowDiagram({
  visual,
  badgeOf,
  door,
  compact = false,
  className,
}: FlowDiagramProps): ReactElement {
  const ref = useRef<HTMLDivElement>(null);
  const width = useElementWidth(ref);
  const metrics = compact ? FLOW_METRICS.compact : FLOW_METRICS.regular;
  const drawing = useMemo(
    () => (width === 0 ? null : flowDrawing(visual, badgeOf, flowOptions(compact, width))),
    [visual, badgeOf, width, compact],
  );
  const tags = useMemo(
    () => (drawing === null ? [] : edgeTagPoints(drawing.edges, metrics.labelCharWidth)),
    [drawing, metrics],
  );

  return (
    // The measured box is the card's full width; the drawing inside may be narrower (it is
    // left-aligned, like text) and, past a single column wider than the card, scrolls.
    <div ref={ref} data-flow-diagram="" className={cn("w-full overflow-x-auto", className)}>
      {drawing !== null && (
        <div
          className="relative"
          style={{ width: drawing.layout.width, height: drawing.layout.height }}
        >
          <svg
            aria-hidden="true"
            className="absolute inset-0 overflow-visible"
            width={drawing.layout.width}
            height={drawing.layout.height}
          >
            {drawing.edges
              .map((drawn, index) => ({ drawn, index }))
              .toSorted(
                (one, two) =>
                  paintRank(one.drawn.edge.status) - paintRank(two.drawn.edge.status) ||
                  one.index - two.index,
              )
              .map(({ drawn, index }) => {
                const { stroke, dash } = edgeStroke(drawn.edge.status);
                const head = arrowHead(drawn.route.points);
                return (
                  <g key={index} fill="none" stroke={stroke} strokeWidth={1.25}>
                    <polyline
                      points={drawn.route.points.map((point) => `${point.x},${point.y}`).join(" ")}
                      strokeDasharray={dash}
                      strokeLinejoin="round"
                    />
                    {head !== null && (
                      <path d={head} strokeLinecap="round" strokeLinejoin="round" />
                    )}
                  </g>
                );
              })}
          </svg>
          {drawing.layout.boxes.map((box) => {
            const entry = drawing.nodes.get(box.id);
            if (entry === undefined) {
              return null;
            }
            const { node, badge } = entry;
            const tone = nodeTone(node.status);
            const open = canOpen(door, node.at);
            return (
              <AnchorTarget
                key={box.id}
                door={door}
                anchor={node.at}
                hint={elementHint(node.note, node.at, badge)}
                label={open ? `${node.label}, open its code` : undefined}
                style={{
                  left: box.x,
                  top: box.y,
                  width: box.width,
                  height: box.height,
                  fontSize: metrics.font,
                  fontFamily: FLOW_FONT_FAMILY,
                  paddingInline: 12 - 3,
                }}
                className={cn(
                  "absolute flex items-center rounded-md border border-l-[3px] whitespace-nowrap text-foreground",
                  VISUAL_CODE_FACE,
                  tone.box,
                  open && "hover:shadow-sm hover:brightness-[0.98] dark:hover:brightness-110",
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
                    "min-w-0 truncate",
                    node.status === "removed" && "line-through decoration-diff-del-fg/60",
                  )}
                >
                  {node.label}
                </span>
                {badge !== null && <ChapterBadge badge={badge} className="ml-auto" />}
              </AnchorTarget>
            );
          })}
          {drawing.edges.map((drawn, index) => (
            <EdgeLabel
              key={index}
              drawn={drawn}
              at={tags[index] ?? null}
              door={door}
              fontSize={metrics.font}
            />
          ))}
        </div>
      )}
    </div>
  );
}
