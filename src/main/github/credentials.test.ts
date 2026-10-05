import { inspect } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GitHubPostedResponse,
  GitHubSetTokenRequest,
  GitHubSetTokenResponse,
  GitHubStatus,
} from "../../shared/github-posting";
import { createGitHubClient } from "./client";
import {
  acceptToken,
  clearClipboardIfToken,
  createCredentialVault,
  onlyPublicRepo,
  readScopesHeader,
  readTokenExpiry,
  tokenShape,
  validateToken,
} from "./credentials";
import { fakeTransport, jsonResponse } from "./fixtures";

// C1's token rules and C2's keeping, with GitHub faked: which pasted strings are refused before
// they are sent anywhere, what `GET /user` must say for a token to be accepted, how a token is
// picked for a pull request — and that no answer, status, failure or schema error ever carries
// any part of a token.

const SECRET = "PLANTEDsecret";
const FINE = `github_pat_${SECRET}0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJ`;
const CLASSIC = `ghp_${SECRET}0123456789abcdefghijklmnopqrstu`;

afterEach(() => {
  vi.restoreAllMocks();
});

/** GitHub's `GET /user`, answering as `login` with these headers. */
function user(login: string, headers: Record<string, string> = {}) {
  return fakeTransport(() =>
    jsonResponse(JSON.stringify({ login, id: 1, type: "User" }), { headers }),
  );
}

describe("tokenShape", () => {
  it("accepts the two kinds by prefix", () => {
    expect(tokenShape(FINE)).toEqual({ ok: true, kind: "fineGrained" });
    expect(tokenShape(CLASSIC)).toEqual({ ok: true, kind: "classic" });
  });

  it("refuses every other kind by name, gh's own first", () => {
    const pad = "x".repeat(40);
    expect(tokenShape(`gho_${pad}`)).toEqual({
      ok: false,
      refusal: { code: "unsupportedKind", kind: "oauth" },
    });
    expect(tokenShape(`ghu_${pad}`)).toMatchObject({ refusal: { kind: "appUser" } });
    expect(tokenShape(`ghs_${pad}`)).toMatchObject({ refusal: { kind: "installation" } });
    expect(tokenShape(`ghr_${pad}`)).toMatchObject({ refusal: { kind: "refresh" } });
    // A pre-2021 classic token: forty hex characters, no prefix.
    expect(tokenShape("0123456789abcdef0123456789abcdef01234567")).toMatchObject({
      refusal: { kind: "unknown" },
    });
  });

  it("refuses anything with a character no token has, which no header could carry", () => {
    expect(tokenShape(`${FINE}\n`)).toEqual({ ok: false, refusal: { code: "malformed" } });
    expect(tokenShape(`Bearer ${FINE}`)).toEqual({ ok: false, refusal: { code: "malformed" } });
    expect(tokenShape("ghp_short")).toEqual({ ok: false, refusal: { code: "malformed" } });
  });
});

describe("readScopesHeader", () => {
  it("tells an absent header from an empty one", () => {
    expect(readScopesHeader(null)).toEqual({ kind: "absent" });
    expect(readScopesHeader("")).toEqual({ kind: "listed", scopes: [], unrecognised: 0 });
  });

  it("accepts exactly public_repo, however it is spaced", () => {
    expect(onlyPublicRepo(readScopesHeader("public_repo"))).toBe(true);
    expect(onlyPublicRepo(readScopesHeader(" public_repo ,"))).toBe(true);
    expect(onlyPublicRepo(readScopesHeader("public_repo, repo"))).toBe(false);
    expect(onlyPublicRepo(readScopesHeader("repo"))).toBe(false);
    expect(onlyPublicRepo(readScopesHeader("public_repo, ??"))).toBe(false);
    expect(onlyPublicRepo(readScopesHeader(""))).toBe(false);
    expect(onlyPublicRepo({ kind: "absent" })).toBe(false);
  });
});

describe("readTokenExpiry", () => {
  it("reads GitHub's UTC form and a numeric offset", () => {
    expect(readTokenExpiry("2026-11-01 12:00:00 UTC")).toBe("2026-11-01T12:00:00.000Z");
    expect(readTokenExpiry("2026-11-01 12:00:00 +0500")).toBe("2026-11-01T07:00:00.000Z");
  });

  it("answers null for anything else", () => {
    expect(readTokenExpiry(null)).toBeNull();
    expect(readTokenExpiry("soon")).toBeNull();
    expect(readTokenExpiry("2026-13-45 99:00:00 UTC")).toBeNull();
  });
});

describe("validateToken", () => {
  it("accepts a fine-grained token after GitHub answers for it, owned by its login by default", async () => {
    const fake = user("octocat", {
      "github-authentication-token-expiration": "2026-12-01 00:00:00 UTC",
    });
    const client = createGitHubClient({ transport: fake.transport, userAgent: "t" });
    expect(await validateToken(client, FINE, undefined)).toEqual({
      ok: true,
      kind: "fineGrained",
      login: "octocat",
      owner: "octocat",
      expiresAt: "2026-12-01T00:00:00.000Z",
    });
    expect(await validateToken(client, FINE, "acme")).toMatchObject({ owner: "acme" });
    expect(fake.calls[0]?.url).toBe("https://api.github.com/user");
    const headers = fake.calls[0]?.init.headers as Record<string, string> | undefined;
    expect(headers?.["Authorization"]).toBe(`Bearer ${FINE}`);
  });

  it("accepts a classic token whose only scope is public_repo, for every owner", async () => {
    const client = createGitHubClient({
      transport: user("octocat", { "x-oauth-scopes": "public_repo" }).transport,
      userAgent: "t",
    });
    expect(await validateToken(client, CLASSIC, "acme")).toEqual({
      ok: true,
      kind: "classic",
      login: "octocat",
      owner: null,
      expiresAt: null,
    });
  });

  it("refuses a wider classic token, naming the scopes and nothing of the token", async () => {
    const client = createGitHubClient({
      transport: user("octocat", { "x-oauth-scopes": "repo, read:org, gist" }).transport,
      userAgent: "t",
    });
    expect(await validateToken(client, CLASSIC, undefined)).toEqual({
      ok: false,
      failure: { code: "classicScopes", scopes: ["gist", "read:org", "repo"] },
    });
  });

  it("refuses a classic token GitHub would not list the scopes of", async () => {
    const client = createGitHubClient({ transport: user("octocat").transport, userAgent: "t" });
    expect(await validateToken(client, CLASSIC, undefined)).toEqual({
      ok: false,
      failure: { code: "classicScopesUnknown" },
    });
  });

  it("refuses gh's kind of token without sending it anywhere", async () => {
    const fake = user("octocat");
    const client = createGitHubClient({ transport: fake.transport, userAgent: "t" });
    expect(await validateToken(client, `gho_${SECRET}${"x".repeat(30)}`, undefined)).toEqual({
      ok: false,
      failure: { code: "unsupportedKind", kind: "oauth" },
    });
    expect(fake.calls).toEqual([]);
  });

  it("passes GitHub's refusal through as a code", async () => {
    const client = createGitHubClient({
      transport: fakeTransport(() => jsonResponse('{"message":"Bad credentials"}', { status: 401 }))
        .transport,
      userAgent: "t",
    });
    expect(await validateToken(client, FINE, undefined)).toEqual({
      ok: false,
      failure: { code: "unauthorized" },
    });
  });

  it("never revalidates against an answer kept for another candidate", async () => {
    const fake = fakeTransport(() =>
      jsonResponse(JSON.stringify({ login: "octocat" }), { headers: { etag: '"abc"' } }),
    );
    const client = createGitHubClient({ transport: fake.transport, userAgent: "t" });
    await validateToken(client, FINE, undefined);
    await validateToken(client, FINE, undefined);
    for (const call of fake.calls) {
      expect(call.init.headers).not.toHaveProperty("If-None-Match");
    }
  });
});

describe("createCredentialVault", () => {
  const held = {
    fine: {
      kind: "fineGrained" as const,
      login: "me",
      owner: "Acme",
      expiresAt: null,
      token: FINE,
    },
    classic: {
      kind: "classic" as const,
      login: "me",
      owner: null,
      expiresAt: null,
      token: CLASSIC,
    },
  };

  it("picks the owner's token first, case aside, then the classic one", () => {
    const vault = createCredentialVault();
    expect(vault.authFor("acme")).toBeNull();
    vault.add(held.classic);
    expect(vault.authFor("acme")).toMatchObject({ kind: "token", scope: "*" });
    vault.add(held.fine);
    expect(vault.authFor("ACME")).toMatchObject({ kind: "token", scope: "acme" });
    expect(vault.authFor("other")).toMatchObject({ scope: "*" });
    const auth = vault.authFor("acme");
    expect(auth?.kind === "token" ? auth.bearer() : null).toBe(FINE);
    vault.forget("ACME");
    expect(vault.authFor("acme")).toMatchObject({ scope: "*" });
    vault.forget(null);
    expect(vault.authFor("acme")).toBeNull();
  });

  it("knows an expired token by the expiry GitHub reported", () => {
    const vault = createCredentialVault();
    vault.add({ ...held.fine, expiresAt: "2026-01-01T00:00:00.000Z" });
    const auth = vault.authFor("acme");
    expect(auth === null ? null : vault.expired(auth, Date.UTC(2026, 5, 1))).toBe(true);
    expect(auth === null ? null : vault.expired(auth, Date.UTC(2025, 5, 1))).toBe(false);
  });

  it("describes what it holds with no part of any token, however it is printed", () => {
    watch();
    const vault = createCredentialVault();
    vault.add(held.fine);
    vault.add(held.classic);
    const status = GitHubStatus.parse({ tokens: vault.status(), exposedBy: [] });
    const auth = vault.authFor("acme");
    // What a log line or a crash record would print of it: `inspect` is what `console` and
    // `crash.ts` use for an object.
    console.log(status, auth);
    expect(JSON.stringify(status)).not.toContain(SECRET);
    expect(JSON.stringify(auth)).not.toContain(SECRET);
    expect(inspect(auth, { depth: 10, showHidden: true })).not.toContain(SECRET);
    expect(inspect(logged, { depth: 10 })).not.toContain(SECRET);
  });
});

describe("the set-token wire", () => {
  it("refuses an oversized paste with an error that quotes none of it", () => {
    const pasted = `${FINE}${"y".repeat(300)}`;
    const result = GitHubSetTokenRequest.safeParse({ token: pasted });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).not.toContain(SECRET);
    expect(String(result.error)).not.toContain(SECRET);
    expect(GitHubSetTokenRequest.safeParse({ token: FINE, owner: "not a login" }).success).toBe(
      false,
    );
  });

  it("has no room in its answer for a token", () => {
    const smuggled = GitHubSetTokenResponse.parse({
      ok: true,
      kind: "fineGrained",
      login: "me",
      owner: "me",
      expiresAt: null,
      clipboardCleared: true,
      token: FINE,
    });
    expect(JSON.stringify(smuggled)).not.toContain(SECRET);
  });
});

const logged: unknown[][] = [];
function watch(): void {
  logged.length = 0;
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    logged.push(args);
  });
}

describe("what crosses IPC", () => {
  it("strips a token smuggled into a status or a post answer on the way out", () => {
    const token = { kind: "fineGrained", login: "me", owner: "me", expiresAt: null, token: FINE };
    expect(JSON.stringify(GitHubStatus.parse({ tokens: [token], exposedBy: [] }))).not.toContain(
      SECRET,
    );
    expect(
      JSON.stringify(
        GitHubPostedResponse.parse({
          ok: false,
          failure: { code: "unauthorized", token: FINE },
        }),
      ),
    ).not.toContain(SECRET);
  });
});

describe("acceptToken", () => {
  function clipboard(text: string) {
    const board = { text, readText: () => board.text, clear: vi.fn(() => (board.text = "")) };
    return board;
  }

  it("keeps a good token, and takes the very same paste off the clipboard", async () => {
    const board = clipboard(`  ${FINE}\n`);
    const vault = createCredentialVault();
    const client = createGitHubClient({ transport: user("octocat").transport, userAgent: "t" });
    const answer = await acceptToken(
      { client, vault, clipboard: board, exposedBy: () => [] },
      FINE,
      undefined,
    );
    expect(answer).toMatchObject({ ok: true, clipboardCleared: true });
    expect(board.clear).toHaveBeenCalledTimes(1);
    expect(vault.authFor("octocat")).not.toBeNull();
    expect(JSON.stringify(answer)).not.toContain(SECRET);
  });

  it("clears the paste on receipt, whatever GitHub says of the token", async () => {
    const refusing = {
      classic: createGitHubClient({
        transport: user("octocat", { "x-oauth-scopes": "repo" }).transport,
        userAgent: "t",
      }),
      revoked: createGitHubClient({
        transport: fakeTransport(() =>
          jsonResponse('{"message":"Bad credentials"}', { status: 401 }),
        ).transport,
        userAgent: "t",
      }),
    };
    for (const [token, client, code] of [
      [CLASSIC, refusing.classic, "classicScopes"],
      [FINE, refusing.revoked, "unauthorized"],
    ] as const) {
      const board = clipboard(token);
      const answer = await acceptToken(
        { client, vault: createCredentialVault(), clipboard: board, exposedBy: () => [] },
        token,
        undefined,
      );
      expect(answer).toMatchObject({ ok: false, failure: { code }, clipboardCleared: true });
      expect(board.clear).toHaveBeenCalledTimes(1);
    }
  });

  it("clears it, and answers unexpected without the error's text, when something throws", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const board = clipboard(FINE);
    const throwing = {
      send: () => Promise.reject(new Error(`boom ${FINE}`)),
      sendWithHeaders: () => Promise.reject(new Error(`boom ${FINE}`)),
      graphql: () => Promise.reject(new Error(`boom ${FINE}`)),
    };
    expect(
      await acceptToken(
        { client: throwing, vault: createCredentialVault(), clipboard: board, exposedBy: () => [] },
        FINE,
        undefined,
      ),
    ).toEqual({ ok: false, failure: { code: "unexpected" }, clipboardCleared: true });
    expect(JSON.stringify(errors.mock.calls)).not.toContain(SECRET);
  });

  it("leaves anything else on the clipboard alone", () => {
    const board = clipboard("a shopping list");
    expect(clearClipboardIfToken(board, FINE)).toBe(false);
    expect(board.clear).not.toHaveBeenCalled();
  });

  it("refuses while the app is exposed, before sending the token anywhere", async () => {
    const fake = user("octocat");
    const vault = createCredentialVault();
    const client = createGitHubClient({ transport: fake.transport, userAgent: "t" });
    expect(
      await acceptToken(
        { client, vault, clipboard: clipboard(FINE), exposedBy: () => ["remote-debugging-port"] },
        FINE,
        undefined,
      ),
    ).toEqual({ ok: false, failure: { code: "debuggingEnabled" }, clipboardCleared: true });
    expect(fake.calls).toEqual([]);
    expect(vault.status()).toEqual([]);
  });
});
