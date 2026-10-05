import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { githubPullRequestOf } from "../../../shared/pull-request";
import type { GitHubInboxResponse, GitHubPullRequestResponse } from "../../../shared/github-ipc";
import type { PullRequestLocateResponse } from "../../../shared/pull-request-ipc";
import { readPullRequestInput } from "../lib/pull-request-input";
import { SHA_A, stubBridge } from "./__fixtures__/bridge";
import {
  INBOX_FRESH_MS,
  initialBase,
  promptFor,
  suggestedBase,
  usePullRequestStore,
  validBase,
} from "./pull-request";

// Review Pull Request…'s state machine, without a window: the steps happen in order, each one
// answers into the state the dialog draws, and an answer for a pull request the reader has
// already moved on from is dropped rather than drawn under the wrong one.

const PR = githubPullRequestOf({ owner: "acme", repo: "widget" }, 12);
const FOUND: PullRequestLocateResponse = {
  ok: true,
  value: {
    kind: "found",
    checkout: { repo: { path: "/code/widget", name: "widget" }, remote: "upstream" },
    base: { name: "main", from: "remoteHead" },
  },
};

const INITIAL = usePullRequestStore.getState();

beforeEach(() => {
  usePullRequestStore.setState(INITIAL, true);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("readPullRequestInput", () => {
  it("reads an address and owner/repo#n, and refuses a bare number in the dialog", () => {
    expect(readPullRequestInput("   ")).toEqual({ kind: "empty" });
    expect(readPullRequestInput("https://github.com/acme/widget/pull/12/files")).toEqual({
      kind: "pullRequest",
      pullRequest: PR,
    });
    expect(readPullRequestInput("acme/widget#12")).toEqual({
      kind: "pullRequest",
      pullRequest: PR,
    });
    expect(readPullRequestInput("#12")).toEqual({ kind: "problem", problem: "number" });
    expect(readPullRequestInput("https://gitlab.com/a/b/pull/1")).toEqual({
      kind: "problem",
      problem: "notGitHub",
    });
    expect(readPullRequestInput("not a pr")).toEqual({ kind: "problem", problem: "unparseable" });
  });
});

describe("the base field", () => {
  it("starts from the suggestion, and accepts only a name git would", () => {
    expect(initialBase({ name: "develop", from: "localDefault" })).toBe("develop");
    expect(initialBase(null)).toBe("");
    expect(validBase(" main ")).toBe("main");
    expect(validBase("")).toBeNull();
    expect(validBase("-x")).toBeNull();
    expect(validBase("a b")).toBeNull();
    // Names BranchName admits and git refuses are field errors too, never a failed fetch.
    expect(validBase("a/.b")).toBeNull();
    expect(validBase("a.lock/b")).toBeNull();
  });
});

describe("suggestedBase", () => {
  const local = { name: "main", from: "remoteHead" } as const;
  const info = { title: "t", state: "open", draft: false, head: SHA_A } as const;

  it("takes GitHub's base over the checkout's guess, and the guess without it", () => {
    expect(suggestedBase(local, { phase: "loaded", info: { ...info, base: "release" } })).toEqual({
      name: "release",
      from: "api",
    });
    expect(suggestedBase(local, { phase: "loaded", info: { ...info, base: null } })).toBe(local);
    expect(suggestedBase(local, { phase: "failed", failure: { code: "notFound" } })).toBe(local);
    expect(suggestedBase(null, { phase: "loading" })).toBeNull();
  });
});

describe("promptFor", () => {
  it("writes the pull request's URL, the worktree, the base ref and the head into the template", () => {
    const prompt = promptFor("{pr}|{worktree}|{base}|{head}", PR, {
      worktree: "/wt/acme/widget-12",
      head: SHA_A,
      base: "upstream/main",
      change: "created",
    });
    expect(prompt).toBe(
      `https://github.com/acme/widget/pull/12|/wt/acme/widget-12|upstream/main|${SHA_A}`,
    );
  });
});

describe("usePullRequestStore", () => {
  it("finds a checkout and prefills the base from it", async () => {
    const bridge = stubBridge({ locatePullRequestCheckout: vi.fn().mockResolvedValue(FOUND) });
    await usePullRequestStore.getState().locate(PR);
    expect(bridge.locatePullRequestCheckout).toHaveBeenCalledWith({ pullRequest: PR });
    const state = usePullRequestStore.getState();
    expect(state.target).toBe(PR);
    expect(state.checkout).toMatchObject({ kind: "found", checkout: { remote: "upstream" } });
    expect(state.base).toBe("main");
    expect(state.busy).toBeNull();
  });

  it("offers Locate and the clone when no checkout is known, and keeps it on a dismissed picker", async () => {
    stubBridge();
    await usePullRequestStore.getState().locate(PR);
    expect(usePullRequestStore.getState().checkout).toEqual({ kind: "notFound" });
    await usePullRequestStore.getState().pickCheckout();
    expect(usePullRequestStore.getState().checkout).toEqual({ kind: "notFound" });
    expect(usePullRequestStore.getState().busy).toBeNull();
  });

  it("shows a refused location without losing the pull request", async () => {
    stubBridge({
      pickPullRequestCheckout: vi.fn().mockResolvedValue({
        ok: false,
        failure: { code: "noMatchingRemote", repo: "/code/other" },
      }),
    });
    await usePullRequestStore.getState().locate(PR);
    await usePullRequestStore.getState().pickCheckout();
    const state = usePullRequestStore.getState();
    expect(state.failure).toEqual({ code: "noMatchingRemote", repo: "/code/other" });
    expect(state.target).toBe(PR);
  });

  it("prepares with the checkout and base on screen, and answers the prompt", async () => {
    const bridge = stubBridge({ locatePullRequestCheckout: vi.fn().mockResolvedValue(FOUND) });
    await usePullRequestStore.getState().locate(PR);
    usePullRequestStore.getState().setBase("release");
    const prepared = await usePullRequestStore.getState().prepare("review {pr} at {head}");
    expect(bridge.preparePullRequest).toHaveBeenCalledWith({
      pullRequest: PR,
      checkout: { repoPath: "/code/widget", remote: "upstream" },
      base: "release",
    });
    expect(prepared?.prompt).toBe(`review https://github.com/acme/widget/pull/12 at ${SHA_A}`);
    expect(usePullRequestStore.getState().prepared).toEqual(prepared);
    // The list re-reads, so the new worktree is a row.
    expect(bridge.listPullRequestWorktrees).toHaveBeenCalled();
  });

  it("refuses to prepare without a valid base", async () => {
    const bridge = stubBridge({ locatePullRequestCheckout: vi.fn().mockResolvedValue(FOUND) });
    await usePullRequestStore.getState().locate(PR);
    usePullRequestStore.getState().setBase("not a branch");
    expect(await usePullRequestStore.getState().prepare("{pr}")).toBeNull();
    expect(bridge.preparePullRequest).not.toHaveBeenCalled();
  });

  it("drops an answer for a pull request the reader has moved on from", async () => {
    let answer: (response: PullRequestLocateResponse) => void = () => {};
    stubBridge({
      locatePullRequestCheckout: vi
        .fn()
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              answer = resolve;
            }),
        )
        .mockResolvedValue({ ok: true, value: { kind: "notFound" } }),
    });
    const first = usePullRequestStore.getState().locate(PR);
    // The reader pastes another while the first is still looking.
    usePullRequestStore.setState({ busy: null });
    const other = githubPullRequestOf({ owner: "acme", repo: "gadget" }, 3);
    await usePullRequestStore.getState().locate(other);
    answer(FOUND);
    await first;
    expect(usePullRequestStore.getState().target).toBe(other);
    expect(usePullRequestStore.getState().checkout).toEqual({ kind: "notFound" });
  });

  it("removes a worktree, says why one was refused, and re-reads the list either way", async () => {
    const bridge = stubBridge({
      removePullRequestWorktree: vi
        .fn()
        .mockResolvedValueOnce({ ok: false, failure: { code: "worktreeOpen", path: "/wt/a-1" } })
        .mockResolvedValue({ ok: true, value: { path: "/wt/a-1" } }),
    });
    const store = usePullRequestStore.getState();
    // Unconfirmed, nothing is removed: the first press only asks.
    await store.removeWorktree("/wt/a-1");
    expect(bridge.removePullRequestWorktree).not.toHaveBeenCalled();
    store.askRemove("/wt/a-1");
    expect(usePullRequestStore.getState().confirmingRemoval).toBe("/wt/a-1");
    store.cancelRemove();
    await store.removeWorktree("/wt/a-1");
    expect(bridge.removePullRequestWorktree).not.toHaveBeenCalled();

    store.askRemove("/wt/a-1");
    await store.removeWorktree("/wt/a-1");
    expect(usePullRequestStore.getState().removeFailure).toEqual({
      path: "/wt/a-1",
      failure: { code: "worktreeOpen", path: "/wt/a-1" },
    });
    expect(usePullRequestStore.getState().confirmingRemoval).toBeNull();
    store.askRemove("/wt/a-1");
    await store.removeWorktree("/wt/a-1");
    expect(usePullRequestStore.getState().removeFailure).toBeNull();
    expect(bridge.removePullRequestWorktree).toHaveBeenCalledTimes(2);
    expect(bridge.listPullRequestWorktrees).toHaveBeenCalledTimes(2);
  });

  it("cancels only an operation Cancel can stop, and a cancelled prepare says so quietly", async () => {
    const bridge = stubBridge({
      locatePullRequestCheckout: vi.fn().mockResolvedValue(FOUND),
      preparePullRequest: vi.fn().mockResolvedValue({ ok: false, failure: { code: "cancelled" } }),
    });
    await usePullRequestStore.getState().cancel();
    expect(bridge.cancelPullRequest).not.toHaveBeenCalled();
    await usePullRequestStore.getState().locate(PR);
    const preparing = usePullRequestStore.getState().prepare("{pr}");
    expect(usePullRequestStore.getState().busy).toBe("preparing");
    await usePullRequestStore.getState().cancel();
    expect(bridge.cancelPullRequest).toHaveBeenCalledTimes(1);
    expect(await preparing).toBeNull();
    expect(usePullRequestStore.getState()).toMatchObject({
      busy: null,
      failure: { code: "cancelled" },
    });
  });

  it("keeps an operation running, and visible, across closing the dialog", async () => {
    let answer: (value: unknown) => void = () => {};
    stubBridge({
      locatePullRequestCheckout: vi.fn().mockResolvedValue(FOUND),
      preparePullRequest: vi.fn().mockImplementation(
        () =>
          new Promise((resolve) => {
            answer = resolve;
          }),
      ),
    });
    usePullRequestStore.getState().openDialog();
    await usePullRequestStore.getState().locate(PR);
    const preparing = usePullRequestStore.getState().prepare("{pr}");
    usePullRequestStore.getState().close();
    usePullRequestStore.getState().openDialog();
    expect(usePullRequestStore.getState().busy).toBe("preparing");
    answer({
      ok: true,
      value: {
        worktree: "/wt/acme/widget-12",
        head: SHA_A,
        base: "origin/main",
        change: "created",
      },
    });
    expect((await preparing)?.prompt).toBe("https://github.com/acme/widget/pull/12");
  });

  it("prefills GitHub's base whichever answer lands first, and asks about the pull request once", async () => {
    const github: GitHubPullRequestResponse = {
      ok: true,
      value: { title: "Fix it", state: "open", draft: true, base: "release", head: SHA_A },
    };
    let answerGitHub: (response: GitHubPullRequestResponse) => void = () => {};
    const bridge = stubBridge({
      locatePullRequestCheckout: vi.fn().mockResolvedValue(FOUND),
      getGitHubPullRequest: vi.fn().mockImplementation(
        () =>
          new Promise((resolve) => {
            answerGitHub = resolve;
          }),
      ),
    });
    // The checkout first: the local guess stands until GitHub answers…
    await usePullRequestStore.getState().locate(PR);
    expect(usePullRequestStore.getState().base).toBe("main");
    expect(usePullRequestStore.getState().info).toEqual({ phase: "loading" });
    answerGitHub(github);
    await vi.waitFor(() => expect(usePullRequestStore.getState().base).toBe("release"));
    expect(usePullRequestStore.getState().info).toEqual({ phase: "loaded", info: github.value });
    expect(bridge.getGitHubPullRequest).toHaveBeenCalledWith({ pullRequest: PR });

    // …and GitHub first: the checkout lands on GitHub's base directly.
    usePullRequestStore.setState(INITIAL, true);
    stubBridge({
      locatePullRequestCheckout: vi.fn().mockImplementation(async () => {
        await new Promise((resolve) => {
          setTimeout(resolve, 5);
        });
        return FOUND;
      }),
      getGitHubPullRequest: vi.fn().mockResolvedValue(github),
    });
    await usePullRequestStore.getState().locate(PR);
    expect(usePullRequestStore.getState().base).toBe("release");
  });

  it("never overwrites a base the reader typed, and keeps the local guess when GitHub cannot say", async () => {
    let answerGitHub: (response: GitHubPullRequestResponse) => void = () => {};
    stubBridge({
      locatePullRequestCheckout: vi.fn().mockResolvedValue(FOUND),
      getGitHubPullRequest: vi.fn().mockImplementation(
        () =>
          new Promise((resolve) => {
            answerGitHub = resolve;
          }),
      ),
    });
    await usePullRequestStore.getState().locate(PR);
    usePullRequestStore.getState().setBase("develop");
    answerGitHub({
      ok: true,
      value: { title: "t", state: "merged", draft: false, base: "release", head: SHA_A },
    });
    await vi.waitFor(() => expect(usePullRequestStore.getState().info.phase).toBe("loaded"));
    expect(usePullRequestStore.getState().base).toBe("develop");

    usePullRequestStore.setState(INITIAL, true);
    stubBridge({ locatePullRequestCheckout: vi.fn().mockResolvedValue(FOUND) });
    await usePullRequestStore.getState().locate(PR);
    await vi.waitFor(() => expect(usePullRequestStore.getState().info.phase).toBe("failed"));
    expect(usePullRequestStore.getState().base).toBe("main");
  });
});

describe("the inbox", () => {
  const INBOX: GitHubInboxResponse = {
    ok: true,
    value: {
      items: [
        {
          pullRequest: PR,
          title: "Fix it",
          author: "someone",
          updatedAt: "2026-10-01T00:00:00Z",
          draft: false,
        },
      ],
      total: 1,
      incomplete: false,
    },
  };

  afterEach(() => {
    vi.useRealTimers();
  });

  it("asks for the login's review requests, and not again while the list is fresh", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const bridge = stubBridge({ listReviewRequests: vi.fn().mockResolvedValue(INBOX) });
    const { refreshInbox } = usePullRequestStore.getState();
    await refreshInbox("octocat");
    expect(bridge.listReviewRequests).toHaveBeenCalledWith({ login: "octocat" });
    expect(usePullRequestStore.getState().inbox).toMatchObject({
      phase: "loaded",
      login: "octocat",
      rows: INBOX.value,
    });
    await refreshInbox("octocat");
    expect(bridge.listReviewRequests).toHaveBeenCalledTimes(1);
    // Refresh always asks; so does a reopening once the list has aged.
    await refreshInbox("octocat", { force: true });
    expect(bridge.listReviewRequests).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(INBOX_FRESH_MS);
    await refreshInbox("octocat");
    expect(bridge.listReviewRequests).toHaveBeenCalledTimes(3);
    // Another login is another list.
    await refreshInbox("hubot");
    expect(bridge.listReviewRequests).toHaveBeenLastCalledWith({ login: "hubot" });
  });

  it("keeps the last list on screen under a failed refresh", async () => {
    stubBridge({
      listReviewRequests: vi
        .fn()
        .mockResolvedValueOnce(INBOX)
        .mockResolvedValue({
          ok: false,
          failure: { code: "rateLimited", resetAt: 1, scope: "anonymous" },
        }),
    });
    await usePullRequestStore.getState().refreshInbox("octocat");
    await usePullRequestStore.getState().refreshInbox("octocat", { force: true });
    expect(usePullRequestStore.getState().inbox).toEqual({
      phase: "failed",
      login: "octocat",
      rows: INBOX.value,
      failure: { code: "rateLimited", resetAt: 1, scope: "anonymous" },
    });
  });

  it("drops an answer for a login the reader has since changed", async () => {
    let answer: (response: GitHubInboxResponse) => void = () => {};
    stubBridge({
      listReviewRequests: vi
        .fn()
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              answer = resolve;
            }),
        )
        .mockResolvedValue({ ok: true, value: { items: [], total: 0, incomplete: false } }),
    });
    const first = usePullRequestStore.getState().refreshInbox("octocat");
    await usePullRequestStore.getState().refreshInbox("hubot");
    answer(INBOX);
    await first;
    expect(usePullRequestStore.getState().inbox).toMatchObject({ phase: "loaded", login: "hubot" });
  });

  it("settles a rejected IPC call as a failure, never a list left loading", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    stubBridge({ listReviewRequests: vi.fn().mockRejectedValue(new Error("IPC rejected")) });
    await usePullRequestStore.getState().refreshInbox("octocat");
    expect(usePullRequestStore.getState().inbox).toEqual({
      phase: "failed",
      login: "octocat",
      rows: null,
      failure: { code: "unexpected" },
    });
  });
});

describe("GitHub's account of the pull request", () => {
  it("settles a rejected IPC call as a failure, and the local base stands", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    stubBridge({
      locatePullRequestCheckout: vi.fn().mockResolvedValue(FOUND),
      getGitHubPullRequest: vi.fn().mockRejectedValue(new Error("IPC rejected")),
    });
    await usePullRequestStore.getState().locate(PR);
    await vi.waitFor(() =>
      expect(usePullRequestStore.getState().info).toEqual({
        phase: "failed",
        failure: { code: "unexpected" },
      }),
    );
    expect(usePullRequestStore.getState().base).toBe("main");
  });
});
