import type { StateCreator } from "zustand";
import { resolveAnchor } from "../../../../shared/diff/anchor";
import { filesByAnchorPath } from "../../../../shared/diff/patch";
import { stepLayer as stepLayerId } from "../../../../shared/layers";
import type { ReferenceSpan } from "../../../../shared/markdown";
import type { SessionId } from "../../../../shared/session";
import {
  indexOfComment,
  navigableEntries,
  orderedComments,
} from "../../lib/diff/comment-navigation";
import { withCollapsed } from "../../lib/read-progress";
import { samePendingScroll, type PendingScroll } from "../../lib/scroll";
import {
  commentFocus,
  endDocTrip,
  enterDoc,
  fileFocus,
  leaveDoc,
  lineFocus,
  setSlice,
  sliceSolo,
  withSlice,
  type SessionSlice,
} from "./slice";
import type { ReviewState } from "./state";

// The reader's way through an authored review: the tour doc as stop zero, the layer order
// after it, and the comments inside whatever is on screen. Almost all of it is derived view
// state — `overviewOpen`, `activeLayerId`, `activeCommentId` are absent from
// `persistedSession` — so these actions schedule no write-back and a relaunch always starts
// the walk over. The exceptions are `focusComment`, `focusReference` and the doc's two doors
// (`openLayerFile`, `openLayerComment`), which also move the file focus, and that half
// persists like any other navigation.
//
// Leaving and entering the doc is spelled `leaveDoc` / `enterDoc` (`slice.ts`) at every site
// here, never as the literal: those two carry the trip rule, and `doc-trip.test.ts` holds the
// spelling against the source.

export type WalkthroughSlice = {
  /** Solo a layer by id, or pass null to clear back to the full diff.
   * Derived view state only: no write-back, and `selection`/`selectedFilePath`/
   * `scrollTop` are left untouched — the diff the session persists never moves.
   * Always leaves the tour doc: choosing what the diff shows means you are done reading
   * the trailhead. */
  setActiveLayer: (layerId: string | null, sessionId?: SessionId) => void;
  /** Open the tour doc — the review's first stop. Clears the soloed layer so the rail has
   * exactly one selected stop, and plans where the document opens (`enterDoc`): where the
   * reader left it while their trip is live, the chapter they are in once they have moved on.
   * A no-op on a session with no doc, and on one whose doc is already up. */
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
   * click-from-the-tour-doc case, which the watch could not see (`pendingScroll`). Clears an active solo that would hide the target so its annotation is
   * actually mounted. The active id is ephemeral (no write-back); the file focus
   * persists like any other navigation. */
  focusComment: (commentId: string, sessionId?: SessionId) => void;
  /** Step the reader through the comments that have a line on the surface (placed
   * or outdated), in reading order over the currently visible (soloed) file set,
   * wrapping at both ends. A no-op when there are none. */
  stepComment: (direction: 1 | -1, sessionId?: SessionId) => void;
  /** The doc's file row: solo the chapter and land on one of its files, as **one** write.
   * It was two calls (`setActiveLayer`, then `selectFile`), and under the trip rule the second
   * would arrive with the document already closed — a navigation act, ending the trip the
   * first had just started. One `setSlice`, one `leaveDoc`, one trip. */
  openLayerFile: (layerId: string, path: string, sessionId?: SessionId) => void;
  /** The doc's comment door, one write for the same reason: solo the chapter and focus one
   * of its findings. An id that names no comment still opens the chapter. */
  openLayerComment: (layerId: string, commentId: string, sessionId?: SessionId) => void;
  /** The Back pill's ×: end the trip where the reader stands, without navigating. The pill
   * goes and the document is a hub again, exactly as if they had moved on (`endDocTrip`).
   * A no-op off a trip. */
  dismissDocTrip: (sessionId?: SessionId) => void;
  /** The tour doc reporting where it is scrolled to. Not navigation — reading never is — so
   * it neither starts nor ends a trip, and it schedules no write-back: the position is
   * ephemeral. It also spends `docReturn`, which is what makes a bare remount restore this
   * position instead of replaying the request the document was last opened with. */
  setDocScrollTop: (scrollTop: number, sessionId?: SessionId) => void;
  /** Drop the focused comment back to none — dismisses the counter and the ring. */
  clearActiveComment: (sessionId?: SessionId) => void;
  /** Go where a prose reference points — `[the caller](src/worker.ts:40-44)`, and the
   * bare-path form beside it. With no span this *is* `selectFile` and delegates to it: one
   * behaviour, one owner. With one, the span is placed against the loaded diff here rather
   * than on the surface, because a reference has no annotation for the surface to look up —
   * so what reaches it is a line that exists, and a reference the diff has drifted past
   * falls back to its file exactly as a stranded comment does.
   *
   * Unfolds the target file for the same reason `focusComment` does: a folded file renders
   * no lines, so there would be nothing to land on, and the reader asked for this line. It
   * does *not* clear a soloed layer, which `focusComment` has to — a chip is only live for
   * a path in the surface's own `paths` set, and on a chapter band that set is the solo. */
  focusReference: (path: string, span: ReferenceSpan | null, sessionId?: SessionId) => void;
  /** The diff surface reporting that it has put the jump it owed under the reader's eye:
   * clears the request and leaves any focus (ring, counter) standing. The one writer of
   * `pendingScroll` on its own — see `commentFocus`. */
  scrollServed: (pending: PendingScroll, sessionId?: SessionId) => void;
};

/** What focusing a comment writes, short of leaving the doc — shared by `focusComment` and
 * the doc's comment door so the two cannot come to differ about what a jump to a finding
 * does. Null when the id names no comment. */
function commentJump(slice: SessionSlice, commentId: string): Partial<SessionSlice> | null {
  const comment = slice.comments.find((candidate) => candidate.id === commentId);
  if (comment === undefined) {
    return null;
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
  return {
    ...commentFocus(commentId),
    selectedFilePath: hostPath,
    ...(collapsedFiles === slice.collapsedFiles ? {} : { collapsedFiles }),
    ...(clearsSolo ? { activeLayerId: null } : {}),
  };
}

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
      setSlice(set, get, id, { activeLayerId: layerId, ...leaveDoc(slice) });
    });
  },

  openOverview: (sessionId) => {
    withSlice(get, sessionId, (slice, id) => {
      // Already up is a no-op, and has to be said: `enterDoc` plans a fresh return each
      // call, so without this the rail's Overview row clicked from the document would hand
      // the mounted document a request nothing is going to serve.
      if (slice.overview === null || slice.overviewOpen) {
        return;
      }
      setSlice(set, get, id, enterDoc(slice));
    });
  },

  closeOverview: (sessionId) => {
    withSlice(get, sessionId, (slice, id) => {
      if (!slice.overviewOpen) {
        return;
      }
      setSlice(set, get, id, leaveDoc(slice));
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
          setSlice(set, get, id, { activeLayerId: first, ...leaveDoc(slice) });
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
        setSlice(set, get, id, enterDoc(slice));
        return;
      }
      const next = stepLayerId(layers, slice.activeLayerId, direction);
      if (next === null || next === slice.activeLayerId) {
        return;
      }
      // The document is already closed here, so `leaveDoc` changes nothing on screen — it is
      // spread for its other half: stepping chapters is the reader moving on, and ends a trip.
      setSlice(set, get, id, { activeLayerId: next, ...leaveDoc(slice) });
    });
  },

  focusComment: (commentId, sessionId) => {
    withSlice(get, sessionId, (slice, id) => {
      const jump = commentJump(slice, commentId);
      if (jump === null) {
        return;
      }
      // Stepping to a comment is diff navigation, so it leaves the doc — the card is
      // about to be scrolled to, and it lives on the diff surface.
      setSlice(set, get, id, { ...jump, ...leaveDoc(slice) });
      get().scheduleSessionWriteBack(id);
    });
  },

  openLayerFile: (layerId, path, sessionId) => {
    withSlice(get, sessionId, (slice, id) => {
      // `setActiveLayer` and `selectFile`, as the one write they have to be.
      setSlice(set, get, id, {
        activeLayerId: layerId,
        selectedFilePath: path,
        ...fileFocus(path),
        ...leaveDoc(slice),
      });
      get().scheduleSessionWriteBack(id);
    });
  },

  openLayerComment: (layerId, commentId, sessionId) => {
    withSlice(get, sessionId, (slice, id) => {
      // The jump is worked out against the slice as the solo will leave it, which is what
      // calling `focusComment` second used to see: a chapter that does not cover its own
      // finding's file (a comment on a file a rollup's child claims) still clears the solo.
      // `jump` is spread after the layer so that clearing wins.
      const jump = commentJump({ ...slice, activeLayerId: layerId }, commentId);
      setSlice(set, get, id, { activeLayerId: layerId, ...jump, ...leaveDoc(slice) });
      if (jump !== null) {
        get().scheduleSessionWriteBack(id);
      }
    });
  },

  dismissDocTrip: (sessionId) => {
    withSlice(get, sessionId, (slice, id) => {
      if (!slice.docTrip) {
        return;
      }
      setSlice(set, get, id, endDocTrip());
    });
  },

  setDocScrollTop: (scrollTop, sessionId) => {
    if (!Number.isFinite(scrollTop)) {
      return;
    }
    withSlice(get, sessionId, (_slice, id) => {
      setSlice(set, get, id, { docScrollTop: Math.max(0, scrollTop), docReturn: null });
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

  focusReference: (path, span, sessionId) => {
    withSlice(get, sessionId, (slice, id) => {
      // A reference to the whole file is plain file navigation, and that already exists.
      if (span === null) {
        get().selectFile(path, id);
        return;
      }
      const file =
        slice.diff.phase === "loaded"
          ? (slice.diff.files.find((candidate) => candidate.path === path) ?? null)
          : null;
      // The layer scroll's own reading of the same question: a frozen embedded patch places
      // every anchor, but only for a file the patch actually carries, so the two surfaces
      // agree about what has drifted.
      const frozen = slice.reviewDiff?.kind === "frozenPatch";
      const anchor = { file: path, ...span };
      const resolution =
        frozen && file !== null
          ? resolveAnchor(anchor, { kind: "frozen" })
          : resolveAnchor(anchor, { kind: "derived", file: file?.fileDiff ?? null });
      if (resolution.status === "outdated") {
        get().selectFile(path, id);
        return;
      }
      const collapsedFiles = withCollapsed(slice.collapsedFiles, [path], false);
      setSlice(set, get, id, {
        ...lineFocus({ path, line: resolution.line, side: span.side }),
        selectedFilePath: path,
        ...(collapsedFiles === slice.collapsedFiles ? {} : { collapsedFiles }),
        // Following a reference is diff navigation, so it leaves the doc the chip was on.
        ...leaveDoc(slice),
      });
      get().scheduleSessionWriteBack(id);
    });
  },

  scrollServed: (pending, sessionId) => {
    withSlice(get, sessionId, (slice, id) => {
      // Only the request it actually served: a jump the reader made between the surface's
      // scroll and this report is a newer request, and clearing it would drop that
      // reader's jump on the floor.
      if (slice.pendingScroll === null || !samePendingScroll(slice.pendingScroll, pending)) {
        return;
      }
      setSlice(set, get, id, { pendingScroll: null });
    });
  },
});
