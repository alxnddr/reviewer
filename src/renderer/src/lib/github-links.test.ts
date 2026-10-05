import { describe, expect, it } from "vitest";
import { parsePatch } from "../../../shared/diff/patch";
import { MULTI_STATUS_PATCH } from "../../../shared/diff/fixtures";
import type { PullRequest } from "../../../shared/pull-request";
import {
  diffLineFragment,
  githubDiffPath,
  githubFilesPageUrl,
  githubFilesUrl,
  githubCheckNote,
  githubHeadOf,
  openOnGitHubHint,
  outsideGitHubDiff,
  prHeadDrift,
  reviewedFilesFor,
  settleGitHubCheck,
  sha256Hex,
  type GitHubCheckState,
} from "./github-links";

const PR: PullRequest = { host: "github.com", owner: "acme", repo: "widgets", number: 42 };
const DIGEST = "d".repeat(64);
const REVIEWED = "a".repeat(40);
const MOVED = "b".repeat(40);
// added.txt, doomed.txt (deleted), greet.ts, img.png, oldname.txt → newname.txt, notes.txt…
const FILES = parsePatch(MULTI_STATUS_PATCH, "github-links");

describe("githubFilesUrl", () => {
  it("opens the Files view at one line on the new side", () => {
    expect(githubFilesUrl(PR, DIGEST, { side: "additions", startLine: 40, endLine: 40 })).toBe(
      `https://github.com/acme/widgets/pull/42/files#diff-${DIGEST}R40`,
    );
  });

  it("has a page with no line, for when there is no digest to anchor with", () => {
    expect(githubFilesPageUrl(PR)).toBe("https://github.com/acme/widgets/pull/42/files");
  });

  it("writes a range as R40-R45, and the old side as L", () => {
    expect(diffLineFragment("additions", 40, 45)).toBe("R40-R45");
    expect(diffLineFragment("deletions", 7, 7)).toBe("L7");
    expect(diffLineFragment("deletions", 7, 9)).toBe("L7-L9");
  });
});

describe("sha256Hex", () => {
  it("is the lowercase hex SHA-256 of the UTF-8 bytes", async () => {
    // The FIPS 180-2 test vector, and a path with a non-ASCII byte so the encoding is pinned.
    expect(await sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    expect(await sha256Hex("src/é.ts")).toMatch(/^[0-9a-f]{64}$/u);
    expect(await sha256Hex("src/é.ts")).not.toBe(await sha256Hex("src/e.ts"));
  });
});

describe("githubDiffPath", () => {
  it("is the file's own path, and a pre-rename name is resolved to the file's new one", () => {
    expect(githubDiffPath("greet.ts", FILES)).toBe("greet.ts");
    expect(githubDiffPath("oldname.txt", FILES)).toBe("newname.txt");
    // A deletion's identity is its old path — the only one it has.
    expect(githubDiffPath("doomed.txt", FILES)).toBe("doomed.txt");
  });

  it("keeps the comment's own name for a file the reviewed diff does not carry, or without one", () => {
    expect(githubDiffPath("elsewhere.ts", FILES)).toBe("elsewhere.ts");
    // The documented residual risk: with no reviewed diff to resolve through, a pre-rename
    // name stays the old name — the right pull request, without the jump.
    expect(githubDiffPath("oldname.txt", null)).toBe("oldname.txt");
  });
});

describe("reviewedFilesFor", () => {
  const REFS = { kind: "refs", base: "main", head: "feature" } as const;
  const whole = {
    reviewDiff: REFS,
    reviewSubrange: null,
    reviewedHead: REVIEWED,
    currentHead: REVIEWED,
    files: FILES,
  };

  it("vouches for a whole refs review whose branch still points at the reviewed commit", () => {
    expect(reviewedFilesFor(whole)).toBe(FILES);
  });

  it("vouches for a frozen pin, which renders the very diff the review was gated against", () => {
    expect(
      reviewedFilesFor({
        ...whole,
        reviewDiff: { kind: "frozenPatch", patch: "diff" },
        reviewedHead: null,
        currentHead: null,
      }),
    ).toBe(FILES);
  });

  it("refuses a narrowed review — the commit that renamed or deleted a file may be outside it", () => {
    expect(
      reviewedFilesFor({
        ...whole,
        reviewSubrange: { kind: "commitRange", first: MOVED, last: MOVED },
      }),
    ).toBeNull();
  });

  it("refuses a branch that moved past the reviewed commit, or one not known to be at it", () => {
    expect(reviewedFilesFor({ ...whole, currentHead: MOVED })).toBeNull();
    expect(reviewedFilesFor({ ...whole, currentHead: null })).toBeNull();
    expect(reviewedFilesFor({ ...whole, reviewedHead: null })).toBeNull();
  });

  it("refuses with no pin (the reader's own diff) and with nothing loaded", () => {
    expect(reviewedFilesFor({ ...whole, reviewDiff: null })).toBeNull();
    expect(reviewedFilesFor({ ...whole, files: null })).toBeNull();
  });
});

describe("prHeadDrift", () => {
  const branchDrift = { reviewedHead: REVIEWED, currentHead: MOVED, since: 2 };

  it("trusts the fetched pull request head over the branch, in both directions", () => {
    expect(
      prHeadDrift({ reviewedHead: REVIEWED, githubHead: null, prHead: MOVED, branchDrift: null }),
    ).toEqual({
      kind: "moved",
      known: "prRef",
    });
    // The branch may carry the reader's own commits; the PR's head is what GitHub shows.
    expect(
      prHeadDrift({ reviewedHead: REVIEWED, githubHead: null, prHead: REVIEWED, branchDrift }),
    ).toEqual({
      kind: "same",
    });
  });

  it("falls back to the branch the review follows when no PR head was fetched", () => {
    expect(
      prHeadDrift({ reviewedHead: REVIEWED, githubHead: null, prHead: null, branchDrift }),
    ).toEqual({
      kind: "moved",
      known: "branch",
    });
    expect(
      prHeadDrift({ reviewedHead: REVIEWED, githubHead: null, prHead: null, branchDrift: null }),
    ).toEqual({
      kind: "same",
    });
  });

  it("trusts GitHub's own head over the fetched ref and the branch", () => {
    expect(
      prHeadDrift({
        reviewedHead: REVIEWED,
        githubHead: MOVED,
        prHead: REVIEWED,
        branchDrift: null,
      }),
    ).toEqual({ kind: "moved", known: "github" });
    // The reader's own commits on the branch cannot outvote GitHub.
    expect(
      prHeadDrift({ reviewedHead: REVIEWED, githubHead: REVIEWED, prHead: null, branchDrift }),
    ).toEqual({ kind: "same" });
  });

  it("calls it moved when any known head differs — one head never hides another's move", () => {
    // GitHub's head remembered from before a fetch says "same"; the ref that fetch just wrote
    // says it moved. The warning fires, naming the ref.
    expect(
      prHeadDrift({
        reviewedHead: REVIEWED,
        githubHead: REVIEWED,
        prHead: MOVED,
        branchDrift: null,
      }),
    ).toEqual({ kind: "moved", known: "prRef" });
    expect(
      prHeadDrift({
        reviewedHead: REVIEWED,
        githubHead: MOVED,
        prHead: REVIEWED,
        branchDrift: null,
      }),
    ).toEqual({ kind: "moved", known: "github" });
  });

  it("says nothing for a review that recorded no reviewed commit", () => {
    expect(
      prHeadDrift({ reviewedHead: null, githubHead: null, prHead: MOVED, branchDrift }),
    ).toEqual({
      kind: "same",
    });
  });
});

describe("openOnGitHubHint", () => {
  it("names the action, and warns only when the pull request is known to have moved", () => {
    expect(openOnGitHubHint({ kind: "same" })).toBe("Copy & open on GitHub");
    expect(openOnGitHubHint({ kind: "moved", known: "prRef" })).toBe(
      "Copy & open on GitHub — the pull request's head, as last fetched, has moved past the reviewed commit, so the pull request's lines may have shifted",
    );
  });

  it("says GitHub's own head moved, when GitHub said so", () => {
    expect(openOnGitHubHint({ kind: "moved", known: "github" })).toBe(
      "Copy & open on GitHub — the pull request on GitHub has moved past the reviewed commit, so the pull request's lines may have shifted",
    );
  });

  it("adds, quietly, that GitHub could not be asked — and why", () => {
    expect(
      openOnGitHubHint({ kind: "same" }, { kind: "unchecked", failure: { code: "notFound" } }),
    ).toBe(
      "Copy & open on GitHub. Not checked against GitHub's diff: GitHub did not show it to Reviewer — it may be private, renamed or deleted",
    );
    expect(
      openOnGitHubHint(
        { kind: "moved", known: "branch" },
        { kind: "unchecked", failure: { code: "network" } },
      ),
    ).toMatch(
      /may have shifted\. Not checked against GitHub's diff: GitHub could not be reached$/u,
    );
  });

  it("says when the warning comes from the local branch rather than the pull request itself", () => {
    expect(openOnGitHubHint({ kind: "moved", known: "branch" })).toBe(
      "Copy & open on GitHub — the local branch has moved past the reviewed commit (the pull request's own head is not known here), so the pull request's lines may have shifted",
    );
  });
});

describe("outsideGitHubDiff", () => {
  const compared: GitHubCheckState = {
    status: "checked",
    check: { kind: "compared", head: REVIEWED, outside: ["c1"] },
    staleBecause: null,
  };

  it("is true only for a comment GitHub's diff, at the reviewed commit, leaves out", () => {
    expect(outsideGitHubDiff(compared, "c1")).toBe(true);
    expect(outsideGitHubDiff(compared, "c2")).toBe(false);
  });

  it("is false whenever it is not known", () => {
    expect(outsideGitHubDiff(null, "c1")).toBe(false);
    expect(outsideGitHubDiff({ status: "unchecked", failure: { code: "network" } }, "c1")).toBe(
      false,
    );
    expect(
      outsideGitHubDiff(
        { status: "checked", check: { kind: "moved", head: MOVED }, staleBecause: null },
        "c1",
      ),
    ).toBe(false);
  });

  it("reads GitHub's head off any answer that has one", () => {
    expect(githubHeadOf(compared)).toBe(REVIEWED);
    expect(
      githubHeadOf({
        status: "checked",
        check: { kind: "moved", head: MOVED },
        staleBecause: null,
      }),
    ).toBe(MOVED);
    expect(githubHeadOf({ status: "unchecked", failure: { code: "timeout" } })).toBeNull();
    expect(githubHeadOf(null)).toBeNull();
  });
});

describe("settleGitHubCheck", () => {
  const checked: GitHubCheckState = {
    status: "checked",
    check: { kind: "compared", head: REVIEWED, outside: ["c1"] },
    staleBecause: null,
  };
  const limited = { code: "rateLimited", resetAt: 1, scope: "anonymous" } as const;

  it("keeps the last answer when a re-check fails, and marks it stale", () => {
    const stale = settleGitHubCheck(checked, { ok: false, failure: limited });
    expect(stale).toEqual({ ...checked, staleBecause: limited });
    // The marks stand; the head no longer outranks the fetched ref; the tooltip says why.
    expect(outsideGitHubDiff(stale, "c1")).toBe(true);
    expect(githubHeadOf(stale)).toBeNull();
    expect(openOnGitHubHint({ kind: "same" }, githubCheckNote(stale))).toMatch(
      /Checked against GitHub's diff earlier; checking again failed: GitHub's limit/u,
    );
  });

  it("is unchecked only when there was no answer to keep, and fresh on success", () => {
    expect(settleGitHubCheck(null, { ok: false, failure: { code: "network" } })).toEqual({
      status: "unchecked",
      failure: { code: "network" },
    });
    expect(
      settleGitHubCheck({ ...checked, staleBecause: limited }, { ok: true, value: checked.check }),
    ).toEqual(checked);
    expect(githubCheckNote(checked)).toBeNull();
  });
});
