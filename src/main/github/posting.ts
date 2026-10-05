import { placesOnDiff, remotePath, type RemoteDiffIndex } from "../../shared/diff/remote-diff";
import { commentFingerprint } from "../../shared/fingerprint";
import type { CommitSha } from "../../shared/git";
import type { GitHubFailure } from "../../shared/github-ipc";
import {
  POSTED_BODY_MAX,
  postableDigest,
  type GitHubDeletePendingRequest,
  type GitHubDeletePendingResponse,
  type GitHubPostedResponse,
  type GitHubPostedState,
  type GitHubPostFailure,
  type GitHubPostOutcome,
  type GitHubPostRecord,
  type GitHubPostRequest,
  type GitHubPostResponse,
} from "../../shared/github-posting";
import { hasPostable, postableComment } from "../../shared/postable-comment";
import { pullRequestLabel, samePullRequest, type PullRequest } from "../../shared/pull-request";
import type { Comment } from "../../shared/review";
import type { Session } from "../../shared/session";
import { createKeyedQueue } from "../pull-request/queue";
import type { GitHubAuth, GitHubClient } from "./client";
import type { CredentialVault } from "./credentials";
import type { DiffChecker } from "./diff-check";
import {
  addPendingThread,
  commentState,
  deletePendingComment,
  findPendingReview,
  postedReviews,
  startPendingReview,
  type DiffSide,
  type PendingComment,
  type PendingReview,
} from "./graphql";
import type { PullRequestReader } from "./rest";

// Layer C (`next-features.md`, C3): a review's comments posted to its pull request as *pending*
// review comments — drafts only the reader sees, until the reader submits the review on GitHub.
// Never submitted from here: the documents this sends are `graphql-documents.ts`, and
// `never-submit.test.ts` holds that file to the three mutations that cannot publish anything.
//
// **What is posted is main's, not the message's.** A request names a session and comment ids,
// plus a digest of the postable text the reader was shown. The body is built here, from the
// session main persists, with the one function Copy uses (`postableComment`): references as blob
// links at the reviewed commit, evidence only when the reader's setting says so. The digest is
// how an edit still on its way through the renderer's write-back is caught — the renderer sends
// the write-back first and this second, so the edit has landed by the time this reads it; if a
// digest still disagrees, nothing is posted (`changedSinceShown`) rather than the words before
// the edit.
//
// **The order, and why it is this one.**
//
//   1. The credential for the pull request's owner (`credentials.ts`), or `noToken`.
//   2. The pull request read *fresh* with it. A head that is not the reviewed commit answers
//      `headMoved` and posts nothing; the renderer asks the reader, and a confirmed request names
//      the head it accepted. The comments still pin to the reviewed commit, and GitHub shows them
//      as outdated against the newer one.
//   3. GitHub's own diff at the reviewed commit, with the token (so a private repository is
//      checked too): a comment whose lines are not in one of its hunks is refused before any
//      write (`lineNotInDiff`) — the selection already leaves these out when B4 knew, and this is
//      the check that does not depend on the renderer having asked. Its paths are the ones posted
//      under (a renamed file's new name), and its deletions and renames decide which references
//      in the body cannot be blob links.
//   4. The reader's pending review, filtered on `viewerDidAuthor`. One begun at another commit,
//      or more than one, is `pendingReviewConflict`: its lines are numbered against a different
//      diff, so a thread added to it would land on the wrong line. One holding more comments than
//      are read back (a hundred) is `pendingReviewFull`: what is already in it could not be
//      checked, so nothing is added — every read-back below is therefore of the whole review.
//   5. The duplicate check (below).
//   6. A pending review started if there is none (no state given — that is what keeps it
//      pending), then one thread per comment, a second apart (`PACE_MS`: GitHub's secondary
//      limit on creating content is about eighty a minute), each recorded the moment GitHub
//      accepts it. Bodies past GitHub's 65,536 characters are refused at step 3, before any write.
//
// Before any of it, two refusals that need no network: an app started with a switch that exposes
// it (`exposure.ts`, `debuggingEnabled`), and a progress record on disk this build cannot read
// (`recordUnreadable`) — posting would have to write over it, and it is what prevents duplicates.
//
// **A second click never makes a second comment.** Three things stand between a comment and its
// duplicate. Every operation on one pull request runs one at a time (`queue`), so two clicks in
// quick succession are two batches in order and the second sees the first's record. The record
// (`GitHubPostRecord`, in the review's progress file) holds each posted comment's node id, written
// after *each* thread rather than at the end, so a batch that fails halfway keeps what it did.
// And before posting, each comment is looked for in the pending review itself — by its recorded
// id, and failing that by its path, lines, side and exact text — which is what catches a thread
// GitHub added whose answer never arrived. Lines are compared as GitHub numbered them against the
// review's own commit (`original*`), never against the pull request's head now, which moves.
//
// **A record pointing at another review is asked about, not trusted or ignored.** A comment
// recorded as pending in a review that is not the reader's pending review now was either
// submitted on GitHub (it is published — refused, `alreadySubmitted`, and marked so), discarded
// (GitHub says `NOT_FOUND` for it — the entry is dropped and the comment posted), or, oddly, still
// pending (left alone). If GitHub cannot be asked, or answers anything else, the comment is not
// posted: a draft beside a published copy is the one outcome this must never produce.
//
// **A review submitted mid-batch.** Each added thread's comment comes back with its `state`. One
// that is not a draft means the reader submitted the review on GitHub between the lookup and the
// add: it is recorded as submitted, reported (`submittedMeanwhile`), and the batch stops. The
// residue: that one comment went out with the submitted review — GitHub took it as part of it —
// and nothing on this side can stop a submission that happens in the moment between.
// `UNPROCESSABLE` on an add (which a review no longer pending can answer) also stops the batch,
// so it cannot hide a submission behind "try the next one".
//
// **A finding re-emitted under a new anchor** has a new fingerprint, so its old entry is orphaned
// and the record says nothing about it. What still holds: the text match against the reader's
// pending review, which finds it if it is there. A copy that went out with a submitted review is
// not found that way — posting it again makes a new *draft*, visible to the reader alone until
// they submit, never a second published comment.
//
// **A write whose answer never arrived may still have happened** (`client.ts` says why). A
// `timeout`, `network`, 5xx or unreadable answer to a write is never taken to mean "not posted":
// the pending review is read back and searched for the comment by path, lines and text before
// the outcome is decided, and the batch stops there — the next attempt starts by reading the
// pending review again. If even that read fails, the comment reports the failure, and the next
// post finds it by its text if it did land.
//
// **Errors as codes.** GitHub's messages never reach a failure; `graphql.ts` maps its errors by
// type. A 401 from a token whose reported expiry has passed is `tokenExpired`; any other 401 is
// `unauthorized` (a revoked token). A batch that stops partway answers which failure stopped it
// (`stoppedBy`), and each comment it did not reach says so (`skipped`, `because`).

/** How far apart thread mutations are sent: GitHub's secondary rate limit on creating content is
 * about eighty requests a minute, and a review's worth of comments sent back to back can trip it. */
export const PACE_MS = 1000;

/** The record as read: none yet, one, or one on disk this build cannot read. */
export type StoredRecord = { ok: true; record: GitHubPostRecord | null } | { ok: false };

export type PostingDeps = {
  client: GitHubClient;
  vault: CredentialVault;
  readPullRequest: PullRequestReader;
  indexAt: DiffChecker["indexAt"];
  /** The session main persists — the source of every body posted. */
  findSession: (id: string) => Session | undefined;
  /** The review's progress record's `github` key (`main/review/progress.ts`). `write` answers
   * false, and writes nothing, over a record it cannot read. */
  records: {
    read: (artifactPath: string) => Promise<StoredRecord>;
    write: (artifactPath: string, record: GitHubPostRecord) => Promise<boolean>;
  };
  /** The reader's `postableIncludesEvidence`, read at the moment of posting. */
  includeEvidence: () => boolean;
  /** The switches that expose this run (`exposure.ts`); any at all refuses posting and removal. */
  exposedBy: () => readonly string[];
  /** Waits between thread mutations (`PACE_MS`); the tests pass one that does not wait. */
  pause?: (ms: number) => Promise<void>;
  now?: () => number;
};

export type Poster = {
  post: (request: GitHubPostRequest) => Promise<GitHubPostResponse>;
  posted: (sessionId: string) => Promise<GitHubPostedResponse>;
  remove: (request: GitHubDeletePendingRequest) => Promise<GitHubDeletePendingResponse>;
};

/** A review of a pull request, as posting needs it. */
type PostableReview = {
  session: Session;
  pr: PullRequest;
  reviewedHead: CommitSha;
  artifactPath: string;
};

function reviewOf(
  session: Session | undefined,
): { ok: true; review: PostableReview } | { ok: false; failure: GitHubPostFailure } {
  const pr = session?.reviewOrigin?.pr ?? null;
  const reviewedHead = session?.reviewOrigin?.reviewedHead ?? null;
  if (session === undefined || pr === null || reviewedHead === null) {
    return { ok: false, failure: { code: "notPullRequest" } };
  }
  if (session.reviewPath === null) {
    return { ok: false, failure: { code: "noRecord" } };
  }
  return { ok: true, review: { session, pr, reviewedHead, artifactPath: session.reviewPath } };
}

/** The record if it is about this pull request at this reviewed commit, else an empty one — a
 * record left from another pull request or another commit is not this review's. */
export function recordFor(
  stored: GitHubPostRecord | null,
  pr: PullRequest,
  reviewedHead: CommitSha,
): GitHubPostRecord {
  return stored !== null &&
    samePullRequest(stored.pullRequest, pr) &&
    stored.reviewedHead === reviewedHead
    ? { ...stored, comments: { ...stored.comments } }
    : { pullRequest: pr, reviewedHead, comments: {} };
}

/** The session's comments' posted states, from a record. */
export function postedStateOf(
  comments: readonly Comment[],
  record: GitHubPostRecord,
  unverified: GitHubPostFailure | null,
): GitHubPostedState {
  const states: GitHubPostedState["comments"] = {};
  for (const comment of comments) {
    const entry = record.comments[commentFingerprint(comment)];
    if (entry !== undefined) {
      states[comment.id] = { state: entry.state, postable: entry.postable };
    }
  }
  return { comments: states, unverified };
}

/** A failure whose request may have reached GitHub and been applied, its answer lost. */
function uncertain(failure: GitHubPostFailure): boolean {
  return (
    failure.code === "timeout" ||
    failure.code === "network" ||
    failure.code === "unavailable" ||
    failure.code === "badResponse"
  );
}

/** GitHub's text, compared the way it may have stored it: line endings normalised, trailing
 * whitespace dropped. */
function sameText(a: string, b: string): boolean {
  const normal = (text: string): string => text.replaceAll("\r\n", "\n").trimEnd();
  return normal(a) === normal(b);
}

/** One comment, ready to post. */
export type Planned = {
  comment: Comment;
  fingerprint: string;
  path: string;
  side: DiffSide;
  body: string;
  /** `postableDigest` of the comment's postable text, for the record. */
  digest: string;
};

/** Whether a comment already in the pending review is this one: same path, same lines against the
 * review's commit, same side — where GitHub said which, from the comment's thread — and the same
 * text. How a thread whose answer was lost is recognised (the header). */
export function isSameComment(pending: PendingComment, planned: Planned): boolean {
  const { startLine, endLine } = planned.comment;
  const range = startLine !== endLine;
  return (
    pending.path === planned.path &&
    pending.line === endLine &&
    (pending.startLine ?? pending.line) === startLine &&
    (pending.side === null || pending.side === planned.side) &&
    (!range || pending.startSide === null || pending.startSide === planned.side) &&
    sameText(pending.body, planned.body)
  );
}

function sideOf(comment: Comment): DiffSide {
  switch (comment.side) {
    case "additions":
      return "RIGHT";
    case "deletions":
      return "LEFT";
  }
}

const waitFor = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

export function createPoster(deps: PostingDeps): Poster {
  const now = deps.now ?? Date.now;
  const pause = deps.pause ?? waitFor;
  // Every operation on one pull request, one at a time: see the header.
  const queue = createKeyedQueue();
  const keyOf = (pr: PullRequest): string => pullRequestLabel(pr).toLowerCase();

  /** `failure`, with a 401 read as an expired token when the token's reported expiry passed. */
  const explained = (failure: GitHubFailure, auth: GitHubAuth): GitHubPostFailure =>
    failure.code === "unauthorized" && deps.vault.expired(auth, now())
      ? { code: "tokenExpired" }
      : failure;

  const fail = (failure: GitHubPostFailure): { ok: false; failure: GitHubPostFailure } => ({
    ok: false,
    failure,
  });

  /** Plan each chosen comment against GitHub's diff at the reviewed commit, or decide it here. */
  const plan = (
    review: PostableReview,
    chosen: readonly Comment[],
    index: RemoteDiffIndex,
    record: GitHubPostRecord,
    outcomes: Record<string, GitHubPostOutcome>,
  ): Planned[] => {
    const options = {
      includeEvidence: deps.includeEvidence(),
      references: {
        kind: "github" as const,
        owner: review.pr.owner,
        repo: review.pr.repo,
        sha: review.reviewedHead,
        absentAtHead: index.absentAtHead,
      },
    };
    const planned: Planned[] = [];
    for (const comment of chosen) {
      const fingerprint = commentFingerprint(comment);
      if (record.comments[fingerprint]?.state === "submitted") {
        outcomes[comment.id] = { kind: "failed", failure: { code: "alreadySubmitted" } };
        continue;
      }
      const path = remotePath(comment, index);
      const body = postableComment(comment, options);
      if (path === null || !placesOnDiff(comment, index.geometry)) {
        outcomes[comment.id] = { kind: "failed", failure: { code: "lineNotInDiff" } };
        continue;
      }
      if (body === null || !hasPostable(comment)) {
        outcomes[comment.id] = { kind: "failed", failure: { code: "notPostable" } };
        continue;
      }
      if (body.length > POSTED_BODY_MAX) {
        outcomes[comment.id] = { kind: "failed", failure: { code: "bodyTooLong" } };
        continue;
      }
      planned.push({
        comment,
        fingerprint,
        path,
        side: sideOf(comment),
        body,
        digest: postableDigest(comment.postable),
      });
    }
    return planned;
  };

  const post = (request: GitHubPostRequest): Promise<GitHubPostResponse> => {
    const found = reviewOf(deps.findSession(request.sessionId));
    if (!found.ok) {
      return Promise.resolve(found);
    }
    const { pr } = found.review;
    return queue([keyOf(pr)], () => postLocked(request));
  };

  const postLocked = async (request: GitHubPostRequest): Promise<GitHubPostResponse> => {
    // Read again inside the queue: an earlier batch, or a write-back, may have landed meanwhile.
    const found = reviewOf(deps.findSession(request.sessionId));
    if (!found.ok) {
      return found;
    }
    const review = found.review;
    const { session, pr, reviewedHead, artifactPath } = review;
    if (deps.exposedBy().length > 0) {
      return fail({ code: "debuggingEnabled" });
    }

    const chosen: Comment[] = [];
    for (const asked of request.comments) {
      const comment = session.comments.find((candidate) => candidate.id === asked.id);
      if (comment === undefined || !hasPostable(comment)) {
        return fail({ code: "notPostable" });
      }
      if (postableDigest(comment.postable) !== asked.postable) {
        return fail({ code: "changedSinceShown" });
      }
      if (!chosen.includes(comment)) {
        chosen.push(comment);
      }
    }

    const stored = await deps.records.read(artifactPath);
    if (!stored.ok) {
      return fail({ code: "recordUnreadable" });
    }

    const auth = deps.vault.authFor(pr.owner);
    if (auth === null) {
      return fail({ code: "noToken" });
    }

    const info = await deps.readPullRequest(pr, { fresh: true, auth });
    if (!info.ok) {
      return fail(explained(info.failure, auth));
    }
    if (info.value.head !== reviewedHead && request.acceptHead !== info.value.head) {
      return fail({ code: "headMoved", head: info.value.head });
    }

    const index = await deps.indexAt(pr, reviewedHead, info.value.baseSha, auth);
    if (!index.ok) {
      return fail(explained(index.failure, auth));
    }

    const record = recordFor(stored.record, pr, reviewedHead);
    const before = JSON.stringify(record);
    const outcomes: Record<string, GitHubPostOutcome> = {};
    const planned = plan(review, chosen, index.value, record, outcomes);

    const finish = async (stoppedBy: GitHubPostFailure | null): Promise<GitHubPostResponse> => {
      if (JSON.stringify(record) !== before) {
        await deps.records.write(artifactPath, record);
      }
      return {
        ok: true,
        value: { outcomes, state: postedStateOf(session.comments, record, null), stoppedBy },
      };
    };

    if (planned.length === 0) {
      return finish(null);
    }

    const lookup = await findPendingReview(deps.client, auth, pr, now());
    if (!lookup.ok) {
      return fail(explained(lookup.failure, auth));
    }
    const [first, ...others] = lookup.value.mine;
    if (others.length > 0 || (first !== undefined && first.commit !== reviewedHead)) {
      return fail({ code: "pendingReviewConflict" });
    }
    if (first !== undefined && !first.complete) {
      return fail({ code: "pendingReviewFull" });
    }
    let pending: PendingReview | null = first ?? null;

    // Comments recorded as pending in some other review: ask GitHub what became of it.
    const pendingId = pending?.id ?? null;
    const elsewhere = planned.filter((item) => {
      const recorded = record.comments[item.fingerprint];
      return recorded?.state === "pending" && recorded.reviewId !== pendingId;
    });
    const settled = new Set<Planned>();
    if (elsewhere.length > 0) {
      const ids = [
        ...new Set(elsewhere.map((item) => record.comments[item.fingerprint]?.reviewId ?? "")),
      ];
      const reviews = await postedReviews(deps.client, auth, ids, now());
      for (const item of elsewhere) {
        const recorded = record.comments[item.fingerprint];
        const answer = reviews.ok ? reviews.value.get(recorded?.reviewId ?? "") : undefined;
        if (recorded === undefined || !reviews.ok || answer === undefined) {
          // Unverifiable: not posted — a published copy may already be out.
          outcomes[item.comment.id] = {
            kind: "failed",
            failure: reviews.ok
              ? { code: "badResponse", status: null }
              : explained(reviews.failure, auth),
          };
          settled.add(item);
          continue;
        }
        switch (answer.kind) {
          case "gone":
            delete record.comments[item.fingerprint];
            break;
          case "submitted":
            record.comments[item.fingerprint] = { ...recorded, state: "submitted" };
            outcomes[item.comment.id] = { kind: "failed", failure: { code: "alreadySubmitted" } };
            settled.add(item);
            break;
          case "pending":
            outcomes[item.comment.id] = { kind: "alreadyPending" };
            settled.add(item);
            break;
        }
      }
    }

    const toPost: Planned[] = [];
    for (const item of planned) {
      if (settled.has(item)) {
        continue;
      }
      const recorded = record.comments[item.fingerprint];
      if (pending !== null) {
        const inReview = pending;
        if (recorded !== undefined && recorded.reviewId === inReview.id) {
          if (inReview.comments.some((candidate) => candidate.id === recorded.commentId)) {
            outcomes[item.comment.id] = { kind: "alreadyPending" };
            continue;
          }
          // Read whole (`pendingReviewFull` above) and not there: deleted on GitHub.
          delete record.comments[item.fingerprint];
        }
        const match = inReview.comments.find((candidate) => isSameComment(candidate, item));
        if (match !== undefined) {
          record.comments[item.fingerprint] = {
            reviewId: inReview.id,
            threadId: null,
            commentId: match.id,
            state: "pending",
            postable: item.digest,
          };
          outcomes[item.comment.id] = { kind: "alreadyPending" };
          continue;
        }
      }
      toPost.push(item);
    }
    if (toPost.length === 0) {
      return finish(null);
    }

    /** The pending review read back whole, for deciding what a lost answer did — or null when it
     * cannot be (not one review of the reader's at the reviewed commit, or past what is read). */
    const readBack = async (): Promise<PendingReview | null> => {
      const again = await findPendingReview(deps.client, auth, pr, now());
      if (!again.ok || again.value.mine.length !== 1) {
        return null;
      }
      const mine = again.value.mine[0] ?? null;
      return mine !== null && mine.commit === reviewedHead && mine.complete ? mine : null;
    };

    if (pending === null) {
      const started = await startPendingReview(
        deps.client,
        auth,
        lookup.value.pullRequestId,
        reviewedHead,
        now(),
      );
      if (started.ok) {
        pending = { id: started.value, commit: reviewedHead, comments: [], complete: true };
      } else {
        const failure = explained(started.failure, auth);
        // Started, with the answer lost? GitHub allows one pending review per reader, so the one
        // read back is it.
        pending = uncertain(failure) ? await readBack() : null;
        if (pending === null) {
          await finish(null);
          return fail(failure);
        }
      }
    }
    const reviewId = pending.id;

    let stoppedBy: GitHubPostFailure | null = null;
    for (const [position, item] of toPost.entries()) {
      if (stoppedBy !== null) {
        outcomes[item.comment.id] = { kind: "skipped", because: stoppedBy };
        continue;
      }
      if (position > 0) {
        await pause(PACE_MS);
      }
      const added = await addPendingThread(
        deps.client,
        auth,
        {
          reviewId,
          path: item.path,
          side: item.side,
          startLine: item.comment.startLine,
          endLine: item.comment.endLine,
          body: item.body,
        },
        now(),
      );
      if (added.ok) {
        if (added.value.kind === "notInDiff") {
          outcomes[item.comment.id] = { kind: "failed", failure: { code: "lineNotInDiff" } };
          continue;
        }
        record.comments[item.fingerprint] = {
          reviewId,
          threadId: added.value.threadId,
          commentId: added.value.commentId,
          state: added.value.pending ? "pending" : "submitted",
          postable: item.digest,
        };
        // Written now, not at the end: a failure later in the batch must not lose this one.
        await deps.records.write(artifactPath, record);
        if (added.value.pending) {
          outcomes[item.comment.id] = { kind: "posted" };
        } else {
          stoppedBy = { code: "submittedMeanwhile" };
          outcomes[item.comment.id] = { kind: "failed", failure: stoppedBy };
        }
        continue;
      }
      const failure = explained(added.failure, auth);
      if (uncertain(failure)) {
        const after = await readBack();
        const landed =
          after?.id === reviewId
            ? after.comments.find((candidate) => isSameComment(candidate, item))
            : undefined;
        if (landed === undefined) {
          outcomes[item.comment.id] = { kind: "failed", failure };
        } else {
          record.comments[item.fingerprint] = {
            reviewId,
            threadId: null,
            commentId: landed.id,
            state: "pending",
            postable: item.digest,
          };
          await deps.records.write(artifactPath, record);
          outcomes[item.comment.id] = { kind: "posted" };
        }
        // The connection just failed once; the next attempt starts from a fresh read.
        stoppedBy = failure;
        continue;
      }
      outcomes[item.comment.id] = { kind: "failed", failure };
      // Only a line outside the diff is about this one comment. Everything else — including
      // `unprocessable`, which a review no longer pending can answer — stops the batch.
      if (failure.code !== "lineNotInDiff") {
        stoppedBy = failure;
      }
    }
    return finish(stoppedBy);
  };

  const posted = (sessionId: string): Promise<GitHubPostedResponse> => {
    const found = reviewOf(deps.findSession(sessionId));
    if (!found.ok) {
      // Not a review of a pull request: nothing is posted, and there is nothing to check.
      return Promise.resolve({ ok: true, value: { comments: {}, unverified: null } });
    }
    const { pr } = found.review;
    return queue([keyOf(pr)], async () => {
      const again = reviewOf(deps.findSession(sessionId));
      if (!again.ok) {
        return { ok: true, value: { comments: {}, unverified: null } };
      }
      const { session, reviewedHead, artifactPath } = again.review;
      const stored = await deps.records.read(artifactPath);
      if (!stored.ok) {
        return { ok: true, value: { comments: {}, unverified: { code: "recordUnreadable" } } };
      }
      const record = recordFor(stored.record, pr, reviewedHead);
      const reviewIds = [
        ...new Set(
          Object.values(record.comments).flatMap((entry) =>
            entry.state === "pending" ? [entry.reviewId] : [],
          ),
        ),
      ];
      if (reviewIds.length === 0) {
        return { ok: true, value: postedStateOf(session.comments, record, null) };
      }
      const auth = deps.vault.authFor(pr.owner);
      if (auth === null) {
        return { ok: true, value: postedStateOf(session.comments, record, { code: "noToken" }) };
      }
      const reviews = await postedReviews(deps.client, auth, reviewIds, now());
      if (!reviews.ok) {
        return {
          ok: true,
          value: postedStateOf(session.comments, record, explained(reviews.failure, auth)),
        };
      }
      const before = JSON.stringify(record);
      for (const [fingerprint, entry] of Object.entries(record.comments)) {
        if (entry.state !== "pending") {
          continue;
        }
        const review = reviews.value.get(entry.reviewId);
        if (review === undefined) {
          continue;
        }
        switch (review.kind) {
          case "gone":
            // Discarded on GitHub — `NOT_FOUND` for it, nothing less: not posted any more.
            delete record.comments[fingerprint];
            break;
          case "submitted":
            record.comments[fingerprint] = { ...entry, state: "submitted" };
            break;
          case "pending":
            // Deleted from the pending review on GitHub — but only when the list was read whole.
            if (review.complete && !review.commentIds.has(entry.commentId)) {
              delete record.comments[fingerprint];
            }
            break;
        }
      }
      if (JSON.stringify(record) !== before) {
        await deps.records.write(artifactPath, record);
      }
      return { ok: true, value: postedStateOf(session.comments, record, null) };
    });
  };

  const remove = (request: GitHubDeletePendingRequest): Promise<GitHubDeletePendingResponse> => {
    const found = reviewOf(deps.findSession(request.sessionId));
    if (!found.ok) {
      return Promise.resolve(found);
    }
    const { pr } = found.review;
    return queue([keyOf(pr)], async () => {
      const again = reviewOf(deps.findSession(request.sessionId));
      if (!again.ok) {
        return again;
      }
      if (deps.exposedBy().length > 0) {
        return fail({ code: "debuggingEnabled" });
      }
      const { session, reviewedHead, artifactPath } = again.review;
      const comment = session.comments.find((candidate) => candidate.id === request.commentId);
      const stored = await deps.records.read(artifactPath);
      if (!stored.ok) {
        return fail({ code: "recordUnreadable" });
      }
      const record = recordFor(stored.record, pr, reviewedHead);
      const fingerprint = comment === undefined ? null : commentFingerprint(comment);
      const entry = fingerprint === null ? undefined : record.comments[fingerprint];
      if (fingerprint === null || entry === undefined || entry.state !== "pending") {
        return fail({ code: "notPending" });
      }
      const auth = deps.vault.authFor(pr.owner);
      if (auth === null) {
        return fail({ code: "noToken" });
      }
      // Only a pending draft of the reader's is ever deleted, and the record cannot vouch for
      // that on its own: the review may have been submitted on GitHub since.
      const state = await commentState(deps.client, auth, entry.commentId, now());
      if (!state.ok) {
        return fail(explained(state.failure, auth));
      }
      switch (state.value) {
        case "gone":
          break;
        case "notPendingMine":
          record.comments[fingerprint] = { ...entry, state: "submitted" };
          await deps.records.write(artifactPath, record);
          return fail({ code: "notPending" });
        case "pendingMine": {
          const deleted = await deletePendingComment(deps.client, auth, entry.commentId, now());
          if (!deleted.ok) {
            return fail(explained(deleted.failure, auth));
          }
          break;
        }
      }
      delete record.comments[fingerprint];
      await deps.records.write(artifactPath, record);
      return { ok: true, value: postedStateOf(session.comments, record, null) };
    });
  };

  return { post, posted, remove };
}
