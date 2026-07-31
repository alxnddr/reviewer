import type { StateCreator } from "zustand";
import type { BranchName } from "../../../../shared/git";
import type { SessionId } from "../../../../shared/session";
import {
  brushReducer,
  isFullBrush,
  reviewFullBrush,
  selectionFromBrush,
  type BrushAction,
} from "../../lib/selection";
import { reloadLog, runDiffLoad } from "./effects";
import { setSlice, withSlice } from "./slice";
import type { ReviewState } from "./state";

// What the reviewer points the diff at: the brush over the commit list, and the two branch
// endpoints the list itself is walked from. Every action here ends in a load — a moved brush
// re-derives the diff, a moved endpoint re-walks the log first — which is why the brush has a
// preview half that deliberately does not.

export type PickerSlice = {
  /** Moves the brush without touching the diff — drag feedback between pointerdown
   * and pointerup; `commitBrush` (or any loading action) makes it real. */
  previewBrush: (action: BrushAction, sessionId?: SessionId) => void;
  commitBrush: (sessionId?: SessionId) => void;
  applyBrush: (action: BrushAction, sessionId?: SessionId) => void;
  /** Clear a review session's commit subrange back to the whole review: the diff
   * returns to the authored pin (frozen or refs) so every comment places again. */
  resetReviewSubrange: (sessionId?: SessionId) => void;
  /** Point the picker at another branch: its commits become the list. Refetches the
   * log and re-locates the brush in it. */
  setHead: (branch: BranchName, sessionId?: SessionId) => void;
  /** Compare `head` against `base` — the list narrows to exactly what `head` adds over
   * it, the range a pull request shows — or pass null to drop the comparison and go
   * back to the branch's own history. Refetches the log, like `setHead`. */
  setBase: (branch: BranchName | null, sessionId?: SessionId) => void;
  swapBranches: (sessionId?: SessionId) => void;
};

export const createPickerSlice: StateCreator<ReviewState, [], [], PickerSlice> = (set, get) => ({
  previewBrush: (action, sessionId) => {
    withSlice(get, sessionId, (slice, id) => {
      if (slice.log?.phase !== "loaded") {
        return;
      }
      const next = brushReducer(slice.brush, action, slice.log.entries.length);
      if (next !== slice.brush) {
        setSlice(set, get, id, { brush: next });
      }
    });
  },

  commitBrush: (sessionId) => {
    withSlice(get, sessionId, (slice, id) => {
      if (slice.reviewOrigin !== null) {
        // A review session's brush narrows within the authored diff — the pin stays, so
        // resetting returns to the exact review. A brush over the whole range is the
        // full review, modelled as no subrange so the diff renders via the pin (placing
        // every anchor) rather than an equivalent-but-re-derived commit range.
        const entries = slice.log?.phase === "loaded" ? slice.log.entries : [];
        const subrange =
          slice.brush === null || isFullBrush(entries, slice.brush)
            ? null
            : selectionFromBrush(entries, slice.brush);
        setSlice(set, get, id, { reviewSubrange: subrange });
      }
      get().scheduleSessionWriteBack(id);
      void runDiffLoad(set, get, id);
    });
  },

  applyBrush: (action, sessionId) => {
    withSlice(get, sessionId, (slice, id) => {
      const before = slice.brush;
      get().previewBrush(action, id);
      // `previewBrush` no-ops when the brush cannot move; the commit has to follow it. A
      // held ArrowDown at the end of the commit list is a stream of actions that change
      // nothing, and committing each one schedules an IPC write-back for a session that
      // did not move. `runDiffLoad`'s `sameSelection` guard already absorbs the refetch,
      // so this is the write-back's half of the same no-op.
      if (get().sessions[id]?.brush !== before) {
        get().commitBrush(id);
      }
    });
  },

  resetReviewSubrange: (sessionId) => {
    withSlice(get, sessionId, (slice, id) => {
      if (slice.reviewOrigin === null) {
        return;
      }
      // Back to the whole review: no subrange (the diff renders via the pin) and the
      // brush spans every commit so the list reflects it.
      const entries = slice.log?.phase === "loaded" ? slice.log.entries : [];
      setSlice(set, get, id, { reviewSubrange: null, brush: reviewFullBrush(entries) });
      get().scheduleSessionWriteBack(id);
      void runDiffLoad(set, get, id);
    });
  },

  setHead: (branch, sessionId) => {
    withSlice(get, sessionId, (slice, id) => {
      if (slice.reviewOrigin !== null || slice.head === branch) {
        return;
      }
      setSlice(set, get, id, { head: branch });
      get().scheduleSessionWriteBack(id);
      void reloadLog(set, get, id);
    });
  },

  setBase: (branch, sessionId) => {
    withSlice(get, sessionId, (slice, id) => {
      if (slice.reviewOrigin !== null || slice.base === branch) {
        return;
      }
      // Comparing to yourself is not a comparison; it is the branch's own history, which
      // is what null already means.
      setSlice(set, get, id, { base: branch === slice.head ? null : branch });
      get().scheduleSessionWriteBack(id);
      void reloadLog(set, get, id);
    });
  },

  swapBranches: (sessionId) => {
    withSlice(get, sessionId, (slice, id) => {
      if (slice.base === null || slice.head === null) {
        return;
      }
      setSlice(set, get, id, { base: slice.head, head: slice.base });
      get().scheduleSessionWriteBack(id);
      void reloadLog(set, get, id);
    });
  },
});
