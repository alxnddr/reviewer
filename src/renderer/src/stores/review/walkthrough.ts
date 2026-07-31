import type { StateCreator } from "zustand";
import { filesByAnchorPath } from "../../../../shared/diff/patch";
import { stepLayer as stepLayerId } from "../../../../shared/layers";
import type { SessionId } from "../../../../shared/session";
import {
  indexOfComment,
  navigableEntries,
  orderedComments,
} from "../../lib/diff/comment-navigation";
import { withCollapsed } from "../../lib/read-progress";
import { commentFocus, setSlice, sliceSolo, withSlice } from "./slice";
import type { ReviewState } from "./state";

// The reader's way through an authored review: the tour doc as stop zero, the layer order
// after it, and the comments inside whatever is on screen. Almost all of it is derived view
// state — `overviewOpen`, `activeLayerId`, `activeCommentId` are absent from
// `persistedSession` — so these actions schedule no write-back and a relaunch always starts
// the walk over. The one exception is `focusComment`, which also moves the file focus, and
// that half persists like any other navigation.

export type WalkthroughSlice = {
  /** Solo a layer by id, or pass null to clear back to the full diff.
   * Derived view state only: no write-back, and `selection`/`selectedFilePath`/
   * `scrollTop` are left untouched — the diff the session persists never moves.
   * Always leaves the tour doc: choosing what the diff shows means you are done reading
   * the trailhead. */
  setActiveLayer: (layerId: string | null, sessionId?: SessionId) => void;
  /** Open the tour doc — the review's first stop. Clears the soloed layer so the rail has
   * exactly one selected stop, and lands on the section the reader last came out of. A
   * no-op on a session with no doc. */
  openOverview: (sessionId?: SessionId) => void;
  /** Leave the tour doc for the full diff — the "browse all files" way out, and what the
   * `o` toggle does from inside the doc. */
  closeOverview: (sessionId?: SessionId) => void;
  /** Walk the walkthrough: the tour doc (when the review has one) is stop zero, then the
   * authored layer order, clamping at both ends. Stepping back off the first layer opens
   * the doc; stepping forward from it enters the first layer. Snappy and additive,
   * exactly like `setActiveLayer` (no write-back, no session mutation). */
  stepLayer: (direction: 1 | -1, sessionId?: SessionId) => void;
  /** Focus a comment by id: mark it active (the card ring + the counter), ask the diff
   * surface to scroll to it, and move the file focus onto its file so the tree and j/k
   * stay in sync. The scroll is a *request* the surface consumes rather than a change it
   * watches, so it is honoured even when the click is what mounts the surface — the
   * click-from-the-tour-doc case, which the watch could not see (`pendingCommentScroll`). Clears an active solo that would hide the target so its annotation is
   * actually mounted. The active id is ephemeral (no write-back); the file focus
   * persists like any other navigation. */
  focusComment: (commentId: string, sessionId?: SessionId) => void;
  /** Step the reader through the comments that have a line on the surface (placed
   * or outdated), in reading order over the currently visible (soloed) file set,
   * wrapping at both ends. A no-op when there are none. */
  stepComment: (direction: 1 | -1, sessionId?: SessionId) => void;
  /** Drop the focused comment back to none — dismisses the counter and the ring. */
  clearActiveComment: (sessionId?: SessionId) => void;
  /** The diff surface reporting that it has put the focused comment under the reader's
   * eye: clears the scroll request and leaves the focus (ring, counter) standing. The one
   * writer of `pendingCommentScroll` on its own — see `commentFocus`. */
  commentScrolled: (commentId: string, sessionId?: SessionId) => void;
};

export const createWalkthroughSlice: StateCreator<ReviewState, [], [], WalkthroughSlice> = (
  set,
  get,
) => ({
  setActiveLayer: (layerId, sessionId) => {
    withSlice(get, sessionId, (slice, id) => {
      if (slice.activeLayerId === layerId && !slice.overviewOpen) {
        return;
      }
      // No write-back: the active layer is a derived view, never a persisted input
      // (it is absent from `persistedSession`), so soloing costs zero bridge calls
      // and a relaunch always reopens on the full diff.
      setSlice(set, get, id, {
        activeLayerId: layerId,
        overviewOpen: false,
        ...(layerId === null ? {} : { lastChapterId: layerId }),
      });
    });
  },

  openOverview: (sessionId) => {
    withSlice(get, sessionId, (slice, id) => {
      if (slice.overview === null) {
        return;
      }
      // The doc is a stop, not an overlay: it clears the solo rather than hiding it, so
      // there is exactly one selected row in the rail and no remembered state to surprise
      // the reader when they come back down into the diff. `lastChapterId` is untouched —
      // it is the doc's own scroll target, so returning lands on the layer just read.
      setSlice(set, get, id, { overviewOpen: true, activeLayerId: null });
    });
  },

  closeOverview: (sessionId) => {
    withSlice(get, sessionId, (slice, id) => {
      if (!slice.overviewOpen) {
        return;
      }
      setSlice(set, get, id, { overviewOpen: false });
    });
  },

  stepLayer: (direction, sessionId) => {
    withSlice(get, sessionId, (slice, id) => {
      const layers = sliceSolo(slice).layers;
      if (slice.overviewOpen) {
        // From stop zero, forward enters the first chapter; back is the start of the
        // walkthrough, so it stays put rather than wrapping to the end.
        const first = direction === 1 ? (layers[0]?.id ?? null) : null;
        if (first !== null) {
          setSlice(set, get, id, {
            activeLayerId: first,
            overviewOpen: false,
            lastChapterId: first,
          });
        }
        return;
      }
      // Stepping back off the first chapter returns to the doc — the walkthrough's real
      // first stop — instead of dead-ending where the reader can still go somewhere.
      if (
        direction === -1 &&
        slice.overview !== null &&
        slice.activeLayerId !== null &&
        layers[0]?.id === slice.activeLayerId
      ) {
        setSlice(set, get, id, { overviewOpen: true, activeLayerId: null });
        return;
      }
      const next = stepLayerId(layers, slice.activeLayerId, direction);
      if (next === null || next === slice.activeLayerId) {
        return;
      }
      setSlice(set, get, id, { activeLayerId: next, lastChapterId: next });
    });
  },

  focusComment: (commentId, sessionId) => {
    withSlice(get, sessionId, (slice, id) => {
      const comment = slice.comments.find((candidate) => candidate.id === commentId);
      if (comment === undefined) {
        return;
      }
      // The file hosting the comment, under the path the loaded diff knows it by: an
      // anchor authored before a rename names the old path, and every path below (solo
      // cover, fold, file focus) is keyed on the diff's current one. Falls back to the
      // authored path when no file claims it — an unplaceable comment focuses nothing.
      const hostPath =
        slice.diff.phase === "loaded"
          ? (filesByAnchorPath(slice.diff.files).get(comment.file)?.path ?? comment.file)
          : comment.file;
      // A soloed layer that doesn't cover the target's file would leave its
      // annotation unmounted, so there'd be nothing to scroll to; clear the solo
      // first (the panel lists every comment, soloed-out ones included). The full
      // diff is unaffected, so this only fires when a solo is actually hiding it.
      const clearsSolo =
        slice.activeLayerId !== null &&
        slice.diff.phase === "loaded" &&
        !sliceSolo(slice).files.some((file) => file.path === hostPath);
      // A folded file renders no lines, so its comment cards are not mounted and there is
      // nothing to scroll to — the same reason a solo that hides the file is cleared above.
      // Unfold it rather than refuse the jump: the reader asked for this finding.
      const collapsedFiles = withCollapsed(slice.collapsedFiles, [hostPath], false);
      // The active id is ephemeral (no write-back); the file focus moves with it so
      // the tree and j/k stay on the comment's file — that half persists.
      setSlice(set, get, id, {
        ...commentFocus(commentId),
        selectedFilePath: hostPath,
        ...(collapsedFiles === slice.collapsedFiles ? {} : { collapsedFiles }),
        // Stepping to a comment is diff navigation, so it leaves the doc — the card is
        // about to be scrolled to, and it lives on the diff surface.
        overviewOpen: false,
        ...(clearsSolo ? { activeLayerId: null } : {}),
      });
      get().scheduleSessionWriteBack(id);
    });
  },

  stepComment: (direction, sessionId) => {
    withSlice(get, sessionId, (slice, id) => {
      if (slice.diff.phase !== "loaded") {
        return;
      }
      // Walk the file set the surface actually shows: a soloed layer restricts both
      // the diff and this walk, so `n`/`p` never jumps to a comment that isn't on
      // screen. `frozen` places every anchor; otherwise placement is positional.
      const frozen = slice.reviewDiff?.kind === "frozenPatch";
      const visible = sliceSolo(slice).files;
      const entries = navigableEntries(orderedComments(visible, slice.comments, frozen));
      if (entries.length === 0) {
        return;
      }
      const current =
        slice.activeCommentId === null ? -1 : indexOfComment(entries, slice.activeCommentId);
      // From nowhere, forward lands on the first comment and backward on the last;
      // otherwise step and wrap so the ends meet (the counter makes the wrap legible).
      const nextIndex =
        current === -1
          ? direction === 1
            ? 0
            : entries.length - 1
          : (current + direction + entries.length) % entries.length;
      const next = entries[nextIndex];
      if (next !== undefined) {
        get().focusComment(next.comment.id, id);
      }
    });
  },

  clearActiveComment: (sessionId) => {
    withSlice(get, sessionId, (_slice, id) => setSlice(set, get, id, commentFocus(null)));
  },

  commentScrolled: (commentId, sessionId) => {
    withSlice(get, sessionId, (slice, id) => {
      // Only the request it actually served: a focus that landed between the surface's
      // scroll and this report is a newer request, and clearing it would drop that
      // reader's jump on the floor.
      if (slice.pendingCommentScroll !== commentId) {
        return;
      }
      setSlice(set, get, id, { pendingCommentScroll: null });
    });
  },
});
