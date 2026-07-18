import { useEffect, type KeyboardEvent, type MouseEvent, type ReactElement } from "react";
import { PlusIcon, XIcon } from "lucide-react";
import type { SessionId } from "../../../shared/session";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { useReviewStore } from "@/stores/review";

// Hand-built tablist: Base UI's Tabs.Tab renders a native button element, which
// cannot legally contain the per-tab close, and its Root/Panel pairing assumes
// the tabs own their panel — here the "panel" is the whole app surface driven by
// activeSessionId. Focused tab == active tab (roving tabindex, switch-on-move),
// so keyboard handling lives on the tablist; ⌘1…9 / ⌃Tab / ⌘W arrive through the
// native menu, not DOM handlers.

function tabDomId(id: SessionId): string {
  return `session-tab-${id}`;
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
  onActivate: (id: SessionId) => void;
  onClose: (id: SessionId) => void;
};

function SessionTab({
  id,
  name,
  path,
  active,
  focusStop,
  onActivate,
  onClose,
}: SessionTabProps): ReactElement {
  return (
    <div
      role="tab"
      id={tabDomId(id)}
      aria-selected={active}
      tabIndex={focusStop ? 0 : -1}
      title={path}
      onClick={() => onActivate(id)}
      onAuxClick={(event: MouseEvent<HTMLDivElement>) => {
        if (event.button === 1) {
          onClose(id);
        }
      }}
      className={cn(
        // border+bg-clip-padding mirror the shared Button's fill geometry so a
        // filled tab and the adjacent plus button paint the same 30px-in-32px
        // region — without it the tab's full-bleed fill reads ~2px taller.
        "group flex h-8 min-w-24 max-w-48 shrink items-center rounded-md border border-transparent bg-clip-padding pl-2.5 outline-none select-none",
        "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
        // Active tab wears the one shared selection fill (bg-selected); hover sits
        // a neutral step below so a hovered tab never reads as the active one.
        // Hovered ink promotes one step because muted-on-wash fails AA in light.
        active
          ? "bg-selected text-foreground"
          : "text-text-muted hover:bg-border/30 hover:text-foreground/80",
      )}
    >
      <span className="min-w-0 truncate font-mono text-xs">{name}</span>
      <Button
        variant="ghost"
        size="icon-sm"
        // ⌘W is the keyboard path to close; the pointer affordance stays out of
        // the tab order so tabbing through the strip never lands inside a tab.
        tabIndex={-1}
        aria-label={`Close ${name}`}
        onClick={(event) => {
          event.stopPropagation();
          onClose(id);
        }}
        className={cn(
          // The dark: twin is required: the ghost variant's dark:hover:bg-muted/50
          // is a separate tailwind-merge group, so hover:bg-border alone loses
          // the cascade in dark and the affordance would darken below its fill.
          "mx-0.5 hover:bg-border dark:hover:bg-border",
          !active && "invisible group-hover:visible group-focus-visible:visible",
        )}
      >
        <XIcon className="size-3.5" />
      </Button>
    </div>
  );
}

/** One tab per session in the title-bar chrome; switching only flips
 * `activeSessionId`, so per-session state survives untouched. The strip is the
 * `no-drag` island — the title bar around it keeps dragging the window. */
export function TabBar(): ReactElement {
  const sessions = useReviewStore((state) => state.sessions);
  const activeSessionId = useReviewStore((state) => state.activeSessionId);
  const activateSession = useReviewStore((state) => state.activateSession);
  const closeSession = useReviewStore((state) => state.closeSession);
  const openRepository = useReviewStore((state) => state.openRepository);
  const openReview = useReviewStore((state) => state.openReview);

  const order = Object.values(sessions);
  const activeIndex = order.findIndex((slice) => slice.id === activeSessionId);

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
      <div
        role="tablist"
        aria-label="Open repositories"
        onKeyDown={onKeyDown}
        // Tabs compress to their floor first; only then does the strip scroll
        // (macOS overlay scrollbars keep the chrome quiet at rest).
        className="flex min-w-0 items-center gap-1 overflow-x-auto"
      >
        {order.map((slice, index) => (
          <SessionTab
            key={slice.id}
            id={slice.id}
            name={slice.repo.name}
            path={slice.repo.path}
            active={slice.id === activeSessionId}
            focusStop={activeIndex === -1 ? index === 0 : slice.id === activeSessionId}
            onActivate={activateSession}
            onClose={closeFromPointer}
          />
        ))}
      </div>
      {/* A session opens from two distinct sources — a repository directory or a
          saved review file — so the plus offers both; labels mirror the native
          File menu, which carries the accelerators. */}
      <DropdownMenu>
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
