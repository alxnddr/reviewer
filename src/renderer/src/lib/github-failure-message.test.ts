import { describe, expect, it } from "vitest";
import type { GitHubFailure } from "../../../shared/github-ipc";
import type { GitHubPostFailure } from "../../../shared/github-posting";
import {
  githubFailureMessage,
  githubPostFailureMessage,
  githubUncheckedReason,
  inboxFailureMessage,
  tokenRefusalMessage,
} from "./github-failure-message";

// Every code has a sentence and a clause, and neither ever claims a pull request does not exist
// — an unauthenticated call cannot tell that from a private repository.

const EVERY_FAILURE: GitHubFailure[] = [
  { code: "rateLimited", resetAt: Date.UTC(2026, 9, 3, 14, 32), scope: "anonymous" },
  { code: "notFound" },
  { code: "unauthorized" },
  { code: "forbidden" },
  { code: "unprocessable" },
  { code: "tooLarge" },
  { code: "unavailable", status: 503 },
  { code: "timeout" },
  { code: "network" },
  { code: "badResponse", status: null },
  { code: "unexpected" },
];

describe("githubFailureMessage", () => {
  it("says something for every code", () => {
    for (const failure of EVERY_FAILURE) {
      expect(githubFailureMessage(failure).length, failure.code).toBeGreaterThan(10);
      expect(githubUncheckedReason(failure).length, failure.code).toBeGreaterThan(10);
    }
  });

  it("names the reset of a spent limit as a time of day", () => {
    const failure = EVERY_FAILURE[0] as GitHubFailure;
    expect(githubFailureMessage(failure)).toMatch(/resets at .*\d{1,2}:\d{2}/u);
    expect(githubUncheckedReason(failure)).toMatch(/until .*\d{1,2}:\d{2}/u);
  });

  it("reads notFound as private, renamed or deleted — never asserts which", () => {
    for (const text of [
      githubFailureMessage({ code: "notFound" }),
      githubUncheckedReason({ code: "notFound" }),
    ]) {
      expect(text).toContain("private, renamed or deleted");
      expect(text).not.toMatch(/does not exist|a private repository/u);
    }
  });

  it("says whose limit is spent", () => {
    expect(githubFailureMessage(EVERY_FAILURE[0] as GitHubFailure)).toContain("without a sign-in");
  });
});

describe("inboxFailureMessage", () => {
  it("names the login when GitHub does not know it, and falls back otherwise", () => {
    expect(inboxFailureMessage({ code: "unprocessable" }, "octo-cat")).toContain("octo-cat");
    expect(inboxFailureMessage({ code: "network" }, "octo-cat")).toBe(
      githubFailureMessage({ code: "network" }),
    );
  });
});

describe("the unexpected failure", () => {
  it("tells the reader what to do, not where a log is", () => {
    const text = githubFailureMessage({ code: "unexpected" });
    expect(text).toContain("Try again");
    expect(text).not.toMatch(/log/iu);
  });
});

describe("githubPostFailureMessage", () => {
  const POST_ONLY: GitHubPostFailure[] = [
    { code: "noToken" },
    { code: "tokenExpired" },
    { code: "headMoved", head: "a".repeat(40) },
    { code: "pendingReviewConflict" },
    { code: "lineNotInDiff" },
    { code: "notPullRequest" },
    { code: "notPostable" },
    { code: "changedSinceShown" },
    { code: "alreadySubmitted" },
    { code: "notPending" },
    { code: "noRecord" },
  ];

  it("says something for every code, the base ones included", () => {
    for (const failure of [...EVERY_FAILURE, ...POST_ONLY]) {
      expect(githubPostFailureMessage(failure).length, failure.code).toBeGreaterThan(10);
    }
  });

  it("tells a reader whose answer never arrived that posting again cannot duplicate", () => {
    for (const code of ["timeout", "network"] as const) {
      expect(githubPostFailureMessage({ code })).toMatch(/will not post it twice/u);
    }
  });

  it("says a token's spent limit is the token's", () => {
    expect(
      githubPostFailureMessage({
        code: "rateLimited",
        resetAt: Date.UTC(2026, 9, 3),
        scope: "token",
      }),
    ).toMatch(/your token/u);
  });
});

describe("tokenRefusalMessage", () => {
  it("names the scopes a classic token has, and points gh's kind at a fine-grained token", () => {
    expect(tokenRefusalMessage({ code: "classicScopes", scopes: ["repo", "gist"] })).toContain(
      "repo, gist",
    );
    expect(tokenRefusalMessage({ code: "classicScopes", scopes: [] })).toMatch(/no scopes/u);
    expect(tokenRefusalMessage({ code: "unsupportedKind", kind: "oauth" })).toMatch(
      /gh CLI.*fine-grained/u,
    );
    for (const kind of ["appUser", "installation", "refresh", "unknown"] as const) {
      expect(tokenRefusalMessage({ code: "unsupportedKind", kind }).length).toBeGreaterThan(10);
    }
    for (const failure of [
      { code: "malformed" } as const,
      { code: "classicScopesUnknown" } as const,
      ...EVERY_FAILURE,
    ]) {
      expect(tokenRefusalMessage(failure).length, failure.code).toBeGreaterThan(10);
    }
  });
});
