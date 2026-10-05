import type { StateCreator } from "zustand";
import type { GitHubPostResponse } from "../../../../shared/github-posting";
import type { SessionId } from "../../../../shared/session";
import { hasPostable } from "../../../../shared/postable-comment";
import { afterPost, postRequestComments, type PostingState } from "../../lib/github-posting";
import { checkGitHubDiff } from "./effects";
import { setSlice, withSlice, type Getter, type Setter } from "./slice";
import type { ReviewState } from "./state";

// Comments leaving for the pull request as pending review comments (Layer C): the post (one
// card's, or Post all's batch), the "it moved — post anyway?" question, removing a draft, and the posted
// states main reports. Every decision is `lib/github-posting.ts`'s; this is the bridge calls
// and the staleness guards around them. Main does the posting itself and builds every body from
// the session it holds (`main/github/posting.ts`).
//
// **What the reader sees is what is posted.** An edit to a postable reaches main through the
// debounced write-back, half a second behind. So a post first sends any write-back still
// pending for the session (`flushSessionWriteBack` — the IPC is ordered, so main applies the
// edit before it reads the post), and the post carries a digest of the text on screen, which
// main checks against the text it holds before posting a word.

export type PostingSlice = {
  /** Post these comments to the review's pull request as pending review comments. With
   * `acceptHead`, the reader has agreed to post over that pull request head. */
  postComments: (
    commentIds: readonly string[],
    options?: { acceptHead?: string; sessionId?: SessionId },
  ) => Promise<void>;
  /** "Post anyway": the question `headMoved` raised, answered yes — the same comments, posted
   * over the head the reader was shown. */
  confirmHeadMoved: (sessionId?: SessionId) => Promise<void>;
  /** The same question answered no: nothing is posted. */
  dismissHeadMoved: (sessionId?: SessionId) => void;
  /** Remove one pending draft from the reader's pending review on GitHub. */
  removePendingComment: (commentId: string, sessionId?: SessionId) => Promise<void>;
  /** Ask main where the comments stand on GitHub. Main re-checks only when it has a record and a
   * token — one request per call — and answers the record alone otherwise. */
  refreshPosted: (sessionId: SessionId) => Promise<void>;
  /** A token was just added for `owner` (null: a classic one, every owner): ask again, with it,
   * about every open review of a pull request it covers — B4's check, which a private repository
   * answered "not found" to without one, and where its comments stand. Without this the token
   * would only reach those sessions at the next launch, by when it is gone. */
  recheckWithToken: (owner: string | null) => Promise<void>;
};

/** Write the session's posting state, if the slice is still there. */
function setPosting(
  set: Setter,
  get: Getter,
  sessionId: SessionId,
  next: (current: PostingState) => PostingState,
): void {
  const slice = get().sessions[sessionId];
  if (slice !== undefined) {
    setSlice(set, get, sessionId, { posting: next(slice.posting) });
  }
}

export const createPostingSlice: StateCreator<ReviewState, [], [], PostingSlice> = (set, get) => ({
  postComments: async (commentIds, options = {}) => {
    const bridge = window.reviewer;
    const target = withSlice(get, options.sessionId, (slice, id) => ({ slice, id }));
    if (!bridge || target === undefined || target.slice.posting.busy) {
      return;
    }
    const { id: sessionId } = target;
    // Any edit still on its way to main goes first (see the header).
    get().flushSessionWriteBack(sessionId);
    const slice = get().sessions[sessionId];
    if (slice === undefined) {
      return;
    }
    const comments = commentIds.flatMap((commentId) => {
      const comment = slice.comments.find((candidate) => candidate.id === commentId);
      return comment !== undefined && hasPostable(comment) ? [comment] : [];
    });
    if (comments.length === 0) {
      return;
    }
    const ids = comments.map((comment) => comment.id);
    setPosting(set, get, sessionId, (current) => ({ ...current, busy: true, failure: null }));
    let response: GitHubPostResponse;
    try {
      response = await bridge.postGitHubComments({
        sessionId,
        comments: postRequestComments(comments),
        ...(options.acceptHead === undefined ? {} : { acceptHead: options.acceptHead }),
      });
    } catch (error) {
      console.error("Posting to GitHub failed:", error);
      response = { ok: false, failure: { code: "unexpected" } };
    }
    setPosting(set, get, sessionId, (current) => afterPost(current, ids, response));
  },

  confirmHeadMoved: async (sessionId) => {
    const target = withSlice(get, sessionId, (slice, id) => ({
      question: slice.posting.headMoved,
      id,
    }));
    if (target === undefined || target.question === null) {
      return;
    }
    const { question, id } = target;
    setPosting(set, get, id, (current) => ({ ...current, headMoved: null }));
    await get().postComments(question.ids, { acceptHead: question.head, sessionId: id });
  },

  dismissHeadMoved: (sessionId) => {
    withSlice(get, sessionId, (slice, id) => {
      if (slice.posting.headMoved !== null) {
        setPosting(set, get, id, (current) => ({ ...current, headMoved: null }));
      }
    });
  },

  removePendingComment: async (commentId, sessionId) => {
    const bridge = window.reviewer;
    const target = withSlice(get, sessionId, (slice, id) => ({ slice, id }));
    if (!bridge || target === undefined || target.slice.posting.busy) {
      return;
    }
    const { id } = target;
    setPosting(set, get, id, (current) => ({ ...current, busy: true, failure: null }));
    let response: Awaited<ReturnType<typeof bridge.deleteGitHubPendingComment>>;
    try {
      response = await bridge.deleteGitHubPendingComment({ sessionId: id, commentId });
    } catch (error) {
      console.error("Removing a pending comment failed:", error);
      response = { ok: false, failure: { code: "unexpected" } };
    }
    setPosting(set, get, id, (current) => {
      const outcomes = { ...current.outcomes };
      delete outcomes[commentId];
      return response.ok
        ? { ...current, busy: false, posted: response.value, outcomes }
        : {
            ...current,
            busy: false,
            outcomes: { ...outcomes, [commentId]: { kind: "failed", failure: response.failure } },
          };
    });
    if (!response.ok && response.failure.code === "notPending") {
      // Main found it submitted or gone on GitHub and updated its record; show that.
      await get().refreshPosted(id);
    }
  },

  recheckWithToken: async (owner) => {
    const covered = Object.values(get().sessions).filter((slice) => {
      const pr = slice.reviewOrigin?.pr ?? null;
      return (
        !slice.needsDerive &&
        pr !== null &&
        (owner === null || pr.owner.toLowerCase() === owner.toLowerCase())
      );
    });
    await Promise.all(
      covered.flatMap((slice) => [
        checkGitHubDiff(set, get, slice.id),
        get().refreshPosted(slice.id),
      ]),
    );
  },

  refreshPosted: async (sessionId) => {
    const bridge = window.reviewer;
    const slice = get().sessions[sessionId];
    if (!bridge || slice === undefined || slice.reviewOrigin?.pr == null) {
      return;
    }
    const origin = slice.reviewOrigin;
    let response: Awaited<ReturnType<typeof bridge.getGitHubPosted>>;
    try {
      response = await bridge.getGitHubPosted({ sessionId });
    } catch (error) {
      console.error("Reading what was posted to GitHub failed:", error);
      response = { ok: false, failure: { code: "unexpected" } };
    }
    const current = get().sessions[sessionId];
    // A re-seated session carries a new origin and asks for itself.
    if (current === undefined || current.reviewOrigin !== origin) {
      return;
    }
    // A failed ask keeps the states already on screen — they are still the last word — and says
    // they were not checked just now, rather than presenting them as fact.
    setPosting(set, get, sessionId, (posting) => ({
      ...posting,
      posted: response.ok
        ? response.value
        : { comments: posting.posted?.comments ?? {}, unverified: response.failure },
    }));
  },
});
