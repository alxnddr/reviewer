import { describe, expect, it } from "vitest";
import * as z from "zod";
import {
  ANONYMOUS,
  apiPath,
  apiUrl,
  authKind,
  authScope,
  createGitHubClient,
  getJson,
  GITHUB_API_VERSION,
  type GitHubAuth,
  type GitHubCall,
} from "./client";
import { fakeTransport, jsonResponse, notFoundResponse, rateLimitedResponse } from "./fixtures";
import { GRAPHQL } from "./graphql-documents";

// The boundary's guarantees, each against a fake transport: what is sent, where it may go, how
// long it may take, how much is read, and which code every kind of answer becomes. No network.

const NOW = 1_791_000_000_000;

/** A promise that only ever rejects, once `signal` has aborted — a transport, or a body, that
 * never answers on its own. Polled rather than subscribed: the poll is the whole of what the
 * fake needs, and a millisecond's granularity is far inside every timeout here. */
async function untilAborted(signal: AbortSignal | null | undefined): Promise<never> {
  for (;;) {
    if (signal?.aborted === true) {
      throw new Error("aborted");
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 1);
    });
  }
}

function call(overrides: Partial<GitHubCall> = {}): GitHubCall {
  return {
    path: apiPath("repos", "octocat", "Hello-World", "pulls", 1),
    media: "json",
    auth: ANONYMOUS,
    resource: "core",
    maxBytes: 1024,
    ...overrides,
  };
}

function client(
  respond: Parameters<typeof fakeTransport>[0],
  options: { timeoutMs?: number; now?: () => number } = {},
) {
  const fake = fakeTransport(respond);
  return {
    ...fake,
    client: createGitHubClient({
      transport: fake.transport,
      userAgent: "Reviewer/test",
      now: options.now ?? (() => NOW),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    }),
  };
}

describe("apiUrl", () => {
  it("builds only api.github.com URLs, encoding the query", () => {
    expect(apiUrl("/search/issues", { q: "is:pr review-requested:octocat" })?.href).toBe(
      "https://api.github.com/search/issues?q=is%3Apr+review-requested%3Aoctocat",
    );
    expect(apiUrl("//evil.example/x")).toBeNull();
    expect(apiUrl("https://evil.example/x")).toBeNull();
    expect(apiUrl("relative")).toBeNull();
  });

  it("keeps every segment one segment, and refuses a path the parser would move", () => {
    expect(apiPath("repos", "a/b", "c d", 3)).toBe("/repos/a%2Fb/c%20d/3");
    expect(apiUrl(apiPath("repos", "a/b", "c d", 3))?.pathname).toBe("/repos/a%2Fb/c%20d/3");
    // Each of these would otherwise resolve or split into a different request than the one named:
    // `apiPath("repos", ".", "..", "x")` used to become https://api.github.com/x.
    expect(apiUrl(apiPath("repos", ".", "..", "x"))).toBeNull();
    expect(apiUrl("/repos/../x")).toBeNull();
    expect(apiUrl("/repos/a\\..\\x")).toBeNull();
    expect(apiUrl("/search/issues?q=x")).toBeNull();
    expect(apiUrl("/repos/a#b")).toBeNull();
  });
});

describe("createGitHubClient", () => {
  it("sends the headers GitHub requires, no cookies, no cache, and no redirect following", async () => {
    const { client: github, calls } = client(() => jsonResponse("{}"));
    await github.send(call());
    expect(calls).toHaveLength(1);
    const [only] = calls;
    expect(only?.url).toBe("https://api.github.com/repos/octocat/Hello-World/pulls/1");
    expect(only?.init).toMatchObject({
      method: "GET",
      redirect: "manual",
      credentials: "omit",
      cache: "no-store",
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "Reviewer/test",
        "X-GitHub-Api-Version": GITHUB_API_VERSION,
      },
    });
    expect(only?.init.headers).not.toHaveProperty("Authorization");
  });

  it("asks for a diff by its media type", async () => {
    const { client: github, calls } = client(
      () =>
        new Response("diff --git a/x b/x\n", {
          headers: { "content-type": "application/vnd.github.diff" },
        }),
    );
    expect(await github.send(call({ media: "diff" }))).toEqual({
      ok: true,
      value: "diff --git a/x b/x\n",
    });
    expect(calls[0]?.init.headers).toMatchObject({ Accept: "application/vnd.github.diff" });
  });

  it("refuses a body of the wrong media type", async () => {
    const { client: github } = client(() => jsonResponse('{"message":"oops"}'));
    expect(await github.send(call({ media: "diff" }))).toEqual({
      ok: false,
      failure: { code: "badResponse", status: null },
    });
  });

  it("posts exactly one thing: a known GraphQL document to /graphql", async () => {
    const { client: github, calls } = client(() => jsonResponse("{}"));
    await github.graphql(ANONYMOUS, GRAPHQL.COMMENT_STATE, { id: "C1" });
    expect(calls[0]?.url).toBe("https://api.github.com/graphql");
    expect(calls[0]?.init).toMatchObject({
      method: "POST",
      body: JSON.stringify({ query: GRAPHQL.COMMENT_STATE, variables: { id: "C1" } }),
      headers: { "Content-Type": "application/json" },
    });
  });

  it("sends nothing to /graphql but through graphql()", async () => {
    const { client: github, calls } = client(() => jsonResponse("{}"));
    for (const path of ["/graphql", "/GraphQL", "/graphql/"]) {
      expect(await github.send(call({ path }))).toEqual({
        ok: false,
        failure: { code: "badResponse", status: null },
      });
      expect((await github.sendWithHeaders(call({ path }), [])).ok).toBe(false);
    }
    expect(calls).toEqual([]);
  });

  it("never turns a GET into a POST, whatever rides along on the call", async () => {
    const { client: github, calls } = client(() => jsonResponse("{}"));
    // A cast or a spread that smuggles a body onto a call: dropped, not sent.
    const smuggled = { ...call(), json: { event: "x" }, graphql: { document: "q", variables: {} } };
    await github.send(smuggled);
    await github.sendWithHeaders(smuggled, []);
    for (const sent of calls) {
      expect(sent.init.method).toBe("GET");
      expect(sent.init.body).toBeUndefined();
    }
  });

  it("follows a redirect within the API origin, for a GET", async () => {
    const { client: github, calls } = client((url) =>
      url.pathname.startsWith("/repos/")
        ? new Response(null, {
            status: 301,
            headers: { location: "https://api.github.com/repositories/1296269/pulls/1" },
          })
        : jsonResponse('{"ok":1}'),
    );
    expect(await github.send(call())).toEqual({ ok: true, value: '{"ok":1}' });
    expect(calls.map((recorded) => recorded.url)).toEqual([
      "https://api.github.com/repos/octocat/Hello-World/pulls/1",
      "https://api.github.com/repositories/1296269/pulls/1",
    ]);
  });

  it("refuses a redirect off the allowlist, and never requests it", async () => {
    for (const location of [
      "https://evil.example/steal",
      "http://api.github.com/repos/x",
      "https://api.github.com:8443/x",
      "https://user:pass@api.github.com/x",
    ]) {
      const { client: github, calls } = client(
        () => new Response(null, { status: 302, headers: { location } }),
      );
      expect(await github.send(call())).toEqual({
        ok: false,
        failure: { code: "badResponse", status: 302 },
      });
      expect(calls).toHaveLength(1);
    }
  });

  it("stops following after a few hops, and never follows a POST", async () => {
    const loop = (): Response =>
      new Response(null, { status: 307, headers: { location: "https://api.github.com/again" } });
    const following = client(loop);
    expect((await following.client.send(call())).ok).toBe(false);
    expect(following.calls).toHaveLength(4);
    const posting = client(loop);
    expect((await posting.client.graphql(ANONYMOUS, GRAPHQL.COMMENT_STATE, {})).ok).toBe(false);
    expect(posting.calls).toHaveLength(1);
  });

  it("answers a redirect that names no Location as badResponse", async () => {
    const { client: github } = client(() => new Response(null, { status: 302 }));
    expect(await github.send(call())).toEqual({
      ok: false,
      failure: { code: "badResponse", status: 302 },
    });
  });

  it("maps each documented status to its code", async () => {
    const cases: [Response, unknown][] = [
      [jsonResponse("{}", { status: 401 }), { code: "unauthorized" }],
      [jsonResponse("{}", { status: 403 }), { code: "forbidden" }],
      [notFoundResponse(), { code: "notFound" }],
      [jsonResponse("{}", { status: 406 }), { code: "tooLarge" }],
      [jsonResponse("{}", { status: 422 }), { code: "unprocessable" }],
      [jsonResponse("{}", { status: 502 }), { code: "unavailable", status: 502 }],
      [jsonResponse("{}", { status: 418 }), { code: "badResponse", status: 418 }],
    ];
    for (const [response, failure] of cases) {
      const { client: github } = client(() => response);
      expect(await github.send(call())).toEqual({ ok: false, failure });
    }
  });

  it("reads a spent primary limit's reset, and a secondary limit's retry-after", async () => {
    const primary = client(() => rateLimitedResponse(1_791_000_600));
    expect(await primary.client.send(call())).toEqual({
      ok: false,
      failure: { code: "rateLimited", resetAt: 1_791_000_600_000, scope: "anonymous" },
    });
    const secondary = client(() =>
      jsonResponse("{}", { status: 403, headers: { "retry-after": "30" } }),
    );
    expect(await secondary.client.send(call())).toEqual({
      ok: false,
      failure: { code: "rateLimited", resetAt: NOW + 30_000, scope: "anonymous" },
    });
    const bare = client(() => jsonResponse("{}", { status: 429 }));
    expect(await bare.client.send(call())).toEqual({
      ok: false,
      failure: { code: "rateLimited", resetAt: NOW + 60_000, scope: "anonymous" },
    });
  });

  it("reads the reset on GitHub's clock, and never past an hour or before now", async () => {
    const limited = (reset: string, date?: string): Response =>
      jsonResponse("{}", {
        status: 403,
        headers: {
          "x-ratelimit-remaining": "0",
          "x-ratelimit-reset": reset,
          ...(date === undefined ? {} : { date }),
        },
      });
    const resetAt = async (response: Response): Promise<unknown> => {
      const result = await client(() => response).client.send(call());
      return result.ok ? null : result.failure.code === "rateLimited" && result.failure.resetAt;
    };
    // GitHub's clock is a day ahead of this machine's; the reset is ten minutes after its `Date`.
    const githubNow = NOW + 86_400_000;
    expect(
      await resetAt(
        limited(String((githubNow + 600_000) / 1000), new Date(githubNow).toUTCString()),
      ),
    ).toBe(NOW + 600_000);
    // A reset GitHub's clock already passed, a reset days out, a number no epoch is.
    expect(await resetAt(limited(String(NOW / 1000 - 3600)))).toBe(NOW + 60_000);
    expect(await resetAt(limited(String(NOW / 1000 + 86_400 * 3)))).toBe(NOW + 3_600_000);
    const absurd = await resetAt(limited("1e300"));
    expect(absurd).toBe(NOW + 3_600_000);
    expect(Number.isSafeInteger(absurd)).toBe(true);
  });

  it("stops asking until the limit resets, per limit", async () => {
    let now = NOW;
    let limited = true;
    const { client: github, calls } = client(
      () => (limited ? rateLimitedResponse(NOW / 1000 + 60) : jsonResponse("{}")),
      { now: () => now },
    );
    await github.send(call({ resource: "search" }));
    limited = false;
    // Same limit, before the reset: answered without a request.
    expect(await github.send(call({ resource: "search" }))).toEqual({
      ok: false,
      failure: { code: "rateLimited", resetAt: NOW + 60_000, scope: "anonymous" },
    });
    expect(calls).toHaveLength(1);
    // Another limit is not shut by it.
    expect((await github.send(call({ resource: "core" }))).ok).toBe(true);
    expect(calls).toHaveLength(2);
    // After the reset, asking again.
    now = NOW + 60_000;
    expect((await github.send(call({ resource: "search" }))).ok).toBe(true);
    expect(calls).toHaveLength(3);
  });

  it("answers network when the transport throws, and timeout when it does not answer in time", async () => {
    const offline = client(() => {
      throw new TypeError("fetch failed");
    });
    expect(await offline.client.send(call())).toEqual({ ok: false, failure: { code: "network" } });

    const hung = client((_url, init) => untilAborted(init.signal), { timeoutMs: 10 });
    expect(await hung.client.send(call())).toEqual({ ok: false, failure: { code: "timeout" } });
  });

  it("times out a body that stops arriving", async () => {
    const { client: github } = client(
      (_url, init) =>
        new Response(
          new ReadableStream<Uint8Array>({
            async pull(controller) {
              controller.enqueue(new TextEncoder().encode("{"));
              // The next chunk never comes: the read only ends when the timeout aborts it.
              await untilAborted(init.signal).catch((error: unknown) => controller.error(error));
            },
          }),
          { headers: { "content-type": "application/json" } },
        ),
      { timeoutMs: 10 },
    );
    expect(await github.send(call())).toEqual({ ok: false, failure: { code: "timeout" } });
  });

  it("stops reading at the cap, declared or not", async () => {
    const declared = client(() => jsonResponse("{}", { headers: { "content-length": "4096" } }));
    expect(await declared.client.send(call())).toEqual({
      ok: false,
      failure: { code: "tooLarge" },
    });

    let pulled = 0;
    const streamed = client(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              pulled += 1;
              controller.enqueue(new Uint8Array(600));
            },
          }),
          { headers: { "content-type": "application/json" } },
        ),
    );
    expect(await streamed.client.send(call())).toEqual({
      ok: false,
      failure: { code: "tooLarge" },
    });
    // An endless body read two chunks in — past 1024 bytes — and no further.
    expect(pulled).toBeLessThan(5);
  });

  it("decodes UTF-8 across chunk boundaries", async () => {
    const bytes = new TextEncoder().encode('"café"');
    const { client: github } = client(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(bytes.slice(0, 4));
              controller.enqueue(bytes.slice(4));
              controller.close();
            },
          }),
          { headers: { "content-type": "application/json" } },
        ),
    );
    expect(await github.send(call())).toEqual({ ok: true, value: '"café"' });
  });

  it("puts nothing GitHub said into a failure", async () => {
    const { client: github } = client(() =>
      jsonResponse(JSON.stringify({ message: "Bad credentials: ghp_secret" }), { status: 401 }),
    );
    const result = await github.send(call());
    expect(JSON.stringify(result)).not.toContain("ghp_secret");
  });
});

describe("createGitHubClient: releasing the request", () => {
  /** A transport that records each call's signal, so a test can see the request was let go. */
  function recording(respond: () => Response) {
    const signals: AbortSignal[] = [];
    const fake = fakeTransport((_url, init) => {
      if (init.signal) signals.push(init.signal);
      return respond();
    });
    return {
      signals,
      github: createGitHubClient({ transport: fake.transport, userAgent: "Reviewer/test" }),
    };
  }

  it("aborts the request when the body is cut off at the cap", async () => {
    const { github, signals } = recording(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              controller.enqueue(new Uint8Array(600));
            },
          }),
          { headers: { "content-type": "application/json" } },
        ),
    );
    expect(await github.send(call())).toEqual({ ok: false, failure: { code: "tooLarge" } });
    // Under Electron, cancelling the stream alone left the socket open until quit.
    expect(signals[0]?.aborted).toBe(true);
  });

  it("aborts the request after discarding an error body, and after every redirect hop", async () => {
    const failing = recording(() => notFoundResponse());
    await failing.github.send(call());
    expect(failing.signals[0]?.aborted).toBe(true);

    let hop = 0;
    const moving = recording(() => {
      hop += 1;
      return hop === 1
        ? new Response("{}", { status: 301, headers: { location: "https://api.github.com/y" } })
        : jsonResponse("{}");
    });
    await moving.github.send(call());
    expect(moving.signals.map((signal) => signal.aborted)).toEqual([true, true]);
  });

  it("answers network for a transport that rejects a redirect instead of returning it", async () => {
    // What Electron's `net.fetch` does with `redirect: "manual"` — and why the app's transport is
    // `net-transport.ts`: a renamed repository would otherwise read as "could not be reached".
    const { github } = recording(() => {
      throw new TypeError("Redirect was cancelled");
    });
    expect(await github.send(call())).toEqual({ ok: false, failure: { code: "network" } });
  });
});

describe("createGitHubClient: conditional requests", () => {
  it("revalidates a kept answer, and serves it on a 304", async () => {
    let fresh = true;
    const { client: github, calls } = client(() =>
      fresh
        ? jsonResponse('{"v":1}', { headers: { etag: '"v1"' } })
        : new Response(null, { status: 304, headers: { etag: '"v1"' } }),
    );
    expect(await github.send(call())).toEqual({ ok: true, value: '{"v":1}' });
    fresh = false;
    expect(await github.send(call())).toEqual({ ok: true, value: '{"v":1}' });
    expect(calls[0]?.init.headers).not.toHaveProperty("If-None-Match");
    expect(calls[1]?.init.headers).toMatchObject({ "If-None-Match": '"v1"' });
  });

  it("keeps a pull request's JSON and its diff at the same URL apart", async () => {
    const { client: github, calls } = client((_url, init) =>
      (init.headers as Record<string, string>)["Accept"] === "application/vnd.github.diff"
        ? new Response("diff --git a/x b/x\n", {
            headers: { "content-type": "application/vnd.github.diff", etag: '"d1"' },
          })
        : jsonResponse("{}", { headers: { etag: '"j1"' } }),
    );
    await github.send(call());
    await github.send(call({ media: "diff" }));
    // The diff's first ask carries no tag: the JSON's tag is not the diff's.
    expect(calls[1]?.init.headers).not.toHaveProperty("If-None-Match");
  });

  it("never revalidates a POST, and treats a 304 it did not ask for as a bad answer", async () => {
    const { client: github, calls } = client(() =>
      jsonResponse("{}", { headers: { etag: '"p1"' } }),
    );
    await github.graphql(ANONYMOUS, GRAPHQL.COMMENT_STATE, {});
    await github.graphql(ANONYMOUS, GRAPHQL.COMMENT_STATE, {});
    expect(calls[1]?.init.headers).not.toHaveProperty("If-None-Match");

    const unasked = client(() => new Response(null, { status: 304 }));
    expect(await unasked.client.send(call())).toEqual({
      ok: false,
      failure: { code: "badResponse", status: 304 },
    });
  });
});

describe("getJson", () => {
  const Shape = z.object({ title: z.string() });

  it("parses against the schema", async () => {
    const { client: github } = client(() => jsonResponse('{"title":"x","extra":1}'));
    expect(await getJson(github, call(), Shape)).toEqual({ ok: true, value: { title: "x" } });
  });

  it("refuses malformed JSON and a shape the schema refuses", async () => {
    for (const body of ["{", '{"title":1}']) {
      const { client: github } = client(() => jsonResponse(body));
      expect(await getJson(github, call(), Shape)).toEqual({
        ok: false,
        failure: { code: "badResponse", status: null },
      });
    }
  });
});

describe("createGitHubClient: a token (Layer C)", () => {
  const SECRET = "PLANTEDsecret";
  const token = (scope: string): GitHubAuth => ({
    kind: "token",
    scope,
    bearer: () => `github_pat_${SECRET}${"x".repeat(40)}`,
  });

  it("sends the token as a bearer header and keys it by whose it is, never by the token", () => {
    expect(authScope(token("acme"))).toBe("token:acme");
    expect(authScope(token("*"))).toBe("token:*");
    expect(authKind(token("acme"))).toBe("token");
    expect(authScope(ANONYMOUS)).toBe("anonymous");
  });

  it("puts the token in the Authorization header and nowhere else", async () => {
    const fake = fakeTransport(() => jsonResponse("{}"));
    const tokenClient = createGitHubClient({
      transport: fake.transport,
      userAgent: "t",
      now: () => NOW,
    });
    await tokenClient.graphql(token("acme"), GRAPHQL.COMMENT_STATE, { id: "C1" });
    const sent = fake.calls[0];
    const headers = sent?.init.headers as Record<string, string> | undefined;
    expect(headers?.["Authorization"]).toBe(`Bearer github_pat_${SECRET}${"x".repeat(40)}`);
    expect(sent?.url).not.toContain(SECRET);
    expect(String(sent?.init.body)).not.toContain(SECRET);
  });

  it("says a spent token limit is the token's, and keeps it apart from the anonymous one", async () => {
    let limited = true;
    const fake = fakeTransport(() =>
      limited ? rateLimitedResponse(Math.floor(NOW / 1000) + 600) : jsonResponse("{}"),
    );
    const tokenClient = createGitHubClient({
      transport: fake.transport,
      userAgent: "t",
      now: () => NOW,
    });
    const answer = await tokenClient.send(call({ auth: token("acme") }));
    expect(answer).toMatchObject({ ok: false, failure: { code: "rateLimited", scope: "token" } });
    expect(JSON.stringify(answer)).not.toContain(SECRET);
    limited = false;
    // The anonymous gate is its own: still open.
    expect((await tokenClient.send(call())).ok).toBe(true);
    // The token's is shut, and another owner's token has its own.
    expect(await tokenClient.send(call({ auth: token("acme") }))).toMatchObject({ ok: false });
    expect((await tokenClient.send(call({ auth: token("other") }))).ok).toBe(true);
  });

  it("reads back only the headers it is asked for by name", async () => {
    const fake = fakeTransport(() =>
      jsonResponse('{"login":"me"}', {
        headers: { "x-oauth-scopes": "public_repo", "set-cookie": "a=b", etag: '"e"' },
      }),
    );
    const tokenClient = createGitHubClient({ transport: fake.transport, userAgent: "t" });
    const answer = await tokenClient.sendWithHeaders(call({ path: "/user", noStore: true }), [
      "x-oauth-scopes",
      "github-authentication-token-expiration",
    ]);
    expect(answer).toEqual({
      ok: true,
      value: {
        body: '{"login":"me"}',
        headers: {
          "x-oauth-scopes": "public_repo",
          "github-authentication-token-expiration": null,
        },
      },
    });
  });

  it("keeps a noStore answer out of the ETag cache both ways", async () => {
    const fake = fakeTransport(() => jsonResponse("{}", { headers: { etag: '"e"' } }));
    const tokenClient = createGitHubClient({ transport: fake.transport, userAgent: "t" });
    await tokenClient.send(call({ noStore: true }));
    await tokenClient.send(call({ noStore: true }));
    await tokenClient.send(call());
    for (const sent of fake.calls) {
      expect(sent.init.headers).not.toHaveProperty("If-None-Match");
    }
  });
});
