import type { StateCreator } from "zustand";
import type { TabCycleDirection, TabOrdinal } from "../../../../shared/ipc";
import type { SessionId } from "../../../../shared/session";
import { deriveSession } from "./effects";
import { withSlice, type Getter, type SessionSlice } from "./slice";
import type { ReviewState } from "./state";
import {
  activeTabStop,
  createStartTabIds,
  neighbourStop,
  nearestSessionStop,
  reconcileTabs,
  sameTabStop,
  type StartTabId,
  type TabStop,
} from "./tab-strip";

// Which projects are open, which one the reader is on, and the strip that says so. The
// arrangement rules themselves are `tab-strip.ts` — this is where a gesture meets them and
// meets main (a close deletes the session; a drag reports the new session order).

export type TabsSlice = {
  /** Every open project's state, by session id. Insertion order used to *be* the tab strip;
   * it is now only the order sessions were learned about in — `tabs` is the strip. */
  sessions: Record<SessionId, SessionSlice>;
  /** Invariant (matching main's store): names an existing slice or nothing. */
  activeSessionId: SessionId | null;
  /** The tab strip, in order: one stop per session plus one per open start tab, interleaved
   * however the reader has arranged them.
   *
   * It is an explicit list because the strip holds two kinds of thing and only one of them is
   * a session. A start tab is not a session and must not become one — a session is a
   * repository or an imported review, both main-owned, persisted and re-derived — so the
   * renderer owns the order and writes back only the session part of it (`reorderTabs`).
   *
   * Invariant: exactly one stop per session in `sessions`, in this list, at all times.
   * `reconcileTabs` is what maintains that against a fresh listing from main. */
  tabs: TabStop[];
  /** The focused start tab, or null when a session is the reader's stop.
   *
   * It rides *over* `activeSessionId`, which is left pointing at the session the reader came
   * from, so leaving a start tab returns them to the exact tab and scroll position they had.
   * Ephemeral like `overviewOpen`: start tabs are never persisted, so a relaunch lands on the
   * review someone was reading rather than on the front door. */
  activeStartTabId: StartTabId | null;
  activateSession: (id: SessionId) => void;
  /** Focus a start tab already in the strip. */
  activateStartTab: (id: StartTabId) => void;
  /** A new start tab at the end of the strip, focused — the `+`, and ⌘T. Every press is a new
   * tab, like every other tabbed app: the button sits at the end of the strip, so that is
   * where its tab lands. */
  openStartTab: () => void;
  /** Take one out of the strip: its own close button, and ⌘W while it is focused. */
  closeStartTab: (id?: StartTabId) => void;
  /** Deletes the session in main and removes the slice; closing the focused tab
   * activates the right neighbour, else the left — either kind — else lands on the start
   * screen. */
  closeSession: (sessionId?: SessionId) => void;
  /** Re-seats the strip after a drag. Both kinds of tab move; only the session order crosses
   * to main, which knows nothing about start tabs. ⌘1…9 and ⌃Tab follow the new arrangement
   * for free, since they read this same list. */
  reorderTabs: (tabs: TabStop[]) => void;
  /** ⌘1…⌘8 are positional; ⌘9 is the last tab (macOS tabbed-app convention). */
  activateTabByOrdinal: (ordinal: TabOrdinal) => void;
  /** ⌃Tab / ⌃⇧Tab; wraps at both ends. */
  cycleActiveSession: (direction: TabCycleDirection) => void;
};

/** Show a stop, whichever kind it is — through the store's own two actions, so a keyboard
 * activation derives its session exactly like a click does. */
function activateStop(get: Getter, stop: TabStop): void {
  if (stop.kind === "start") {
    get().activateStartTab(stop.id);
  } else {
    get().activateSession(stop.id);
  }
}

export const createTabsSlice: StateCreator<ReviewState, [], [], TabsSlice> = (set, get) => {
  const nextStartTabId = createStartTabIds();

  return {
    sessions: {},
    activeSessionId: null,
    tabs: [],
    activeStartTabId: null,

    activateSession: (id) => {
      const slice = get().sessions[id];
      if (slice === undefined) {
        return;
      }
      // Clicking a tab means "show me that", which is also a way of leaving a start screen —
      // including when the tab clicked is the one already underneath it. That start tab stays in
      // the strip: the reader switched tabs, they did not close one.
      if (get().activeSessionId !== id) {
        set({ activeSessionId: id, activeStartTabId: null });
        get().scheduleActiveWriteBack();
      } else if (get().activeStartTabId !== null) {
        set({ activeStartTabId: null });
      }
      if (slice.needsDerive) {
        void deriveSession(set, get, id);
      }
    },

    activateStartTab: (id) => {
      // Only a stop that is actually in the strip: a stale id (its tab closed while a menu was
      // open) must not resurrect a tab, and `activeStartTabId` naming a tab nobody renders would
      // be a screen with no tab selected.
      if (get().tabs.some((stop) => stop.kind === "start" && stop.id === id)) {
        set({ activeStartTabId: id });
      }
    },

    openStartTab: () => {
      const id = nextStartTabId();
      set({ tabs: [...get().tabs, { kind: "start", id }], activeStartTabId: id });
    },

    closeStartTab: (startTabId) => {
      const id = startTabId ?? get().activeStartTabId;
      if (id === null) {
        return;
      }
      const tabs = get().tabs;
      const index = tabs.findIndex((stop) => stop.kind === "start" && stop.id === id);
      if (index === -1) {
        return;
      }
      const remaining = tabs.filter((_, position) => position !== index);
      if (get().activeStartTabId !== id) {
        // A background tab closed by its own X: the reader stays where they are.
        set({ tabs: remaining });
        return;
      }
      // The focused one: the strip's own neighbour rule, read off the arrangement it is leaving —
      // right neighbour, else left, and both of them are stops that survive the close. Landing on
      // a session activates it (deriving it if it has never been shown); landing on nothing leaves
      // the start screen up, which is what an empty strip shows anyway.
      const next = neighbourStop(tabs, index);
      set({ tabs: remaining, activeStartTabId: null });
      if (next !== null) {
        activateStop(get, next);
      }
    },

    closeSession: (sessionId) => {
      // ⌘W closes the focused tab, and while a start screen is up that is the focused tab — the
      // session behind it is not what the reader is looking at. A pointer close always names its
      // session explicitly (the X on a background tab), so it is unaffected.
      if (sessionId === undefined && get().activeStartTabId !== null) {
        get().closeStartTab();
        return;
      }
      withSlice(get, sessionId, (_slice, id) => {
        // A write-back still in its debounce window is *sent*, not dropped. Everything else on a
        // closing session dies with it, but progress outlives the tab — it is mirrored to the
        // artifact's own record — and the last half-second of it is exactly the part a reader
        // just did. Send then delete: main applies the update to a session it still has, mirrors
        // the marks, and drops the session on the next message.
        get().flushSessionWriteBack(id);
        const tabs = get().tabs;
        const index = tabs.findIndex((stop) => stop.kind === "session" && stop.id === id);
        // Two different questions, and they have two different answers whenever a start tab is
        // involved. What the reader should be *looking at* is the closed tab's neighbour, either
        // kind — that is what every tabbed app does and what they watch happen. What
        // `activeSessionId` may *name* is a session or nothing, so it takes the nearest session
        // instead, which is also the tab a focused start tab is drawn over and returns to.
        const neighbour = index === -1 ? null : neighbourStop(tabs, index);
        const pointer = index === -1 ? null : nearestSessionStop(tabs, index);
        const remaining = { ...get().sessions };
        delete remaining[id];
        // The pointer moves whenever it named the closed session — including while a start tab is
        // drawn over it, where leaving it behind would point at a session that no longer exists.
        // Only a close of the tab actually *on screen* moves the reader.
        const wasPointer = get().activeSessionId === id;
        const onScreen = wasPointer && get().activeStartTabId === null;
        set({
          sessions: remaining,
          tabs: tabs.filter((stop) => stop.kind !== "session" || stop.id !== id),
          ...(wasPointer ? { activeSessionId: pointer } : {}),
        });
        void window.reviewer?.deleteSession({ id });
        if (wasPointer && pointer !== null) {
          // Main nulled its active pointer on delete; the debounced write-back
          // re-points it. Last-tab closes stay null on both sides.
          get().scheduleActiveWriteBack();
        }
        if (onScreen && neighbour !== null) {
          // Through the shared activation so a session neighbour derives on arrival exactly as a
          // click on it would, and a start-tab neighbour becomes the surface.
          activateStop(get, neighbour);
        }
      });
    },

    reorderTabs: (tabs) => {
      // Only stops that still exist, and every live one exactly once: a drag that lands while a
      // session is opening or closing must not drop a tab or invent one.
      const sessionIds = Object.keys(get().sessions);
      const next = reconcileTabs(tabs, sessionIds);
      set({ tabs: next });
      // Main knows nothing about start tabs, so it is told the session order and nothing else.
      void window.reviewer?.reorderSessions({
        ids: next.filter((stop) => stop.kind === "session").map((stop) => stop.id),
      });
    },

    activateTabByOrdinal: (ordinal) => {
      // Over the whole strip, start tabs included: the accelerators name positions in what the
      // reader can see, and a digit that skipped a tab because it is not a session would be
      // counting something else.
      const stops = get().tabs;
      const stop = ordinal === 9 ? stops.at(-1) : stops[ordinal - 1];
      if (stop !== undefined) {
        activateStop(get, stop);
      }
    },

    cycleActiveSession: (direction) => {
      const state = get();
      const stops = state.tabs;
      const first = stops[0];
      if (first === undefined) {
        return;
      }
      const current = activeTabStop(state);
      if (current === null) {
        // Sessions exist but none is active (salvaged store): cycling enters the strip.
        activateStop(get, first);
        return;
      }
      const index = stops.findIndex((stop) => sameTabStop(stop, current));
      const step = direction === "next" ? 1 : -1;
      const next = stops[(index + step + stops.length) % stops.length];
      if (next !== undefined && !sameTabStop(next, current)) {
        activateStop(get, next);
      }
    },
  };
};
