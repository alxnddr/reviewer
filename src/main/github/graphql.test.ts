import { describe, expect, it } from "vitest";
import { githubPullRequestOf } from "../../shared/pull-request";
import { ANONYMOUS, createGitHubClient } from "./client";
import { fakeTransport, jsonResponse } from "./fixtures";
import {
  addPendingThread,
  commentState,
  failureForErrors,
  findPendingReview,
  postedReviews,
  threadVariables,
} from "./graphql";

// The GraphQL half of Layer C's boundary: errors read by type, never by message; a null thread
// read as "not in the diff"; a discarded review read as an answer, not a failure; the reader's
// pending review told apart from anyone else's. The answers are shaped from GitHub's published
// schema (`graphql-documents.ts` names the version).

const NOW = Date.UTC(2026, 9, 3);
const PR = githubPullRequestOf({ owner: "octocat", repo: "Hello-World" }, 1);

function answering(body: unknown) {
  const fake = fakeTransport(() => jsonResponse(JSON.stringify(body)));
  return { fake, client: createGitHubClient({ transport: fake.transport, userAgent: "t" }) };
}

describe("failureForErrors", () => {
  it("maps by type, and anything unknown to badResponse", () => {
    expect(failureForErrors([{ type: "NOT_FOUND" }], ANONYMOUS, NOW)).toEqual({ code: "notFound" });
    expect(failureForErrors([{ type: "FORBIDDEN" }], ANONYMOUS, NOW)).toEqual({
      code: "forbidden",
    });
    expect(failureForErrors([{ type: "INSUFFICIENT_SCOPES" }], ANONYMOUS, NOW)).toEqual({
      code: "forbidden",
    });
    expect(failureForErrors([{ type: "UNPROCESSABLE" }], ANONYMOUS, NOW)).toEqual({
      code: "unprocessable",
    });
    expect(failureForErrors([{ type: "RATE_LIMITED" }], ANONYMOUS, NOW)).toEqual({
      code: "rateLimited",
      resetAt: NOW + 60_000,
      scope: "anonymous",
    });
    expect(failureForErrors([{ type: "SOMETHING_NEW" }], ANONYMOUS, NOW)).toEqual({
      code: "badResponse",
      status: null,
    });
    expect(failureForErrors([], ANONYMOUS, NOW)).toEqual({ code: "badResponse", status: null });
  });
});

describe("threadVariables", () => {
  const base = { reviewId: "PRR_1", path: "a.ts", side: "LEFT" as const, body: "b" };

  it("names the first line and side of a range", () => {
    expect(threadVariables({ ...base, startLine: 3, endLine: 5 })).toEqual({
      reviewId: "PRR_1",
      path: "a.ts",
      line: 5,
      side: "LEFT",
      startLine: 3,
      startSide: "LEFT",
      body: "b",
    });
  });

  it("leaves both out for one line", () => {
    const one = threadVariables({ ...base, startLine: 4, endLine: 4 });
    expect(one).not.toHaveProperty("startLine");
    expect(one).not.toHaveProperty("startSide");
    expect(one).toMatchObject({ line: 4, side: "LEFT" });
  });
});

describe("addPendingThread", () => {
  const input = {
    reviewId: "PRR_1",
    path: "a.ts",
    side: "RIGHT" as const,
    startLine: 1,
    endLine: 1,
    body: "b",
  };

  it("reads thread: null as the line not being in GitHub's diff, error or not", async () => {
    for (const body of [
      { data: { addPullRequestReviewThread: { thread: null } } },
      {
        data: { addPullRequestReviewThread: { thread: null } },
        errors: [{ type: "UNPROCESSABLE", message: "line must be part of the diff" }],
      },
    ]) {
      const { client } = answering(body);
      expect(await addPendingThread(client, ANONYMOUS, input, NOW)).toEqual({
        ok: true,
        value: { kind: "notInDiff" },
      });
    }
  });

  it("maps an error with no payload by type, and never carries GitHub's message", async () => {
    const { client } = answering({
      data: { addPullRequestReviewThread: null },
      errors: [{ type: "FORBIDDEN", message: "Resource not accessible by personal access token" }],
    });
    const answer = await addPendingThread(client, ANONYMOUS, input, NOW);
    expect(answer).toEqual({ ok: false, failure: { code: "forbidden" } });
    expect(JSON.stringify(answer)).not.toContain("accessible");
  });

  it("answers the thread and its comment", async () => {
    const { client } = answering({
      data: {
        addPullRequestReviewThread: {
          thread: { id: "PRRT_1", comments: { nodes: [{ id: "PRRC_1", state: "PENDING" }] } },
        },
      },
    });
    expect(await addPendingThread(client, ANONYMOUS, input, NOW)).toEqual({
      ok: true,
      value: { kind: "added", threadId: "PRRT_1", commentId: "PRRC_1", pending: true },
    });
  });

  it("says when the comment GitHub made is not a draft — the review was submitted meanwhile", async () => {
    const { client } = answering({
      data: {
        addPullRequestReviewThread: {
          thread: { id: "PRRT_1", comments: { nodes: [{ id: "PRRC_1", state: "SUBMITTED" }] } },
        },
      },
    });
    expect(await addPendingThread(client, ANONYMOUS, input, NOW)).toMatchObject({
      ok: true,
      value: { pending: false },
    });
  });
});

describe("findPendingReview", () => {
  it("keeps only the reader's own pending reviews", async () => {
    const review = (id: string, viewerDidAuthor: boolean) => ({
      id,
      viewerDidAuthor,
      commit: { oid: "a".repeat(40) },
      comments: { pageInfo: { hasNextPage: false }, nodes: [] },
    });
    const { client, fake } = answering({
      data: {
        repository: {
          pullRequest: {
            id: "PR_1",
            reviews: { nodes: [review("PRR_other", false), review("PRR_mine", true)] },
          },
        },
      },
    });
    const answer = await findPendingReview(client, ANONYMOUS, PR, NOW);
    expect(answer).toMatchObject({
      ok: true,
      value: { pullRequestId: "PR_1", mine: [{ id: "PRR_mine" }] },
    });
    const sent = JSON.parse(String(fake.calls[0]?.init.body)) as { variables: unknown };
    expect(sent.variables).toEqual({ owner: "octocat", repo: "Hello-World", number: 1 });
    expect(fake.calls[0]?.init.method).toBe("POST");
    expect(fake.calls[0]?.url).toBe("https://api.github.com/graphql");
  });

  it("calls a pull request GitHub does not show notFound", async () => {
    const { client } = answering({
      data: { repository: null },
      errors: [{ type: "NOT_FOUND", message: "Could not resolve to a Repository" }],
    });
    expect(await findPendingReview(client, ANONYMOUS, PR, NOW)).toEqual({
      ok: false,
      failure: { code: "notFound" },
    });
  });
});

describe("findPendingReview's lines and sides", () => {
  it("numbers lines against the review's commit, and takes each comment's side from its thread", async () => {
    const { client } = answering({
      data: {
        repository: {
          pullRequest: {
            id: "PR_1",
            reviews: {
              nodes: [
                {
                  id: "PRR_mine",
                  viewerDidAuthor: true,
                  commit: { oid: "a".repeat(40) },
                  comments: {
                    pageInfo: { hasNextPage: false },
                    nodes: [
                      // The head moved: GitHub renumbers `line` against it; `originalLine` is
                      // still the line at the review's commit.
                      {
                        id: "C1",
                        path: "a.ts",
                        line: 40,
                        originalLine: 12,
                        startLine: 38,
                        originalStartLine: 10,
                        body: "x",
                      },
                      {
                        id: "C2",
                        path: "a.ts",
                        line: null,
                        originalLine: 3,
                        startLine: null,
                        originalStartLine: null,
                        body: "y",
                      },
                    ],
                  },
                },
              ],
            },
            reviewThreads: {
              nodes: [
                { diffSide: "LEFT", startDiffSide: "LEFT", comments: { nodes: [{ id: "C1" }] } },
              ],
            },
          },
        },
      },
    });
    const answer = await findPendingReview(client, ANONYMOUS, PR, NOW);
    expect(answer.ok && answer.value.mine[0]?.comments).toEqual([
      {
        id: "C1",
        path: "a.ts",
        line: 12,
        startLine: 10,
        side: "LEFT",
        startSide: "LEFT",
        body: "x",
      },
      { id: "C2", path: "a.ts", line: 3, startLine: null, side: null, startSide: null, body: "y" },
    ]);
  });
});

describe("commentState", () => {
  it("is gone only when GitHub says NOT_FOUND about that node", async () => {
    const gone = answering({
      data: { node: null },
      errors: [{ type: "NOT_FOUND", path: ["node"] }],
    });
    expect(await commentState(gone.client, ANONYMOUS, "C1", NOW)).toEqual({
      ok: true,
      value: "gone",
    });
    const forbidden = answering({
      data: { node: null },
      errors: [{ type: "FORBIDDEN", path: ["node"], message: "SAML enforcement" }],
    });
    expect(await commentState(forbidden.client, ANONYMOUS, "C1", NOW)).toEqual({
      ok: false,
      failure: { code: "forbidden" },
    });
    const silent = answering({ data: { node: null } });
    expect((await commentState(silent.client, ANONYMOUS, "C1", NOW)).ok).toBe(false);
  });
});

describe("postedReviews", () => {
  it("never reads a null as gone beside a FORBIDDEN, even when another node is NOT_FOUND", async () => {
    const { client } = answering({
      data: { nodes: [null, null] },
      errors: [
        { type: "NOT_FOUND", path: ["nodes", 0] },
        { type: "FORBIDDEN", path: ["nodes", 1], message: "Resource protected by SSO" },
      ],
    });
    expect(await postedReviews(client, ANONYMOUS, ["PRR_1", "PRR_2"], NOW)).toEqual({
      ok: false,
      failure: { code: "forbidden" },
    });
  });

  it("never reads a null with no error at all as gone", async () => {
    const { client } = answering({ data: { nodes: [null] } });
    expect((await postedReviews(client, ANONYMOUS, ["PRR_1"], NOW)).ok).toBe(false);
  });

  it("reads a discarded review as gone, beside the NOT_FOUND that says so", async () => {
    const { client } = answering({
      data: {
        nodes: [
          null,
          {
            id: "PRR_2",
            state: "PENDING",
            comments: { pageInfo: { hasNextPage: false }, nodes: [{ id: "C1" }] },
          },
          {
            id: "PRR_3",
            state: "CHANGES_REQUESTED",
            comments: { pageInfo: { hasNextPage: false }, nodes: [] },
          },
        ],
      },
      errors: [
        {
          type: "NOT_FOUND",
          path: ["nodes", 0],
          message: "Could not resolve to a node with the global id",
        },
      ],
    });
    const answer = await postedReviews(client, ANONYMOUS, ["PRR_1", "PRR_2", "PRR_3"], NOW);
    expect(answer.ok && [...answer.value]).toEqual([
      ["PRR_1", { kind: "gone" }],
      ["PRR_2", { kind: "pending", commentIds: new Set(["C1"]), complete: true }],
      ["PRR_3", { kind: "submitted" }],
    ]);
  });

  it("refuses an answer that does not line up with what was asked", async () => {
    const { client } = answering({ data: { nodes: [] } });
    expect(await postedReviews(client, ANONYMOUS, ["PRR_1"], NOW)).toEqual({
      ok: false,
      failure: { code: "badResponse", status: null },
    });
  });
});
