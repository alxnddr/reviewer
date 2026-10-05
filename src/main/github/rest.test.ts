import { describe, expect, it } from "vitest";
import { githubPullRequestOf } from "../../shared/pull-request";
import { createGitHubClient } from "./client";
import {
  fakeTransport,
  jsonResponse,
  notFoundResponse,
  pullRequestBody,
  searchBody,
  searchItem,
  SHA_HEAD,
} from "./fixtures";
import {
  createPullRequestReader,
  getPullRequestInfo,
  INBOX_PAGE_SIZE,
  listReviewRequests,
  reviewRequestedQuery,
  wireInfo,
} from "./rest";

// GitHub's documented JSON in, the app's wire shapes out — against answers cut from live ones
// (`fixtures.ts`), with no network.

const HELLO = githubPullRequestOf({ owner: "octocat", repo: "Hello-World" }, 1);

function github(respond: Parameters<typeof fakeTransport>[0]) {
  const fake = fakeTransport(respond);
  return {
    calls: fake.calls,
    client: createGitHubClient({ transport: fake.transport, userAgent: "Reviewer/test" }),
  };
}

describe("listReviewRequests", () => {
  it("searches for the login's open review requests, newest first, one page", async () => {
    const { client, calls } = github(() => jsonResponse(searchBody([])));
    await listReviewRequests(client, "octo-cat");
    const url = new URL(calls[0]?.url ?? "");
    expect(url.origin + url.pathname).toBe("https://api.github.com/search/issues");
    expect(url.searchParams.get("q")).toBe(reviewRequestedQuery("octo-cat"));
    expect(url.searchParams.get("q")).toBe(
      "is:pr is:open archived:false review-requested:octo-cat",
    );
    expect(url.searchParams.get("sort")).toBe("updated");
    expect(url.searchParams.get("order")).toBe("desc");
    expect(url.searchParams.get("per_page")).toBe(String(INBOX_PAGE_SIZE));
  });

  it("reads each row's pull request out of its own address", async () => {
    const { client } = github(() => jsonResponse(searchBody([searchItem()], 31)));
    expect(await listReviewRequests(client, "gaearon")).toEqual({
      ok: true,
      value: {
        items: [
          {
            pullRequest: githubPullRequestOf({ owner: "vercel", repo: "next.js" }, 98114),
            title: "Add no-adhoc-sleep lint rule and migrate ad-hoc sleep promises",
            author: "wbinnssmith",
            updatedAt: "2026-10-01T00:50:57Z",
            draft: true,
          },
        ],
        total: 31,
        incomplete: false,
      },
    });
  });

  it("drops a row it cannot act on, and keeps the rest", async () => {
    const { client } = github(() =>
      jsonResponse(
        searchBody([
          // An issue, not a pull request.
          searchItem({ pull_request: undefined, html_url: "https://github.com/a/b/issues/3" }),
          // An address that disagrees with its own number.
          searchItem({ number: 1 }),
          // Not GitHub's shape at all.
          { html_url: 42 },
          searchItem({ user: null, draft: undefined, title: "t".repeat(5000) }),
        ]),
      ),
    );
    const result = await listReviewRequests(client, "gaearon");
    expect(result.ok && result.value.items).toEqual([
      expect.objectContaining({ author: null, draft: false, title: "t".repeat(1024) }),
    ]);
  });

  it("names an app's login as it is", async () => {
    const { client } = github(() =>
      jsonResponse(searchBody([searchItem({ user: { login: "dependabot[bot]" } })])),
    );
    const result = await listReviewRequests(client, "gaearon");
    expect(result.ok && result.value.items[0]?.author).toBe("dependabot[bot]");
  });

  it("refuses a page that is not a search answer", async () => {
    const { client } = github(() => jsonResponse('{"items":"nope"}'));
    expect(await listReviewRequests(client, "gaearon")).toEqual({
      ok: false,
      failure: { code: "badResponse", status: null },
    });
  });

  it("answers an unknown user as unprocessable", async () => {
    const { client } = github(() =>
      jsonResponse('{"message":"Validation Failed"}', { status: 422 }),
    );
    expect(await listReviewRequests(client, "nobody-at-all")).toEqual({
      ok: false,
      failure: { code: "unprocessable" },
    });
  });
});

describe("getPullRequestInfo", () => {
  it("asks for the pull request and keeps its title, state, base and head", async () => {
    const { client, calls } = github(() => jsonResponse(pullRequestBody()));
    expect(await getPullRequestInfo(client, HELLO)).toEqual({
      ok: true,
      value: {
        title: "Edited README via GitHub",
        state: "closed",
        draft: false,
        base: "master",
        head: SHA_HEAD,
        baseSha: "553c2077f0edc3d5dc5d17262f6aa498e69d6f8e",
      },
    });
    expect(calls[0]?.url).toBe("https://api.github.com/repos/octocat/Hello-World/pulls/1");
  });

  it("calls a merged pull request merged, and a draft a draft", async () => {
    const merged = github(() =>
      jsonResponse(pullRequestBody({ merged: true, merged_at: "2026-01-01T00:00:00Z" })),
    );
    const draft = github(() => jsonResponse(pullRequestBody({ state: "open", draft: true })));
    expect(await getPullRequestInfo(merged.client, HELLO)).toMatchObject({
      ok: true,
      value: { state: "merged" },
    });
    expect(await getPullRequestInfo(draft.client, HELLO)).toMatchObject({
      ok: true,
      value: { state: "open", draft: true },
    });
  });

  it("leaves the base out when it is not a branch name git would take", async () => {
    const { client } = github(() =>
      jsonResponse(pullRequestBody({ base: { ref: "-rf", sha: SHA_HEAD } })),
    );
    expect(await getPullRequestInfo(client, HELLO)).toMatchObject({
      ok: true,
      value: { base: null },
    });
  });

  it("refuses a head that is not a full sha", async () => {
    const { client } = github(() =>
      jsonResponse(pullRequestBody({ head: { sha: "abc", ref: "x" } })),
    );
    expect((await getPullRequestInfo(client, HELLO)).ok).toBe(false);
  });

  it("answers a private repository, as an unauthenticated call sees it, as notFound", async () => {
    const { client } = github(() => notFoundResponse());
    expect(await getPullRequestInfo(client, HELLO)).toEqual({
      ok: false,
      failure: { code: "notFound" },
    });
  });
});

describe("createPullRequestReader", () => {
  it("reuses an answer for a minute, across spellings, and shares one in flight", async () => {
    let now = 0;
    const { client, calls } = github(() => jsonResponse(pullRequestBody()));
    const read = createPullRequestReader(client, { now: () => now });
    await Promise.all([
      read(HELLO),
      read(githubPullRequestOf({ owner: "OCTOCAT", repo: "hello-world" }, 1)),
    ]);
    expect(calls).toHaveLength(1);
    now = 59_999;
    await read(HELLO);
    expect(calls).toHaveLength(1);
    now = 60_000;
    await read(HELLO);
    expect(calls).toHaveLength(2);
    // Another pull request is another answer.
    await read(githubPullRequestOf({ owner: "octocat", repo: "Hello-World" }, 2));
    expect(calls).toHaveLength(3);
  });

  it("keeps no failure", async () => {
    let missing = true;
    const { client, calls } = github(() =>
      missing ? notFoundResponse() : jsonResponse(pullRequestBody()),
    );
    const read = createPullRequestReader(client);
    expect((await read(HELLO)).ok).toBe(false);
    missing = false;
    expect((await read(HELLO)).ok).toBe(true);
    expect(calls).toHaveLength(2);
  });

  it("keeps the base sha in main", async () => {
    const { client } = github(() => jsonResponse(pullRequestBody()));
    const read = await createPullRequestReader(client)(HELLO);
    expect(read.ok && wireInfo(read.value)).not.toHaveProperty("baseSha");
  });

  it("asks again when the read must be fresh, and keeps that answer", async () => {
    const { client, calls } = github(() => jsonResponse(pullRequestBody()));
    const read = createPullRequestReader(client);
    await read(HELLO);
    await read(HELLO, { fresh: true });
    expect(calls).toHaveLength(2);
    await read(HELLO);
    expect(calls).toHaveLength(2);
  });
});
