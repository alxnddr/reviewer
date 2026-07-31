import type { StateCreator } from "zustand";
import { Comment, type ReviewAnchor } from "../../../../shared/review";
import type { SessionId } from "../../../../shared/session";
import {
  commentsToPrompt,
  commentToPrompt,
  promptCommentsFrom,
  type PromptComment,
} from "../../lib/review-export";
import { setSlice, withSlice, type SessionSlice } from "./slice";
import type { ReviewState } from "./state";

// The comment layer: the three edits a reviewer makes to it, and the three ways a comment
// leaves for an agent. They sit together because the clipboard payload is a projection of
// exactly what the first three write — the comments this session holds, against the diff the
// reader is looking at.

/** A successful prompt copy, named by what it copied. The nonce is what makes a second copy
 * of the same target flash again — the scope and id alone would be an unchanged value, and
 * the control would sit there having acknowledged nothing.
 *
 * It exists because the copy has two entry points and only one of them is a click: ⇧⌘C and
 * ⌥⇧⌘C arrive as menu commands, with no button to hand a promise back to. Recording the
 * copy centrally is what lets the card's glyph answer a keystroke the card never saw. */
export type PromptCopy =
  | { scope: "comment"; commentId: string; nonce: number }
  | { scope: "all"; nonce: number };

export type CurationSlice = {
  /** The last prompt copy that succeeded, so the control it was *about* can flash its
   * check. App-level and transient: never persisted, never in a slice, and cleared by
   * nothing — the flash is the component's timer, and a stale record is inert because the
   * controls value-compare the nonce (`useCopiedFlash`). */
  promptCopy: PromptCopy | null;
  /** Curation: add a user-authored comment at a picked anchor. The app assigns
   * identity here — a manual comment is stamped exactly like an imported one; an
   * empty body is never stored. Persists via the write-back. */
  addComment: (anchor: ReviewAnchor, body: string, sessionId?: SessionId) => void;
  /** Edit any comment — imported or manual, all equally editable; an
   * empty body is a no-op, never an empty-body write. */
  editComment: (commentId: string, body: string, sessionId?: SessionId) => void;
  /** Discard any comment; a discarded comment leaves no trace. */
  discardComment: (commentId: string, sessionId?: SessionId) => void;
  /** Put one comment on the clipboard as a prompt an agent can act on directly. Resolves
   * true only once the clipboard write has, which is also when `promptCopy` is recorded —
   * a refused write leaves no trace and shows no check. */
  copyCommentPrompt: (commentId: string, sessionId?: SessionId) => Promise<boolean>;
  /** The ⇧⌘C entry point: the same copy, aimed at the comment the reader is on. False with
   * none focused — the key was pressed with nothing under it, exactly as `n` is on a review
   * with no comments. */
  copyActiveCommentPrompt: (sessionId?: SessionId) => Promise<boolean>;
  /** Every comment in the review as one prompt, grouped by the layers the review authored,
   * whatever is soloed on screen. "All" has to mean the review or it means whatever the
   * reader last clicked, which is not something a clipboard can say. */
  copyAllCommentsPrompt: (sessionId?: SessionId) => Promise<boolean>;
};

/** Comments projected for a prompt, against the diff the reader is actually looking at.
 *
 * `frozen` is read off the render pin (`reviewDiff`), not off an export origin, and the two
 * differ on purpose. An export is about the artifact and can afford `resolveExportOrigin`'s
 * git read to be sure what it is exporting; a copy fires on a keystroke and has to be
 * instant, and — more to the point — what it copies has to agree with what is on screen. A
 * card showing "Outdated" must copy as outdated, or the payload and the app are telling the
 * reader two different things about the same comment. */
function promptCommentsOf(slice: SessionSlice, comments: readonly Comment[]): PromptComment[] {
  const files = slice.diff.phase === "loaded" ? slice.diff.files : [];
  return promptCommentsFrom(comments, files, slice.reviewDiff?.kind === "frozenPatch");
}

/** Write to the clipboard, reporting whether it landed. Never throws: a denied or absent
 * clipboard is a false, which the callers turn into "no check" — the one honest signal a
 * copy affordance has, and the same thing the app's two older copy buttons do with a
 * rejected write. */
async function writeClipboard(text: string): Promise<boolean> {
  try {
    const clipboard = globalThis.navigator?.clipboard;
    if (clipboard === undefined) {
      return false;
    }
    await clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export const createCurationSlice: StateCreator<ReviewState, [], [], CurationSlice> = (set, get) => {
  /** Distinguishes one copy from the next so a control can tell a repeat from a re-render;
   * see `PromptCopy`. A counter rather than a clock — `Date.now()` twice in a frame is the
   * same number, and this only has to differ from the value before it — and one per store, so
   * two instances cannot hand out each other's nonces. */
  let promptCopySequence = 0;

  return {
    promptCopy: null,

    addComment: (anchor, body, sessionId) => {
      withSlice(get, sessionId, (slice, id) => {
        const trimmed = body.trim();
        if (trimmed === "") {
          return;
        }
        // The app stamps identity for a manual comment exactly as importReview does
        // for an imported one: a fresh uuid via Web Crypto in the renderer.
        // safeParse is the final gate — a malformed anchor (which the schema's
        // ascending/positive refinements reject) never becomes stored state that a
        // write-back would then fail to persist.
        const parsed = Comment.safeParse({
          ...anchor,
          body: trimmed,
          id: crypto.randomUUID(),
        });
        if (!parsed.success) {
          return;
        }
        setSlice(set, get, id, { comments: [...slice.comments, parsed.data] });
        get().scheduleSessionWriteBack(id);
      });
    },

    editComment: (commentId, body, sessionId) => {
      withSlice(get, sessionId, (slice, id) => {
        const trimmed = body.trim();
        if (trimmed === "" || !slice.comments.some((comment) => comment.id === commentId)) {
          return;
        }
        setSlice(set, get, id, {
          comments: slice.comments.map((comment) =>
            comment.id === commentId ? { ...comment, body: trimmed } : comment,
          ),
        });
        get().scheduleSessionWriteBack(id);
      });
    },

    discardComment: (commentId, sessionId) => {
      withSlice(get, sessionId, (slice, id) => {
        const remaining = slice.comments.filter((comment) => comment.id !== commentId);
        if (remaining.length === slice.comments.length) {
          return;
        }
        // Never leave the focus pointing at a comment that no longer exists — the
        // counter would read a phantom position and the ring would target nothing.
        setSlice(set, get, id, {
          comments: remaining,
          ...(slice.activeCommentId === commentId ? { activeCommentId: null } : {}),
        });
        get().scheduleSessionWriteBack(id);
      });
    },

    // The three clipboard actions are the only ones that answer anything, so each turns
    // `withSlice`'s "never ran" into the same false the copy itself reports when it does not
    // land — no session and no clipboard are one signal to the caller: no check.
    copyCommentPrompt: async (commentId, sessionId) => {
      const copied = await withSlice(get, sessionId, async (slice) => {
        const comment = slice.comments.find((candidate) => candidate.id === commentId);
        if (comment === undefined) {
          return false;
        }
        const [projected] = promptCommentsOf(slice, [comment]);
        if (projected === undefined || !(await writeClipboard(commentToPrompt(projected)))) {
          return false;
        }
        promptCopySequence += 1;
        set({ promptCopy: { scope: "comment", commentId, nonce: promptCopySequence } });
        return true;
      });
      return copied ?? false;
    },

    copyActiveCommentPrompt: async (sessionId) => {
      const copied = await withSlice(get, sessionId, async (slice, id) =>
        slice.activeCommentId === null
          ? false
          : await get().copyCommentPrompt(slice.activeCommentId, id),
      );
      return copied ?? false;
    },

    copyAllCommentsPrompt: async (sessionId) => {
      const copied = await withSlice(get, sessionId, async (slice) => {
        if (slice.comments.length === 0) {
          return false;
        }
        const text = commentsToPrompt({
          repo: slice.repo,
          // The authored refs, which the origin holds verbatim whatever diff is on screen. A
          // plain repo session the reader commented on themselves has no authored origin, and
          // the payload names no range rather than inventing one out of the current pickers.
          refs:
            slice.reviewOrigin === null
              ? null
              : { base: slice.reviewOrigin.base, head: slice.reviewOrigin.head },
          overview: slice.overview,
          layers: slice.layers,
          // The session's own comments, never the soloed subset: "all" is the review.
          comments: promptCommentsOf(slice, slice.comments),
        });
        if (!(await writeClipboard(text))) {
          return false;
        }
        promptCopySequence += 1;
        set({ promptCopy: { scope: "all", nonce: promptCopySequence } });
        return true;
      });
      return copied ?? false;
    },
  };
};
