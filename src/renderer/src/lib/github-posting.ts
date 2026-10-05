import type { CommitSha } from "../../../shared/git";
import {
  POST_BATCH_MAX,
  postableDigest,
  type GitHubPostedState,
  type GitHubPostFailure,
  type GitHubPostOutcome,
  type GitHubPostResponse,
  type GitHubStatus,
  type GitHubTokenStatus,
  type PostedCommentState,
} from "../../../shared/github-posting";
import { resolutionOf, type CommentResolutions } from "../../../shared/comment-resolution";
import { hasPostable } from "../../../shared/postable-comment";
import type { PullRequest } from "../../../shared/pull-request";
import type { Comment } from "../../../shared/review";
import { githubPostFailureMessage } from "./github-failure-message";
import { outsideGitHubDiff, type GitHubCheckState } from "./github-links";

// The decisions behind posting comments to a pull request (Layer C), as pure functions over the
// session's posting state: which comments may be picked for the batch, what a post's answer does
// to the state, and whether the reader holds a token that covers the pull request. The store
// (`stores/review/posting.ts`) calls these and the bridge; the cards and the rail draw what they
// say. Main decides everything that matters again — this is what the screen offers, not what
// GitHub gets.
//
// **Two ways to post, both a click in the window:** Post on one card, or Post all in the rail.
// Post all sends every comment that can go, less the ones the reader marked `skipped` or
// `disagree` (`postAllBatch`): a mark is how the reader says "not this one", so there is no
// second, posting-only selection to keep in step with it. Every post is a pending draft the
// reader submits on GitHub; nothing here can submit (`main/github/never-submit.test.ts`). A
// comment that cannot go is not offered at all: one with no text for the author, one already
// pending or submitted, and one GitHub's own diff leaves out (B4's answer, when GitHub gave one).

/** One session's posting state. Derived, never persisted — the record of what was posted is
 * main's (`GitHubPostRecord`), re-asked when the session derives. */
export type PostingState = {
  /** Where the comments stand on GitHub as main last said, or null until it has. */
  posted: GitHubPostedState | null;
  /** What the last post or removal came to for each comment it touched, until the next one. */
  outcomes: Readonly<Record<string, GitHubPostOutcome>>;
  /** A post or a removal is on its way — the controls stand down until it answers. */
  busy: boolean;
  /** Waiting on the reader: the pull request moved past the reviewed commit, and posting pins
   * these comments to the reviewed one anyway. */
  headMoved: { head: CommitSha; ids: readonly string[] } | null;
  /** The last failure that stopped a post — before any comment was tried, or partway through
   * (`stoppedBy`), when the comments it did not reach say `skipped`. */
  failure: GitHubPostFailure | null;
  /** Whether `failure` stopped a batch partway rather than before it began. */
  stoppedPartway: boolean;
};

export const NO_POSTING: PostingState = {
  posted: null,
  outcomes: {},
  busy: false,
  headMoved: null,
  failure: null,
  stoppedPartway: false,
};

/** Whether the reader holds a token that covers `pr` — one for its owner (GitHub's names are
 * case-insensitive), or a classic `public_repo` one, which covers every owner. What decides
 * whether Post is drawn at all; main picks the same way (`credentials.ts`'s `authFor`). */
export function tokenCovers(status: GitHubStatus | null, pr: PullRequest | null): boolean {
  if (status === null || pr === null) {
    return false;
  }
  const owner = pr.owner.toLowerCase();
  return status.tokens.some((token) => token.owner === null || token.owner.toLowerCase() === owner);
}

/** Where one comment stands on GitHub, or null for not posted. */
export function postedStateOf(posting: PostingState, commentId: string): PostedCommentState | null {
  return posting.posted?.comments[commentId]?.state ?? null;
}

/** Whether a comment's postable text has been edited since it went to GitHub — which still has
 * the words from before. Known only when the record kept a digest of what went. */
export function editedSincePosted(posting: PostingState, comment: Comment): boolean {
  const posted = posting.posted?.comments[comment.id];
  return (
    posted !== undefined &&
    posted.postable !== null &&
    hasPostable(comment) &&
    postableDigest(comment.postable) !== posted.postable
  );
}

/** Why the posted states on screen were not checked against GitHub just now, or null when they
 * were — or when there is nothing on GitHub to check. */
export function unverifiedReason(posting: PostingState): GitHubPostFailure | null {
  const posted = posting.posted;
  if (posted === null || Object.keys(posted.comments).length === 0) {
    return null;
  }
  return posted.unverified;
}

/** Whether a comment may be picked, or posted on its own: it has text for the author, it is not
 * already on GitHub, and GitHub's diff — when GitHub said — carries its lines. */
export function postable(
  comment: Comment,
  posting: PostingState,
  check: GitHubCheckState | null,
): boolean {
  return (
    hasPostable(comment) &&
    postedStateOf(posting, comment.id) === null &&
    !outsideGitHubDiff(check, comment.id)
  );
}

/** What Post all sends: every comment that may go (`postable`) and that the reader has not
 * marked `skipped` or `disagree`, in the review's own order, up to what one post takes
 * (`POST_BATCH_MAX`) — a longer review takes a second click, which the count on the button
 * shows. `addressed` does not hold a comment back: on someone else's pull request it is the
 * author who addresses it, and the reader marking it so is agreeing with it. */
export function postAllBatch(
  comments: readonly Comment[],
  posting: PostingState,
  check: GitHubCheckState | null,
  resolutions: CommentResolutions,
): Comment[] {
  return comments
    .filter((comment) => {
      const mark = resolutionOf(resolutions, comment);
      return mark !== "skipped" && mark !== "disagree" && postable(comment, posting, check);
    })
    .slice(0, POST_BATCH_MAX);
}

/** What the post request says about each comment: its id and a digest of the text the reader
 * is looking at, which main checks against the text it holds (`shared/github-posting.ts`). */
export function postRequestComments(
  comments: readonly Comment[],
): { id: string; postable: string }[] {
  return comments.flatMap((comment) =>
    hasPostable(comment) ? [{ id: comment.id, postable: postableDigest(comment.postable) }] : [],
  );
}

/** The posting state after a post's answer, for the comments it was about (`ids`):
 *
 * - every comment's outcome recorded for its card, and the posted states replaced by main's;
 * - `headMoved` held for the reader to answer, nothing else changed;
 * - any other failure that stopped the post, kept for the rail and noted on each card asked;
 * - a batch that stopped partway keeps what stopped it for the rail, and the comments it did
 *   not reach carry `skipped` for their cards. */
export function afterPost(
  posting: PostingState,
  ids: readonly string[],
  response: GitHubPostResponse,
): PostingState {
  const settled = { ...posting, busy: false };
  if (!response.ok) {
    if (response.failure.code === "headMoved") {
      return { ...settled, headMoved: { head: response.failure.head, ids }, failure: null };
    }
    const outcomes = { ...posting.outcomes };
    for (const id of ids) {
      outcomes[id] = { kind: "failed", failure: response.failure };
    }
    return {
      ...settled,
      outcomes,
      failure: response.failure,
      stoppedPartway: false,
      headMoved: null,
    };
  }
  return {
    ...settled,
    posted: response.value.state,
    outcomes: { ...posting.outcomes, ...response.value.outcomes },
    failure: response.value.stoppedBy,
    stoppedPartway: response.value.stoppedBy !== null,
    headMoved: null,
  };
}

/** How many comments are pending on GitHub — what "Open on GitHub" is there for. */
export function pendingCount(posting: PostingState): number {
  return Object.values(posting.posted?.comments ?? {}).filter(
    (posted) => posted.state === "pending",
  ).length;
}

/** What a card says about its last post, when that did not post it: `failed` with why, or
 * `skipped` — the batch stopped before it — with what stopped the batch. Null otherwise.
 *
 * **The outcome itself, never a copy.** Cards read this through a store selector, and a selector
 * that built a new object on every call would hand React a new snapshot each render — an update
 * loop that blanks the window. The two outcome shapes are this type's shapes, so the stored
 * object is returned as it is. */
export type CardNote = Extract<GitHubPostOutcome, { kind: "failed" | "skipped" }>;

export function cardNote(posting: PostingState, commentId: string): CardNote | null {
  const outcome = posting.outcomes[commentId];
  switch (outcome?.kind) {
    case "failed":
    case "skipped":
      return outcome;
    case "posted":
    case "alreadyPending":
    case undefined:
      return null;
  }
}

// --- describing a held token (Settings ▸ GitHub) ------------------------------------------

/** Whether Settings ▸ GitHub draws the field a token is typed into: only once main has answered
 * and said this run is not exposed (`exposedBy` empty). While it is — or before it has said — the
 * field is not drawn at all: a token typed into a page a debugger is attached to is read there,
 * before main could refuse it. */
export function tokenFormOffered(status: GitHubStatus | null): boolean {
  return status !== null && status.exposedBy.length === 0;
}

/** A token's kind, as the Settings row names it. */
export function tokenKindLabel(kind: GitHubTokenStatus["kind"]): string {
  switch (kind) {
    case "fineGrained":
      return "Fine-grained";
    case "classic":
      return "Classic, public_repo only";
  }
}

/** Whose pull requests a token posts to: the owner's name, and nothing narrower — a
 * fine-grained token's grant within its owner cannot be read back, so the app claims no more
 * than the owner the reader named. */
export function tokenCoverage(token: Pick<GitHubTokenStatus, "owner">): string {
  return token.owner === null ? "Any public repository" : token.owner;
}

/** The expiry GitHub reported, said as a date — or that it reported none, which is not the same
 * as "never": the header is known to be missing for some tokens that do expire. */
export function tokenExpiryLabel(expiresAt: string | null, now: number): string {
  if (expiresAt === null) {
    return "No expiry reported";
  }
  const at = Date.parse(expiresAt);
  const date = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(at));
  return at <= now ? `Expired ${date}` : `Expires ${date}`;
}

/** The quiet word a card shows for its last post when that did not post it, with the reason for
 * its tooltip — or null. A `lineNotInDiff` failure says nothing when B4's "Not in GitHub's diff"
 * note is already on the card (`outsideNoteShown`): one fact, said once. */
export function cardNoteText(
  note: CardNote | null,
  outsideNoteShown: boolean,
): { label: string; hint: string } | null {
  if (note === null) {
    return null;
  }
  switch (note.kind) {
    case "failed":
      if (note.failure.code === "lineNotInDiff") {
        return outsideNoteShown
          ? null
          : { label: "Not in GitHub's diff", hint: githubPostFailureMessage(note.failure) };
      }
      return { label: "Not posted", hint: githubPostFailureMessage(note.failure) };
    case "skipped":
      return {
        label: "Not posted",
        hint: `The batch stopped before this comment. ${githubPostFailureMessage(note.because)}`,
      };
  }
}
