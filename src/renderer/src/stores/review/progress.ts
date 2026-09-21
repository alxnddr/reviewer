import type { StateCreator } from "zustand";
import { clamp } from "../../../../shared/clamp";
import type { PatchFile } from "../../../../shared/diff/patch";
import { findLayer, soloFiles } from "../../../../shared/layers";
import type { SessionId } from "../../../../shared/session";
import type { CommentResolution } from "../../../../shared/review-progress";
import { isFileRead, markFilesRead, nextUnreadFile, withCollapsed } from "../../lib/read-progress";
import { withResolution } from "../../../../shared/comment-resolution";
import {
  fileFocus,
  leaveDoc,
  setSlice,
  sliceSolo,
  withSlice,
  type Getter,
  type SessionSlice,
  type Setter,
} from "./slice";
import type { ReviewState } from "./state";

// Where the reader is in the diff, and how much of it they have been through: the focused
// file, the scroll position that rides with it, the read marks, the folds the marks pull
// along, and what they decided about each finding. All of it persists — this is the half of
// a session that a relaunch owes back.
//
// The comment marks sit here rather than in `curation.ts` beside the comment edits, and the
// line between the two is what a write means. Curation changes the review; this records what
// one reader did about it. A mark never reaches the artifact, exactly like a read file.

export type ProgressSlice = {
  selectFile: (path: string, sessionId?: SessionId) => void;
  selectAdjacentFile: (direction: 1 | -1, sessionId?: SessionId) => void;
  setScrollTop: (scrollTop: number, sessionId?: SessionId) => void;
  /** Mark one file of the loaded diff read or unread — the atom every other progress
   * readout is derived from. Marks against the file's current content, so the mark can
   * never outlive the code it was made about. Derived view state: no write-back, and a
   * path the loaded diff does not carry is a no-op rather than a mark for nothing. */
  setFileRead: (path: string, read: boolean, sessionId?: SessionId) => void;
  /** The `r` gesture: flip the focused file (or a named one). Pure — it moves nothing,
   * so the reader stays exactly where they were reading. */
  toggleFileRead: (path?: string | null, sessionId?: SessionId) => void;
  /** The `⇧R` gesture: mark the focused file read and land on the next file that still
   * is not — `r` and a search for the next unread file, as one press, since that is the
   * pair a reader repeats a few dozen times a review.
   *
   * Deliberately a mark rather than a flip: a gesture that carries the reader onward cannot
   * also be the one that takes a mark back, since the file it un-marked would be off screen
   * by the time they saw what happened. With nothing left unread ahead it marks and stays,
   * which is `r` exactly — see `nextUnreadFile` for why it does not wrap. No focused file is
   * nothing to mark and so nothing to do, the same silence `r` answers with. */
  markFileReadAndAdvance: (sessionId?: SessionId) => void;
  /** Mark a whole chapter read or unread: every file in the layer's *extent* — itself
   * plus everything nested under it, the same subset soloing shows — so completing a
   * group and completing its sections are the same act. The synthetic "not covered by
   * layers" layer works here too, since it solos like any other. */
  setLayerRead: (layerId: string, read: boolean, sessionId?: SessionId) => void;
  /** Back to nothing read. Scoped to a file set (the tree's own listing, or the whole
   * diff from the doc) so a reset offered beside a subset can never quietly wipe the
   * rest of the review's progress. */
  clearFilesRead: (paths: readonly string[], sessionId?: SessionId) => void;
  /** Fold a file's body away in the code view, or open it back up — the file header's own
   * disclosure. Independent of the read mark: marking read folds, but folding is not
   * marking, and a finished file the reader opens again stays open. */
  setFileCollapsed: (path: string, collapsed: boolean, sessionId?: SessionId) => void;
  /** Record what the reader decided about one finding, or clear the mark with null. The
   * three words are `CommentResolution`'s and are the ones the fix prompt asks an agent to
   * report back, so setting one is transcription rather than translation.
   *
   * Keyed by the comment's fingerprint, not its id: the id is minted fresh at every import,
   * and a mark that did not survive reopening the review would not be worth persisting. An
   * id naming no comment in this session is a no-op — the same silence every other action
   * here answers a stale target with. */
  setCommentResolution: (
    commentId: string,
    resolution: CommentResolution | null,
    sessionId?: SessionId,
  ) => void;
};

/** Every read-progress write funnels through here — one file, a chapter's worth, or a
 * reset — so the rule that marking a file folds it away is stated once instead of at four
 * call sites that could drift apart.
 *
 * Reading a file is finishing with it: its body is then pane real estate spent on
 * settled work, so the fold is part of the same gesture and the files still owed rise up
 * to meet the reader. Unmarking is its mirror and opens the file back up; the header stays
 * a disclosure either way, so a finished file is always one click from being read again.
 *
 * Two more jobs beyond `setSlice`: a gesture that changed nothing (both helpers return
 * their input on a no-op) never reaches the store, so a redundant click costs no render and
 * — since the write-back rides on the change — no disk write either; and what did change is
 * persisted, through the same debounced write-back as every other session input, so a reader
 * who quits mid-review comes back to the review mid-read.
 *
 * `also` is for the one gesture that marks *and* moves (`⇧R`): it rides in the same patch so
 * the mark, the fold and the new focus are one store write and one render rather than three
 * — and so the write-back that carries them is one too. Whether anything moved is `setSlice`'s
 * answer, not a comparison repeated here, because a patch this function does not know the
 * shape of is exactly what a hand-written guard would go stale against. */
function applyRead(
  set: Setter,
  get: Getter,
  sessionId: SessionId,
  files: readonly PatchFile[],
  read: boolean,
  also?: Partial<SessionSlice>,
): void {
  const slice = get().sessions[sessionId];
  if (slice === undefined) {
    return;
  }
  const readFiles = markFilesRead(slice.readFiles, files, read);
  const collapsedFiles = withCollapsed(
    slice.collapsedFiles,
    files.map((file) => file.path),
    read,
  );
  if (setSlice(set, get, sessionId, { readFiles, collapsedFiles, ...also })) {
    get().scheduleSessionWriteBack(sessionId);
  }
}

export const createProgressSlice: StateCreator<ReviewState, [], [], ProgressSlice> = (
  set,
  get,
) => ({
  selectFile: (path, sessionId) => {
    withSlice(get, sessionId, (slice, id) => {
      // Plain file navigation dismisses the comment step-through: the reader is
      // browsing files now, not walking comments — and it leaves the tour doc, since a
      // picked file is a request to see the diff (the doc's own file chips route here).
      //
      // And it asks the surface for the scroll rather than leaving it to notice: leaving
      // the doc *mounts* the diff pane, so the only sites that can see this jump coming are
      // the ones on this side of it (`fileFocus`).
      setSlice(set, get, id, {
        selectedFilePath: path,
        ...fileFocus(path),
        ...leaveDoc(slice),
      });
      get().scheduleSessionWriteBack(id);
    });
  },

  selectAdjacentFile: (direction, sessionId) => {
    withSlice(get, sessionId, (slice, id) => {
      if (slice.diff.phase !== "loaded" || slice.diff.files.length === 0) {
        return;
      }
      // Walk the file set the surface actually shows, the same way `n`/`p` does: with a layer
      // soloed the diff renders only that layer's extent, and stepping the full list marched
      // the selection off into files that are not on screen — from the reader's side, j/k
      // simply stopped working at the layer's last file.
      const files = sliceSolo(slice).files;
      if (files.length === 0) {
        return;
      }
      const currentIndex = files.findIndex((file) => file.path === slice.selectedFilePath);
      const nextIndex =
        currentIndex === -1
          ? direction === 1
            ? 0
            : files.length - 1
          : clamp(currentIndex + direction, 0, files.length - 1);
      const next = files[nextIndex];
      if (next && next.path !== slice.selectedFilePath) {
        // j/k is plain file navigation — it dismisses the comment step-through. It is also
        // live on the tour doc (nothing in `App.tsx`'s switch stands down there), so it
        // leaves the doc and mounts the diff pane, and asks for its scroll the same way
        // `selectFile` does rather than trusting the surface to notice.
        setSlice(set, get, id, {
          selectedFilePath: next.path,
          ...fileFocus(next.path),
          ...leaveDoc(slice),
        });
        get().scheduleSessionWriteBack(id);
      }
    });
  },

  setScrollTop: (scrollTop, sessionId) => {
    if (!Number.isFinite(scrollTop)) {
      return;
    }
    withSlice(get, sessionId, (_slice, id) => {
      setSlice(set, get, id, { scrollTop: Math.max(0, scrollTop) });
      get().scheduleSessionWriteBack(id);
    });
  },

  setFileRead: (path, read, sessionId) => {
    withSlice(get, sessionId, (slice, id) => {
      if (slice.diff.phase !== "loaded") {
        return;
      }
      const file = slice.diff.files.find((candidate) => candidate.path === path);
      if (file === undefined) {
        return;
      }
      applyRead(set, get, id, [file], read);
    });
  },

  toggleFileRead: (path, sessionId) => {
    withSlice(get, sessionId, (slice, id) => {
      if (slice.diff.phase !== "loaded") {
        return;
      }
      // No argument means the file the reader is on — the one j/k and the tree agree is
      // focused, which is the only file `r` could sensibly mean.
      const target = path ?? slice.selectedFilePath;
      const file = slice.diff.files.find((candidate) => candidate.path === target);
      if (file === undefined) {
        return;
      }
      applyRead(set, get, id, [file], !isFileRead(slice.readFiles, file));
    });
  },

  markFileReadAndAdvance: (sessionId) => {
    withSlice(get, sessionId, (slice, id) => {
      if (slice.diff.phase !== "loaded") {
        return;
      }
      const file = slice.diff.files.find((candidate) => candidate.path === slice.selectedFilePath);
      if (file === undefined) {
        return;
      }
      // The target is read off the marks as they stand rather than after the mark lands,
      // and the two answers are the same one: the walk starts strictly *after* the file
      // being marked, so the mark about to be made is never the mark it would stop on.
      //
      // The soloed order, not the whole diff, for the reason `selectAdjacentFile` walks it
      // too — with a chapter soloed, the files off screen are not files the reader is being
      // asked to read, and advancing into one is the selection leaving the surface.
      const next = nextUnreadFile(sliceSolo(slice).files, slice.readFiles, file.path);
      applyRead(
        set,
        get,
        id,
        [file],
        true,
        // Moving is moving: it dismisses the comment walk and leaves the tour doc, exactly
        // as j/k do, since a reader who asked for the next file is asking to see it.
        next === null
          ? undefined
          : { selectedFilePath: next, ...fileFocus(next), ...leaveDoc(slice) },
      );
    });
  },

  setLayerRead: (layerId, read, sessionId) => {
    withSlice(get, sessionId, (slice, id) => {
      if (slice.diff.phase !== "loaded") {
        return;
      }
      const layers = sliceSolo(slice).layers;
      const layer = findLayer(layers, layerId);
      if (layer === null) {
        return;
      }
      // The extent, via the same `soloFiles` the diff and the tree render — so "mark this
      // chapter read" covers exactly what soloing it puts on screen, no more.
      applyRead(set, get, id, soloFiles(slice.diff.files, layer, layers), read);
    });
  },

  clearFilesRead: (paths, sessionId) => {
    withSlice(get, sessionId, (slice, id) => {
      if (slice.diff.phase !== "loaded") {
        return;
      }
      const wanted = new Set(paths);
      applyRead(
        set,
        get,
        id,
        slice.diff.files.filter((file) => wanted.has(file.path)),
        false,
      );
    });
  },

  setCommentResolution: (commentId, resolution, sessionId) => {
    withSlice(get, sessionId, (slice, id) => {
      const comment = slice.comments.find((candidate) => candidate.id === commentId);
      if (comment === undefined) {
        return;
      }
      // `withResolution` answers the same map when the word is already the one on the
      // comment, so re-picking it costs no render and — the write-back riding on the
      // change — no disk write. Deliberately not guarded on the diff being loaded, unlike
      // the file marks above: a mark is about the finding, not about a file on screen, so
      // one made from the rail before the diff finishes is a mark the reader meant.
      const resolvedComments = withResolution(slice.resolvedComments, comment, resolution);
      if (resolvedComments === slice.resolvedComments) {
        return;
      }
      setSlice(set, get, id, { resolvedComments });
      get().scheduleSessionWriteBack(id);
    });
  },

  setFileCollapsed: (path, collapsed, sessionId) => {
    withSlice(get, sessionId, (slice, id) => {
      // Folding alone, leaving the read mark exactly as it was: a reader who opens a
      // finished file back up has not un-finished it, and one who folds an unread file away
      // has not claimed to have read it.
      const collapsedFiles = withCollapsed(slice.collapsedFiles, [path], collapsed);
      if (collapsedFiles !== slice.collapsedFiles) {
        setSlice(set, get, id, { collapsedFiles });
        get().scheduleSessionWriteBack(id);
      }
    });
  },
});
