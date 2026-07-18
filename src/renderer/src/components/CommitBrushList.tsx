import {
  useEffect,
  useRef,
  type KeyboardEvent,
  type PointerEvent,
  type ReactElement,
  type ReactNode,
} from "react";
import { GitBranch } from "lucide-react";
import type { BranchName, LogEntry } from "../../../shared/git";
import { cn } from "@/lib/utils";
import { relativeTime } from "@/lib/relative-time";
import { useCoarseNow } from "@/lib/use-coarse-now";
import { brushBounds, brushContains, logEntryKey, type BrushRange } from "@/lib/selection";
import { useReviewStore } from "@/stores/review";

// Hand-built listbox: no registry piece offers brush range-selection — pointer
// drag across rows plus shift/arrow extension. The ARIA contract is a
// multiselectable listbox whose options form one contiguous band; the store's
// reducer guarantees contiguity.

/** How close to the list edge (px) a drag must get before the list auto-scrolls. */
const DRAG_SCROLL_MARGIN = 24;

function rowDomId(index: number): string {
  return `commit-brush-option-${index}`;
}

function rowIndexAtPoint(x: number, y: number): number | null {
  const row = document.elementFromPoint(x, y)?.closest("[data-brush-index]");
  if (!(row instanceof HTMLElement) || row.dataset["brushIndex"] === undefined) {
    return null;
  }
  const index = Number(row.dataset["brushIndex"]);
  return Number.isInteger(index) ? index : null;
}

type CommitRowProps = {
  entry: LogEntry;
  index: number;
  selected: boolean;
  focused: boolean;
  bandStart: boolean;
  bandEnd: boolean;
  now: Date;
};

function CommitRow({
  entry,
  index,
  selected,
  focused,
  bandStart,
  bandEnd,
  now,
}: CommitRowProps): ReactElement {
  return (
    <div
      role="option"
      id={rowDomId(index)}
      data-brush-index={index}
      aria-selected={selected}
      className={cn(
        // min-h-7 is the 28px macOS-chrome floor; the two-line anatomy lands
        // around 38px — dense-tool register, rows read adjacent.
        "flex min-h-7 cursor-default flex-col justify-center gap-0 px-2 py-1 select-none",
        // Selected rows form the brush band in the themed selection fill
        // (bg-selected); hover stays a neutral wash a step below so a hovered row
        // never visually joins the band.
        selected ? "bg-selected text-foreground" : "text-text-muted hover:bg-border/30",
        selected && bandStart && "rounded-t-md",
        selected && bandEnd && "rounded-b-md",
        // The focus end of the band — where shift+arrow extends from — is marked
        // only while the listbox itself has keyboard focus.
        focused && "ring-ring group-focus-visible:ring-1 group-focus-visible:ring-inset",
      )}
    >
      {entry.kind === "uncommitted" ? (
        <>
          <span className="truncate text-sm">Uncommitted changes</span>
          <span
            className={cn("truncate text-xs", selected ? "text-foreground/80" : "text-text-muted")}
          >
            working tree
          </span>
        </>
      ) : (
        <>
          <span className="truncate text-sm">{entry.commit.subject}</span>
          <span
            className={cn("truncate text-xs", selected ? "text-foreground/80" : "text-text-muted")}
          >
            <span className="font-mono">{entry.commit.shortSha}</span>
            {` · ${entry.commit.author} · ${relativeTime(entry.commit.authoredAt, now)}`}
          </span>
        </>
      )}
    </div>
  );
}

/** The ref the log is walking (HEAD), so the commit list is never an anonymous
 * history — null names a detached HEAD, which `git log` walks all the same. The
 * label/value typography mirrors the Base/Head fields in branch-compare mode. */
export function BranchHeading({ branch }: { branch: BranchName | null }): ReactElement {
  return (
    <div className="flex flex-col gap-1 px-2 pb-2">
      <span className="text-xs text-text-muted">On branch</span>
      <span className="flex items-center gap-1.5 text-sm">
        <GitBranch aria-hidden="true" className="size-3.5 shrink-0 text-text-muted" />
        {branch === null ? (
          <span className="text-text-muted">Detached HEAD</span>
        ) : (
          <span className="truncate font-mono text-foreground" title={branch}>
            {branch}
          </span>
        )}
      </span>
    </div>
  );
}

type CommitBrushListProps = {
  entries: LogEntry[];
  brush: BrushRange | null;
  /** The block above the list — an "On branch" heading in commits mode, the review
   * range plus its full-review reset in review mode. Rendered in both the populated
   * and empty states so the list is never headless. */
  heading: ReactNode;
  /** The affordance line between heading and list (the brush summary), or null. */
  summary: ReactNode;
  /** What the list says when there are no rows to brush. */
  emptyMessage: ReactNode;
};

export function CommitBrushList({
  entries,
  brush,
  heading,
  summary,
  emptyMessage,
}: CommitBrushListProps): ReactElement {
  const previewBrush = useReviewStore((state) => state.previewBrush);
  const commitBrush = useReviewStore((state) => state.commitBrush);
  const applyBrush = useReviewStore((state) => state.applyBrush);

  const listRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);
  const dragPointRef = useRef<{ x: number; y: number } | null>(null);
  const dragScrollFrameRef = useRef<number | null>(null);

  const now = useCoarseNow();

  const bounds = brush === null ? null : brushBounds(brush);
  const focusIndex = brush?.focus ?? null;

  useEffect(() => {
    // Keyboard moves must keep the focus row visible; during a drag the
    // auto-scroll loop owns the scroll position instead.
    if (focusIndex !== null && !draggingRef.current) {
      document.getElementById(rowDomId(focusIndex))?.scrollIntoView({ block: "nearest" });
    }
  }, [focusIndex]);

  useEffect(() => {
    return () => {
      if (dragScrollFrameRef.current !== null) {
        cancelAnimationFrame(dragScrollFrameRef.current);
      }
    };
  }, []);

  if (entries.length === 0) {
    return (
      <div className="flex min-h-0 flex-col">
        {heading}
        <p className="px-2 pb-3 text-xs text-text-muted">{emptyMessage}</p>
      </div>
    );
  }

  const extendAtPoint = (x: number, y: number): void => {
    const index = rowIndexAtPoint(x, y);
    if (index !== null) {
      previewBrush({ type: "extend", index });
    }
  };

  /** Holding a drag past the list edge keeps scrolling and extending — a range
   * taller than the visible list must not require wiggling the pointer. */
  const dragScrollStep = (): void => {
    dragScrollFrameRef.current = null;
    const list = listRef.current;
    const point = dragPointRef.current;
    if (!draggingRef.current || list === null || point === null) {
      return;
    }
    const rect = list.getBoundingClientRect();
    const pastTop = rect.top + DRAG_SCROLL_MARGIN - point.y;
    const pastBottom = point.y - (rect.bottom - DRAG_SCROLL_MARGIN);
    const overshoot = Math.max(pastTop, pastBottom);
    if (overshoot <= 0) {
      return;
    }
    const step = Math.min(Math.max(overshoot / 2, 2), 24);
    list.scrollTop += pastTop > 0 ? -step : step;
    const clampedY = Math.min(Math.max(point.y, rect.top + 4), rect.bottom - 4);
    extendAtPoint(point.x, clampedY);
    dragScrollFrameRef.current = requestAnimationFrame(dragScrollStep);
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) {
      return;
    }
    const index = rowIndexAtPoint(event.clientX, event.clientY);
    if (index === null) {
      return;
    }
    draggingRef.current = true;
    dragPointRef.current = { x: event.clientX, y: event.clientY };
    listRef.current?.setPointerCapture(event.pointerId);
    previewBrush(event.shiftKey ? { type: "extend", index } : { type: "set", index });
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>): void => {
    if (!draggingRef.current) {
      return;
    }
    dragPointRef.current = { x: event.clientX, y: event.clientY };
    extendAtPoint(event.clientX, event.clientY);
    if (dragScrollFrameRef.current === null) {
      dragScrollFrameRef.current = requestAnimationFrame(dragScrollStep);
    }
  };

  const endDrag = (): void => {
    if (draggingRef.current) {
      draggingRef.current = false;
      dragPointRef.current = null;
      commitBrush();
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        applyBrush({ type: "step", direction: 1, extend: event.shiftKey });
        break;
      case "ArrowUp":
        event.preventDefault();
        applyBrush({ type: "step", direction: -1, extend: event.shiftKey });
        break;
      case "Home":
        event.preventDefault();
        applyBrush(event.shiftKey ? { type: "extend", index: 0 } : { type: "set", index: 0 });
        break;
      case "End": {
        event.preventDefault();
        const last = entries.length - 1;
        applyBrush(event.shiftKey ? { type: "extend", index: last } : { type: "set", index: last });
        break;
      }
      default:
        break;
    }
  };

  return (
    <div className="flex min-h-0 flex-col">
      {heading}
      {summary !== null && <p className="px-2 pb-1.5 text-xs text-text-muted">{summary}</p>}
      <div
        ref={listRef}
        role="listbox"
        aria-label="Commits"
        aria-multiselectable="true"
        aria-activedescendant={focusIndex === null ? undefined : rowDomId(focusIndex)}
        tabIndex={0}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onKeyDown={onKeyDown}
        // -mx-3 cancels SelectionPanel's px-3 so the scroll track sits flush
        // against the sidebar border instead of leaving a gutter; px-4 restores
        // the row inset. ring-inset keeps the focus ring inside the flush right
        // edge rather than under the border.
        className="group -mx-3 min-h-0 flex-1 overflow-y-auto rounded-md px-4 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
      >
        {entries.map((entry, index) => (
          <CommitRow
            key={logEntryKey(entry)}
            entry={entry}
            index={index}
            selected={brush !== null && brushContains(brush, index)}
            focused={focusIndex === index}
            bandStart={bounds?.top === index}
            bandEnd={bounds?.bottom === index}
            now={now}
          />
        ))}
      </div>
    </div>
  );
}
