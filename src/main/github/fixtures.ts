import { vi } from "vitest";
import type { GitHubTransport } from "./client";

// GitHub's answers as the tests replay them, and the fake transport that replays them — so no
// test in this directory touches the network. The JSON bodies are cut down from live answers of
// API version 2026-03-10 (2026-10-03: `GET /search/issues` and `GET /repos/<o>/<r>/pulls/<n>`,
// both unauthenticated), keeping every field `rest.ts` reads and a few it does not, so the
// lenient raw schemas are exercised against extra keys as well. The rate-limit headers are the
// ones those answers carried.

export const SHA_HEAD = "7044a8a032e85b6ab611033b2ac8af7ce85805b2";
export const SHA_OTHER = "1".repeat(40);

/** One page of `GET /search/issues?q=is:pr is:open review-requested:<login>`. */
export function searchBody(items: readonly unknown[], total = items.length): string {
  return JSON.stringify({
    total_count: total,
    incomplete_results: false,
    items,
    search_type: "legacy",
  });
}

/** One search row, a pull request. */
export function searchItem(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    url: "https://api.github.com/repos/vercel/next.js/issues/98114",
    repository_url: "https://api.github.com/repos/vercel/next.js",
    html_url: "https://github.com/vercel/next.js/pull/98114",
    id: 3_456_789_012,
    number: 98114,
    title: "Add no-adhoc-sleep lint rule and migrate ad-hoc sleep promises",
    user: { login: "wbinnssmith", id: 1, type: "User" },
    state: "open",
    draft: true,
    created_at: "2026-09-30T21:12:03Z",
    updated_at: "2026-10-01T00:50:57Z",
    pull_request: {
      url: "https://api.github.com/repos/vercel/next.js/pulls/98114",
      html_url: "https://github.com/vercel/next.js/pull/98114",
      diff_url: "https://github.com/vercel/next.js/pull/98114.diff",
      patch_url: "https://github.com/vercel/next.js/pull/98114.patch",
      merged_at: null,
    },
    ...overrides,
  };
}

/** `GET /repos/octocat/Hello-World/pulls/1`, trimmed. */
export function pullRequestBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    url: "https://api.github.com/repos/octocat/Hello-World/pulls/1",
    number: 1,
    state: "closed",
    title: "Edited README via GitHub",
    user: { login: "unoju" },
    draft: false,
    merged: false,
    merged_at: null,
    head: {
      label: "unoju:patch-1",
      ref: "patch-1",
      sha: SHA_HEAD,
      repo: { full_name: "unoju/Hello-World" },
    },
    base: {
      label: "octocat:master",
      ref: "master",
      sha: "553c2077f0edc3d5dc5d17262f6aa498e69d6f8e",
      repo: { full_name: "octocat/Hello-World" },
    },
    ...overrides,
  });
}

/** `GET /repos/octocat/Hello-World/pulls/1` with `Accept: application/vnd.github.diff`. */
export const HELLO_WORLD_DIFF = `diff --git a/README b/README
index c57eff55e..719be62e9 100644
--- a/README
+++ b/README
@@ -1 +1,6 @@
-Hello World!
\\ No newline at end of file
+Hello World!
+$ mkdir ~/Hello-WorldCreates a directory for your project called "Hello-World" in your user directory
+$ cd ~/Hello-WorldChanges the current working directory to your newly created directory
+$ git initSets up the necessary Git files
+Initialized empty Git repository in /Users/your_user_directory/Hello-World/.git/
+$ touch README
\\ No newline at end of file
`;

const JSON_TYPE = "application/json; charset=utf-8";
const DIFF_TYPE = "application/vnd.github.diff; charset=utf-8";

export function jsonResponse(
  body: string,
  init: { status?: number; headers?: Record<string, string> } = {},
): Response {
  return new Response(body, {
    status: init.status ?? 200,
    headers: { "content-type": JSON_TYPE, ...init.headers },
  });
}

export function diffResponse(body: string): Response {
  return new Response(body, { status: 200, headers: { "content-type": DIFF_TYPE } });
}

/** A primary rate limit spent: GitHub's 403 with `x-ratelimit-remaining: 0` and the reset in
 * epoch seconds, and its message body. */
export function rateLimitedResponse(resetEpochSeconds: number, status = 403): Response {
  return jsonResponse(
    JSON.stringify({
      message: "API rate limit exceeded for 203.0.113.7. (But here's the good news: …)",
      documentation_url:
        "https://docs.github.com/rest/overview/resources-in-the-rest-api#rate-limiting",
    }),
    {
      status,
      headers: {
        "x-ratelimit-limit": "10",
        "x-ratelimit-remaining": "0",
        "x-ratelimit-used": "10",
        "x-ratelimit-resource": "search",
        "x-ratelimit-reset": String(resetEpochSeconds),
      },
    },
  );
}

export function notFoundResponse(): Response {
  return jsonResponse(
    JSON.stringify({
      message: "Not Found",
      documentation_url: "https://docs.github.com/rest",
      status: "404",
    }),
    { status: 404 },
  );
}

export type RecordedCall = { url: string; init: RequestInit };

/** A transport that answers from `respond` and records what it was asked. */
export function fakeTransport(
  respond: (url: URL, init: RequestInit) => Response | Promise<Response>,
): { transport: GitHubTransport; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const transport = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return await respond(new URL(url), init);
  });
  return { transport, calls };
}
