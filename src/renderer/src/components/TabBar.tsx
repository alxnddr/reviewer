import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type ReactElement,
  type ReactNode,
} from "react";
import { PlusIcon, XIcon } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipHint,
  TooltipTrigger,
  TOOLTIP_DELAY_MS,
} from "@/components/ui/tooltip";
import { ShortcutHint } from "@/components/ui/kbd";
import { shortRef } from "@/lib/refs";
import { tabNames, type TabSubject } from "@/lib/tab-name";
import { useOverflowing } from "@/lib/use-overflowing";
import { useScrollIntoViewById } from "@/lib/use-scroll-into-view";
import { cn } from "@/lib/utils";
import { clamp } from "../../../shared/clamp";
import type { SessionId } from "../../../shared/session";
import {
  activeTabStop,
  sameTabStop,
  useReviewStore,
  type SessionSlice,
  type TabStop,
} from "@/stores/review";

// Hand-built tablist. Not because Base UI's Tabs cannot render the shape: a tab
// defaults to a native button, which cannot legally contain the per-tab close, but
// `<Tabs.Tab nativeButton={false} render={<div />} />` opts out of that and has Base UI
// re-apply the activation behaviour the native element was carrying (the role is `tab`
// either way). What it does not give is the rest of this file — the drag reorder,
// the per-tab container query and the clipped-name fade, and a Root/Panel pairing that
// assumes the tabs own their panel, where here the "panel" is the whole app surface
// driven by activeSessionId. Focused tab == active tab (roving tabindex,
// switch-on-move), so keyboard handling lives on the tablist; ⌘1…9 / ⌃Tab / ⌘W arrive
// through the native menu, not DOM handlers.
//
// Crowding is absorbed by the tabs, not by the strip: each claims the same
// preferred width and they shrink together toward a floor, so the strip only
// scrolls once even the floor won't fit. The geometry that can't be utilities
// (separators, the clipped-name fade, the per-tab container query) is the
// `[data-tab]` block in index.css.
//
// A tab is named after what is inside it, not after the folder it came from — see
// `lib/tab-name.ts` for why, and for how two tabs that would say the same thing are told
// apart. The strip is named as a set, so the naming happens here rather than per tab.
//
// Not every tab is a session: `+` (and ⌘T) opens a start tab, a renderer-only stop that can
// sit anywhere in the strip, be dragged like any other, and is replaced in place by whatever
// review is opened from it (see `tabs` / `claimStartTabSlot` in the store). So the strip is one
// ordered list of stops here, and the two kinds differ only in what they are about — the box,
// the width, the compression, the drag and the keyboard are the same code for both.

/** Slop before a press becomes a drag, so a click with an unsteady hand still
 * reads as a click. */
const DRAG_THRESHOLD_PX = 4;

/** The element id a stop's tab carries. Kept apart by kind so a start tab and a session can
 * never collide, and always looked up with `getElementById` — a session id is a uuid and a
 * start id has a `-` in it, neither of which is safe to splice into a selector. */
function tabDomId(stop: TabStop): string {
  return `${stop.kind}-tab-${stop.id}`;
}

function moved<T>(items: T[], from: number, to: number): T[] {
  const next = [...items];
  const [item] = next.splice(from, 1);
  if (item !== undefined) {
    next.splice(to, 0, item);
  }
  return next;
}

/** What the naming rule is given about one session. A review contributes its authored title
 * and its head ref; a plain repository session contributes neither, which is what makes it
 * fall back to the repository's own name. */
function tabSubject(slice: SessionSlice): TabSubject {
  const review = slice.reviewOrigin;
  return {
    repoName: slice.repo.name,
    repoPath: slice.repo.path,
    title: review === null ? null : (slice.overview?.title ?? null),
    head: review?.head ?? null,
  };
}

/** The second line of a tab's hover hint: what the first line cannot say. For a review that
 * is which project and which range it covers — the name above is the change, not the code it
 * is against. For a repository session it is the path, which is the only thing that tells two
 * checkouts of one project apart. */
function tabHint(slice: SessionSlice): string {
  const review = slice.reviewOrigin;
  return review === null
    ? slice.repo.path
    : `${slice.repo.name} · ${shortRef(review.base)} → ${shortRef(review.head)}`;
}

/** True while a tab is not wholly inside the scrollable strip — the gate on the
 * activation scroll below. Only a clipped tab scrolls: an unconditional nudge leaves
 * the strip resting a few px in. */
function clippedInStrip(tab: HTMLElement): boolean {
  const strip = tab.closest('[role="tablist"]');
  if (strip === null) {
    return false;
  }
  const tabRect = tab.getBoundingClientRect();
  const stripRect = strip.getBoundingClientRect();
  return tabRect.left < stripRect.left || tabRect.right > stripRect.right;
}

/** How long the reveal ring stands on a tab an open request landed on. Long enough to be
 * seen after the eye has travelled from the start screen's list up to the strip; short
 * enough that it is clearly a flash and not a new resting state the tab has taken on. */
const REVEAL_MS = 1200;

/** The session to ring right now, or null. Driven off the store's nonce rather than its id,
 * so asking twice for the same already-open review flashes twice — the `useCopiedFlash`
 * idiom, and for the same reason: the reader pressed twice and is owed two answers. The
 * mount-seeded ref matters as much here, or a strip remounting (a window reopening, a
 * hot reload) would replay a reveal for a click made long ago.
 *
 * Two effects, not one, and that split is load-bearing: under StrictMode the first is
 * invoked twice, and a timer started inside it would be cleared by the first pass's cleanup
 * and never restarted by the second, which the ref sends straight to the early return. So
 * the ref-guarded effect only *records* the reveal and the timer hangs off the state it
 * sets — the exact shape `useCopyFeedback` uses, and the reason it works. */
function useRevealedTab(): SessionId | null {
  const revealed = useReviewStore((state) => state.revealedSession);
  const [shown, setShown] = useState<{ id: SessionId; nonce: number } | null>(null);
  const seen = useRef(revealed?.nonce ?? null);

  useEffect(() => {
    if (revealed === null || revealed.nonce === seen.current) {
      return;
    }
    seen.current = revealed.nonce;
    setShown(revealed);
  }, [revealed]);

  useEffect(() => {
    if (shown === null) {
      return;
    }
    const timer = window.setTimeout(() => setShown(null), REVEAL_MS);
    return () => window.clearTimeout(timer);
  }, [shown]);

  return shown?.id ?? null;
}

/** Everything both kinds of tab share: the box, its states, and its close affordance. The
 * two differ only in what they are about, so they differ only in what they pass here. */
function TabShell({
  domId,
  name,
  hint,
  active,
  focusStop,
  closeLabel,
  dragOffset,
  dragging,
  revealed,
  onActivate,
  onClose,
  onPointerDown,
}: {
  domId: string;
  name: string;
  hint: ReactNode;
  active: boolean;
  /** Roving-tabindex holder. Usually the active tab; falls back to the first
   * tab when nothing is active (a salvaged store can null the pointer while
   * keeping sessions), so the strip never becomes keyboard-unreachable. */
  focusStop: boolean;
  closeLabel: string;
  /** Live horizontal offset while this tab is the one being dragged, else null. */
  dragOffset: number | null;
  /** True for the moment after an open request landed on this tab because its review was
   * already open. One tab per artifact means that click adds nothing to the strip, and a
   * click with no visible result reads as a click that failed — so the tab it went to says
   * "here, this one" itself. */
  revealed: boolean;
  /** True while *any* tab is being dragged — suppresses tooltips strip-wide, so
   * a drag passing under a resting tab can't summon its popup. */
  dragging: boolean;
  onActivate: () => void;
  onClose: () => void;
  onPointerDown: (event: PointerEvent<HTMLDivElement>) => void;
}): ReactElement {
  const nameRef = useRef<HTMLSpanElement>(null);
  // Drives the fade — a name is only faded when there is actually something cut off,
  // so a comfortable strip shows hard-edged names. Re-measured on every resize, which
  // is what shrinking tabs produce as siblings open and close.
  const clipped = useOverflowing(nameRef, name);

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
        id={domId}
        render={
          <div
            role="tab"
            data-tab
            // Read by the sibling-aware separator rules in index.css, which can't
            // see React state — a tab has to know whether the tab *before* it is
            // filled.
            data-active={active}
            aria-selected={active}
            // Every tab controls the same region: the "panel" a tab switches is the whole
            // app surface driven by activeSessionId, not a pane of its own (see the module
            // comment above) — so this is the one id every tab points at, matching
            // AppShell's `<main id="app-content">`.
            aria-controls="app-content"
            tabIndex={focusStop ? 0 : -1}
            onClick={onActivate}
            onPointerDown={onPointerDown}
            onAuxClick={(event: MouseEvent<HTMLDivElement>) => {
              if (event.button === 1) {
                onClose();
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
              // width two tabs would split the whole title bar between them. One
              // width for both kinds, which is also what keeps the drag honest —
              // it reads the pitch off two adjacent tabs and applies it to every
              // slot.
              // border+bg-clip-padding mirror the shared Button's fill geometry so
              // a filled tab and the adjacent plus button paint the same
              // 30px-in-32px region — without it the tab's full-bleed fill reads
              // ~2px taller.
              "group relative flex h-8 w-48 max-w-48 min-w-14 shrink items-center rounded-md border border-transparent bg-clip-padding px-2.5 outline-none select-none",
              "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
              // Active tab wears the one shared selection fill (bg-selected); hover
              // sits a neutral step below so a hovered tab never reads as the active
              // one. Hovered ink promotes one step because muted-on-wash fails AA in
              // light.
              active
                ? "bg-selected text-foreground"
                : "text-text-muted hover:bg-border/30 hover:text-foreground/80",
              dragOffset !== null && "cursor-grabbing",
              // A ring rather than a colour change: the tab under it may be active or
              // inactive, and only an outline reads the same over both fills. It rides the
              // same `ring` token focus uses, at the same inset, so the strip has one
              // vocabulary for "look here" instead of two.
              revealed && "ring-2 ring-ring ring-inset",
            )}
          />
        }
      >
        <span
          ref={nameRef}
          data-tab-title
          data-clipped={clipped}
          // Sans, not mono: a tab names its review the way the chrome around it
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
          aria-label={closeLabel}
          onClick={(event) => {
            event.stopPropagation();
            onClose();
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
          name is recoverable — and the second line is what the name itself cannot say. */}
      <TooltipContent side="bottom" align="start">
        <div className="flex flex-col gap-0.5">
          <span>{name}</span>
          <span className="text-background/70">{hint}</span>
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
  stop: TabStop;
  pointerId: number;
  originX: number;
  index: number;
  /** Distance between adjacent slots — every tab shares one width, so one number does. */
  step: number;
};

/** One tab per stop in the title-bar chrome — a session, or a start screen. Switching only
 * moves `activeSessionId` / `activeStartTabId`, so per-session state survives untouched. The
 * strip is the `no-drag` island — the title bar around it keeps dragging the window. */
export function TabBar(): ReactElement {
  // Reactive to which sessions exist, not to their contents. `setSlice` (review/slice.ts)
  // reallocates a fresh top-level `sessions` record on every write to any session, so
  // subscribing to the record itself re-rendered every tab on every slice mutation
  // anywhere in the app — up to 60 Hz while dragging the commit brush. `tabSubject` and
  // `tabHint` below only read fields (`repo`, `reviewOrigin`, `overview`) that are fixed
  // at session creation and never rewritten in place, so reading the record's current
  // snapshot straight off the store, rather than subscribing to it, stays correct — this
  // only needs to re-render when a session actually opens or closes. If any of those three
  // ever becomes writable on a live session, the tab label goes stale instead of updating,
  // because the key set hasn't changed: project the label strings into this selector then.
  useReviewStore(useShallow((state) => Object.keys(state.sessions)));
  const tabs = useReviewStore((state) => state.tabs);
  const activeSessionId = useReviewStore((state) => state.activeSessionId);
  const activeStartTabId = useReviewStore((state) => state.activeStartTabId);
  const activateSession = useReviewStore((state) => state.activateSession);
  const activateStartTab = useReviewStore((state) => state.activateStartTab);
  const closeSession = useReviewStore((state) => state.closeSession);
  const reorderTabs = useReviewStore((state) => state.reorderTabs);
  const openStartTab = useReviewStore((state) => state.openStartTab);
  const closeStartTab = useReviewStore((state) => state.closeStartTab);
  const revealedId = useRevealedTab();
  const sessions = useReviewStore.getState().sessions;

  // Named as a set, and only the sessions take part: `tabNames` disambiguates against the other
  // *reviews* in the strip, and every start tab is called the same thing on purpose.
  const slices = tabs.flatMap((stop) => (stop.kind === "session" ? (sessions[stop.id] ?? []) : []));
  const names = new Map(
    tabNames(slices.map((slice) => tabSubject(slice))).map((name, index) => [
      slices[index]?.id ?? "",
      name,
    ]),
  );
  const current = activeTabStop({ activeStartTabId, activeSessionId });
  const activeIndex = current === null ? -1 : tabs.findIndex((stop) => sameTabStop(stop, current));
  // With nothing active at all, the first tab holds the strip's one tab stop.
  const focusIndex = activeIndex === -1 ? 0 : activeIndex;

  const stripRef = useRef<HTMLDivElement>(null);
  const [clipped, setClipped] = useState({ start: false, end: false });
  const dragRef = useRef<DragState | null>(null);
  const [drag, setDrag] = useState<{ stop: TabStop; offset: number } | null>(null);

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
  }, [tabs.length]);

  // Activation from anywhere (click, menu ⌘n, a re-opened duplicate, a start tab) must
  // keep the active tab visible inside the scrollable strip. Keyed on the two ids `current`
  // is built from rather than on `current`, which is a fresh object every render.
  useScrollIntoViewById(
    current === null ? null : tabDomId(current),
    { block: "nearest", inline: "nearest", when: clippedInStrip },
    [activeSessionId, activeStartTabId],
  );

  /** Show a stop and take the keyboard with it. */
  const activate = (stop: TabStop): void => {
    if (stop.kind === "start") {
      activateStartTab(stop.id);
    } else {
      activateSession(stop.id);
    }
    document.getElementById(tabDomId(stop))?.focus();
  };

  /** Show the stop at `index`, for the arrow keys. */
  const activateAt = (index: number): void => {
    const target = tabs[index];
    if (target !== undefined) {
      activate(target);
    }
  };

  /** ⌥⇧←/→: the keyboard's path to what a drag does with the pointer — move the
   * focused stop one slot over and keep the keyboard on it. Focused tab == active tab
   * here (see the module comment), so this always moves the one the reader is on. */
  const moveFocused = (delta: number): void => {
    const target = clamp(focusIndex + delta, 0, tabs.length - 1);
    if (target === focusIndex) {
      return;
    }
    const stop = tabs[focusIndex];
    if (stop === undefined) {
      return;
    }
    reorderTabs(moved(tabs, focusIndex, target));
    document.getElementById(tabDomId(stop))?.focus();
  };

  /** Pointer closes only: the close button unmounts with its tab, so DOM focus
   * would drop to body; hand it to whichever tab ends up focused. */
  const closeFromPointer = (stop: TabStop): void => {
    if (stop.kind === "start") {
      closeStartTab(stop.id);
    } else {
      closeSession(stop.id);
    }
    const state = useReviewStore.getState();
    const next = activeTabStop(state);
    if (next !== null) {
      document.getElementById(tabDomId(next))?.focus();
    }
  };

  const onTabPointerDown = (event: PointerEvent<HTMLDivElement>, stop: TabStop): void => {
    // The close button is a press target of its own, and a middle click is a
    // close gesture — neither should arm a drag.
    if (event.button !== 0 || (event.target as HTMLElement).closest("[data-tab-close]") !== null) {
      return;
    }
    if (stop.kind === "start") {
      activateStartTab(stop.id);
    } else {
      activateSession(stop.id);
    }

    const strip = stripRef.current;
    const elements = strip === null ? [] : [...strip.querySelectorAll<HTMLElement>("[data-tab]")];
    const index = elements.findIndex((tab) => tab.id === tabDomId(stop));
    if (index === -1 || elements.length < 2) {
      return;
    }
    // Slot pitch straight off the laid-out strip, so it stays honest however far
    // the tabs have compressed or whatever the gap is set to. Every tab shares one
    // width, so two adjacent ones give the pitch for all of them.
    const first = elements[0]?.getBoundingClientRect();
    const second = elements[1]?.getBoundingClientRect();
    const step = first !== undefined && second !== undefined ? second.left - first.left : 0;
    if (step <= 0) {
      return;
    }
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { stop, pointerId: event.pointerId, originX: event.clientX, index, step };
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
    const stops = useReviewStore.getState().tabs;
    const shift = Math.round(offset / state.step);
    if (shift !== 0) {
      const target = clamp(state.index + shift, 0, stops.length - 1);
      if (target !== state.index) {
        reorderTabs(moved(stops, state.index, target));
        // Re-base onto the new slot so the tab keeps tracking the pointer rather
        // than jumping by a slot's width the moment it swaps.
        state.originX += (target - state.index) * state.step;
        state.index = target;
      }
    }
    setDrag({ stop: state.stop, offset: event.clientX - state.originX });
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
    // ⌥⇧ exactly — not ⌘⌥⇧ or ⌃⌥⇧, which the sheet does not claim and which a reader
    // holding either of those for some other reason should not silently reorder a tab.
    const moveChord = event.altKey && event.shiftKey && !event.metaKey && !event.ctrlKey;
    switch (event.key) {
      case "ArrowLeft":
        event.preventDefault();
        if (moveChord) {
          moveFocused(-1);
        } else {
          activateAt(Math.max(focusIndex - 1, 0));
        }
        break;
      case "ArrowRight":
        event.preventDefault();
        if (moveChord) {
          moveFocused(1);
        } else {
          activateAt(Math.min(focusIndex + 1, tabs.length - 1));
        }
        break;
      case "Home":
        event.preventDefault();
        activateAt(0);
        break;
      case "End":
        event.preventDefault();
        activateAt(tabs.length - 1);
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
          aria-label="Open reviews"
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
          {tabs.map((stop, index) => {
            const slice = stop.kind === "session" ? sessions[stop.id] : undefined;
            // A stop whose session is mid-close: skip the row rather than paint a nameless
            // tab for one frame.
            if (stop.kind === "session" && slice === undefined) {
              return null;
            }
            const name = slice === undefined ? "Start" : (names.get(slice.id) ?? slice.repo.name);
            return (
              <TabShell
                key={`${stop.kind}-${stop.id}`}
                domId={tabDomId(stop)}
                name={name}
                hint={slice === undefined ? "Ask for a review, or reopen one" : tabHint(slice)}
                active={current !== null && sameTabStop(stop, current)}
                focusStop={index === focusIndex}
                closeLabel={`Close ${name}`}
                dragOffset={drag !== null && sameTabStop(drag.stop, stop) ? drag.offset : null}
                dragging={drag !== null}
                revealed={slice !== undefined && slice.id === revealedId}
                onActivate={() => activate(stop)}
                onClose={() => closeFromPointer(stop)}
                onPointerDown={(event) => onTabPointerDown(event, stop)}
              />
            );
          })}
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
      {/* One button, one meaning: a new tab, showing the start screen. It used to be a menu
          offering "Open Repository…" and "Open Review…", which made the strip's only
          affordance a pair of file pickers — the two errands a reader is *least* likely to
          be on, and both of them still in the File menu and on the start screen itself. */}
      <TooltipHint side="bottom" align="start" content={<ShortcutHint id="tab.new" />}>
        <Button
          variant="chrome"
          size="icon"
          aria-label="New tab"
          className="shrink-0"
          onClick={openStartTab}
        >
          <PlusIcon />
        </Button>
      </TooltipHint>
    </div>
  );
}
