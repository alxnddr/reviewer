import { describe, expect, it } from "vitest";
import { QUOTED_PATH_HOST_PATCH } from "../../shared/diff/fixtures";
import { githubPullRequestOf } from "../../shared/pull-request";
import { createGitHubClient } from "./client";
import { createDiffChecker } from "./diff-check";
import { createPullRequestReader } from "./rest";
import {
  diffResponse,
  fakeTransport,
  HELLO_WORLD_DIFF,
  jsonResponse,
  notFoundResponse,
  pullRequestBody,
  SHA_HEAD,
  SHA_OTHER,
} from "./fixtures";

// B4's request budget and its answers: the head first, GitHub's diff only at the reviewed
// commit, the diff fetched once per head however often the check is asked, and every failure
// passed through for the renderer to treat as "not checked". No network.

const HELLO = githubPullRequestOf({ owner: "octocat", repo: "Hello-World" }, 1);

const ANCHORS = [
  { id: "on", file: "README", side: "additions" as const, startLine: 2, endLine: 4 },
  { id: "off", file: "README", side: "additions" as const, startLine: 9, endLine: 9 },
  { id: "gone", file: "LICENSE", side: "additions" as const, startLine: 1, endLine: 1 },
];

/** A GitHub that answers the pull request with `head` (and the base at `base`) and its diff with
 * Hello-World's. The pull request is read afresh every time (`memoMs: 0`), so the counts below
 * are the diff cache's alone. */
function github(
  options: { head?: string; base?: () => string; diff?: () => Response; memoMs?: number } = {},
) {
  const fake = fakeTransport((_url, init) => {
    const accept = (init.headers as Record<string, string>)["Accept"];
    return accept === "application/vnd.github.diff"
      ? (options.diff ?? (() => diffResponse(HELLO_WORLD_DIFF)))()
      : jsonResponse(
          pullRequestBody({
            head: { sha: options.head ?? SHA_HEAD },
            base: { ref: "master", sha: options.base?.() ?? SHA_OTHER },
          }),
        );
  });
  const accepts = (): (string | undefined)[] =>
    fake.calls.map((call) => (call.init.headers as Record<string, string>)["Accept"]);
  const client = createGitHubClient({ transport: fake.transport, userAgent: "Reviewer/test" });
  return {
    accepts,
    check: createDiffChecker(
      client,
      createPullRequestReader(client, { memoMs: options.memoMs ?? 0 }),
    ).check,
  };
}

const diffs = (accepts: (string | undefined)[]): number =>
  accepts.filter((accept) => accept === "application/vnd.github.diff").length;

describe("createDiffChecker", () => {
  it("places every anchor against GitHub's diff at the reviewed commit", async () => {
    const { check } = github();
    expect(await check({ pullRequest: HELLO, reviewedHead: SHA_HEAD, anchors: ANCHORS })).toEqual({
      ok: true,
      value: { kind: "compared", head: SHA_HEAD, outside: ["off", "gone"] },
    });
  });

  it("answers moved, and never fetches the diff, when the pull request has moved on", async () => {
    const { check, accepts } = github({ head: SHA_OTHER });
    expect(await check({ pullRequest: HELLO, reviewedHead: SHA_HEAD, anchors: ANCHORS })).toEqual({
      ok: true,
      value: { kind: "moved", head: SHA_OTHER },
    });
    expect(accepts()).toEqual(["application/vnd.github+json"]);
  });

  it("fetches a head's diff once, however often and however spelled it is asked", async () => {
    const { check, accepts } = github();
    await check({ pullRequest: HELLO, reviewedHead: SHA_HEAD, anchors: ANCHORS });
    const shouting = githubPullRequestOf({ owner: "OctoCat", repo: "hello-world" }, 1);
    await Promise.all([
      check({ pullRequest: shouting, reviewedHead: SHA_HEAD, anchors: ANCHORS }),
      check({ pullRequest: HELLO, reviewedHead: SHA_HEAD, anchors: [] }),
    ]);
    expect(diffs(accepts())).toBe(1);
  });

  it("does not keep a failed diff, so the next check asks again", async () => {
    let fail = true;
    const { check, accepts } = github({
      diff: () => (fail ? jsonResponse("{}", { status: 502 }) : diffResponse(HELLO_WORLD_DIFF)),
    });
    expect(await check({ pullRequest: HELLO, reviewedHead: SHA_HEAD, anchors: ANCHORS })).toEqual({
      ok: false,
      failure: { code: "unavailable", status: 502 },
    });
    fail = false;
    expect((await check({ pullRequest: HELLO, reviewedHead: SHA_HEAD, anchors: ANCHORS })).ok).toBe(
      true,
    );
    expect(diffs(accepts())).toBe(2);
  });

  it("passes a private repository's notFound through, for the renderer to call unchecked", async () => {
    const fake = fakeTransport(() => notFoundResponse());
    const client = createGitHubClient({ transport: fake.transport, userAgent: "Reviewer/test" });
    const { check } = createDiffChecker(client, createPullRequestReader(client));
    expect(await check({ pullRequest: HELLO, reviewedHead: SHA_HEAD, anchors: ANCHORS })).toEqual({
      ok: false,
      failure: { code: "notFound" },
    });
  });

  it("reads GitHub's diff again when the base moves under the same head", async () => {
    let base = SHA_OTHER;
    const { check, accepts } = github({ base: () => base });
    await check({ pullRequest: HELLO, reviewedHead: SHA_HEAD, anchors: ANCHORS });
    await check({ pullRequest: HELLO, reviewedHead: SHA_HEAD, anchors: ANCHORS });
    expect(diffs(accepts())).toBe(1);
    // Retargeted, or the base branch advanced: the merge base, and so GitHub's diff, may differ.
    base = "2".repeat(40);
    await check({ pullRequest: HELLO, reviewedHead: SHA_HEAD, anchors: ANCHORS });
    expect(diffs(accepts())).toBe(2);
  });

  it("shares the pull request's answer with a lookup moments before", async () => {
    const { check, accepts } = github({ memoMs: 60_000 });
    await check({ pullRequest: HELLO, reviewedHead: SHA_HEAD, anchors: ANCHORS });
    await check({ pullRequest: HELLO, reviewedHead: SHA_HEAD, anchors: ANCHORS });
    expect(accepts().filter((accept) => accept === "application/vnd.github+json")).toHaveLength(1);
  });

  it("places anchors on a file GitHub C-quotes, by its plain name", async () => {
    const { check } = github({ diff: () => diffResponse(QUOTED_PATH_HOST_PATCH) });
    const file = "Day01-20/11.常用数据结构之字符串.md";
    expect(
      await check({
        pullRequest: HELLO,
        reviewedHead: SHA_HEAD,
        anchors: [
          { id: "in", file, side: "additions", startLine: 7, endLine: 7 },
          { id: "out", file, side: "additions", startLine: 40, endLine: 40 },
        ],
      }),
    ).toEqual({ ok: true, value: { kind: "compared", head: SHA_HEAD, outside: ["out"] } });
  });

  it("asks for the diff pinned to the base and head shas, never the pull request's moving one", async () => {
    const fake = fakeTransport((_url, init) =>
      (init.headers as Record<string, string>)["Accept"] === "application/vnd.github.diff"
        ? diffResponse(HELLO_WORLD_DIFF)
        : jsonResponse(pullRequestBody({ base: { ref: "master", sha: SHA_OTHER } })),
    );
    const client = createGitHubClient({ transport: fake.transport, userAgent: "Reviewer/test" });
    await createDiffChecker(client, createPullRequestReader(client)).check({
      pullRequest: HELLO,
      reviewedHead: SHA_HEAD,
      anchors: ANCHORS,
    });
    expect(fake.calls.map((call) => new URL(call.url).pathname)).toEqual([
      "/repos/octocat/Hello-World/pulls/1",
      `/repos/octocat/Hello-World/compare/${SHA_OTHER}...${SHA_HEAD}`,
    ]);
  });

  it("reads the head past the memo when asked fresh, so a move since is seen", async () => {
    let head = SHA_HEAD;
    const fake = fakeTransport((_url, init) =>
      (init.headers as Record<string, string>)["Accept"] === "application/vnd.github.diff"
        ? diffResponse(HELLO_WORLD_DIFF)
        : jsonResponse(pullRequestBody({ head: { sha: head } })),
    );
    const client = createGitHubClient({ transport: fake.transport, userAgent: "Reviewer/test" });
    const { check } = createDiffChecker(client, createPullRequestReader(client));
    const request = { pullRequest: HELLO, reviewedHead: SHA_HEAD, anchors: ANCHORS };
    expect((await check(request)).ok).toBe(true);
    head = SHA_OTHER;
    // The memo still remembers the reviewed head…
    expect(await check(request)).toMatchObject({ ok: true, value: { kind: "compared" } });
    // …and a fresh check, the one after a fetch, does not.
    expect(await check({ ...request, fresh: true })).toEqual({
      ok: true,
      value: { kind: "moved", head: SHA_OTHER },
    });
  });
});
