import * as z from "zod";
import type { CommitSha } from "../../shared/git";
import type { GitHubFailure, GitHubResult } from "../../shared/github-ipc";
import { GitHubNodeId } from "../../shared/github-posting";
import type { PullRequest } from "../../shared/pull-request";
import { authKind, type GitHubAuth, type GitHubClient } from "./client";
import { GRAPHQL, type GraphqlDocument } from "./graphql-documents";

// Layer C's GraphQL, as typed operations: each one a document from `graphql-documents.ts`, its
// variables, and a zod schema for the `data` it answers — through the client's one POST
// (`client.ts`'s `graphql`: the allowlist, the timeout, the cap, the typed failures).
//
// **GraphQL fails twice.** Once as HTTP (a 401, a 403, a 5xx — `client.ts` maps those), and again
// inside a 200: an `errors` array beside — or instead of — the `data`. Those are mapped here by
// their `type` (`NOT_FOUND`, `FORBIDDEN`, `RATE_LIMITED`, …), never by their `message`: the message
// is GitHub's prose, it changes, and it never reaches a failure (`client.ts`'s rule). An error of a
// type this file does not know is `badResponse`.
//
// **A null is an answer only when GitHub says why.** `nodes(ids:)` answers null *and* a
// `NOT_FOUND` error, at that node's path, for a review that was discarded on GitHub; that is the
// fact the reconcile is looking for. But a node is also null beside a `FORBIDDEN` — a token the
// organisation has not approved, single sign-on not authorised for it, another account's token —
// and that says nothing about whether the review exists. Reading every null as "gone" would wipe
// the record of drafts that are still on GitHub, and a later Remove would forget one it never
// deleted. So a null node is "gone" only when an error *at its own path* says `NOT_FOUND`
// (`notFoundAt`); any other null is a failure, and the states it would have changed stay as they
// were, marked unverified.

/** The `errors` GitHub puts in a 200: `type`, and `path` — which field the error is about. */
const RawErrors = z
  .array(
    z
      .object({
        type: z.string().max(64).optional(),
        path: z
          .array(z.union([z.string().max(128), z.int()]))
          .max(16)
          .optional(),
      })
      .loose(),
  )
  .max(100)
  .optional();

const RawEnvelope = z.object({ data: z.unknown().optional(), errors: RawErrors }).loose();

/** One error, as much as is read of it. */
export type GraphqlError = { type: string; path: readonly (string | number)[] };

/** What a GraphQL call came back with: the data, parsed (null when GitHub sent none), and the
 * errors beside it. */
export type GraphqlAnswer<T> = { data: T | null; errors: GraphqlError[] };

/** The failure an `errors` array stands for, by the first error's `type`. A rate limit inside a
 * 200 names no reset, so it is the client's unspecified minute. */
export function failureForErrors(
  errors: readonly Pick<GraphqlError, "type">[],
  auth: GitHubAuth,
  now: number,
): GitHubFailure {
  switch (errors[0]?.type) {
    case "NOT_FOUND":
      return { code: "notFound" };
    case "FORBIDDEN":
    case "INSUFFICIENT_SCOPES":
      return { code: "forbidden" };
    case "RATE_LIMITED":
      return { code: "rateLimited", resetAt: now + 60_000, scope: authKind(auth) };
    case "UNPROCESSABLE":
      return { code: "unprocessable" };
    default:
      return { code: "badResponse", status: null };
  }
}

/** The errors about one field, by its path (`["nodes", 2]`, `["node"]`). */
function errorsAt(
  errors: readonly GraphqlError[],
  path: readonly (string | number)[],
): GraphqlError[] {
  return errors.filter(
    (error) =>
      error.path.length === path.length && error.path.every((part, index) => part === path[index]),
  );
}

/** Whether GitHub said, at this very path, that what was asked for is not there. */
export function notFoundAt(
  errors: readonly GraphqlError[],
  path: readonly (string | number)[],
): boolean {
  const here = errorsAt(errors, path);
  return here.length > 0 && here.every((error) => error.type === "NOT_FOUND");
}

/** Run one document. `schema` parses `data`; data that does not parse is `badResponse`. */
export async function runGraphql<T>(
  client: GitHubClient,
  auth: GitHubAuth,
  document: GraphqlDocument,
  variables: Readonly<Record<string, unknown>>,
  schema: z.ZodType<T>,
): Promise<GitHubResult<GraphqlAnswer<T>>> {
  const body = await client.graphql(auth, document, variables);
  if (!body.ok) {
    return body;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(body.value);
  } catch {
    return { ok: false, failure: { code: "badResponse", status: null } };
  }
  const envelope = RawEnvelope.safeParse(raw);
  if (!envelope.success) {
    return { ok: false, failure: { code: "badResponse", status: null } };
  }
  const errors = (envelope.data.errors ?? []).map((error) => ({
    type: error.type ?? "",
    path: error.path ?? [],
  }));
  if (envelope.data.data === undefined || envelope.data.data === null) {
    return { ok: true, value: { data: null, errors } };
  }
  const data = schema.safeParse(envelope.data.data);
  return data.success
    ? { ok: true, value: { data: data.data, errors } }
    : { ok: false, failure: { code: "badResponse", status: null } };
}

/** `answer`'s data, or the failure its errors stand for when there is none. */
function required<T>(
  answer: GitHubResult<GraphqlAnswer<T>>,
  auth: GitHubAuth,
  now: number,
): GitHubResult<T> {
  if (!answer.ok) {
    return answer;
  }
  if (answer.value.data === null) {
    return { ok: false, failure: failureForErrors(answer.value.errors, auth, now) };
  }
  return { ok: true, value: answer.value.data };
}

// --- the reader's pending review ---------------------------------------------------------

/** A side of the diff, as GitHub names it. */
export type DiffSide = "LEFT" | "RIGHT";

/** A comment already in a pending review, as much of it as matching needs. `line`/`startLine`
 * are numbered against the review's own commit (GitHub's `original*` fields, the current ones
 * only when those are missing); `side`/`startSide` come from the comment's thread, and are null
 * when the thread was not among those read. */
export type PendingComment = {
  id: string;
  path: string;
  line: number | null;
  startLine: number | null;
  side: DiffSide | null;
  startSide: DiffSide | null;
  body: string;
};

export type PendingReview = {
  id: string;
  /** The commit the review was started at — its lines are numbered against this diff. */
  commit: string | null;
  comments: PendingComment[];
  /** Whether `comments` is the whole list (false past a hundred). */
  complete: boolean;
};

export type PendingLookup = {
  pullRequestId: string;
  /** The reader's pending reviews on the pull request: none, one, or — which GitHub should never
   * allow — more. */
  mine: PendingReview[];
};

const RawSide = z.enum(["LEFT", "RIGHT"]);

const RawPendingComment = z.object({
  id: GitHubNodeId,
  path: z.string(),
  line: z.int().nullable(),
  originalLine: z.int().nullable(),
  startLine: z.int().nullable(),
  originalStartLine: z.int().nullable(),
  body: z.string(),
});

const RawPending = z.object({
  repository: z
    .object({
      pullRequest: z
        .object({
          id: GitHubNodeId,
          reviews: z
            .object({
              nodes: z
                .array(
                  z
                    .object({
                      id: GitHubNodeId,
                      viewerDidAuthor: z.boolean(),
                      commit: z.object({ oid: z.string() }).nullable(),
                      comments: z.object({
                        pageInfo: z.object({ hasNextPage: z.boolean() }),
                        nodes: z.array(RawPendingComment.nullable()),
                      }),
                    })
                    .nullable(),
                )
                .nullable(),
            })
            .nullable(),
          reviewThreads: z
            .object({
              nodes: z
                .array(
                  z
                    .object({
                      diffSide: RawSide.nullable().catch(null),
                      startDiffSide: RawSide.nullable().catch(null),
                      comments: z.object({
                        nodes: z.array(z.object({ id: GitHubNodeId }).nullable()),
                      }),
                    })
                    .nullable(),
                )
                .nullable(),
            })
            .nullable()
            .catch(null),
        })
        .nullable(),
    })
    .nullable(),
});

/** The pull request's node id and the reader's pending reviews on it. */
export async function findPendingReview(
  client: GitHubClient,
  auth: GitHubAuth,
  pr: PullRequest,
  now: number,
): Promise<GitHubResult<PendingLookup>> {
  const answer = required(
    await runGraphql(
      client,
      auth,
      GRAPHQL.PENDING_REVIEW,
      { owner: pr.owner, repo: pr.repo, number: pr.number },
      RawPending,
    ),
    auth,
    now,
  );
  if (!answer.ok) {
    return answer;
  }
  const pullRequest = answer.value.repository?.pullRequest ?? null;
  if (pullRequest === null) {
    return { ok: false, failure: { code: "notFound" } };
  }
  /** Each thread's sides, by its first comment's id. */
  const sides = new Map<string, { side: DiffSide | null; startSide: DiffSide | null }>();
  for (const thread of pullRequest.reviewThreads?.nodes ?? []) {
    const first = thread?.comments.nodes.find((node) => node !== null);
    if (thread !== null && first !== undefined && first !== null) {
      sides.set(first.id, { side: thread.diffSide, startSide: thread.startDiffSide });
    }
  }
  const mine = (pullRequest.reviews?.nodes ?? [])
    .flatMap((review) => (review === null || !review.viewerDidAuthor ? [] : [review]))
    .map((review) => ({
      id: review.id,
      commit: review.commit?.oid ?? null,
      complete: !review.comments.pageInfo.hasNextPage,
      comments: review.comments.nodes.flatMap((comment): PendingComment[] =>
        comment === null
          ? []
          : [
              {
                id: comment.id,
                path: comment.path,
                // Against the review's commit, not the pull request's head now.
                line: comment.originalLine ?? comment.line,
                startLine: comment.originalStartLine ?? comment.startLine,
                side: sides.get(comment.id)?.side ?? null,
                startSide: sides.get(comment.id)?.startSide ?? null,
                body: comment.body,
              },
            ],
      ),
    }));
  return { ok: true, value: { pullRequestId: pullRequest.id, mine } };
}

const RawStarted = z.object({
  addPullRequestReview: z
    .object({ pullRequestReview: z.object({ id: GitHubNodeId }).nullable() })
    .nullable(),
});

/** Start the reader's pending review on the pull request, at the reviewed commit. */
export async function startPendingReview(
  client: GitHubClient,
  auth: GitHubAuth,
  pullRequestId: string,
  reviewedHead: CommitSha,
  now: number,
): Promise<GitHubResult<string>> {
  const answer = required(
    await runGraphql(
      client,
      auth,
      GRAPHQL.START_PENDING_REVIEW,
      { pullRequestId, commitOID: reviewedHead },
      RawStarted,
    ),
    auth,
    now,
  );
  if (!answer.ok) {
    return answer;
  }
  const id = answer.value.addPullRequestReview?.pullRequestReview?.id ?? null;
  return id === null
    ? { ok: false, failure: { code: "badResponse", status: null } }
    : { ok: true, value: id };
}

/** One comment as a line thread: GitHub's side of the diff, its path there, and its lines. */
export type ThreadInput = {
  reviewId: string;
  path: string;
  side: "LEFT" | "RIGHT";
  startLine: number;
  endLine: number;
  body: string;
};

/** The variables for a thread: a range names its first line and side; one line names neither,
 * so the input carries no `startLine` at all (`graphql-documents.ts` says why that is absence). */
export function threadVariables(input: ThreadInput): Record<string, unknown> {
  return {
    reviewId: input.reviewId,
    path: input.path,
    line: input.endLine,
    side: input.side,
    body: input.body,
    ...(input.startLine === input.endLine
      ? {}
      : { startLine: input.startLine, startSide: input.side }),
  };
}

const RawThread = z.object({
  addPullRequestReviewThread: z
    .object({
      thread: z
        .object({
          id: GitHubNodeId,
          comments: z.object({
            nodes: z.array(z.object({ id: GitHubNodeId, state: z.string().max(32) }).nullable()),
          }),
        })
        .nullable(),
    })
    .nullable(),
});

/** What adding a thread came to: the thread and its comment — `pending` false when GitHub says the
 * comment is not a draft, which means the review was submitted on GitHub in the meantime — or
 * GitHub's `thread: null`: the line is not in its diff. */
export type AddedThread =
  | { kind: "added"; threadId: string; commentId: string; pending: boolean }
  | { kind: "notInDiff" };

export async function addPendingThread(
  client: GitHubClient,
  auth: GitHubAuth,
  input: ThreadInput,
  now: number,
): Promise<GitHubResult<AddedThread>> {
  const answer = await runGraphql(
    client,
    auth,
    GRAPHQL.ADD_PENDING_THREAD,
    threadVariables(input),
    RawThread,
  );
  if (!answer.ok) {
    return answer;
  }
  const { data, errors } = answer.value;
  const payload = data?.addPullRequestReviewThread ?? null;
  if (payload === null) {
    return { ok: false, failure: failureForErrors(errors, auth, now) };
  }
  if (payload.thread === null) {
    // Whatever error rode along, a null thread is GitHub declining the line.
    return { ok: true, value: { kind: "notInDiff" } };
  }
  const comment = payload.thread.comments.nodes.find((node) => node !== null) ?? null;
  return comment === null
    ? { ok: false, failure: { code: "badResponse", status: null } }
    : {
        ok: true,
        value: {
          kind: "added",
          threadId: payload.thread.id,
          commentId: comment.id,
          pending: comment.state === "PENDING",
        },
      };
}

const RawCommentState = z.object({
  node: z
    .object({
      id: GitHubNodeId.optional(),
      state: z.string().optional(),
      viewerDidAuthor: z.boolean().optional(),
    })
    .nullable(),
});

/** Whether a comment is a pending draft the reader wrote — the only kind ever deleted. `gone`
 * is a comment GitHub no longer has (deleted, or its review discarded). */
export type CommentState = "pendingMine" | "notPendingMine" | "gone";

export async function commentState(
  client: GitHubClient,
  auth: GitHubAuth,
  commentId: string,
  now: number,
): Promise<GitHubResult<CommentState>> {
  const answer = await runGraphql(
    client,
    auth,
    GRAPHQL.COMMENT_STATE,
    { id: commentId },
    RawCommentState,
  );
  if (!answer.ok) {
    return answer;
  }
  const { data, errors } = answer.value;
  if (data?.node == null) {
    // Gone only when GitHub says so about this node; any other null (a forbidden token, an
    // organisation's single sign-on) says nothing about the comment.
    return notFoundAt(errors, ["node"])
      ? { ok: true, value: "gone" }
      : {
          ok: false,
          failure: failureForErrors(errorsAt(errors, ["node"]).concat(errors), auth, now),
        };
  }
  const node = data.node;
  return {
    ok: true,
    value:
      node.state === "PENDING" && node.viewerDidAuthor === true ? "pendingMine" : "notPendingMine",
  };
}

const RawDeleted = z.object({
  deletePullRequestReviewComment: z
    .object({ pullRequestReviewComment: z.object({ id: GitHubNodeId }).nullable() })
    .nullable(),
});

/** Delete one comment. Only ever called on one `commentState` just said is a pending draft of
 * the reader's. A comment already gone counts as deleted. */
export async function deletePendingComment(
  client: GitHubClient,
  auth: GitHubAuth,
  commentId: string,
  now: number,
): Promise<GitHubResult<void>> {
  const answer = await runGraphql(
    client,
    auth,
    GRAPHQL.DELETE_PENDING_COMMENT,
    { id: commentId },
    RawDeleted,
  );
  if (!answer.ok) {
    return answer;
  }
  const { data, errors } = answer.value;
  if (
    data?.deletePullRequestReviewComment != null ||
    notFoundAt(errors, ["deletePullRequestReviewComment"])
  ) {
    return { ok: true, value: undefined };
  }
  return { ok: false, failure: failureForErrors(errors, auth, now) };
}

const RawPostedReviews = z.object({
  nodes: z.array(
    z
      .object({
        id: GitHubNodeId.optional(),
        state: z.string().optional(),
        comments: z
          .object({
            pageInfo: z.object({ hasNextPage: z.boolean() }),
            nodes: z.array(z.object({ id: GitHubNodeId }).nullable()),
          })
          .optional(),
      })
      .nullable(),
  ),
});

/** A review the app posted into, as GitHub has it now. */
export type PostedReview =
  | { kind: "gone" }
  | { kind: "submitted" }
  | { kind: "pending"; commentIds: ReadonlySet<string>; complete: boolean };

/** Every review in `ids`, by id, in one request. A review GitHub no longer has (discarded on
 * GitHub) is `gone` — `nodes` answers null for it, beside a `NOT_FOUND` error at its own path
 * (`["nodes", i]`) that is the answer, not a failure. A null with any other error, or none, fails
 * the whole answer: nothing is concluded from it (see the header). */
export async function postedReviews(
  client: GitHubClient,
  auth: GitHubAuth,
  ids: readonly string[],
  now: number,
): Promise<GitHubResult<Map<string, PostedReview>>> {
  const answer = await runGraphql(client, auth, GRAPHQL.POSTED_REVIEWS, { ids }, RawPostedReviews);
  if (!answer.ok) {
    return answer;
  }
  const { data, errors } = answer.value;
  if (data === null) {
    return { ok: false, failure: failureForErrors(errors, auth, now) };
  }
  if (data.nodes.length !== ids.length) {
    return { ok: false, failure: { code: "badResponse", status: null } };
  }
  const reviews = new Map<string, PostedReview>();
  for (const [index, id] of ids.entries()) {
    const node = data.nodes[index] ?? null;
    if (node === null) {
      if (!notFoundAt(errors, ["nodes", index])) {
        const here = errorsAt(errors, ["nodes", index]);
        return { ok: false, failure: failureForErrors(here.length > 0 ? here : errors, auth, now) };
      }
      reviews.set(id, { kind: "gone" });
    } else if (node.state === "PENDING") {
      reviews.set(id, {
        kind: "pending",
        commentIds: new Set(
          (node.comments?.nodes ?? []).flatMap((comment) => (comment === null ? [] : [comment.id])),
        ),
        complete: node.comments?.pageInfo.hasNextPage !== true,
      });
    } else {
      // Submitted — or a state this file does not know, which offers nothing either.
      reviews.set(id, { kind: "submitted" });
    }
  }
  return { ok: true, value: reviews };
}
