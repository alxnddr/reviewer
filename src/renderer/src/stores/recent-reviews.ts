import { create } from "zustand";
import type { RecentReview } from "../../../shared/recent-reviews";
// Relative, not `@/`: this module is unit-tested, and the alias is a bundler concern the
// vitest config does not share (every other store imports its lib the same way).
import { filterRecents, stepIndex } from "../lib/recent-reviews";

// The recents picker's state, kept out of the review store for the same reason the onboarding
// guide's is: nothing here belongs to a session, and the picker has to work before there is
// one — the start screen, which lists reviews itself, is exactly where it matters most.
//
// The list is never cached across openings. `rvw emit` writes into that directory while this
// window is running — that is the entire loop the app is built around — so a list held from
// the last time the panel was open is wrong precisely when the reader is looking for the
// review they just asked for. Every open re-reads, and `refresh` is deliberately not gated on
// the panel being open: the start screen reads the same list to decide whether to offer the
// way in at all, and a count it cannot get is a door it cannot show.
//
// The cursor lives here rather than in the component because two things move it: the arrow
// keys, and the query changing under it. Keeping both in one place is what makes "typing
// always leaves the cursor on the first surviving row" a rule instead of an effect.

type RecentReviewsState = {
  open: boolean;
  /** `idle` before the first read of a given opening — distinct from `loaded` with no rows,
   * which is the real "you have no reviews" answer and says something quite different. */
  phase: "idle" | "loading" | "loaded";
  /** Where main looked. Shown under both lists, so "nothing here" names a real place. */
  dir: string | null;
  reviews: RecentReview[];
  /** Artifacts past the cap, left off the end of the list. Reported, never swallowed. */
  truncated: number;
  /** The directory is there and would not open — a different sentence from having no reviews. */
  unreadable: boolean;
  query: string;
  /** Index into the *filtered* list, or -1 when it is empty. */
  activeIndex: number;
  openPanel: () => void;
  close: () => void;
  refresh: () => Promise<void>;
  setQuery: (query: string) => void;
  /** Steps the cursor by `delta` rows, clamped to the filtered list. */
  moveCursor: (delta: number) => void;
  /** Puts the cursor on a row — the pointer's way in, so hovering and arrowing agree. */
  setCursor: (index: number) => void;
};

/** The rows on screen: the filter applied to what main answered. Exported because the panel
 * and the store's own cursor moves must agree on what "row 3" means, and the only way to
 * guarantee that is for both to ask the same function. */
export function visibleRecents(state: RecentReviewsState): readonly RecentReview[] {
  return filterRecents(state.reviews, state.query);
}

export const useRecentReviewsStore = create<RecentReviewsState>((set, get) => ({
  open: false,
  phase: "idle",
  dir: null,
  reviews: [],
  truncated: 0,
  unreadable: false,
  query: "",
  activeIndex: -1,

  openPanel: () => {
    // The query is cleared on the way in, not on the way out: a panel that reopens still
    // filtered by something typed minutes ago looks like an empty reviews directory.
    set({ open: true, query: "", activeIndex: -1 });
    void get().refresh();
  },

  close: () => set({ open: false }),

  refresh: async () => {
    const bridge = window.reviewer;
    if (!bridge) {
      return;
    }
    set({ phase: "loading" });
    const response = await bridge.listRecentReviews();
    set((state) => ({
      phase: "loaded",
      dir: response.dir,
      reviews: response.reviews,
      truncated: response.truncated,
      unreadable: response.unreadable,
      // Straight onto the newest review, which is what the reader came for often enough that
      // making them press ↓ first would be the wrong default. Measured against the *filtered*
      // list: a reader who typed while this was in flight has already narrowed it, and parking
      // the cursor on row 0 of a list they cannot see is worse than having no cursor.
      activeIndex: filterRecents(response.reviews, state.query).length > 0 ? 0 : -1,
    }));
  },

  setQuery: (query) => {
    set({ query });
    // Re-derived against the *new* filter, not adjusted: the row that was under the cursor is
    // usually gone, and following it would leave the cursor somewhere arbitrary. First
    // surviving row, or none.
    set((state) => ({ activeIndex: visibleRecents(state).length > 0 ? 0 : -1 }));
  },

  moveCursor: (delta) => {
    const state = get();
    set({ activeIndex: stepIndex(state.activeIndex, delta, visibleRecents(state).length) });
  },

  setCursor: (index) => set({ activeIndex: index }),
}));
