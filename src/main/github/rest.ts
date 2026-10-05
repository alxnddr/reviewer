import * as z from "zod";
import { BranchName, CommitSha } from "../../shared/git";
import {
  GitHubInboxItem,
  TITLE_MAX,
  type GitHubInbox,
  type GitHubInboxRequest,
  type GitHubPullRequestInfo,
  type GitHubResult,
} from "../../shared/github-ipc";
import { parsePullRequestArg, pullRequestLabel, type PullRequest } from "../../shared/pull-request";
import {
  ANONYMOUS,
  apiPath,
  authScope,
  getJson,
  type GitHubAuth,
  type GitHubClient,
} from "./client";

/** A login the inbox request has already held to `GitHubOwner`. */
type Login = GitHubInboxRequest["login"];

// The REST reads Layer B makes (`next-features.md`, B3–B5), anonymous unless a caller passes the
// reader's token (Layer C: the lookup and the diff check do, the inbox never does): the inbox
// search, one pull request, and its diff between two commits. Each is a `GitHubCall` through the
// client (`client.ts` holds the allowlist, the timeout, the cap and the failure codes) and a
// mapping from GitHub's documented JSON to the app's own wire shape (`shared/github-ipc.ts`).
//
// **GitHub's JSON is parsed leniently and mapped strictly.** The raw schemas below name only the
// fields this file reads, as plain objects that ignore the rest, so a field GitHub adds costs
// nothing; the mapping then holds every value to the app's schemas — a sha to `CommitSha`, a
// base to `BranchName`, a row's address to `parsePullRequestArg` — and what does not fit is
// dropped (one inbox row) or refused (`badResponse`), never passed on. The shapes are those of
// API version `GITHUB_API_VERSION`, checked against live answers (2026-10-03): the fixtures in
// `fixtures.ts` are cut down from them.
//
// The `auth` parameter is the credential seam (`client.ts`): every read here takes it, defaulting
// to anonymous, so Layer C's token reaches these reads — a private repository's pull request, a
// higher limit — without a second copy of any of them.

/** Response caps. A search page of 50 rows is ~250 KB and a pull request's JSON ~30 KB; a diff is
 * whatever the pull request is, and a compare diff has no file limit of its own
 * (`getComparisonDiff`), so this cap is what bounds it. */
const SEARCH_MAX_BYTES = 4 * 1024 * 1024;
const PULL_REQUEST_MAX_BYTES = 2 * 1024 * 1024;
export const DIFF_MAX_BYTES = 16 * 1024 * 1024;

/** One page of the inbox, newest first. Fifty is past what anyone has waiting on them, and
 * still one request. */
export const INBOX_PAGE_SIZE = 50;

/** The `owner/repo/pulls/<n>` path of a pull request. A value-returning switch on the host with
 * no `default:` — a second host is a compile error here, and its own client. */
function pullRequestPath(pr: PullRequest): string {
  switch (pr.host) {
    case "github.com":
      return apiPath("repos", pr.owner, pr.repo, "pulls", pr.number);
  }
}

// --- the inbox ------------------------------------------------------------------------------

/** The search for the open pull requests that request `login`'s review. Without a token `@me`
 * means nobody, so the query names the login. `login` is a validated `GitHubOwner` (`Login`) — letters,
 * digits, `-`, `_` — so it is one token of the query and cannot add a qualifier of its own; the
 * query string is URL-encoded by the client (`URLSearchParams`), not here. `archived:false`
 * because an archived repository's pull request can no longer be reviewed. */
export function reviewRequestedQuery(login: Login): string {
  return `is:pr is:open archived:false review-requested:${login}`;
}

const RawSearch = z.object({
  total_count: z.int().nonnegative(),
  incomplete_results: z.boolean(),
  // Rows are checked one at a time (`RawSearchItem`): one row GitHub shaped unexpectedly costs
  // that row, not the inbox.
  items: z.array(z.unknown()),
});

const RawSearchItem = z.object({
  html_url: z.string(),
  number: z.int(),
  title: z.string(),
  updated_at: z.string(),
  draft: z.boolean().nullish(),
  user: z.object({ login: z.string() }).nullable(),
  /** Present on a pull request, absent on an issue — the query asks for pull requests only, and
   * this is the check that it got them. */
  pull_request: z.object({}).loose(),
});

/** A search row as an inbox row, or null when it is not one the app can act on. The pull
 * request is read out of the row's own web address by the parser a pasted address goes through,
 * so a row and a paste cannot disagree about which pull request they name. */
function inboxRow(raw: unknown): GitHubInbox["items"][number] | null {
  const item = RawSearchItem.safeParse(raw);
  if (!item.success) {
    return null;
  }
  const read = parsePullRequestArg(item.data.html_url);
  if (
    !read.ok ||
    read.arg.kind !== "pullRequest" ||
    read.arg.pullRequest.number !== item.data.number
  ) {
    return null;
  }
  const row = GitHubInboxItem.safeParse({
    pullRequest: read.arg.pullRequest,
    title: item.data.title.slice(0, TITLE_MAX),
    author: item.data.user?.login.slice(0, 128) ?? null,
    updatedAt: item.data.updated_at,
    draft: item.data.draft ?? false,
  });
  return row.success ? row.data : null;
}

export async function listReviewRequests(
  client: GitHubClient,
  login: Login,
  auth: GitHubAuth = ANONYMOUS,
): Promise<GitHubResult<GitHubInbox>> {
  const page = await getJson(
    client,
    {
      path: apiPath("search", "issues"),
      query: {
        q: reviewRequestedQuery(login),
        sort: "updated",
        order: "desc",
        per_page: String(INBOX_PAGE_SIZE),
      },
      auth,
      resource: "search",
      maxBytes: SEARCH_MAX_BYTES,
    },
    RawSearch,
  );
  if (!page.ok) {
    return page;
  }
  return {
    ok: true,
    value: {
      items: page.value.items.flatMap((raw) => inboxRow(raw) ?? []),
      total: page.value.total_count,
      incomplete: page.value.incomplete_results,
    },
  };
}

// --- one pull request -----------------------------------------------------------------------

const RawPullRequest = z.object({
  title: z.string(),
  state: z.enum(["open", "closed"]),
  merged: z.boolean().nullish(),
  merged_at: z.string().nullish(),
  draft: z.boolean().nullish(),
  base: z.object({ ref: z.string(), sha: CommitSha }),
  head: z.object({ sha: CommitSha }),
});

/** A pull request as main keeps it: the wire's `GitHubPullRequestInfo` plus the sha its base
 * branch stood at, which only the diff check needs (`diff-check.ts` keys GitHub's diff on it). */
export type PullRequestSnapshot = GitHubPullRequestInfo & { baseSha: CommitSha };

/** What crosses IPC of a snapshot — the base sha stays in main. */
export function wireInfo({
  baseSha: _baseSha,
  ...info
}: PullRequestSnapshot): GitHubPullRequestInfo {
  return info;
}

export async function getPullRequestInfo(
  client: GitHubClient,
  pr: PullRequest,
  auth: GitHubAuth = ANONYMOUS,
): Promise<GitHubResult<PullRequestSnapshot>> {
  const raw = await getJson(
    client,
    { path: pullRequestPath(pr), auth, resource: "core", maxBytes: PULL_REQUEST_MAX_BYTES },
    RawPullRequest,
  );
  if (!raw.ok) {
    return raw;
  }
  const { title, state, merged, merged_at: mergedAt, draft, base, head } = raw.value;
  const branch = BranchName.safeParse(base.ref);
  return {
    ok: true,
    value: {
      title: title.slice(0, TITLE_MAX),
      // A merged pull request is `closed` with `merged: true`; GitHub's own page says Merged.
      state: merged === true || (mergedAt ?? null) !== null ? "merged" : state,
      draft: draft ?? false,
      base: branch.success ? branch.data : null,
      head: head.sha,
      baseSha: base.sha,
    },
  };
}

/** How long a pull request's answer is reused. Long enough to cover one errand — the dialog
 * looking a pull request up, the reader pressing Fetch, the check that follows the fetch — and
 * short enough that "has it moved?" is still answered by GitHub, not by this memo. */
export const PULL_REQUEST_MEMO_MS = 60_000;

/** How a pull request is read: who asks (`auth`, anonymous by default), and whether the answer
 * must be GitHub's own *now* (`fresh`) — skipping the memo, though still through the client's
 * conditional request. Fresh is for the moments a stale head would mislead: right after a fetch,
 * which may have just seen the pull request move, and Layer C's "the head moved — ask before
 * posting" gate. */
export type PullRequestReadOptions = { fresh?: boolean; auth?: GitHubAuth };

export type PullRequestReader = (
  pr: PullRequest,
  options?: PullRequestReadOptions,
) => Promise<GitHubResult<PullRequestSnapshot>>;

/** `getPullRequestInfo`, with each pull request's answer reused for `PULL_REQUEST_MEMO_MS` and a
 * concurrent second ask waiting on the first. One reader serves both the dialog's lookup
 * (`github:pull-request`) and the diff check (`diff-check.ts`), which are often the same pull
 * request within seconds — the unauthenticated core limit is 60 an hour, and a 304 does not spare
 * it (`client.ts`), so this is what does. Only answers are kept; a failure is asked again. A
 * `fresh` read asks GitHub regardless and keeps what it answers.
 *
 * Keyed by `authScope(auth)` — the credential's identity, never the credential (`client.ts`'s
 * `RateLimitScope`) — and the pull request case-folded (GitHub's names are case-insensitive), so a
 * token's answer, which can see a private repository, is never served to an anonymous ask or the
 * other way round. */
export function createPullRequestReader(
  client: GitHubClient,
  options: { now?: () => number; memoMs?: number } = {},
): PullRequestReader {
  const now = options.now ?? Date.now;
  const memoMs = options.memoMs ?? PULL_REQUEST_MEMO_MS;
  const answers = new Map<
    string,
    { at: number; answer: Promise<GitHubResult<PullRequestSnapshot>> }
  >();
  return (pr, read = {}) => {
    const auth = read.auth ?? ANONYMOUS;
    const key = `${authScope(auth)}|${pullRequestLabel(pr).toLowerCase()}`;
    const kept = answers.get(key);
    if (read.fresh !== true && kept !== undefined && now() - kept.at < memoMs) {
      return kept.answer;
    }
    const answer = getPullRequestInfo(client, pr, auth).then((result) => {
      if (!result.ok && answers.get(key)?.answer === answer) {
        answers.delete(key);
      }
      return result;
    });
    answers.set(key, { at: now(), answer });
    // Expired entries go when they are next passed; the map holds one per pull request asked
    // about in a session, which is a handful.
    for (const [other, entry] of answers) {
      if (now() - entry.at >= memoMs) {
        answers.delete(other);
      }
    }
    return answer;
  };
}

/** GitHub's diff of a pull request *pinned to two commits*: `GET /repos/<o>/<r>/compare/
 * <base>...<head>` as `application/vnd.github.diff`. Three dots is GitHub's merge-base comparison
 * — the diff from the merge base of the two commits to `head`, which is what a pull request's own
 * Files view and `GET /pulls/<n>` (diff) show — and the compare is asked of the base repository,
 * which sees a fork's head through its pull request refs. Checked live (2026-10-03): for
 * `octocat/Hello-World#1`, a pull request from a fork, the answer is byte-identical to the pull
 * request's own diff, unauthenticated.
 *
 * Pinned rather than `/pulls/<n>`, because that one always describes the head *as of the request*:
 * a check that read the head a minute ago (`createPullRequestReader`'s memo) and then asked for
 * the pull request's diff could get a newer head's diff and cache it under the older head. These
 * two shas are the key the diff is cached under (`diff-check.ts`), so the key and the content
 * cannot disagree.
 *
 * Limits: `/pulls/<n>` refuses a diff past 300 files (406, `tooLarge`); a compare diff has no such
 * refusal — `torvalds/linux` `v6.0...v6.1` came back whole, 48 MB and 12,964 files — so what bounds
 * it here is `DIFF_MAX_BYTES`, past which the client answers `tooLarge` and the check is skipped.
 * Text, not parsed: the caller parses it with the app's one patch parser (`shared/diff/patch.ts`). */
export function getComparisonDiff(
  client: GitHubClient,
  pr: PullRequest,
  baseSha: CommitSha,
  headSha: CommitSha,
  auth: GitHubAuth = ANONYMOUS,
): Promise<GitHubResult<string>> {
  return client.send({
    path: comparePath(pr, baseSha, headSha),
    media: "diff",
    auth,
    resource: "core",
    maxBytes: DIFF_MAX_BYTES,
  });
}

/** `repos/<owner>/<repo>/compare/<base>...<head>` on the pull request's own repository. A
 * value-returning switch on the host, like `pullRequestPath`. */
function comparePath(pr: PullRequest, baseSha: CommitSha, headSha: CommitSha): string {
  switch (pr.host) {
    case "github.com":
      return apiPath("repos", pr.owner, pr.repo, "compare", `${baseSha}...${headSha}`);
  }
}
