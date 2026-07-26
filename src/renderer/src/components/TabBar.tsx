import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type ReactElement,
  type RefObject,
} from "react";
import { PlusIcon, XIcon } from "lucide-react";
import type { SessionId } from "../../../shared/session";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipHint,
  TooltipTrigger,
  TOOLTIP_DELAY_MS,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useReviewStore } from "@/stores/review";

// Hand-built tablist: Base UI's Tabs.Tab renders a native button element, which
// cannot legally contain the per-tab close, and its Root/Panel pairing assumes
// the tabs own their panel — here the "panel" is the whole app surface driven by
// activeSessionId. Focused tab == active tab (roving tabindex, switch-on-move),
// so keyboard handling lives on the tablist; ⌘1…9 / ⌃Tab / ⌘W arrive through the
// native menu, not DOM handlers.
//
// Crowding is absorbed by the tabs, not by the strip: each claims the same
// preferred width and they shrink together toward a floor, so the strip only
// scrolls once even the floor won't fit. The geometry that can't be utilities
// (separators, the clipped-name fade, the per-tab container query) is the
// `[data-tab]` block in index.css.

/** Slop before a press becomes a drag, so a click with an unsteady hand still
 * reads as a click. */
const DRAG_THRESHOLD_PX = 4;

function tabDomId(id: SessionId): string {
  return `session-tab-${id}`;
}

function moved<T>(items: T[], from: number, to: number): T[] {
  const next = [...items];
  const [item] = next.splice(from, 1);
  if (item !== undefined) {
    next.splice(to, 0, item);
  }
  return next;
}

/** True while the element's text is wider than the box holding it. Drives the
 * fade — a name is only faded when there is actually something cut off, so a
 * comfortable strip shows hard-edged names. Re-measures on every resize, which
 * is what shrinking tabs produce as siblings open and close. */
function useClipped(ref: RefObject<HTMLElement | null>, text: string): boolean {
  const [clipped, setClipped] = useState(false);

  useEffect(() => {
    const element = ref.current;
    if (element === null) {
      return;
    }
    const measure = (): void => {
      setClipped(element.scrollWidth > element.clientWidth);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref, text]);

  return clipped;
}

type SessionTabProps = {
  id: SessionId;
  name: string;
  path: string;
  active: boolean;
  /** Roving-tabindex holder. Usually the active tab; falls back to the first
   * tab when no session is active (a salvaged store can null the pointer while
   * keeping sessions), so the strip never becomes keyboard-unreachable. */
  focusStop: boolean;
  /** Live horizontal offset while this tab is the one being dragged, else null. */
  dragOffset: number | null;
  /** True while *any* tab is being dragged — suppresses tooltips strip-wide, so
   * a drag passing under a resting tab can't summon its popup. */
  dragging: boolean;
  onActivate: (id: SessionId) => void;
  onClose: (id: SessionId) => void;
  onDragStart: (event: PointerEvent<HTMLDivElement>, id: SessionId) => void;
};

function SessionTab({
  id,
  name,
  path,
  active,
  focusStop,
  dragOffset,
  dragging,
  onActivate,
  onClose,
  onDragStart,
}: SessionTabProps): ReactElement {
  const nameRef = useRef<HTMLSpanElement>(null);
  const clipped = useClipped(nameRef, name);

  return (
    // The hover delay rides on the trigger, not a shared provider: a provider
    // spanning the strip has the tabs contend for one active trigger, and the
    // winner closes the tooltip that just opened (reason "none") before it can
    // ever mount.
    <Tooltip disabled={dragging}>
      <TooltipTrigger
        delay={TOOLTIP_DELAY_MS}
        // The id belongs on the trigger, not on the rendered element: Base UI
        // registers its active trigger by id, and overriding that id on the
        // element leaves it unable to find the trigger again — it then closes
        // the tooltip it just opened, before it can mount.
        id={tabDomId(id)}
        render={
          <div
            role="tab"
            data-tab
            // Read by the sibling-aware separator rules in index.css, which can't
            // see React state — a tab has to know whether the tab *before* it is
            // filled.
            data-active={active}
            aria-selected={active}
            tabIndex={focusStop ? 0 : -1}
            onClick={() => onActivate(id)}
            onPointerDown={(event: PointerEvent<HTMLDivElement>) => onDragStart(event, id)}
            onAuxClick={(event: MouseEvent<HTMLDivElement>) => {
              if (event.button === 1) {
                onClose(id);
              }
            }}
            style={
              dragOffset === null
                ? undefined
                : // Rides above its neighbours so it reads as lifted off the strip
                  // while they close the gap behind it.
                  { transform: `translateX(${dragOffset}px)`, zIndex: 1 }
            }
            className={cn(
              // w-48 is the width a tab *wants*; min-w-14 is the floor it will
              // shrink to before the strip gives up and scrolls. Both matter:
              // without the floor tabs crush to nothing, without the preferred
              // width two tabs would split the whole title bar between them.
              // border+bg-clip-padding mirror the shared Button's fill geometry so
              // a filled tab and the adjacent plus button paint the same
              // 30px-in-32px region — without it the tab's full-bleed fill reads
              // ~2px taller.
              "group relative flex h-8 w-48 min-w-14 max-w-48 shrink items-center rounded-md border border-transparent bg-clip-padding px-2.5 outline-none select-none",
              "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
              // Active tab wears the one shared selection fill (bg-selected); hover
              // sits a neutral step below so a hovered tab never reads as the active
              // one. Hovered ink promotes one step because muted-on-wash fails AA in
              // light.
              active
                ? "bg-selected text-foreground"
                : "text-text-muted hover:bg-border/30 hover:text-foreground/80",
              dragOffset !== null && "cursor-grabbing",
            )}
          />
        }
      >
        <span
          ref={nameRef}
          data-tab-title
          data-clipped={clipped}
          // Sans, not mono: a tab names a repository the way the chrome around it
          // names things — mono is reserved for machine text (refs, paths, code).
          className="min-w-0 flex-1 overflow-hidden text-xs whitespace-nowrap"
        >
          {name}
        </span>
        <Button
          variant="ghost"
          size="icon-sm"
          data-tab-close
          // ⌘W is the keyboard path to close; the pointer affordance stays out of
          // the tab order so tabbing through the strip never lands inside a tab.
          tabIndex={-1}
          aria-label={`Close ${name}`}
          onClick={(event) => {
            event.stopPropagation();
            onClose(id);
          }}
          className={cn(
            // Lifted out of the flow so the name is laid out against the tab's full
            // width — in-flow it would levy its own width on every tab, including
            // the ones too narrow to spare it. The name yields the space back (a
            // margin in index.css) only while this is actually shown.
            "absolute right-1 size-5",
            // The dark: twin is required: the ghost variant's dark:hover:bg-muted/50
            // is a separate tailwind-merge group, so hover:bg-border alone loses
            // the cascade in dark and the affordance would darken below its fill.
            "hover:bg-border dark:hover:bg-border",
            !active && "invisible group-hover:visible group-focus-visible:visible",
          )}
        >
          <XIcon className="size-3" />
        </Button>
      </TooltipTrigger>
      {/* The strip trades the full name away as it compresses, so this is where the
          name is recoverable — and the path is what actually tells two same-named
          checkouts apart. */}
      <TooltipContent side="bottom" align="start">
        <div className="flex flex-col gap-0.5">
          <span>{name}</span>
          <span className="text-background/70">{path}</span>
        </div>
      </TooltipContent>
    </Tooltip>
  );
}

/** The in-flight drag. Kept in a ref, not state: pointermove writes to it on
 * every frame and only the offset needs to re-render. `index` and `originX`
 * track the tab's *current* slot, both re-based each time it swaps, so the
 * offset stays within one slot's width however far the pointer travels. */
type DragState = {
  id: SessionId;
  pointerId: number;
  originX: number;
  index: number;
  /** Distance between adjacent slots — tabs share a width, so one number does. */
  step: number;
};

/** One tab per session in the title-bar chrome; switching only flips
 * `activeSessionId`, so per-session state survives untouched. The strip is the
 * `no-drag` island — the title bar around it keeps dragging the window. */
export function TabBar(): ReactElement {
  const sessions = useReviewStore((state) => state.sessions);
  const activeSessionId = useReviewStore((state) => state.activeSessionId);
  const activateSession = useReviewStore((state) => state.activateSession);
  const closeSession = useReviewStore((state) => state.closeSession);
  const reorderSessions = useReviewStore((state) => state.reorderSessions);
  const openRepository = useReviewStore((state) => state.openRepository);
  const openReview = useReviewStore((state) => state.openReview);

  const order = Object.values(sessions);
  const activeIndex = order.findIndex((slice) => slice.id === activeSessionId);

  const stripRef = useRef<HTMLDivElement>(null);
  const [clipped, setClipped] = useState({ start: false, end: false });
  const dragRef = useRef<DragState | null>(null);
  const [drag, setDrag] = useState<{ id: SessionId; offset: number } | null>(null);

  useEffect(() => {
    // Each edge fades only while tabs are actually hidden past it. Fading both
    // whenever the strip *can* scroll would dim the first tab of a strip resting
    // at position zero, which reads as a rendering fault rather than an edge.
    const strip = stripRef.current;
    if (strip === null) {
      return;
    }
    const measure = (): void => {
      // Sub-pixel strip widths make an exact comparison flicker at the ends.
      const overflow = strip.scrollWidth - strip.clientWidth;
      setClipped({
        start: strip.scrollLeft > 1,
        end: overflow > 1 && strip.scrollLeft < overflow - 1,
      });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(strip);
    strip.addEventListener("scroll", measure, { passive: true });
    return () => {
      observer.disconnect();
      strip.removeEventListener("scroll", measure);
    };
  }, [order.length]);

  useEffect(() => {
    // Activation from anywhere (click, menu ⌘n, a re-opened duplicate) must
    // keep the active tab visible inside the scrollable strip. Only a clipped
    // tab scrolls — an unconditional nudge leaves the strip resting a few px in.
    if (activeSessionId === null) {
      return;
    }
    const tab = document.getElementById(tabDomId(activeSessionId));
    const strip = tab?.closest('[role="tablist"]');
    if (!tab || !strip) {
      return;
    }
    const tabRect = tab.getBoundingClientRect();
    const stripRect = strip.getBoundingClientRect();
    if (tabRect.left < stripRect.left || tabRect.right > stripRect.right) {
      tab.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
  }, [activeSessionId]);

  const activateAt = (index: number): void => {
    const target = order[index];
    if (target !== undefined) {
      activateSession(target.id);
      document.getElementById(tabDomId(target.id))?.focus();
    }
  };

  /** Pointer closes only: the close button unmounts with its tab, so DOM focus
   * would drop to body; hand it to whichever tab ends up active. */
  const closeFromPointer = (id: SessionId): void => {
    closeSession(id);
    const nextActive = useReviewStore.getState().activeSessionId;
    if (nextActive !== null) {
      document.getElementById(tabDomId(nextActive))?.focus();
    }
  };

  const onTabPointerDown = (event: PointerEvent<HTMLDivElement>, id: SessionId): void => {
    // The close button is a press target of its own, and a middle click is a
    // close gesture — neither should arm a drag.
    if (event.button !== 0 || (event.target as HTMLElement).closest("[data-tab-close]") !== null) {
      return;
    }
    activateSession(id);

    const strip = stripRef.current;
    const tabs = strip === null ? [] : [...strip.querySelectorAll<HTMLElement>("[data-tab]")];
    const index = tabs.findIndex((tab) => tab.id === tabDomId(id));
    if (index === -1 || tabs.length < 2) {
      return;
    }
    // Slot pitch straight off the laid-out strip, so it stays honest however far
    // the tabs have compressed or whatever the gap is set to.
    const first = tabs[0]?.getBoundingClientRect();
    const second = tabs[1]?.getBoundingClientRect();
    const step = first !== undefined && second !== undefined ? second.left - first.left : 0;
    if (step <= 0) {
      return;
    }
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { id, pointerId: event.pointerId, originX: event.clientX, index, step };
  };

  const onTabPointerMove = (event: PointerEvent<HTMLDivElement>): void => {
    const state = dragRef.current;
    if (state === null || event.pointerId !== state.pointerId) {
      return;
    }
    const offset = event.clientX - state.originX;
    if (drag === null && Math.abs(offset) < DRAG_THRESHOLD_PX) {
      return;
    }
    const ids = Object.keys(useReviewStore.getState().sessions);
    const shift = Math.round(offset / state.step);
    if (shift !== 0) {
      const target = Math.min(Math.max(state.index + shift, 0), ids.length - 1);
      if (target !== state.index) {
        reorderSessions(moved(ids, state.index, target));
        // Re-base onto the new slot so the tab keeps tracking the pointer rather
        // than jumping by a slot's width the moment it swaps.
        state.originX += (target - state.index) * state.step;
        state.index = target;
      }
    }
    setDrag({ id: state.id, offset: event.clientX - state.originX });
  };

  const onTabPointerUp = (event: PointerEvent<HTMLDivElement>): void => {
    const state = dragRef.current;
    if (state === null || event.pointerId !== state.pointerId) {
      return;
    }
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    dragRef.current = null;
    setDrag(null);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    switch (event.key) {
      case "ArrowLeft":
        event.preventDefault();
        activateAt(Math.max(activeIndex - 1, 0));
        break;
      case "ArrowRight":
        event.preventDefault();
        activateAt(Math.min(activeIndex + 1, order.length - 1));
        break;
      case "Home":
        event.preventDefault();
        activateAt(0);
        break;
      case "End":
        event.preventDefault();
        activateAt(order.length - 1);
        break;
      default:
        break;
    }
  };

  return (
    <div className="app-region-no-drag flex min-w-0 items-center gap-1">
      {/* Wrapper exists to hang the edge fades over the scroll box; the scroll box
          itself can't host them, since they would scroll away with the tabs. */}
      <div className="relative flex min-w-0 items-center">
        <div
          ref={stripRef}
          role="tablist"
          aria-label="Open repositories"
          onKeyDown={onKeyDown}
          // Move/up are delegated here rather than bound per tab: pointer capture
          // keeps delivering to the pressed tab, but the strip is what survives a
          // reorder unmounting and remounting that tab mid-drag.
          onPointerMove={onTabPointerMove}
          onPointerUp={onTabPointerUp}
          onPointerCancel={onTabPointerUp}
          // gap-3 leaves room for the hairline separators drawn into it. Tabs
          // compress to their floor first; only then does the strip scroll —
          // without a bar, since a scrollbar in 40px of chrome is all noise.
          className="no-scrollbar flex min-w-0 items-center gap-3 overflow-x-auto"
        >
          {order.map((slice, index) => (
            <SessionTab
              key={slice.id}
              id={slice.id}
              name={slice.repo.name}
              path={slice.repo.path}
              active={slice.id === activeSessionId}
              focusStop={activeIndex === -1 ? index === 0 : slice.id === activeSessionId}
              dragOffset={drag?.id === slice.id ? drag.offset : null}
              dragging={drag !== null}
              onActivate={activateSession}
              onClose={closeFromPointer}
              onDragStart={onTabPointerDown}
            />
          ))}
        </div>
        {/* Tabs pass under the chrome colour rather than stopping at a hard edge,
            so a scrolled strip reads as continuing past the frame. */}
        {clipped.start && (
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-y-0 left-0 w-6 bg-linear-to-r from-sidebar to-transparent"
          />
        )}
        {clipped.end && (
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-y-0 right-0 w-6 bg-linear-to-l from-sidebar to-transparent"
          />
        )}
      </div>
      {/* A session opens from two distinct sources — a repository directory or a
          saved review file — so the plus offers both; labels mirror the native
          File menu, which carries the accelerators. */}
      <DropdownMenu>
        <TooltipHint side="bottom" align="start" content="Open repository or review">
          <DropdownMenuTrigger
            render={
              <Button
                variant="ghost"
                size="icon"
                aria-label="Open repository or review"
                // Ghost hover on bg-sidebar chrome comes from the border tone; the
                // dark: twin outranks the ghost variant's own dark hover arm, and the
                // aria-expanded arm keeps the wash while the menu is open.
                className="shrink-0 hover:bg-border/60 aria-expanded:bg-border/60 dark:hover:bg-border/60 dark:aria-expanded:bg-border/60"
              />
            }
          >
            <PlusIcon />
          </DropdownMenuTrigger>
        </TooltipHint>
        {/* w-auto min-w-40: the trigger is a 32px icon button, so the default
            anchor-width sizing would wrap the labels. */}
        <DropdownMenuContent align="start" sideOffset={8} className="w-auto min-w-40">
          <DropdownMenuItem onClick={() => void openRepository()}>
            Open Repository…
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => void openReview()}>Open Review…</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
