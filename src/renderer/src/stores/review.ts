import { create } from "zustand";
import { createBootSlice } from "./review/boot";
import { createCurationSlice } from "./review/curation";
import { createExportSlice } from "./review/export";
import { createOpenSlice } from "./review/open";
import { createPickerSlice } from "./review/picker";
import { createProgressSlice } from "./review/progress";
import type { ReviewState } from "./review/state";
import { createTabsSlice } from "./review/tabs";
import { createWalkthroughSlice } from "./review/walkthrough";
import { createWriteBackSlice } from "./review/write-back";

// The review store, composed. Everything it is made of lives in `review/`, one module per
// concern, and this file is only the seam where they are put together and published.
//
// The nine slices — each one a chunk of state with the actions that maintain it, declared
// together so a field's prose sits with its code:
//
//   boot.ts          sessions arriving from main: hydration, and re-listing on a push
//   tabs.ts          which projects are open, and which one the reader is on
//   open.ts          the four ways a reader asks for something to be opened
//   picker.ts        what the diff is pointed at: the brush and the two branch endpoints
//   progress.ts      the reader's place in the diff, and how much they have been through
//   curation.ts      comments: authored, edited, discarded, and copied out as prompts
//   walkthrough.ts   the way through an authored review: tour doc, layers, comments
//   export.ts        the review as a file on disk, in either shape
//   write-back.ts    everything that travels back to main, debounced — the two debouncers,
//                    the schedule/flush its siblings persist through, and the quit-path lid
//
// …and what they share, none of which is a slice:
//
//   slice.ts         one open project's state (`SessionSlice`), and the two combinators
//                    every action reaches it through (`setSlice`, `withSlice`)
//   slice-factory.ts the one slice literal there is, and the restore that mirrors it
//   state.ts         `ReviewState` — what the nine add up to
//   tab-strip.ts     the strip as a value: what a stop is, and how a list of them rearranges
//   effects.ts       the three git errands: diff load, log re-walk, first derivation
//
// No slice reads another's state or calls another's action by import, and none of them
// imports another module in this directory that is a slice. Where one needs something another
// owns, it goes through `get()` — `openReview` re-lists via `get().syncSessions()`,
// `stepComment` focuses via `get().focusComment()`, every mutating action persists via
// `get().scheduleSessionWriteBack()` — which is the zustand slices pattern and the reason the
// modules above form a tree rather than a mesh.
//
// A factory rather than one `create()` call, because a store instance owns mutable things that
// are not state and must not be shared: two write-back debouncers, the in-flight hydration
// promise, and three counters (start tab ids, reveal nonces, copy nonces). At module scope a
// second instance would arm the first one's timers and hand out its ids. `useReviewStore` below
// is the app's one instance; the tests make their own per case, which is what lets them start
// from a genuinely empty store rather than resetting a singleton field by field.
export function createReviewStore() {
  return create<ReviewState>()((...a) => ({
    ...createBootSlice(...a),
    ...createTabsSlice(...a),
    ...createOpenSlice(...a),
    ...createPickerSlice(...a),
    ...createProgressSlice(...a),
    ...createCurationSlice(...a),
    ...createWalkthroughSlice(...a),
    ...createExportSlice(...a),
    ...createWriteBackSlice(...a),
  }));
}

/** The store the app runs on: one instance, bound at module load, imported as a hook by every
 * component. A discarded instance should have `cancelWriteBacks()` called on it first (see
 * `write-back.ts`); this one is never discarded — it dies with the window. */
export const useReviewStore = createReviewStore();

export type ReviewStore = ReturnType<typeof createReviewStore>;

// The store's public surface, unchanged by the split: components import the selectors and the
// strip helpers from here, the tests and the preview harness import the slice factory, and a
// test that stands in for the hook itself names what a selector is handed (`ReviewState`).
export type { BootPhase } from "./review/boot";
export type { PromptCopy } from "./review/curation";
export {
  selectActiveSlice,
  selectSoloedDiff,
  type SessionSlice,
  type SessionsView,
} from "./review/slice";
export { createSessionSlice } from "./review/slice-factory";
export type { ReviewState } from "./review/state";
export { activeTabStop, sameTabStop, type StartTabId, type TabStop } from "./review/tab-strip";
export { WRITE_BACK_DEBOUNCE_MS } from "./review/write-back";
