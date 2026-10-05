// Every GraphQL document the app sends to GitHub, and nothing else (`next-features.md`, C3/C4).
//
// They live alone in this file so that what the app can ask GitHub to *do* is one short list a
// person — or a test — can read whole. `never-submit.test.ts` reads this file and holds it to
// exactly three mutations: start a pending review, add a thread to it, delete a pending comment.
// None of them can publish anything. A review becomes visible to anyone but the reader only when
// the reader presses Submit on GitHub; the mutation that would do it from here is not in this
// file, and the test fails the build if it ever is. `graphql.ts` accepts only these constants as
// a document (`GraphqlDocument`), so a query written inline anywhere else is a type error.
//
// Field names are checked against GitHub's published schema (`@octokit/graphql-schema` 15.26.1):
// `AddPullRequestReviewInput`, `AddPullRequestReviewThreadInput`,
// `DeletePullRequestReviewCommentInput`, `PullRequestReview.comments`/`commit`/`viewerDidAuthor`,
// `PullRequestReviewComment.state`.
//
// Two shapes worth knowing:
//
//   - Starting a pending review names the pull request and the reviewed commit (`commitOID`) and
//     nothing else. Leaving the review's state out is what makes it pending.
//   - A thread's `startLine`/`startSide` are variables a single-line comment does not provide.
//     GraphQL treats an input field whose variable was not provided as absent (not null), which
//     is exactly "a single line" to `addPullRequestReviewThread`.

/** The pull request's node id, and the reader's pending review on it with the comments already
 * in it (C3 step 1). `reviews(states: [PENDING])` is filtered on `viewerDidAuthor` by the caller
 * as well: GitHub documents that a pending review is visible only to its author, but that this
 * list holds only the viewer's is inferred, not documented. A hundred comments is the most read
 * back; a pending review holding more is refused (`hasNextPage`), never guessed about.
 *
 * Each comment's lines are read as `original*` too: `line`/`startLine` are numbered against the
 * pull request's head *now*, and the original ones against the commit the review was started at —
 * the reviewed commit, which is what a comment posted from here is numbered against. The side of
 * the diff is not on a comment at all, only on its thread, so the newest hundred threads are read
 * for their sides, matched to comments by the thread's first comment. */
const PENDING_REVIEW = `query PendingReview($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      id
      reviews(states: [PENDING], first: 10) {
        nodes {
          id
          viewerDidAuthor
          commit { oid }
          comments(first: 100) {
            pageInfo { hasNextPage }
            nodes { id path line originalLine startLine originalStartLine body }
          }
        }
      }
      reviewThreads(last: 100) {
        nodes { diffSide startDiffSide comments(first: 1) { nodes { id } } }
      }
    }
  }
}`;

/** Start the reader's pending review at the reviewed commit (C3 step 2). */
const START_PENDING_REVIEW = `mutation StartPendingReview($pullRequestId: ID!, $commitOID: GitObjectID!) {
  addPullRequestReview(input: { pullRequestId: $pullRequestId, commitOID: $commitOID }) {
    pullRequestReview { id }
  }
}`;

/** Add one comment to the pending review as a line thread (C3 step 3) — to the *review*, by
 * `pullRequestReviewId`, never to the pull request by `pullRequestId`, which GitHub can take as a
 * comment to publish on its own. GitHub answers `thread: null`, often with no error, when the line
 * is not in its diff. The new comment's `state` comes back so a review submitted on GitHub between
 * the lookup and this call is noticed (`SUBMITTED`) rather than recorded as a draft. */
const ADD_PENDING_THREAD = `mutation AddPendingThread($reviewId: ID!, $path: String!, $line: Int!, $side: DiffSide!, $startLine: Int, $startSide: DiffSide, $body: String!) {
  addPullRequestReviewThread(input: { pullRequestReviewId: $reviewId, path: $path, line: $line, side: $side, startLine: $startLine, startSide: $startSide, body: $body, subjectType: LINE }) {
    thread { id comments(first: 1) { nodes { id state } } }
  }
}`;

/** One comment's state, before it is deleted: only a pending draft the reader wrote is ever
 * deleted, and the record alone cannot vouch for that — the reader may have submitted the review
 * on GitHub since. */
const COMMENT_STATE = `query CommentState($id: ID!) {
  node(id: $id) {
    ... on PullRequestReviewComment { id state viewerDidAuthor }
  }
}`;

/** Remove one pending draft (C3 step 6). */
const DELETE_PENDING_COMMENT = `mutation DeletePendingComment($id: ID!) {
  deletePullRequestReviewComment(input: { id: $id }) {
    pullRequestReviewComment { id }
  }
}`;

/** The reviews the app posted into, re-read on open (C3 step 5): gone (null — discarded on
 * GitHub), still pending with these comments, or submitted. One request for all of them. */
const POSTED_REVIEWS = `query PostedReviews($ids: [ID!]!) {
  nodes(ids: $ids) {
    ... on PullRequestReview {
      id
      state
      comments(first: 100) {
        pageInfo { hasNextPage }
        nodes { id }
      }
    }
  }
}`;

export const GRAPHQL = {
  PENDING_REVIEW,
  START_PENDING_REVIEW,
  ADD_PENDING_THREAD,
  COMMENT_STATE,
  DELETE_PENDING_COMMENT,
  POSTED_REVIEWS,
} as const;

/** A document the app may send: one of the constants above, and no other string. */
export type GraphqlDocument = (typeof GRAPHQL)[keyof typeof GRAPHQL];
