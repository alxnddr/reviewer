import { afterEach, describe, expect, it, vi } from "vitest";
import { commentFingerprint } from "../../shared/fingerprint";
import { postableDigest, type GitHubPostRecord } from "../../shared/github-posting";
import { postableComment } from "../../shared/postable-comment";
import { githubPullRequestOf } from "../../shared/pull-request";
import type { Comment } from "../../shared/review";
import { NO_PROGRESS } from "../../shared/review-progress";
import { Session } from "../../shared/session";
import { createGitHubClient } from "./client";
import { createCredentialVault, type CredentialVault } from "./credentials";
import { createDiffChecker } from "./diff-check";
import {
  diffResponse,
  fakeTransport,
  HELLO_WORLD_DIFF,
  jsonResponse,
  pullRequestBody,
  SHA_HEAD,
  SHA_OTHER,
} from "./fixtures";
import { createPoster, PACE_MS } from "./posting";
import { createPullRequestReader } from "./rest";

// C3's flow against a GitHub that lives in this file: the pull request, its diff, and a GraphQL
// endpoint that keeps a pending review the way GitHub does — one per reader, numbered against the
// commit it was started at. No network; every request is recorded, so each test says what was
// asked of GitHub as well as what came back. Three properties are held across all of them:
//
//   - nothing ever asks GitHub to submit (no `event` in any request, no other mutation);
//   - a planted token is sent as the Authorization header and appears nowhere else — not in a
//     response, an outcome, a record, a request body or a console line;
//   - a comment is never posted twice.

const PR = githubPullRequestOf({ owner: "octocat", repo: "Hello-World" }, 1);
const BASE_SHA = "553c2077f0edc3d5dc5d17262f6aa498e69d6f8e";
const TOKEN = "github_pat_PLANTEDsecretTokenValue0123456789abcdefghijklmnopqrstuvwxyzABCDEFGH";
const SECRET = "PLANTEDsecret";
const SESSION_ID = "22222222-2222-4222-8222-222222222222";
const ARTIFACT = "/reviews/hello.reviewer.json";

function comment(id: string, overrides: Partial<Comment> = {}): Comment {
  return {
    id,
    file: "README",
    side: "additions",
    startLine: 2,
    endLine: 4,
    body: `Finding ${id}`,
    postable: `Please look at this (${id.slice(0, 4)}).`,
    ...overrides,
  };
}

const ON = comment("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
const ALSO = comment("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", { startLine: 5, endLine: 5 });
const OFF = comment("cccccccc-cccc-4ccc-8ccc-cccccccccccc", { startLine: 9, endLine: 9 });
const NONE = comment("dddddddd-dddd-4ddd-8ddd-dddddddddddd", { postable: undefined });

function session(comments: Comment[]): Session {
  return Session.parse({
    id: SESSION_ID,
    source: { kind: "local", repo: { path: "/repo", name: "repo" } },
    head: null,
    commitSelection: null,
    selectedFilePath: null,
    scrollTop: 0,
    comments,
    layers: [],
    reviewOrigin: {
      repo: { path: "/repo", name: "repo" },
      base: "main",
      head: SHA_HEAD,
      patch: null,
      reviewedHead: SHA_HEAD,
      pr: PR,
    },
    reviewPath: ARTIFACT,
    ...NO_PROGRESS,
  });
}

type PendingComment = {
  id: string;
  path: string;
  line: number;
  startLine: number | null;
  side: string;
  startSide: string | null;
  body: string;
};

/** GitHub, as far as these tests need it. */
function fakeGitHub(
  options: {
    head?: string;
    /** How the next thread mutation goes: applied and answered, applied with the answer lost
     * (the connection drops after GitHub did it), lost before it landed, or `thread: null`. */
    threads?: ("ok" | "landedLost" | "lost" | "null" | "unprocessable")[];
    /** GitHub's diff of the pull request at the reviewed commit. */
    diff?: string;
    /** How far the pull request's head moved the lines since the review's commit: GitHub's
     * `line` is renumbered by this, `originalLine` is not. */
    drift?: number;
    /** Submit the reader's pending review on GitHub just before this many-th thread lands. */
    submitBeforeThread?: number;
    /** Answer `nodes(ids:)` with nulls beside FORBIDDEN (an unapproved token, SSO). */
    forbidNodes?: boolean;
    /** The pending review holds more comments than one page. */
    overflowing?: boolean;
  } = {},
) {
  let threadCount = 0;
  const state = {
    head: options.head ?? SHA_HEAD,
    forbidNodes: options.forbidNodes === true,
    reviews: new Map<
      string,
      { commit: string; viewer: boolean; state: string; comments: PendingComment[] }
    >(),
    counter: 0,
  };
  const threads = [...(options.threads ?? [])];
  const operations: { name: string; variables: Record<string, unknown>; query: string }[] = [];
  const pending = (): [string, typeof state.reviews extends Map<string, infer V> ? V : never][] =>
    [...state.reviews].filter(([, review]) => review.state === "PENDING");

  const graphql = (query: string, variables: Record<string, unknown>): Response => {
    const name = /^\s*(?:query|mutation)\s+(\w+)/u.exec(query)?.[1] ?? "?";
    operations.push({ name, variables, query });
    switch (name) {
      case "PendingReview":
        return jsonResponse(
          JSON.stringify({
            data: {
              repository: {
                pullRequest: {
                  id: "PR_node1",
                  reviews: {
                    nodes: pending().map(([id, review]) => ({
                      id,
                      viewerDidAuthor: review.viewer,
                      commit: { oid: review.commit },
                      comments: {
                        pageInfo: { hasNextPage: options.overflowing === true },
                        nodes: review.comments.map((c) => ({
                          id: c.id,
                          path: c.path,
                          line: c.line + (options.drift ?? 0),
                          originalLine: c.line,
                          startLine:
                            c.startLine === null ? null : c.startLine + (options.drift ?? 0),
                          originalStartLine: c.startLine,
                          body: c.body,
                        })),
                      },
                    })),
                  },
                  reviewThreads: {
                    nodes: pending().flatMap(([, review]) =>
                      review.comments.map((c) => ({
                        diffSide: c.side,
                        startDiffSide: c.startSide,
                        comments: { nodes: [{ id: c.id }] },
                      })),
                    ),
                  },
                },
              },
            },
          }),
        );
      case "StartPendingReview": {
        state.counter += 1;
        const id = `PRR_review${state.counter}`;
        state.reviews.set(id, {
          commit: String(variables["commitOID"]),
          viewer: true,
          state: "PENDING",
          comments: [],
        });
        return jsonResponse(
          JSON.stringify({ data: { addPullRequestReview: { pullRequestReview: { id } } } }),
        );
      }
      case "AddPendingThread": {
        const how = threads.shift() ?? "ok";
        if (how === "null") {
          return jsonResponse(
            JSON.stringify({ data: { addPullRequestReviewThread: { thread: null } } }),
          );
        }
        if (how === "lost") {
          throw new Error("socket hang up");
        }
        if (how === "unprocessable") {
          return jsonResponse(
            JSON.stringify({
              data: { addPullRequestReviewThread: null },
              errors: [{ type: "UNPROCESSABLE", path: ["addPullRequestReviewThread"] }],
            }),
          );
        }
        const review = state.reviews.get(String(variables["reviewId"]));
        threadCount += 1;
        if (review !== undefined && threadCount === options.submitBeforeThread) {
          review.state = "COMMENTED";
        }
        state.counter += 1;
        const commentId = `PRRC_comment${state.counter}`;
        review?.comments.push({
          id: commentId,
          path: String(variables["path"]),
          line: Number(variables["line"]),
          startLine: variables["startLine"] === undefined ? null : Number(variables["startLine"]),
          side: String(variables["side"]),
          startSide: variables["startSide"] === undefined ? null : String(variables["startSide"]),
          body: String(variables["body"]),
        });
        const commentState = review?.state === "PENDING" ? "PENDING" : "SUBMITTED";
        if (how === "landedLost") {
          throw new Error("socket hang up");
        }
        return jsonResponse(
          JSON.stringify({
            data: {
              addPullRequestReviewThread: {
                thread: {
                  id: `PRRT_thread${state.counter}`,
                  comments: { nodes: [{ id: commentId, state: commentState }] },
                },
              },
            },
          }),
        );
      }
      case "PostedReviews": {
        const ids = variables["ids"] as string[];
        if (state.forbidNodes) {
          return jsonResponse(
            JSON.stringify({
              data: { nodes: ids.map(() => null) },
              errors: ids.map((_, index) => ({
                type: "FORBIDDEN",
                path: ["nodes", index],
                message: "Resource protected by organization SAML enforcement.",
              })),
            }),
          );
        }
        return jsonResponse(
          JSON.stringify({
            data: {
              nodes: ids.map((id) => {
                const review = state.reviews.get(id);
                return review === undefined
                  ? null
                  : {
                      id,
                      state: review.state,
                      comments: {
                        pageInfo: { hasNextPage: false },
                        nodes: review.comments.map((c) => ({ id: c.id })),
                      },
                    };
              }),
            },
            errors: ids.flatMap((id, index) =>
              state.reviews.has(id)
                ? []
                : [{ type: "NOT_FOUND", path: ["nodes", index], message: "Could not resolve" }],
            ),
          }),
        );
      }
      case "CommentState": {
        const id = String(variables["id"]);
        if (state.forbidNodes) {
          return jsonResponse(
            JSON.stringify({
              data: { node: null },
              errors: [{ type: "FORBIDDEN", path: ["node"], message: "SAML enforcement" }],
            }),
          );
        }
        const owner = [...state.reviews.values()].find((review) =>
          review.comments.some((c) => c.id === id),
        );
        return jsonResponse(
          JSON.stringify({
            data: {
              node:
                owner === undefined
                  ? null
                  : {
                      id,
                      state: owner.state === "PENDING" ? "PENDING" : "SUBMITTED",
                      viewerDidAuthor: true,
                    },
            },
          }),
        );
      }
      case "DeletePendingComment": {
        const id = String(variables["id"]);
        for (const review of state.reviews.values()) {
          review.comments = review.comments.filter((c) => c.id !== id);
        }
        return jsonResponse(
          JSON.stringify({
            data: { deletePullRequestReviewComment: { pullRequestReviewComment: { id } } },
          }),
        );
      }
      default:
        throw new Error(`unexpected operation ${name}`);
    }
  };

  const fake = fakeTransport((url, init) => {
    if (url.pathname === "/graphql") {
      const body = JSON.parse(String(init.body)) as {
        query: string;
        variables: Record<string, unknown>;
      };
      return graphql(body.query, body.variables);
    }
    if (url.pathname.includes("/compare/")) {
      return diffResponse(options.diff ?? HELLO_WORLD_DIFF);
    }
    return jsonResponse(
      pullRequestBody({ head: { sha: state.head }, base: { ref: "master", sha: BASE_SHA } }),
    );
  });
  return { state, operations, fake, names: () => operations.map((op) => op.name) };
}

type Harness = ReturnType<typeof harness>;

function harness(
  options: {
    comments?: Comment[];
    github?: ReturnType<typeof fakeGitHub>;
    vault?: CredentialVault;
    evidence?: boolean;
    expiresAt?: string | null;
    now?: number;
    /** The record on disk cannot be read. */
    unreadable?: boolean;
    exposedBy?: string[];
  } = {},
) {
  const github = options.github ?? fakeGitHub();
  const client = createGitHubClient({
    transport: github.fake.transport,
    userAgent: "Reviewer/test",
  });
  const reader = createPullRequestReader(client, { memoMs: 0 });
  const vault = options.vault ?? createCredentialVault();
  if (options.vault === undefined) {
    vault.add({
      kind: "fineGrained",
      login: "octocat",
      owner: "octocat",
      expiresAt: options.expiresAt ?? null,
      token: TOKEN,
    });
  }
  let current = session(options.comments ?? [ON, ALSO, OFF, NONE]);
  const records = new Map<string, GitHubPostRecord>();
  const pause = vi.fn((_ms: number) => Promise.resolve());
  const poster = createPoster({
    client,
    vault,
    readPullRequest: reader,
    indexAt: createDiffChecker(client, reader).indexAt,
    findSession: (id) => (id === current.id ? current : undefined),
    records: {
      read: (path) =>
        Promise.resolve(
          options.unreadable === true
            ? { ok: false as const }
            : { ok: true as const, record: records.get(path) ?? null },
        ),
      write: (path, record) => {
        records.set(path, structuredClone(record));
        return Promise.resolve(true);
      },
    },
    includeEvidence: () => options.evidence ?? false,
    exposedBy: () => options.exposedBy ?? [],
    pause,
    now: () => options.now ?? Date.UTC(2026, 9, 3),
  });
  return {
    github,
    poster,
    records,
    pause,
    setComments: (comments: Comment[]) => {
      current = session(comments);
    },
    ask: (comments: Comment[], acceptHead?: string) =>
      poster.post({
        sessionId: SESSION_ID,
        comments: comments.map((c) => ({ id: c.id, postable: postableDigest(c.postable ?? "") })),
        ...(acceptHead === undefined ? {} : { acceptHead }),
      }),
  };
}

/** Every request a harness made, and every answer it gave, as one string — for the token checks. */
function everything(h: Harness, answers: unknown[]): string {
  return JSON.stringify({
    answers,
    records: [...h.records.values()],
    bodies: h.github.fake.calls.map((call) => call.init.body ?? null),
    urls: h.github.fake.calls.map((call) => call.url),
  });
}

const consoleCalls: unknown[][] = [];
afterEach(() => {
  vi.restoreAllMocks();
  consoleCalls.length = 0;
});
function watchConsole(): void {
  for (const method of ["log", "error", "warn", "info", "debug"] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      consoleCalls.push(args);
    });
  }
}

describe("posting pending comments", () => {
  it("starts a pending review at the reviewed commit and adds each comment as a line thread", async () => {
    const h = harness();
    const answer = await h.ask([ON, ALSO]);
    expect(answer).toMatchObject({
      ok: true,
      value: {
        outcomes: { [ON.id]: { kind: "posted" }, [ALSO.id]: { kind: "posted" } },
        state: {
          comments: { [ON.id]: { state: "pending" }, [ALSO.id]: { state: "pending" } },
          unverified: null,
        },
      },
    });
    expect(h.github.names()).toEqual([
      "PendingReview",
      "StartPendingReview",
      "AddPendingThread",
      "AddPendingThread",
    ]);
    const [start, range, single] = h.github.operations.slice(1);
    expect(start?.variables).toEqual({ pullRequestId: "PR_node1", commitOID: SHA_HEAD });
    expect(range?.variables).toEqual({
      reviewId: "PRR_review1",
      path: "README",
      line: 4,
      side: "RIGHT",
      startLine: 2,
      startSide: "RIGHT",
      body: postableComment(ON, {
        includeEvidence: false,
        references: {
          kind: "github",
          owner: "octocat",
          repo: "Hello-World",
          sha: SHA_HEAD,
          absentAtHead: new Set(),
        },
      }),
    });
    // One line: no startLine at all, which GitHub reads as a single-line comment.
    expect(single?.variables).not.toHaveProperty("startLine");
    expect(single?.variables).not.toHaveProperty("startSide");
    expect(h.records.get(ARTIFACT)?.comments[commentFingerprint(ON)]).toMatchObject({
      reviewId: "PRR_review1",
      state: "pending",
    });
  });

  it("posts the text main holds, with evidence only when the reader asked for it", async () => {
    const withEvidence = comment("eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", { evidence: "ran it" });
    const off = harness({ comments: [withEvidence] });
    await off.ask([withEvidence]);
    expect(off.github.operations.at(-1)?.variables["body"]).not.toContain("<details>");
    const on = harness({ comments: [withEvidence], evidence: true });
    await on.ask([withEvidence]);
    expect(on.github.operations.at(-1)?.variables["body"]).toContain("<summary>Evidence</summary>");
  });

  it("refuses text the reader was not shown, before asking GitHub anything", async () => {
    const h = harness();
    const answer = await h.poster.post({
      sessionId: SESSION_ID,
      comments: [{ id: ON.id, postable: postableDigest("an older wording") }],
    });
    expect(answer).toEqual({ ok: false, failure: { code: "changedSinceShown" } });
    expect(h.github.fake.calls).toEqual([]);
  });

  it("refuses a comment with no text for the author", async () => {
    const h = harness();
    expect(await h.ask([NONE])).toEqual({ ok: false, failure: { code: "notPostable" } });
    expect(h.github.fake.calls).toEqual([]);
  });

  it("answers noToken with no token for the owner, and asks nothing", async () => {
    const h = harness({ vault: createCredentialVault() });
    expect(await h.ask([ON])).toEqual({ ok: false, failure: { code: "noToken" } });
    expect(h.github.fake.calls).toEqual([]);
  });

  it("stops at a moved head, and posts over exactly the head the reader accepted", async () => {
    const h = harness({ github: fakeGitHub({ head: SHA_OTHER }) });
    expect(await h.ask([ON])).toEqual({
      ok: false,
      failure: { code: "headMoved", head: SHA_OTHER },
    });
    expect(h.github.names()).toEqual([]);
    // Accepting some other head is not accepting this one.
    expect(await h.ask([ON], "2".repeat(40))).toMatchObject({
      ok: false,
      failure: { code: "headMoved" },
    });
    const posted = await h.ask([ON], SHA_OTHER);
    expect(posted).toMatchObject({
      ok: true,
      value: { outcomes: { [ON.id]: { kind: "posted" } } },
    });
    // Still pinned to the reviewed commit, so GitHub shows it as outdated.
    expect(h.github.operations.find((op) => op.name === "StartPendingReview")?.variables).toEqual({
      pullRequestId: "PR_node1",
      commitOID: SHA_HEAD,
    });
  });

  it("refuses lines GitHub's diff leaves out without a write, and posts the rest", async () => {
    const h = harness();
    const answer = await h.ask([ON, OFF]);
    expect(answer).toMatchObject({
      ok: true,
      value: {
        outcomes: {
          [ON.id]: { kind: "posted" },
          [OFF.id]: { kind: "failed", failure: { code: "lineNotInDiff" } },
        },
      },
    });
    expect(h.github.names().filter((name) => name === "AddPendingThread")).toHaveLength(1);
  });

  it("maps GitHub's thread: null to lineNotInDiff", async () => {
    const h = harness({ github: fakeGitHub({ threads: ["null"] }) });
    expect(await h.ask([ON])).toMatchObject({
      ok: true,
      value: { outcomes: { [ON.id]: { kind: "failed", failure: { code: "lineNotInDiff" } } } },
    });
    expect(h.records.get(ARTIFACT)?.comments ?? {}).toEqual({});
  });

  it("adds to the reader's own pending review at the reviewed commit, ignoring anyone else's", async () => {
    const github = fakeGitHub();
    github.state.reviews.set("PRR_someoneElse", {
      commit: SHA_OTHER,
      viewer: false,
      state: "PENDING",
      comments: [],
    });
    github.state.reviews.set("PRR_mine", {
      commit: SHA_HEAD,
      viewer: true,
      state: "PENDING",
      comments: [],
    });
    const h = harness({ github });
    await h.ask([ON]);
    expect(h.github.names()).toEqual(["PendingReview", "AddPendingThread"]);
    expect(h.github.operations.at(-1)?.variables["reviewId"]).toBe("PRR_mine");
  });

  it("refuses a pending review begun at another commit: its lines are another diff's", async () => {
    const github = fakeGitHub();
    github.state.reviews.set("PRR_mine", {
      commit: SHA_OTHER,
      viewer: true,
      state: "PENDING",
      comments: [],
    });
    const h = harness({ github });
    expect(await h.ask([ON])).toEqual({ ok: false, failure: { code: "pendingReviewConflict" } });
    expect(h.github.names()).toEqual(["PendingReview"]);
  });

  it("never posts a comment twice: a second click finds it recorded and still pending", async () => {
    const h = harness();
    await h.ask([ON]);
    const again = await h.ask([ON]);
    expect(again).toMatchObject({
      ok: true,
      value: { outcomes: { [ON.id]: { kind: "alreadyPending" } } },
    });
    expect(h.github.names().filter((name) => name === "AddPendingThread")).toHaveLength(1);
    expect(h.github.state.reviews.get("PRR_review1")?.comments).toHaveLength(1);
  });

  it("serialises two clicks at once, so the second sees the first's thread", async () => {
    const h = harness();
    const [first, second] = await Promise.all([h.ask([ON]), h.ask([ON])]);
    expect(first).toMatchObject({ ok: true, value: { outcomes: { [ON.id]: { kind: "posted" } } } });
    expect(second).toMatchObject({
      ok: true,
      value: { outcomes: { [ON.id]: { kind: "alreadyPending" } } },
    });
    expect(h.github.state.reviews.get("PRR_review1")?.comments).toHaveLength(1);
  });

  it("finds a thread whose answer was lost by its path, lines and text, and stops the batch", async () => {
    const h = harness({ github: fakeGitHub({ threads: ["landedLost"] }) });
    const answer = await h.ask([ON, ALSO]);
    expect(answer).toMatchObject({
      ok: true,
      value: {
        outcomes: { [ON.id]: { kind: "posted" }, [ALSO.id]: { kind: "skipped" } },
        state: { comments: { [ON.id]: { state: "pending" } } },
      },
    });
    expect(h.records.get(ARTIFACT)?.comments[commentFingerprint(ON)]).toMatchObject({
      threadId: null,
      commentId: "PRRC_comment2",
    });
    // The next post adds only what is missing.
    await h.ask([ON, ALSO]);
    expect(h.github.state.reviews.get("PRR_review1")?.comments).toHaveLength(2);
  });

  it("reports a lost write that did not land as the failure, and posts it later exactly once", async () => {
    const h = harness({ github: fakeGitHub({ threads: ["lost"] }) });
    expect(await h.ask([ON, ALSO])).toMatchObject({
      ok: true,
      value: {
        outcomes: {
          [ON.id]: { kind: "failed", failure: { code: "network" } },
          [ALSO.id]: { kind: "skipped" },
        },
      },
    });
    await h.ask([ON]);
    expect(h.github.state.reviews.get("PRR_review1")?.comments).toHaveLength(1);
  });

  it("finds a comment the record lost by its text, rather than posting it again", async () => {
    const h = harness();
    await h.ask([ON]);
    h.records.clear();
    expect(await h.ask([ON])).toMatchObject({
      ok: true,
      value: { outcomes: { [ON.id]: { kind: "alreadyPending" } } },
    });
    expect(h.github.state.reviews.get("PRR_review1")?.comments).toHaveLength(1);
    expect(h.records.get(ARTIFACT)?.comments[commentFingerprint(ON)]?.commentId).toBe(
      "PRRC_comment2",
    );
  });

  it("calls a 401 after the reported expiry tokenExpired, and before it unauthorized", async () => {
    const github = fakeGitHub();
    const refuse = (): Response => jsonResponse('{"message":"Bad credentials"}', { status: 401 });
    vi.mocked(github.fake.transport).mockImplementation((url: string, init: RequestInit) => {
      github.fake.calls.push({ url, init });
      return Promise.resolve(refuse());
    });
    const expired = harness({ github, expiresAt: "2026-01-01T00:00:00.000Z" });
    expect(await expired.ask([ON])).toEqual({ ok: false, failure: { code: "tokenExpired" } });
    const revoked = harness({ github, expiresAt: "2027-01-01T00:00:00.000Z" });
    expect(await revoked.ask([ON])).toEqual({ ok: false, failure: { code: "unauthorized" } });
  });

  it("refuses a comment already submitted on GitHub", async () => {
    const h = harness();
    await h.ask([ON]);
    const review = h.github.state.reviews.get("PRR_review1");
    if (review !== undefined) {
      review.state = "COMMENTED";
    }
    await h.poster.posted(SESSION_ID);
    expect(await h.ask([ON])).toMatchObject({
      ok: true,
      value: { outcomes: { [ON.id]: { kind: "failed", failure: { code: "alreadySubmitted" } } } },
    });
  });
});

describe("re-reading what was posted", () => {
  it("asks GitHub nothing when nothing is recorded", async () => {
    const h = harness();
    expect(await h.poster.posted(SESSION_ID)).toEqual({
      ok: true,
      value: { comments: {}, unverified: null },
    });
    expect(h.github.fake.calls).toEqual([]);
  });

  it("resets comments of a review discarded on GitHub to not posted, in one request", async () => {
    const h = harness();
    await h.ask([ON, ALSO]);
    h.github.state.reviews.clear();
    const before = h.github.fake.calls.length;
    expect(await h.poster.posted(SESSION_ID)).toEqual({
      ok: true,
      value: { comments: {}, unverified: null },
    });
    expect(h.github.fake.calls.length - before).toBe(1);
    expect(h.records.get(ARTIFACT)?.comments).toEqual({});
  });

  it("shows a submitted review's comments as submitted", async () => {
    const h = harness();
    await h.ask([ON]);
    const review = h.github.state.reviews.get("PRR_review1");
    if (review !== undefined) {
      review.state = "APPROVED";
    }
    expect(await h.poster.posted(SESSION_ID)).toMatchObject({
      ok: true,
      value: { comments: { [ON.id]: { state: "submitted" } } },
    });
  });

  it("drops a draft deleted on GitHub, keeping the rest", async () => {
    const h = harness();
    await h.ask([ON, ALSO]);
    const review = h.github.state.reviews.get("PRR_review1");
    if (review !== undefined) {
      review.comments = review.comments.slice(1);
    }
    expect(await h.poster.posted(SESSION_ID)).toMatchObject({
      ok: true,
      value: { comments: { [ALSO.id]: { state: "pending" } } },
    });
  });

  it("answers the record unverified without a token", async () => {
    const h = harness();
    await h.ask([ON]);
    const withoutToken = createPoster({
      client: createGitHubClient({ transport: h.github.fake.transport, userAgent: "t" }),
      vault: createCredentialVault(),
      readPullRequest: () => Promise.reject(new Error("not asked")),
      indexAt: () => Promise.reject(new Error("not asked")),
      findSession: () => session([ON, ALSO, OFF, NONE]),
      records: {
        read: (path) => Promise.resolve({ ok: true, record: h.records.get(path) ?? null }),
        write: () => Promise.resolve(true),
      },
      includeEvidence: () => false,
      exposedBy: () => [],
    });
    const before = h.github.fake.calls.length;
    expect(await withoutToken.posted(SESSION_ID)).toEqual({
      ok: true,
      value: {
        comments: { [ON.id]: { state: "pending", postable: postableDigest(ON.postable ?? "") } },
        unverified: { code: "noToken" },
      },
    });
    expect(h.github.fake.calls.length).toBe(before);
  });
});

describe("removing a pending draft", () => {
  it("deletes a pending draft of the reader's and forgets it", async () => {
    const h = harness();
    await h.ask([ON]);
    expect(await h.poster.remove({ sessionId: SESSION_ID, commentId: ON.id })).toEqual({
      ok: true,
      value: { comments: {}, unverified: null },
    });
    expect(h.github.names().slice(-2)).toEqual(["CommentState", "DeletePendingComment"]);
    expect(h.github.state.reviews.get("PRR_review1")?.comments).toEqual([]);
  });

  it("never deletes a comment that went out with a submitted review", async () => {
    const h = harness();
    await h.ask([ON]);
    const review = h.github.state.reviews.get("PRR_review1");
    if (review !== undefined) {
      review.state = "COMMENTED";
    }
    expect(await h.poster.remove({ sessionId: SESSION_ID, commentId: ON.id })).toEqual({
      ok: false,
      failure: { code: "notPending" },
    });
    expect(h.github.names()).not.toContain("DeletePendingComment");
    expect(h.records.get(ARTIFACT)?.comments[commentFingerprint(ON)]?.state).toBe("submitted");
  });

  it("refuses a comment that is not recorded as pending, asking GitHub nothing", async () => {
    const h = harness();
    expect(await h.poster.remove({ sessionId: SESSION_ID, commentId: ON.id })).toEqual({
      ok: false,
      failure: { code: "notPending" },
    });
    expect(h.github.fake.calls).toEqual([]);
  });
});

describe("what posting never does", () => {
  /** Every flow above, once more, on one GitHub — for the properties that hold across all. */
  async function everyFlow(): Promise<{ h: Harness; answers: unknown[] }> {
    watchConsole();
    const github = fakeGitHub({ threads: ["ok", "landedLost", "lost", "null"] });
    const h = harness({ github });
    // In order: each one sees what the one before it left on GitHub.
    const answers: unknown[] = [
      await h.ask([ON]),
      await h.ask([ALSO, OFF]),
      await h.ask([ALSO]),
      await h.ask([ALSO]),
      await h.poster.posted(SESSION_ID),
      await h.poster.remove({ sessionId: SESSION_ID, commentId: ON.id }),
    ];
    github.state.head = SHA_OTHER;
    answers.push(await h.ask([ON]));
    return { h, answers };
  }

  it("never asks GitHub to submit, approve or request changes", async () => {
    const { h } = await everyFlow();
    for (const operation of h.github.operations) {
      expect(operation.query).not.toMatch(/submit|event/iu);
      expect(Object.keys(operation.variables)).not.toContain("event");
      expect(JSON.stringify(operation.variables)).not.toMatch(
        /\b(?:APPROVE|REQUEST_CHANGES|COMMENT)\b/u,
      );
    }
    expect(new Set(h.github.names())).toEqual(
      new Set([
        "PendingReview",
        "StartPendingReview",
        "AddPendingThread",
        "PostedReviews",
        "CommentState",
        "DeletePendingComment",
      ]),
    );
  });

  it("sends the token only as the Authorization header, and puts it nowhere else", async () => {
    const { h, answers } = await everyFlow();
    for (const call of h.github.fake.calls) {
      expect((call.init.headers as Record<string, string>)["Authorization"]).toBe(
        `Bearer ${TOKEN}`,
      );
    }
    expect(everything(h, answers)).not.toContain(SECRET);
    expect(JSON.stringify(consoleCalls)).not.toContain(SECRET);
  });
});

describe("the review's findings, fixed", () => {
  /** A rename with a changed line, and a deleted file — GitHub's diff at the reviewed commit. */
  const RENAME_AND_DELETE = `diff --git a/old/name.ts b/new/name.ts
similarity index 80%
rename from old/name.ts
rename to new/name.ts
index 1111111..2222222 100644
--- a/old/name.ts
+++ b/new/name.ts
@@ -1,4 +1,4 @@
 one
-two
+TWO
 three
 four
diff --git a/gone.ts b/gone.ts
deleted file mode 100644
index 3333333..0000000
--- a/gone.ts
+++ /dev/null
@@ -1,2 +0,0 @@
-a
-b
`;
  const THIRD = comment("eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", { startLine: 6, endLine: 6 });

  it("posts a deletion on the old side, under a renamed file's new path, and a deleted file's range", async () => {
    const onOld = comment("11111111-1111-4111-8111-111111111111", {
      file: "old/name.ts",
      side: "deletions",
      startLine: 2,
      endLine: 2,
      postable: "See [the deleted file](gone.ts:1).",
    });
    const onGone = comment("33333333-3333-4333-8333-333333333333", {
      file: "gone.ts",
      side: "deletions",
      startLine: 1,
      endLine: 2,
    });
    const h = harness({
      comments: [onOld, onGone],
      github: fakeGitHub({ diff: RENAME_AND_DELETE }),
    });
    expect(await h.ask([onOld, onGone])).toMatchObject({
      ok: true,
      value: { outcomes: { [onOld.id]: { kind: "posted" }, [onGone.id]: { kind: "posted" } } },
    });
    const threads = h.github.operations.filter((op) => op.name === "AddPendingThread");
    expect(threads[0]?.variables).toMatchObject({ path: "new/name.ts", line: 2, side: "LEFT" });
    expect(threads[0]?.variables).not.toHaveProperty("startLine");
    // A reference to a file the change deletes cannot be a blob link at the reviewed commit.
    expect(threads[0]?.variables["body"]).toBe("See the deleted file (`gone.ts:1`).");
    expect(threads[1]?.variables).toMatchObject({
      path: "gone.ts",
      line: 2,
      side: "LEFT",
      startLine: 1,
      startSide: "LEFT",
    });
  });

  it("(C1) never drafts again a comment that went out with a review since submitted", async () => {
    const h = harness();
    await h.ask([ON]);
    const old = h.github.state.reviews.get("PRR_review1");
    if (old !== undefined) {
      old.state = "COMMENTED";
    }
    // No reconcile in between: the record still says pending.
    expect(await h.ask([ON])).toMatchObject({
      ok: true,
      value: {
        outcomes: { [ON.id]: { kind: "failed", failure: { code: "alreadySubmitted" } } },
        state: { comments: { [ON.id]: { state: "submitted" } } },
      },
    });
    expect(h.github.names().filter((name) => name === "StartPendingReview")).toHaveLength(1);
    expect(h.github.names().filter((name) => name === "AddPendingThread")).toHaveLength(1);
  });

  it("(C1) posts again a comment whose review GitHub says is gone", async () => {
    const h = harness();
    await h.ask([ON]);
    h.github.state.reviews.delete("PRR_review1");
    expect(await h.ask([ON])).toMatchObject({
      ok: true,
      value: { outcomes: { [ON.id]: { kind: "posted" } } },
    });
    expect(h.records.get(ARTIFACT)?.comments[commentFingerprint(ON)]?.reviewId).toBe("PRR_review3");
  });

  it("(C1) posts nothing for a recorded comment GitHub will not say anything about", async () => {
    const h = harness();
    await h.ask([ON]);
    h.github.state.reviews.delete("PRR_review1");
    h.github.state.forbidNodes = true;
    expect(await h.ask([ON])).toMatchObject({
      ok: true,
      value: { outcomes: { [ON.id]: { kind: "failed", failure: { code: "forbidden" } } } },
    });
    expect(h.github.names().filter((name) => name === "AddPendingThread")).toHaveLength(1);
    expect(h.records.get(ARTIFACT)?.comments[commentFingerprint(ON)]?.state).toBe("pending");
  });

  it("(C2) keeps the record, unverified, when GitHub answers FORBIDDEN beside a null", async () => {
    const h = harness();
    await h.ask([ON]);
    h.github.state.forbidNodes = true;
    const before = structuredClone(h.records.get(ARTIFACT));
    expect(await h.poster.posted(SESSION_ID)).toMatchObject({
      ok: true,
      value: { comments: { [ON.id]: { state: "pending" } }, unverified: { code: "forbidden" } },
    });
    expect(h.records.get(ARTIFACT)).toEqual(before);
    // …and Remove neither deletes nor forgets it.
    expect(await h.poster.remove({ sessionId: SESSION_ID, commentId: ON.id })).toEqual({
      ok: false,
      failure: { code: "forbidden" },
    });
    expect(h.records.get(ARTIFACT)).toEqual(before);
    expect(h.github.names()).not.toContain("DeletePendingComment");
  });

  it("(C3) finds a lost thread by the review's own line numbers after the head moved", async () => {
    const h = harness({ github: fakeGitHub({ threads: ["landedLost"], drift: 5 }) });
    expect(await h.ask([ON])).toMatchObject({
      ok: true,
      value: { outcomes: { [ON.id]: { kind: "posted" } } },
    });
    await h.ask([ON]);
    expect(h.github.state.reviews.get("PRR_review1")?.comments).toHaveLength(1);
  });

  it("(C3) does not take a comment on the other side of the diff for this one", async () => {
    const github = fakeGitHub();
    const left = comment("44444444-4444-4444-8444-444444444444", {
      side: "deletions",
      startLine: 1,
      endLine: 1,
    });
    const body = postableComment(left, {
      includeEvidence: false,
      references: {
        kind: "github",
        owner: "octocat",
        repo: "Hello-World",
        sha: SHA_HEAD,
        absentAtHead: new Set(),
      },
    });
    github.state.reviews.set("PRR_mine", {
      commit: SHA_HEAD,
      viewer: true,
      state: "PENDING",
      comments: [
        {
          id: "PRRC_right",
          path: "README",
          line: 1,
          startLine: null,
          side: "RIGHT",
          startSide: null,
          body: body ?? "",
        },
      ],
    });
    const h = harness({ comments: [left], github });
    expect(await h.ask([left])).toMatchObject({
      ok: true,
      value: { outcomes: { [left.id]: { kind: "posted" } } },
    });
  });

  it("(C4) stops at a review submitted mid-batch, recording what went with it", async () => {
    const h = harness({
      comments: [ON, ALSO, THIRD],
      github: fakeGitHub({ submitBeforeThread: 2 }),
    });
    expect(await h.ask([ON, ALSO, THIRD])).toMatchObject({
      ok: true,
      value: {
        outcomes: {
          [ON.id]: { kind: "posted" },
          [ALSO.id]: { kind: "failed", failure: { code: "submittedMeanwhile" } },
          [THIRD.id]: { kind: "skipped", because: { code: "submittedMeanwhile" } },
        },
        stoppedBy: { code: "submittedMeanwhile" },
      },
    });
    expect(h.records.get(ARTIFACT)?.comments[commentFingerprint(ALSO)]?.state).toBe("submitted");
  });

  it("(C4) stops the batch at UNPROCESSABLE, which a no-longer-pending review can answer", async () => {
    const h = harness({ github: fakeGitHub({ threads: ["unprocessable"] }) });
    expect(await h.ask([ON, ALSO])).toMatchObject({
      ok: true,
      value: {
        outcomes: {
          [ON.id]: { kind: "failed", failure: { code: "unprocessable" } },
          [ALSO.id]: { kind: "skipped", because: { code: "unprocessable" } },
        },
        stoppedBy: { code: "unprocessable" },
      },
    });
  });

  it("(C5) records a digest of the text that went", async () => {
    const h = harness();
    await h.ask([ON]);
    expect(h.records.get(ARTIFACT)?.comments[commentFingerprint(ON)]?.postable).toBe(
      postableDigest(ON.postable ?? ""),
    );
  });

  it("(C8) says what stopped a batch, on the answer and on each comment it did not reach", async () => {
    const h = harness({ github: fakeGitHub({ threads: ["lost"] }) });
    expect(await h.ask([ON, ALSO])).toMatchObject({
      ok: true,
      value: {
        outcomes: { [ALSO.id]: { kind: "skipped", because: { code: "network" } } },
        stoppedBy: { code: "network" },
      },
    });
  });

  it("(C11a) leaves a second between thread mutations", async () => {
    const h = harness({ comments: [ON, ALSO, THIRD] });
    await h.ask([ON, ALSO, THIRD]);
    expect(h.pause.mock.calls).toEqual([[PACE_MS], [PACE_MS]]);
    expect(PACE_MS).toBe(1000);
  });

  it("(C11c) refuses to add to a pending review holding more than it reads back", async () => {
    const github = fakeGitHub({ overflowing: true });
    github.state.reviews.set("PRR_mine", {
      commit: SHA_HEAD,
      viewer: true,
      state: "PENDING",
      comments: [],
    });
    const h = harness({ github });
    expect(await h.ask([ON])).toEqual({ ok: false, failure: { code: "pendingReviewFull" } });
    expect(h.github.names()).toEqual(["PendingReview"]);
  });

  it("(C11d) refuses to post over a record it cannot read, asking GitHub nothing", async () => {
    const h = harness({ unreadable: true });
    expect(await h.ask([ON])).toEqual({ ok: false, failure: { code: "recordUnreadable" } });
    expect(await h.poster.remove({ sessionId: SESSION_ID, commentId: ON.id })).toEqual({
      ok: false,
      failure: { code: "recordUnreadable" },
    });
    expect(h.github.fake.calls).toEqual([]);
  });

  it("(S2) refuses to post or remove while the app is exposed", async () => {
    const h = harness({ exposedBy: ["remote-debugging-port"] });
    expect(await h.ask([ON])).toEqual({ ok: false, failure: { code: "debuggingEnabled" } });
    expect(await h.poster.remove({ sessionId: SESSION_ID, commentId: ON.id })).toEqual({
      ok: false,
      failure: { code: "debuggingEnabled" },
    });
    expect(h.github.fake.calls).toEqual([]);
  });

  it("(S6) refuses a body past GitHub's limit before any write", async () => {
    const long = comment("55555555-5555-4555-8555-555555555555", { postable: "x".repeat(65_537) });
    const h = harness({ comments: [long] });
    expect(await h.ask([long])).toMatchObject({
      ok: true,
      value: { outcomes: { [long.id]: { kind: "failed", failure: { code: "bodyTooLong" } } } },
    });
    expect(h.github.names()).toEqual([]);
  });

  it("asks again when the head moved again after the reader accepted the first move", async () => {
    const h = harness({ github: fakeGitHub({ head: SHA_OTHER }) });
    expect(await h.ask([ON])).toMatchObject({ failure: { code: "headMoved", head: SHA_OTHER } });
    const later = "3".repeat(40);
    h.github.state.head = later;
    expect(await h.ask([ON], SHA_OTHER)).toEqual({
      ok: false,
      failure: { code: "headMoved", head: later },
    });
    expect(h.github.names()).toEqual([]);
  });
});
