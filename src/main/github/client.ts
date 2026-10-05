import type * as z from "zod";
import type { GitHubFailure, GitHubResult } from "../../shared/github-ipc";
import type { GraphqlDocument } from "./graphql-documents";

// The one way anything in this app reaches GitHub over HTTP. Every request main makes to GitHub
// — the inbox search and the pull request reads (`rest.ts`, GETs, as `GitHubCall`s) and Layer C's
// GraphQL (`graphql.ts`, the one POST, through `graphql`) — goes through `createGitHubClient`, and
// nothing else in the codebase opens a connection to GitHub (`never-submit.test.ts` holds that). (git's own fetches are git's, with the reader's own credentials;
// they never pass through here.)
//
// What the boundary holds, each for a reason:
//
//   - **An allowlist of exactly `https://api.github.com`.** A call names a path, never a URL;
//     the origin is this module's constant, and the built URL is asserted against the allowlist
//     before every request — https, that host, the default port, no userinfo, and a pathname
//     exactly the path asked for (`apiUrl`), so a dot segment, a backslash, a `?` or a `#` that
//     would have the URL parser resolve or split the path somewhere else is refused rather than
//     followed. A redirect is followed by this code, not the transport — only for a GET, only to
//     the same allowlisted origin (GitHub answers a renamed or transferred repository with a 301
//     to `/repositories/<id>/…`), and at most `MAX_REDIRECTS` times; anywhere else is
//     `badResponse`. So the transport must hand back a redirect *as a response* — a 3xx with its
//     `location` — and never follow one itself (`redirect: "manual"`). Electron's `net.fetch`
//     cannot do that: in manual mode it rejects with "Redirect was cancelled" for every redirect,
//     same origin or not, and never returns the 3xx — which is why the app's transport is
//     `net-transport.ts`, built on `net.request`, and not `net.fetch`.
//   - **A timeout over the whole exchange**, body included: one `AbortController` per call, fired
//     after `timeoutMs`, which is what tells a `timeout` apart from a `network` failure. The same
//     controller is aborted when the call ends, *however* it ends (`send`'s `finally`): a body cut
//     off at the cap, an error body never read, a redirect's body, a finished read. Cancelling a
//     body stream alone does not release the connection under Electron — measured: the socket
//     stayed open, stalled, until quit — and aborting the request does.
//   - **A response size cap per call.** The body is read as a stream and abandoned the moment it
//     passes `maxBytes` (a declared `content-length` past it is refused before reading at all),
//     so a pull request's diff can never become an unbounded allocation in main.
//   - **Every response parsed.** JSON goes through the call's zod schema (`getJson`); a body that
//     does not parse is `badResponse`, never a cast.
//   - **Typed failures, never a throw.** The transport throwing, a status GitHub documents, a
//     redirect off the allowlist: each is one `GitHubFailure` code (`shared/github-ipc.ts`),
//     whose sentence the renderer composes. No GitHub `message` text crosses into a failure.
//     **For Layer C's writes:** `timeout` and `network` say the *answer* did not arrive, not that
//     the request did not land. A write that timed out, or whose connection dropped, may well have
//     been applied by GitHub — a thread added, a pending review created — so a poster must read
//     state back (or use an idempotent shape) before it retries, never assume nothing happened.
//   - **The rate limit respected, not discovered twice.** A `rateLimited` answer closes the gate
//     for that limit (`rateLimitKey`: who is asking × which of GitHub's limits) until the reset,
//     and calls before then answer `rateLimited` without touching the network — a reader
//     pressing Refresh on a spent search limit costs nothing. The reset is read on GitHub's clock
//     and translated to this machine's through the answer's `Date` header, then clamped
//     (`resetAtFrom`): a skewed clock must not shut the gate for a day, and a nonsense header must
//     not become a number the IPC schema refuses.
//   - **Conditional requests, ours alone.** A GET answered with an `ETag` keeps that tag and its
//     body (`createEtagCache`, small and in memory); the next identical GET sends `If-None-Match`,
//     and a `304` answers with the kept body. GitHub does not count a 304 against the primary
//     limit for an *authenticated* request (Layer C's) — checked live (2026-10-03), an
//     unauthenticated 304 is still counted, so today it saves bytes, not budget; `rest.ts`'s
//     short memo of a pull request is what saves the anonymous budget. The cache is keyed by who
//     asked (`authScope`), the media and the URL, so an answer fetched with a token can never be
//     served to an anonymous call or the other way round, and a pull request's JSON never answers
//     for its diff at the same URL. The transport's own HTTP cache stays off (`cache:
//     "no-store"`): revalidation is this scheme's and nobody else's, and Layer C's authenticated
//     answers must not land in Chromium's disk cache.
//   - **No cookies.** `credentials: "omit"`: Electron's network stack issues from the default
//     session, whose cookies for github.com would otherwise ride along.
//
// **The transport is injected** (`GitHubTransport`), so this module is Electron-free and its
// tests run against a fake with no network. In the app it is `netTransport` (`net-transport.ts`)
// over Electron's `net.request`, not Node's global `fetch`: Electron's net module goes through
// Chromium's network stack, which honours the system proxy settings (and PAC) and the macOS trust
// store — what makes it work on a corporate network that proxies or inspects TLS, where Node's
// fetch would see neither.
//
// **Credentials, and the rule.** Every call names its `auth`: `anonymous`, or Layer C's `token`
// (`credentials.ts` holds the tokens; this module only ever *sends* one). `authHeaders`,
// `authScope` and `authKind` are closed switches, so a third kind of credential is a compile
// error here until it says which header it sends and whose limit it counts against. The rule:
// **a credential never appears in a failure, a log line, a cache key, or anything that crosses
// IPC.** The token arm does not even carry the secret as a value — it carries a function that
// returns it (`bearer`), closed over in `credentials.ts`, so a `JSON.stringify` or a
// `console.log` of a call, an auth or a failure has no string to print. This module logs
// nothing, never echoes a request, and maps every transport throw to a code without reading the
// error — so an error that quotes a header (an invalid header value) dies here unread. It reads
// back exactly two response headers, by name (`ResponseHeaderName`), for `credentials.ts`'s
// validation of a pasted token; neither carries the credential.

/** The only origin a request may go to. */
export const GITHUB_API_ORIGIN = "https://api.github.com";
const GITHUB_API_HOST = "api.github.com";

/** The REST API version every call pins (`X-GitHub-Api-Version`): the shapes `rest.ts` parses
 * are this version's. GitHub answers 410 for a version it has retired, which reads as
 * `badResponse` — the visible sign it is time to move. */
export const GITHUB_API_VERSION = "2026-03-10";

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 3;
/** How long the gate stays shut after a rate-limited answer that named no usable reset —
 * GitHub's documented minimum wait for a secondary limit. */
const UNSPECIFIED_RESET_MS = 60_000;
/** The longest the gate is ever shut. GitHub's primary limits reset within the hour; a reset
 * further out than that is a clock or a header to distrust, not a reason to stop asking. */
const MAX_RESET_MS = 60 * 60 * 1000;
/** What the ETag cache keeps: a handful of answers, none large. A diff is not worth keeping here
 * — `diff-check.ts` keeps its geometry per head instead — so bodies past the size are not. */
const ETAG_MAX_ENTRIES = 32;
const ETAG_MAX_BODY_BYTES = 1024 * 1024;

/** A `fetch`-shaped function: `netTransport` in the app, a fake in the tests. It must report a
 * redirect as a 3xx response with its `location` rather than follow it, and honour the init's
 * `signal`, `credentials`, `cache` and headers. */
export type GitHubTransport = (url: string, init: RequestInit) => Promise<Response>;

/** Who a call is made as.
 *
 * - `anonymous`: no credential — unauthenticated limits are per network address.
 * - `token`: a personal access token the reader pasted (`credentials.ts`). `scope` names *whose*
 *   token it is — the owner it covers, `*` for a classic `public_repo` token, or a one-off name
 *   for a token still being validated — and is what limits and kept answers are keyed by
 *   (`authScope`). `bearer` returns the secret at the moment the header is built and nowhere
 *   else; it is a function so that the secret is never a property of this object (see the
 *   header's rule). */
export type GitHubAuth =
  | { kind: "anonymous" }
  | { kind: "token"; scope: string; bearer: () => string };
export const ANONYMOUS: GitHubAuth = { kind: "anonymous" };

/** Which credential a call is made as, as a value fit to be a key.
 *
 * **It must identify the credential, never contain it.** Three things key on it — the rate-limit
 * gate (`rateLimitKey`), the ETag cache (`etagKey`) and the pull request memo (`rest.ts`'s
 * `createPullRequestReader`) — and what keeps one credential's answers and limits from being
 * served to another is that two credentials never share a scope. A token is told apart by
 * *whose* it is (`token:<owner>`, `token:*`), never by the token string, because a map key is
 * still a place a secret would sit. */
export type AuthScope = "anonymous" | `token:${string}`;

/** The wire's `rateLimited.scope`: which *kind* of limit is spent, so the renderer can say whose
 * it is ("without a sign-in" is false for a token). */
export type RateLimitScope = Extract<GitHubFailure, { code: "rateLimited" }>["scope"];

function authHeaders(auth: GitHubAuth): Record<string, string> {
  switch (auth.kind) {
    case "anonymous":
      return {};
    case "token":
      return { Authorization: `Bearer ${auth.bearer()}` };
  }
}

/** The identity limits and cached answers are kept apart by (`AuthScope` says what it may and
 * may not be): unauthenticated limits are per network address, a token's are its own. */
export function authScope(auth: GitHubAuth): AuthScope {
  switch (auth.kind) {
    case "anonymous":
      return "anonymous";
    case "token":
      return `token:${auth.scope}`;
  }
}

/** The kind of credential a call was made as, for the wire (`RateLimitScope`). */
export function authKind(auth: GitHubAuth): RateLimitScope {
  switch (auth.kind) {
    case "anonymous":
      return "anonymous";
    case "token":
      return "token";
  }
}

/** Which of GitHub's limits a call counts against: `search` (10 a minute unauthenticated),
 * `graphql` (Layer C's posting, a token's own points budget), or everything else, `core` (60 an
 * hour unauthenticated). */
export type RateLimitResource = "core" | "search" | "graphql";

/** What the call expects back: JSON (`application/vnd.github+json`), or a pull request's diff
 * (`application/vnd.github.diff`, the plain `git diff` text). */
export type GitHubMedia = "json" | "diff";

const ACCEPT: Record<GitHubMedia, string> = {
  json: "application/vnd.github+json",
  diff: "application/vnd.github.diff",
};

export type GitHubCall = {
  /** The path under the API origin, `/`-rooted, its segments already encoded (`apiPath`). */
  path: string;
  query?: Readonly<Record<string, string>>;
  media: GitHubMedia;
  auth: GitHubAuth;
  resource: RateLimitResource;
  /** The most bytes of body read before the answer is `tooLarge`. */
  maxBytes: number;
  /** Keep this answer out of the ETag cache, both ways: neither revalidated against a kept body
   * nor kept. For a token being validated (`credentials.ts`), whose answer must be its own and
   * never one kept for whichever candidate was pasted before it. */
  noStore?: true;
};

/** The response headers a caller may read back, and no others: what `credentials.ts` needs to
 * validate a pasted token — its classic scopes, and the expiry GitHub reports. Neither carries
 * the credential. A closed list so that "read a header" can never grow into "read the headers". */
export type ResponseHeaderName = "x-oauth-scopes" | "github-authentication-token-expiration";

/** A body with the named headers it came with — absent ones as null. */
export type WithHeaders = {
  body: string;
  headers: Readonly<Partial<Record<ResponseHeaderName, string | null>>>;
};

/** A call as the exchange runs it: a `GitHubCall`, which is always a GET, or the one POST this
 * module makes — a GraphQL document from `graphql-documents.ts` to `/graphql` (`graphqlCall`).
 * Not exported: nothing outside this file can build a request with a body. */
type Request = GitHubCall & {
  graphql?: { document: GraphqlDocument; variables: Readonly<Record<string, unknown>> };
};

/** The path GraphQL is posted to, and the most of its answer read. */
const GRAPHQL_PATH = "/graphql";
const GRAPHQL_MAX_BYTES = 2 * 1024 * 1024;

export type GitHubClient = {
  /** A GET: the call's body as text, or why there is none. */
  send: (call: GitHubCall) => Promise<GitHubResult<string>>;
  /** The one write this app can make: a document from `graphql-documents.ts` — the type admits no
   * other string — posted to `/graphql` with its variables. There is no way to POST anything else,
   * to any other path: a REST write (a published review comment, a review event) is not a call
   * this client can be asked to make. The answer is the raw JSON text; `graphql.ts` reads it. */
  graphql: (
    auth: GitHubAuth,
    document: GraphqlDocument,
    variables: Readonly<Record<string, unknown>>,
  ) => Promise<GitHubResult<string>>;
  /** The same, with the named headers of the answer (`ResponseHeaderName`). A 304 served from
   * the ETag cache reports the 304's headers, so a caller that reads headers should set
   * `noStore`. */
  sendWithHeaders: (
    call: GitHubCall,
    names: readonly ResponseHeaderName[],
  ) => Promise<GitHubResult<WithHeaders>>;
};

export type GitHubClientOptions = {
  transport: GitHubTransport;
  /** GitHub refuses a request without one; it names the app and its version. */
  userAgent: string;
  timeoutMs?: number;
  now?: () => number;
};

/** `/a/b/c` from raw segments, each percent-encoded so no name can add a segment, a query or a
 * fragment. `.` and `..` survive encoding as themselves, and are refused by `apiUrl`. */
export function apiPath(...segments: readonly (string | number)[]): string {
  return segments.map((segment) => `/${encodeURIComponent(String(segment))}`).join("");
}

/** Whether a URL is one this module may request: https to the API host, default port, no
 * userinfo. */
export function isAllowedUrl(url: URL): boolean {
  return (
    url.protocol === "https:" &&
    url.hostname === GITHUB_API_HOST &&
    url.port === "" &&
    url.username === "" &&
    url.password === ""
  );
}

/** The call's URL, or null when it would leave the allowlist or not be the path asked for. The
 * built URL's pathname must equal `path` exactly: the URL parser resolves `.`/`..` segments,
 * turns `\` into `/`, and splits at `?` and `#`, and each of those would make the request go
 * somewhere the caller did not name. */
export function apiUrl(path: string, query?: Readonly<Record<string, string>>): URL | null {
  if (!path.startsWith("/") || path.startsWith("//")) {
    return null;
  }
  const url = new URL(path, GITHUB_API_ORIGIN);
  if (url.pathname !== path || url.search !== "" || url.hash !== "") {
    return null;
  }
  for (const [key, value] of Object.entries(query ?? {})) {
    url.searchParams.set(key, value);
  }
  return isAllowedUrl(url) ? url : null;
}

const fail = (failure: GitHubFailure): { ok: false; failure: GitHubFailure } => ({
  ok: false,
  failure,
});

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

/** Where a redirect points, resolved against the URL that answered — or null when it points off
 * the allowlist, or nowhere. */
function redirectTarget(response: Response, from: URL): URL | null {
  const location = response.headers.get("location");
  if (location === null) {
    return null;
  }
  try {
    const target = new URL(location, from);
    return isAllowedUrl(target) ? target : null;
  } catch {
    return null;
  }
}

/** A header as a non-negative finite number, or null. */
function numericHeader(response: Response, name: string): number | null {
  const raw = response.headers.get(name);
  if (raw === null || raw.trim() === "") {
    return null;
  }
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

/** When a spent limit refills, on this machine's clock, as a safe integer in `[now, now + 1h]`.
 *
 * `x-ratelimit-reset` is epoch seconds on GitHub's clock; read against GitHub's own `Date`
 * header it is a *duration* (reset − date), which is what survives a local clock that is off.
 * Without a `Date`, the reset is taken as it is. `retry-after` is already a duration. Anything
 * unusable — absent, non-numeric, in the past — is a minute from now, and anything past an hour
 * is an hour: the gate is a courtesy to GitHub, not a sentence on the reader. */
export function resetAtFrom(response: Response, now: number): number {
  const clamp = (at: number): number =>
    Number.isFinite(at) ? Math.round(Math.min(Math.max(at, now), now + MAX_RESET_MS)) : now;
  const retryAfter = numericHeader(response, "retry-after");
  if (response.headers.get("x-ratelimit-remaining")?.trim() !== "0" && retryAfter !== null) {
    return clamp(now + retryAfter * 1000);
  }
  const reset = numericHeader(response, "x-ratelimit-reset");
  if (reset === null) {
    return clamp(now + (retryAfter === null ? UNSPECIFIED_RESET_MS : retryAfter * 1000));
  }
  const served = Date.parse(response.headers.get("date") ?? "");
  const at = Number.isNaN(served) ? reset * 1000 : now + (reset * 1000 - served);
  return at <= now ? clamp(now + UNSPECIFIED_RESET_MS) : clamp(at);
}

/** The code for a status GitHub answered with. A 403 or 429 is a rate limit when GitHub says so
 * — `x-ratelimit-remaining: 0` (the primary limit) or a `retry-after` (a secondary limit) — and a
 * 429 is one regardless; otherwise a 403 is `forbidden`. A 406 on these endpoints is GitHub
 * declining to render a diff past its own size limits. */
export function failureForStatus(
  response: Response,
  now: number,
  scope: RateLimitScope,
): GitHubFailure {
  const status = response.status;
  switch (status) {
    case 401:
      return { code: "unauthorized" };
    case 403:
    case 429: {
      const limited =
        status === 429 ||
        response.headers.get("x-ratelimit-remaining")?.trim() === "0" ||
        numericHeader(response, "retry-after") !== null;
      return limited
        ? { code: "rateLimited", resetAt: resetAtFrom(response, now), scope }
        : { code: "forbidden" };
    }
    case 404:
      return { code: "notFound" };
    case 406:
      return { code: "tooLarge" };
    case 422:
      return { code: "unprocessable" };
    default:
      return status >= 500 && status <= 599
        ? { code: "unavailable", status }
        : { code: "badResponse", status };
  }
}

/** Whether the body's declared type is the media the call asked for. A diff that came back as
 * JSON (an error document with a 2xx) would parse as an empty patch and claim every comment is
 * outside it; this is what refuses it instead. */
function mediaMatches(response: Response, media: GitHubMedia): boolean {
  const type = (response.headers.get("content-type") ?? "").toLowerCase();
  switch (media) {
    case "json":
      return type.includes("json");
    case "diff":
      return type.includes("diff") || type.startsWith("text/plain");
  }
}

type BodyRead =
  | { ok: true; text: string }
  | { ok: false; reason: "tooLarge" | "aborted" | "failed" };

/** The body as UTF-8 text, read until `maxBytes` and no further. Stopping early cancels the
 * stream; releasing the connection is `send`'s abort, which follows every call. */
async function readCapped(
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
): Promise<BodyRead> {
  const declared = numericHeader(response, "content-length");
  if (declared !== null && declared > maxBytes) {
    await discard(response);
    return { ok: false, reason: "tooLarge" };
  }
  if (response.body === null) {
    return { ok: true, text: "" };
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        return { ok: false, reason: "tooLarge" };
      }
      chunks.push(value);
    }
  } catch {
    return { ok: false, reason: signal.aborted ? "aborted" : "failed" };
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, text: new TextDecoder("utf-8").decode(bytes) };
}

/** Lets go of a body nobody will read. Not enough on its own to free the connection under
 * Electron — `send`'s abort is what does that — but it stops a fake or Node from buffering it. */
async function discard(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => {});
}

type EtagEntry = { etag: string; body: string };

/** The kept answers of conditional GETs, oldest first (a `Map`'s order is the eviction order; a
 * hit is re-inserted to make it the newest). Keys are `authScope|media|url` and nothing else. */
function createEtagCache(): {
  get: (key: string) => EtagEntry | undefined;
  set: (key: string, entry: EtagEntry) => void;
} {
  const entries = new Map<string, EtagEntry>();
  return {
    get: (key) => {
      const entry = entries.get(key);
      if (entry !== undefined) {
        entries.delete(key);
        entries.set(key, entry);
      }
      return entry;
    },
    set: (key, entry) => {
      // Counted in UTF-16 units, which bounds the bytes within a factor of two either way — a
      // cap on memory, not an exact one.
      if (entry.body.length > ETAG_MAX_BODY_BYTES) {
        entries.delete(key);
        return;
      }
      entries.delete(key);
      entries.set(key, entry);
      for (const oldest of entries.keys()) {
        if (entries.size <= ETAG_MAX_ENTRIES) {
          break;
        }
        entries.delete(oldest);
      }
    },
  };
}

export function createGitHubClient(options: GitHubClientOptions): GitHubClient {
  const { transport, userAgent } = options;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const now = options.now ?? Date.now;
  /** When each shut gate opens again, by `rateLimitKey`. */
  const shutUntil = new Map<string, number>();
  const rateLimitKey = (call: GitHubCall): string => `${authScope(call.auth)}:${call.resource}`;
  const etags = createEtagCache();
  const etagKey = (call: GitHubCall, url: URL): string =>
    `${authScope(call.auth)}|${call.media}|${url.href}`;

  const requestInit = (
    call: Request,
    signal: AbortSignal,
    cached: EtagEntry | undefined,
  ): RequestInit => {
    const headers: Record<string, string> = {
      Accept: ACCEPT[call.media],
      "User-Agent": userAgent,
      "X-GitHub-Api-Version": GITHUB_API_VERSION,
      ...authHeaders(call.auth),
    };
    const post = call.graphql !== undefined;
    if (post) {
      headers["Content-Type"] = "application/json";
    }
    if (cached !== undefined) {
      headers["If-None-Match"] = cached.etag;
    }
    return {
      method: post ? "POST" : "GET",
      headers,
      ...(call.graphql === undefined
        ? {}
        : {
            body: JSON.stringify({
              query: call.graphql.document,
              variables: call.graphql.variables,
            }),
          }),
      redirect: "manual",
      credentials: "omit",
      cache: "no-store",
      signal,
    };
  };

  /** An answer as the exchange keeps it: the body, and the response's own headers — which stay
   * inside this module; `sendWithHeaders` hands out only the ones it is asked for by name. */
  type Answer = { text: string; headers: Headers };

  /** One exchange, redirects included, under the call's one timeout. */
  const exchange = async (
    call: Request,
    start: URL,
    signal: AbortSignal,
  ): Promise<GitHubResult<Answer>> => {
    let url = start;
    for (let hop = 0; ; hop += 1) {
      const post = call.graphql !== undefined;
      const store = !post && call.noStore !== true;
      const key = etagKey(call, url);
      const cached = store ? etags.get(key) : undefined;
      let response: Response;
      try {
        response = await transport(url.href, requestInit(call, signal, cached));
      } catch {
        // The thrown error is not read: under Electron or Node it may quote the request it
        // failed on, headers included (see the header's rule).
        return fail(signal.aborted ? { code: "timeout" } : { code: "network" });
      }
      if (isRedirect(response.status)) {
        await discard(response);
        const next = post ? null : redirectTarget(response, url);
        if (next === null || hop >= MAX_REDIRECTS) {
          return fail({ code: "badResponse", status: response.status });
        }
        url = next;
        continue;
      }
      if (response.status === 304 && cached !== undefined) {
        await discard(response);
        return { ok: true, value: { text: cached.body, headers: response.headers } };
      }
      if (response.status < 200 || response.status > 299) {
        await discard(response);
        const failure = failureForStatus(response, now(), authKind(call.auth));
        if (failure.code === "rateLimited") {
          shutUntil.set(rateLimitKey(call), failure.resetAt);
        }
        return fail(failure);
      }
      if (!mediaMatches(response, call.media)) {
        await discard(response);
        return fail({ code: "badResponse", status: null });
      }
      const body = await readCapped(response, call.maxBytes, signal);
      if (body.ok) {
        const etag = response.headers.get("etag");
        if (store && etag !== null) {
          etags.set(key, { etag, body: body.text });
        }
        return { ok: true, value: { text: body.text, headers: response.headers } };
      }
      switch (body.reason) {
        case "tooLarge":
          return fail({ code: "tooLarge" });
        case "aborted":
          return fail({ code: "timeout" });
        case "failed":
          return fail({ code: "network" });
      }
    }
  };

  const run = async (call: Request): Promise<GitHubResult<Answer>> => {
    const opensAt = shutUntil.get(rateLimitKey(call));
    if (opensAt !== undefined) {
      if (now() < opensAt) {
        return fail({ code: "rateLimited", resetAt: opensAt, scope: authKind(call.auth) });
      }
      shutUntil.delete(rateLimitKey(call));
    }
    const url = apiUrl(call.path, call.query);
    if (url === null) {
      return fail({ code: "badResponse", status: null });
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await exchange(call, url, controller.signal);
    } finally {
      clearTimeout(timer);
      // Every way out releases the request: see the header on why cancelling a body is not
      // enough. After a complete read this is a no-op.
      controller.abort();
    }
  };

  const text = async (call: Request): Promise<GitHubResult<string>> => {
    const answer = await run(call);
    return answer.ok ? { ok: true, value: answer.value.text } : answer;
  };

  /** A GET, rebuilt from exactly a call's own fields: a caller's object carrying a stray
   * `graphql` key (a cast, a spread) does not become a POST. */
  const getOnly = (call: GitHubCall): Request => ({
    path: call.path,
    ...(call.query === undefined ? {} : { query: call.query }),
    media: call.media,
    auth: call.auth,
    resource: call.resource,
    maxBytes: call.maxBytes,
    ...(call.noStore === undefined ? {} : { noStore: call.noStore }),
  });

  /** Whether a GET names the GraphQL endpoint, in any spelling GitHub would route there. GraphQL
   * goes through `graphql` and nowhere else, so its one document closure holds end to end. */
  const graphqlPath = (path: string): boolean =>
    path.toLowerCase().replace(/\/+$/u, "") === GRAPHQL_PATH;

  return {
    send: (call) =>
      graphqlPath(call.path)
        ? Promise.resolve(fail({ code: "badResponse", status: null }))
        : text(getOnly(call)),
    graphql: (auth, document, variables) =>
      text({
        path: GRAPHQL_PATH,
        media: "json",
        auth,
        resource: "graphql",
        maxBytes: GRAPHQL_MAX_BYTES,
        graphql: { document, variables },
      }),
    sendWithHeaders: async (call, names) => {
      if (graphqlPath(call.path)) {
        return fail({ code: "badResponse", status: null });
      }
      const answer = await run(getOnly(call));
      if (!answer.ok) {
        return answer;
      }
      const headers: Partial<Record<ResponseHeaderName, string | null>> = {};
      for (const name of names) {
        headers[name] = answer.value.headers.get(name);
      }
      return { ok: true, value: { body: answer.value.text, headers } };
    },
  };
}

/** A JSON call's body, parsed and checked against `schema`. Malformed JSON and a shape the
 * schema refuses are both `badResponse` with no status — the status was fine, the body is not
 * the documented one, and nothing downstream should guess at it. */
export async function getJson<T>(
  client: GitHubClient,
  call: Omit<GitHubCall, "media">,
  schema: z.ZodType<T>,
): Promise<GitHubResult<T>> {
  const body = await client.send({ ...call, media: "json" });
  if (!body.ok) {
    return body;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(body.value);
  } catch {
    return fail({ code: "badResponse", status: null });
  }
  const parsed = schema.safeParse(raw);
  return parsed.success
    ? { ok: true, value: parsed.data }
    : fail({ code: "badResponse", status: null });
}
