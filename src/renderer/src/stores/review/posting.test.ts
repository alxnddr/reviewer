import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { postableDigest, type GitHubPostResponse } from "../../../../shared/github-posting";
import type { Comment, ReviewOrigin } from "../../../../shared/review";
import { NO_POSTING } from "../../lib/github-posting";
import { stubBridge } from "../__fixtures__/bridge";
import { createReviewStore, createSessionSlice, type ReviewStore } from "../review";

// The posting slice's half of Layer C: what it sends main and in what order, and what it does
// with each kind of answer. Main's half — what is actually posted — is `main/github/posting.ts`'s
// suite; this one holds the renderer to sending ids and digests, never bodies, and to sending a
// pending edit *before* the post that must see it.

const SESSION = "11111111-1111-4111-8111-111111111111";
const HEAD = "a".repeat(40);
const MOVED = "b".repeat(40);

const ORIGIN: ReviewOrigin = {
  repo: { path: "/repo", name: "repo" },
  base: "main",
  head: HEAD,
  patch: null,
  reviewedHead: HEAD,
  pr: { host: "github.com", owner: "acme", repo: "widget", number: 7 },
};

function comment(id: string, postable: string | null): Comment {
  return {
    id,
    file: "README",
    side: "additions",
    startLine: 1,
    endLine: 1,
    body: "finding",
    ...(postable === null ? {} : { postable }),
  };
}

const A = comment("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "Text for A.");
const B = comment("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "Text for B.");
const BARE = comment("cccccccc-cccc-4ccc-8ccc-cccccccccccc", null);

let store: ReviewStore;

beforeEach(() => {
  store = createReviewStore();
  store.setState({
    activeSessionId: SESSION,
    sessions: {
      [SESSION]: createSessionSlice(
        { id: SESSION, repo: ORIGIN.repo },
        { needsDerive: false, comments: [A, B, BARE], reviewOrigin: ORIGIN },
      ),
    },
  });
});

afterEach(() => {
  store.getState().cancelWriteBacks();
  vi.unstubAllGlobals();
});

function posting() {
  return store.getState().sessions[SESSION]?.posting ?? NO_POSTING;
}

describe("postComments", () => {
  it("sends a pending edit first, then ids and digests of the text on screen — never a body", async () => {
    const order: string[] = [];
    const bridge = stubBridge({
      updateSession: vi.fn(() => {
        order.push("updateSession");
        return Promise.resolve();
      }),
      postGitHubComments: vi.fn(() => {
        order.push("post");
        return Promise.resolve<GitHubPostResponse>({
          ok: true,
          value: {
            outcomes: { [A.id]: { kind: "posted" } },
            state: { comments: { [A.id]: { state: "pending", postable: null } }, unverified: null },
            stoppedBy: null,
          },
        });
      }),
    });
    store.getState().editComment(A.id, "postable", "Edited for the author.");
    await store.getState().postComments([A.id]);
    expect(order).toEqual(["updateSession", "post"]);
    expect(bridge.postGitHubComments).toHaveBeenCalledWith({
      sessionId: SESSION,
      comments: [{ id: A.id, postable: postableDigest("Edited for the author.") }],
    });
    expect(JSON.stringify(vi.mocked(bridge.postGitHubComments).mock.calls)).not.toContain(
      "Edited for the author",
    );
    expect(posting().posted?.comments[A.id]?.state).toBe("pending");
    expect(posting().busy).toBe(false);
  });

  it("holds a moved head as a question, and posts over exactly that head when answered yes", async () => {
    const post = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, failure: { code: "headMoved", head: MOVED } })
      .mockResolvedValueOnce({
        ok: true,
        value: { outcomes: {}, state: { comments: {}, unverified: null }, stoppedBy: null },
      });
    stubBridge({ postGitHubComments: post });
    await store.getState().postComments([A.id, B.id]);
    expect(posting().headMoved).toEqual({ head: MOVED, ids: [A.id, B.id] });
    await store.getState().confirmHeadMoved();
    expect(post).toHaveBeenLastCalledWith(
      expect.objectContaining({ acceptHead: MOVED, comments: expect.any(Array) }),
    );
    expect(posting().headMoved).toBeNull();
  });

  it("answered no, posts nothing", async () => {
    const post = vi
      .fn()
      .mockResolvedValue({ ok: false, failure: { code: "headMoved", head: MOVED } });
    stubBridge({ postGitHubComments: post });
    await store.getState().postComments([A.id]);
    store.getState().dismissHeadMoved();
    expect(posting().headMoved).toBeNull();
    expect(post).toHaveBeenCalledTimes(1);
  });

  it("notes a failure that stopped the post on every card it was about", async () => {
    stubBridge({
      postGitHubComments: vi.fn().mockResolvedValue({ ok: false, failure: { code: "noToken" } }),
    });
    await store.getState().postComments([A.id]);
    expect(posting().failure).toEqual({ code: "noToken" });
    expect(posting().outcomes[A.id]).toEqual({ kind: "failed", failure: { code: "noToken" } });
  });

  it("turns an IPC that threw into a typed failure, never a rejection", async () => {
    stubBridge({ postGitHubComments: vi.fn().mockRejectedValue(new Error("boom")) });
    vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(store.getState().postComments([A.id])).resolves.toBeUndefined();
    expect(posting().failure).toEqual({ code: "unexpected" });
    expect(posting().busy).toBe(false);
  });
});

describe("removePendingComment", () => {
  it("replaces the posted states with main's answer", async () => {
    stubBridge({
      deleteGitHubPendingComment: vi.fn().mockResolvedValue({
        ok: true,
        value: { comments: {}, unverified: null },
      }),
    });
    await store.getState().removePendingComment(A.id);
    expect(posting().posted).toEqual({ comments: {}, unverified: null });
  });

  it("re-reads the states when main says it is not pending any more", async () => {
    const bridge = stubBridge({
      deleteGitHubPendingComment: vi
        .fn()
        .mockResolvedValue({ ok: false, failure: { code: "notPending" } }),
      getGitHubPosted: vi.fn().mockResolvedValue({
        ok: true,
        value: { comments: { [A.id]: { state: "submitted", postable: null } }, unverified: null },
      }),
    });
    await store.getState().removePendingComment(A.id);
    expect(bridge.getGitHubPosted).toHaveBeenCalledWith({ sessionId: SESSION });
    expect(posting().posted?.comments[A.id]?.state).toBe("submitted");
  });
});

describe("refreshPosted", () => {
  it("(C7) keeps the states on screen when main cannot check them, and says so", async () => {
    stubBridge({
      getGitHubPosted: vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          value: { comments: { [A.id]: { state: "pending", postable: null } }, unverified: null },
        })
        .mockResolvedValueOnce({ ok: false, failure: { code: "recordUnreadable" } }),
    });
    await store.getState().refreshPosted(SESSION);
    await store.getState().refreshPosted(SESSION);
    expect(posting().posted).toEqual({
      comments: { [A.id]: { state: "pending", postable: null } },
      unverified: { code: "recordUnreadable" },
    });
  });
});

describe("recheckWithToken", () => {
  it("asks again, with the new token, about every open review of a pull request it covers", async () => {
    const bridge = stubBridge();
    await store.getState().recheckWithToken("ACME");
    expect(bridge.checkGitHubDiff).toHaveBeenCalledTimes(1);
    expect(bridge.getGitHubPosted).toHaveBeenCalledWith({ sessionId: SESSION });
  });

  it("leaves reviews of other owners alone", async () => {
    const bridge = stubBridge();
    await store.getState().recheckWithToken("someone-else");
    expect(bridge.checkGitHubDiff).not.toHaveBeenCalled();
    expect(bridge.getGitHubPosted).not.toHaveBeenCalled();
  });
});
