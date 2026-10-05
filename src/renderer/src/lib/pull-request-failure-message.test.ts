import { describe, expect, it } from "vitest";
import type { PullRequestFailure } from "../../../shared/pull-request-ipc";
import {
  pullRequestFailureMessage,
  pullRequestInputMessage,
  type PullRequestInputProblem,
} from "./pull-request-failure-message";

describe("pullRequestFailureMessage", () => {
  it("has a sentence for every failure code, naming the path or branch it is about", () => {
    const failures: [PullRequestFailure, string][] = [
      [{ code: "git", failure: { code: "authFailed" } }, "credentials"],
      [{ code: "noMatchingRemote", repo: "/code/widget" }, "/code/widget"],
      [{ code: "prNotFound" }, "no pull request"],
      [{ code: "baseNotFound", base: "develop" }, "develop"],
      [{ code: "worktreeDirty", path: "/wt/acme/widget-12", reason: "uncommitted" }, "uncommitted"],
      [
        { code: "worktreeDirty", path: "/wt/acme/widget-12", reason: "commits" },
        "not on any branch",
      ],
      [{ code: "worktreeOnBranch", path: "/wt/acme/widget-12", branch: "fix" }, "branch fix"],
      [{ code: "cancelled" }, "Cancelled"],
      [
        {
          code: "worktreeLocked",
          path: "/wt/acme/widget-12",
          checkout: "/code/w",
          reason: "initializing",
        },
        "never finished",
      ],
      [{ code: "worktreePathTaken", path: "/wt/acme/widget-12" }, "/wt/acme/widget-12"],
      [{ code: "worktreeOpen", path: "/wt/acme/widget-12" }, "Close that review"],
      [{ code: "notAWorktree", path: "/wt/acme/widget-12" }, "/wt/acme/widget-12"],
      [{ code: "cloneTargetExists", path: "/code/widget" }, "/code/widget"],
    ];
    for (const [failure, fragment] of failures) {
      expect(pullRequestFailureMessage(failure)).toContain(fragment);
    }
  });

  it("offers to remove a locked worktree only when its checkout never finished, by its real path", () => {
    const path = "/Users/me/Library/Application Support/Reviewer/worktrees/acme/it's-12";
    const quoted = "'/Users/me/Library/Application Support/Reviewer/worktrees/acme/it'\\''s-12'";
    const locked = (reason: string): string =>
      pullRequestFailureMessage({ code: "worktreeLocked", path, checkout: "/code/w", reason });

    const unfinished = locked("initializing");
    expect(unfinished).toContain("never finished");
    expect(unfinished).toContain(`git -C '/code/w' worktree unlock ${quoted}`);
    expect(unfinished).toContain(`git -C '/code/w' worktree remove --force ${quoted}`);

    // A lock someone took on purpose says nothing about the tree: unlock, and nothing more.
    for (const reason of ["on a removable drive", ""]) {
      const deliberate = locked(reason);
      expect(deliberate).toContain(`git -C '/code/w' worktree unlock ${quoted}`);
      expect(deliberate).not.toContain("remove");
      expect(deliberate).not.toContain("never finished");
    }
    expect(locked("on a removable drive")).toContain("(on a removable drive)");
    // Never a placeholder for the reader to fill in.
    expect(unfinished).not.toContain("<path>");
  });

  it("throws on an unknown code", () => {
    expect(() =>
      pullRequestFailureMessage({ code: "nonsense" } as unknown as PullRequestFailure),
    ).toThrow(/Unhandled variant/u);
  });
});

describe("pullRequestInputMessage", () => {
  it("tells a bare number apart from text that is no pull request at all", () => {
    const problems: PullRequestInputProblem[] = ["number", "notGitHub", "unparseable"];
    const sentences = problems.map((problem) => pullRequestInputMessage(problem));
    expect(new Set(sentences).size).toBe(problems.length);
    expect(pullRequestInputMessage("number")).toContain("owner/repo#123");
  });
});
