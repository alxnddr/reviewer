import * as z from "zod";
import {
  GitHubScopeName,
  type GitHubSetTokenResponse,
  type GitHubTokenKind,
  type GitHubTokenRefusal,
  type GitHubTokenStatus,
} from "../../shared/github-posting";
import { GitHubOwner } from "../../shared/pull-request";
import { apiPath, type GitHubAuth, type GitHubClient } from "./client";

// The reader's GitHub tokens (`next-features.md`, C1 and C2, and the threat model above them):
// which ones are accepted, how a pasted one is checked, and where it is kept — in this module's
// closure, in main's memory, until the app quits.
//
// **Memory only, and why.** The app is not signed. Until it is, a "remember my token" backed by
// `safeStorage` would keep the token in a Keychain item an agent can reach by running JavaScript
// *as* Reviewer — rewriting `app.asar` and waiting for the next launch is enough without
// signing, fuses or not — so remembering would only slow an agent down while telling the reader
// it was safe. So the reader pastes a token once per launch, and nothing here touches the disk.
// **The seam for later** is `createCredentialVault`: once the app is signed and notarized, a
// store that seals each entry with `safeStorage` in its own file under userData (never
// `main/store.ts`, which the reader's settings share) loads into the vault at launch and is
// written by `add`/`forget`. Nothing outside this module would change.
//
// **Where the secret is, exactly.** One `Map` inside `createCredentialVault`'s closure. The vault
// hands out a `GitHubAuth` whose `bearer` is a function closed over that entry, so the secret is
// never a property of any object that leaves this file — a log line, a `JSON.stringify` of a
// call, a crash record of a thrown request would all find a function, not a string. It is never
// written to an environment variable, never passed to git (git keeps the reader's own
// credentials), never put in a failure, and never sent back over IPC: what leaves is
// `GitHubTokenStatus` — kind, login, owner, expiry — which GitHub tells anyone who asks.
//
// **Which tokens (C1).** A fine-grained token (`github_pat_`) is accepted after one successful
// `GET /user` with it: its permissions cannot be read back, so the app does not claim to have
// checked that it is narrow — Settings says how to make one that is. A classic token (`ghp_`) is
// accepted only when `X-OAuth-Scopes` says exactly `public_repo`: anything wider (`repo` is every
// private repository) is the exposure the reader is trying to avoid. Every other kind is refused
// by its prefix, before it is ever sent anywhere — `gho_` in particular, which is what `gh` holds
// (`next-features.md`'s Decisions: its scopes cannot be narrowed).
//
// **Keyed by owner.** A fine-grained token covers one resource owner — the reader's account or
// one organisation — and that cannot be read back either, so the reader says which (default:
// the token's own login). A classic `public_repo` token covers every owner's public repositories.
// For a pull request, the token for its owner wins (case-insensitively, as GitHub's names are);
// the classic one answers otherwise.

/** The one-off scope of a token being validated, numbered so no two candidates share a
 * rate-limit gate or anything else keyed on scope. */
let validationCount = 0;

/** What a pasted string is, by its shape alone — before it is sent anywhere. */
export type TokenShape =
  | { ok: true; kind: GitHubTokenKind }
  | { ok: false; refusal: Extract<GitHubTokenRefusal, { code: "malformed" | "unsupportedKind" }> };

/** Every GitHub token is letters, digits and underscores. Anything else — a space, a newline, a
 * quote from a sloppy copy — is refused here, which is also what keeps an `Authorization` header
 * built from it from ever being invalid (an invalid header value's error message would quote
 * it). */
const TOKEN_CHARSET = /^[A-Za-z0-9_]+$/u;
/** The shortest token GitHub issues is 40 characters. */
const TOKEN_MIN = 40;

/** Classify a pasted token by its prefix (GitHub's documented token formats). */
export function tokenShape(token: string): TokenShape {
  if (token.length < TOKEN_MIN || !TOKEN_CHARSET.test(token)) {
    return { ok: false, refusal: { code: "malformed" } };
  }
  const unsupported = (
    kind: Extract<GitHubTokenRefusal, { code: "unsupportedKind" }>["kind"],
  ): TokenShape => ({ ok: false, refusal: { code: "unsupportedKind", kind } });
  if (token.startsWith("github_pat_")) {
    return { ok: true, kind: "fineGrained" };
  }
  if (token.startsWith("ghp_")) {
    return { ok: true, kind: "classic" };
  }
  if (token.startsWith("gho_")) {
    return unsupported("oauth");
  }
  if (token.startsWith("ghu_")) {
    return unsupported("appUser");
  }
  if (token.startsWith("ghs_")) {
    return unsupported("installation");
  }
  if (token.startsWith("ghr_")) {
    return unsupported("refresh");
  }
  return unsupported("unknown");
}

/** `X-OAuth-Scopes` as GitHub sends it: absent (a fine-grained token, which has no scopes to
 * list), or a comma-separated list — possibly empty, which is a classic token with no scope at
 * all. The two are different answers and are kept apart. Each name is trimmed; a name outside
 * GitHub's scope charset is kept as `unrecognised` rather than dropped, so it still counts as a
 * scope the token has. */
export type ScopesHeader =
  | { kind: "absent" }
  | { kind: "listed"; scopes: string[]; unrecognised: number };

export function readScopesHeader(value: string | null | undefined): ScopesHeader {
  if (value === null || value === undefined) {
    return { kind: "absent" };
  }
  const names = value
    .split(",")
    .map((name) => name.trim().toLowerCase())
    .filter((name) => name !== "");
  const scopes = [...new Set(names.filter((name) => GitHubScopeName.safeParse(name).success))];
  return {
    kind: "listed",
    scopes: scopes.toSorted(),
    unrecognised: names.filter((name) => !GitHubScopeName.safeParse(name).success).length,
  };
}

/** Whether a classic token's scopes are exactly `public_repo` — nothing more, nothing less. */
export function onlyPublicRepo(header: ScopesHeader): boolean {
  return (
    header.kind === "listed" &&
    header.unrecognised === 0 &&
    header.scopes.length === 1 &&
    header.scopes[0] === "public_repo"
  );
}

/** `github-authentication-token-expiration` as an ISO instant, or null. GitHub writes it
 * `2026-11-01 12:00:00 UTC`, and has been seen writing a numeric offset (`+0500`) instead; both
 * are read, anything else is null. Advisory only — reported unreliable for fine-grained tokens —
 * so a value that does not parse costs the expiry line, nothing more. */
export function readTokenExpiry(value: string | null | undefined): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  const match =
    /^(?<date>\d{4}-\d{2}-\d{2})[ T](?<time>\d{2}:\d{2}:\d{2})\s*(?<zone>UTC|Z|[+-]\d{2}:?\d{2})?$/u.exec(
      value.trim(),
    );
  if (match?.groups === undefined) {
    return null;
  }
  const { date, time, zone } = match.groups;
  const offset =
    zone === undefined || zone === "UTC" || zone === "Z"
      ? "Z"
      : `${zone.slice(0, 3)}:${zone.slice(-2)}`;
  const at = Date.parse(`${date ?? ""}T${time ?? ""}${offset}`);
  return Number.isNaN(at) ? null : new Date(at).toISOString();
}

/** One held token. `token` is the secret; it lives in this record inside the vault's map and is
 * read by the `bearer` closure the vault hands out, nowhere else. */
type HeldToken = GitHubTokenStatus & { token: string };

export type CredentialVault = {
  /** What main holds, with no part of any token in it. */
  status: () => GitHubTokenStatus[];
  /** Keep a validated token, replacing one for the same owner (or the classic one). */
  add: (held: HeldToken) => void;
  /** Forget the token for `owner`, or the classic one (`null`). */
  forget: (owner: string | null) => void;
  /** The credential a pull request of `owner` is posted with: the token for that owner first,
   * else the classic one, else none. */
  authFor: (owner: string) => GitHubAuth | null;
  /** Whether the token behind `auth` is past the expiry GitHub reported — what tells an
   * expired token's 401 from a revoked one's. */
  expired: (auth: GitHubAuth, now: number) => boolean;
};

/** The vault's key for a token: its owner case-folded, or `*` for a classic token. Also the
 * token's `authScope` suffix, which is why it may name an owner and never the token. */
function ownerKey(owner: string | null): string {
  return owner === null ? "*" : owner.toLowerCase();
}

export function createCredentialVault(): CredentialVault {
  const held = new Map<string, HeldToken>();

  const authOf = (key: string, entry: HeldToken): GitHubAuth => ({
    kind: "token",
    scope: key,
    // Read at the moment the header is built: a token forgotten after this auth was handed out
    // is still sent by a call already holding it, and by nothing after.
    bearer: () => entry.token,
  });

  return {
    status: () =>
      [...held.values()]
        .map(({ kind, login, owner, expiresAt }) => ({ kind, login, owner, expiresAt }))
        .toSorted((a, b) => ownerKey(a.owner).localeCompare(ownerKey(b.owner))),
    add: (entry) => {
      held.set(ownerKey(entry.owner), { ...entry });
    },
    forget: (owner) => {
      held.delete(ownerKey(owner));
    },
    authFor: (owner) => {
      const exact = held.get(ownerKey(owner));
      if (exact !== undefined) {
        return authOf(ownerKey(owner), exact);
      }
      const classic = held.get("*");
      return classic === undefined ? null : authOf("*", classic);
    },
    expired: (auth, now) => {
      if (auth.kind !== "token") {
        return false;
      }
      const expiresAt = held.get(auth.scope)?.expiresAt ?? null;
      return expiresAt !== null && Date.parse(expiresAt) <= now;
    },
  };
}

/** `GET /user`, cut to the one field read. */
const RawUser = z.object({ login: z.string() });

/** The answer is small; anything larger is not the documented one. */
const USER_MAX_BYTES = 256 * 1024;

/** Check a pasted token with GitHub and describe it (C1): refuse it by shape before it is sent
 * anywhere, then `GET /user` with it — which proves GitHub accepts it, names its login, and (for a
 * classic token) lists its scopes. The answer never carries any part of the token; a refusal is a
 * code. `owner` is the account or organisation the reader says a fine-grained token is for. */
/** What checking a token came to, before anything about the clipboard. */
export type TokenCheck =
  | (GitHubTokenStatus & { ok: true })
  | { ok: false; failure: GitHubTokenRefusal };

export async function validateToken(
  client: GitHubClient,
  token: string,
  owner: string | undefined,
): Promise<TokenCheck> {
  const shape = tokenShape(token);
  if (!shape.ok) {
    return { ok: false, failure: shape.refusal };
  }
  validationCount += 1;
  const candidate: GitHubAuth = {
    kind: "token",
    scope: `?validating-${validationCount}`,
    bearer: () => token,
  };
  const answer = await client.sendWithHeaders(
    {
      path: apiPath("user"),
      media: "json",
      auth: candidate,
      resource: "core",
      maxBytes: USER_MAX_BYTES,
      // This candidate's own answer, never one kept for whichever token was pasted before.
      noStore: true,
    },
    ["x-oauth-scopes", "github-authentication-token-expiration"],
  );
  if (!answer.ok) {
    return answer;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(answer.value.body);
  } catch {
    return { ok: false, failure: { code: "badResponse", status: null } };
  }
  const user = RawUser.safeParse(raw);
  const login = user.success ? GitHubOwner.safeParse(user.data.login) : null;
  if (login === null || !login.success) {
    return { ok: false, failure: { code: "badResponse", status: null } };
  }
  const scopes = readScopesHeader(answer.value.headers["x-oauth-scopes"]);
  const expiresAt = readTokenExpiry(answer.value.headers["github-authentication-token-expiration"]);
  switch (shape.kind) {
    case "classic":
      if (scopes.kind === "absent") {
        return { ok: false, failure: { code: "classicScopesUnknown" } };
      }
      if (!onlyPublicRepo(scopes)) {
        return { ok: false, failure: { code: "classicScopes", scopes: scopes.scopes } };
      }
      return { ok: true, kind: "classic", login: login.data, owner: null, expiresAt };
    case "fineGrained":
      return {
        ok: true,
        kind: "fineGrained",
        login: login.data,
        owner: owner ?? login.data,
        expiresAt,
      };
  }
}

/** The two calls on Electron's `clipboard` this needs. */
export type Clipboard = { readText: () => string; clear: () => void };

/** Empty the clipboard if it holds exactly `token` (surrounding whitespace aside), and say whether
 * it did. Pasting a token leaves it on the general pasteboard, where any program the reader runs —
 * an agent included — can read it for as long as nothing else is copied; once main holds the
 * token, the copy there is only exposure. Anything else on the clipboard is the reader's, and is
 * left alone. */
export function clearClipboardIfToken(clipboard: Clipboard, token: string): boolean {
  if (clipboard.readText().trim() !== token.trim()) {
    return false;
  }
  clipboard.clear();
  return true;
}

/** `github:set-token` from end to end, Electron injected. First, on receipt and whatever comes of
 * it, the paste comes off the clipboard (`clearClipboardIfToken`): a token GitHub refuses, or one
 * refused here, is no less a secret sitting where any program can read it. Then: refuse while the
 * app is exposed (`exposure.ts`); else check the token with GitHub (`validateToken`) and keep it.
 * A throw is answered `unexpected`, logged by its name only — whatever threw was handed the token,
 * and a message is free to quote what it was handed. */
export async function acceptToken(
  deps: {
    client: GitHubClient;
    vault: CredentialVault;
    clipboard: Clipboard;
    exposedBy: () => readonly string[];
  },
  token: string,
  owner: string | undefined,
): Promise<GitHubSetTokenResponse> {
  let clipboardCleared = false;
  try {
    clipboardCleared = clearClipboardIfToken(deps.clipboard, token);
    if (deps.exposedBy().length > 0) {
      return { ok: false, failure: { code: "debuggingEnabled" }, clipboardCleared };
    }
    const answer = await validateToken(deps.client, token, owner);
    if (!answer.ok) {
      return { ...answer, clipboardCleared };
    }
    const { kind, login, owner: covers, expiresAt } = answer;
    deps.vault.add({ kind, login, owner: covers, expiresAt, token });
    return { ...answer, clipboardCleared };
  } catch (error) {
    console.error(
      "Taking a GitHub token failed unexpectedly:",
      error instanceof Error ? error.name : typeof error,
    );
    return { ok: false, failure: { code: "unexpected" }, clipboardCleared };
  }
}
