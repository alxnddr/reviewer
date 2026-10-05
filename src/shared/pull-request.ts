import * as z from "zod";

// The pull request a review is of, and the three ways one is spelled before it is known.
//
// A review of someone else's change has an address on the code host, and once the artifact
// carries it the app can deep-link a comment to its lines and copy a postable text whose file
// references are links rather than paths. `rvw emit --pr` is the only writer: it records what
// it was told and checks nothing online — `rvw` stays offline, and a PR that does not exist is
// discovered by the reader's browser, not by the CLI.
//
// Node-free and in `shared` rather than in `cli/`, because three places read these spellings:
// the CLI's `--pr`, and the app's Review Pull Request… dialog, which takes a pasted URL
// (`lib/pull-request-input.ts`) and matches `owner/repo` against the remotes of checkouts it
// already knows (`main/pull-request/flow.ts`) — the same remote parse `rvw emit --pr <n>` uses
// to find owner and repo from `origin`. One parser, so
// the dialog and the flag cannot disagree about whether a URL names a pull request.
//
// **Shaped for a second host, built for one.** `PullRequest` is a discriminated union on
// `host` with a single arm, and every function below that *produces* host-specific text is a
// value-returning switch on it with no `default:` — so GitLab or a GitHub Enterprise host is a
// new arm and a compile error at each place that has to learn it, not a rewrite. Enterprise
// is deliberately out: each company's host is its own allowlist entry and its own token story
// (`next-features.md`, Out of scope). Until then `host` is the literal `"github.com"`.
//
// **Validated as names, not as whatever a URL happened to hold.** Owner and repo are
// interpolated into URLs (`lib/github-links.ts`, `shared/postable-comment.ts`) and, later, a
// git refspec (`pullRequestRef`), so the schema admits only the characters GitHub itself
// admits: no `/`, no `..`, no whitespace, nothing that needs escaping to stay one path segment.
// The parsers assemble a candidate and hand it to the schema rather than trusting their own
// regexes, which is the parse-don't-trust rule every other boundary here follows.

/** The one host a review can name today. */
export const GITHUB_HOST = "github.com";

/** The longest owner or repo name admitted. GitHub's own bounds are 39 for a login and 100 for
 * a repository; an Enterprise Managed User's login carries an `_shortcode` suffix past the 39,
 * so one ceiling serves both and still refuses a string no host would issue. */
const MAX_NAME_LENGTH = 100;

/** A GitHub login or organization: letters, digits, `-` and `_` (the EMU suffix), never
 * starting or ending with a separator. Stricter than "anything but `/`" so a typo such as a
 * stray `.` or a space is refused here, at the flag, rather than turning into a link that 404s
 * in front of the change's author. */
export const GitHubOwner = z
  .string()
  .max(MAX_NAME_LENGTH)
  .regex(/^[A-Za-z0-9](?:[A-Za-z0-9_-]*[A-Za-z0-9])?$/u, {
    error: "Not a GitHub owner name (letters, digits, - and _)",
  });

/** A GitHub repository name: letters, digits, `.`, `-` and `_`, and never `.` or `..`, which
 * GitHub refuses and which would walk a URL path upward. */
export const GitHubRepoName = z
  .string()
  .max(MAX_NAME_LENGTH)
  .regex(/^[A-Za-z0-9._-]+$/u, { error: "Not a GitHub repository name (letters, digits, . - _)" })
  .refine((name) => name !== "." && name !== "..", {
    error: "Not a GitHub repository name",
  });

/** A pull request number: GitHub numbers issues and pull requests from 1, in one sequence. */
const PullRequestNumber = z.int().positive();

/** `owner/repo` on GitHub — what a remote URL names, and the half of a pull request a bare
 * `--pr 123` has to find somewhere else. */
export const GitHubRepo = z.object({ owner: GitHubOwner, repo: GitHubRepoName });
export type GitHubRepo = z.infer<typeof GitHubRepo>;

/** A pull request on github.com. A plain `z.object` rather than a strict one: the artifact
 * that carries it is already strict at the top (`ReviewArtifact`), and a later key added
 * *inside* this object — the base branch, say — should cost an older build that key, not the
 * whole file. */
export const GitHubPullRequest = GitHubRepo.extend({
  host: z.literal(GITHUB_HOST),
  number: PullRequestNumber,
});
export type GitHubPullRequest = z.infer<typeof GitHubPullRequest>;

/** The pull request a review is of. One arm today; see the header for why it is a union. */
export const PullRequest = z.discriminatedUnion("host", [GitHubPullRequest]);
export type PullRequest = z.infer<typeof PullRequest>;

/** The pull request's own page — `https://github.com/<owner>/<repo>/pull/<n>`. Every part was
 * validated as a single URL-safe segment by the schema, so nothing here needs escaping; a
 * second host is a compile error in this switch. */
export function pullRequestUrl(pr: PullRequest): string {
  switch (pr.host) {
    case "github.com":
      return `https://${GITHUB_HOST}/${pr.owner}/${pr.repo}/pull/${pr.number}`;
  }
}

/** The short spelling a person reads in a line of output: `owner/repo#123`. */
export function pullRequestLabel(pr: PullRequest): string {
  switch (pr.host) {
    case "github.com":
      return `${pr.owner}/${pr.repo}#${pr.number}`;
  }
}

/** What a `--pr` value (or a pasted PR address) named before anything is looked up: a whole
 * pull request, or only its number, whose owner and repo must come from the checkout's
 * `origin` remote. */
export type PullRequestArg =
  | { kind: "pullRequest"; pullRequest: PullRequest }
  | { kind: "number"; number: number };

/** Why a spelling names no pull request — a code, because the sentence a person reads is
 * composed where it is shown (`cli/pull-request.ts`; `lib/pull-request-failure-message.ts`):
 *
 * - `notGitHub` — a URL or remote on some other host: right shape, wrong place.
 * - `unparseable` — none of the accepted spellings, or one whose owner, repo or number is not
 *   a name GitHub would issue. */
export type PullRequestParseFailure = "notGitHub" | "unparseable";

export type PullRequestArgResult =
  | { ok: true; arg: PullRequestArg }
  | { ok: false; reason: PullRequestParseFailure };

export type GitHubRemoteResult =
  | { ok: true; repo: GitHubRepo }
  | { ok: false; reason: PullRequestParseFailure };

/** The hosts a github.com remote is spelled with: the site itself, the `www.` alias a pasted
 * browser URL carries, and `ssh.github.com`, GitHub's documented SSH-over-443 host for
 * networks that block port 22. */
const GITHUB_REMOTE_HOSTS = new Set([GITHUB_HOST, `www.${GITHUB_HOST}`, `ssh.${GITHUB_HOST}`]);

/** `scheme://[userinfo@]host[:port]/path` — the URL spellings of a remote or a PR address.
 *
 * The userinfo is skipped, never kept: an https remote may carry a token there
 * (`https://x-access-token:…@github.com/…`), and nothing downstream needs it. It is matched
 * **greedily, up to the last `@` before the first `/`**, because a password may itself hold an
 * `@` (`https://user:p@ss@github.com/…`): stopping at the first one would read `ss@github.com`
 * as the host, misfile a GitHub remote as foreign, and — in `redactUrlCredentials`, which
 * applies the same rule and then some — leave part of the secret in the printed text. */
const URL_FORM =
  /^(?<scheme>[A-Za-z][A-Za-z0-9+.-]*):\/\/(?:[^/]*@)?(?<host>[^/:?#@]+)(?<port>:\d*)?(?<path>\/[^?#]*)?(?:[?#].*)?$/u;

/** Every `scheme://…` token in a text: the scheme, and the rest up to whitespace, a quote or an
 * angle bracket — the characters git and the CLI put around a URL they quote. */
const URL_TOKEN = /([A-Za-z][A-Za-z0-9+.-]*:\/\/)([^\s'"<>]*)/gu;

/** A port is digits; anything else after a `:` in the authority is a password. */
const AUTHORITY_PORT = /^[^:]*(?::\d*)?$/u;

/** One URL token with its userinfo gone. Two rules, and the second one over-redacts on purpose:
 *
 * - The authority (everything before the first `/`) holds an `@`: drop through its *last* `@`
 *   — `URL_FORM`'s greedy rule, so `https://user:p@ss@github.com` loses all of `user:p@ss`.
 * - The authority holds no `@` but a `:` that is not a port, and an `@` comes later: the
 *   password held a `/` (`https://u:p/w@github.com/…`), so the "authority" git would never read
 *   that way is a credential, and everything through the token's last `@` goes. A path with an
 *   `@` in it after a real `host:port` is never touched; one after a password-shaped authority
 *   loses its head — the right way round to be wrong about a secret. */
function redactToken(rest: string): string {
  const slash = rest.indexOf("/");
  const authority = slash === -1 ? rest : rest.slice(0, slash);
  const inAuthority = authority.lastIndexOf("@");
  if (inAuthority !== -1) {
    return rest.slice(inAuthority + 1);
  }
  const last = rest.lastIndexOf("@");
  return last !== -1 && !AUTHORITY_PORT.test(authority) ? rest.slice(last + 1) : rest;
}

/** `text` with the userinfo of every `scheme://` URL in it removed, before it is printed
 * anywhere — an error message about a remote or a pasted address goes to an agent's transcript,
 * and a remote's failure line (`main/git/ops.ts`) goes to the screen: two places a credential
 * must never be echoed. One implementation for both, so the CLI and the app cannot disagree
 * about what a credential looks like. Anything that is not such a URL comes back unchanged. */
export function redactUrlCredentials(text: string): string {
  return text.replaceAll(
    URL_TOKEN,
    (_match, scheme: string, rest: string) => `${scheme}${redactToken(rest)}`,
  );
}

/** git's scp-like spelling, `[user@]host:path` — the form `git@github.com:o/r.git` takes. git
 * reads it only when no `/` comes before the first `:`, which the host group enforces. */
const SCP_FORM = /^(?:[^@/]+@)?(?<host>[^:/]+):(?<path>.+)$/u;

/** `owner/repo#123`, the form GitHub itself writes cross-repository references in. */
const SLUG_FORM = /^(?<owner>[^/\s#]+)\/(?<repo>[^/\s#]+)#(?<number>\d+)$/u;

/** A number alone, with or without the `#` GitHub prefixes it with. */
const NUMBER_FORM = /^#?(?<number>\d+)$/u;

/** A pasted address with its scheme left off — `github.com/o/r/pull/12`, the form a browser's
 * address bar copies on some platforms and a person types from memory. Read as https. */
const SCHEMELESS_GITHUB = /^(?:www\.)?github\.com\//iu;

/** The tabs of a pull request's page, the only segments admitted after `/pull/<n>`: anything
 * else is a path this parser does not know to be the same pull request. */
const PULL_REQUEST_TABS = new Set(["files", "changes", "commits", "checks"]);

/** The one segment a tab may carry after it: a commit, or a commit range — what GitHub's
 * "changes from this commit" (`/files/<sha>`, `/commits/<sha>`, `/changes/<a>..<b>`) links
 * look like. */
const COMMIT_SEGMENT = /^[0-9a-f]{7,64}(?:\.\.[0-9a-f]{7,64})?$/u;

/** One trailing `.git` off a repository name — the suffix git and GitHub both treat as
 * optional. Applied by every form here, the remote parse included, so B3 matching a pasted
 * pull request against a checkout's remotes compares like with like. */
function withoutGitSuffix(repo: string | undefined): string | undefined {
  return repo?.replace(/\.git$/u, "");
}

/** A `--pr` value: a pull request's URL (`https://github.com/o/r/pull/123`, scheme optional,
 * with one of its tabs after it and any query or fragment), `owner/repo#123`, or a bare `123`.
 * Surrounding whitespace is forgiven, because a value pasted into a terminal often brings some.
 *
 * The URL form is read strictly — no empty segment, no `.`/`..`, no explicit port, nothing
 * after the number but a known tab — because a value that only *contains* a pull request's
 * address is not one, and a lenient read is how `/pull/1/../../../x` would become PR 1. */
export function parsePullRequestArg(text: string): PullRequestArgResult {
  const trimmed = text.trim();
  const value = SCHEMELESS_GITHUB.test(trimmed) ? `https://${trimmed}` : trimmed;

  const number = NUMBER_FORM.exec(value)?.groups?.["number"];
  if (number !== undefined) {
    const parsed = PullRequestNumber.safeParse(Number(number));
    return parsed.success
      ? { ok: true, arg: { kind: "number", number: parsed.data } }
      : { ok: false, reason: "unparseable" };
  }

  const slug = SLUG_FORM.exec(value)?.groups;
  if (slug !== undefined) {
    return githubPullRequest(slug["owner"], withoutGitSuffix(slug["repo"]), slug["number"]);
  }

  const url = URL_FORM.exec(value)?.groups;
  if (url === undefined) {
    return { ok: false, reason: "unparseable" };
  }
  const scheme = (url["scheme"] ?? "").toLowerCase();
  const host = (url["host"] ?? "").toLowerCase();
  if (host !== GITHUB_HOST && host !== `www.${GITHUB_HOST}`) {
    return { ok: false, reason: "notGitHub" };
  }
  if ((scheme !== "https" && scheme !== "http") || url["port"] !== undefined) {
    return { ok: false, reason: "unparseable" };
  }
  const parts = pullRequestPath(url["path"] ?? "");
  return parts === null
    ? { ok: false, reason: "unparseable" }
    : githubPullRequest(parts.owner, withoutGitSuffix(parts.repo), parts.number);
}

/** `/<owner>/<repo>/pull/<n>[/<tab>[/<commit>]][/]` → its three parts, or null for any other
 * path. Split without dropping empty segments, so `//o//r//pull//1` is refused rather than
 * collapsed into a pull request; `.` and `..` are refused by the owner and repo schemas and,
 * after the number, by the tab allowlist. */
function pullRequestPath(
  path: string,
): { owner: string | undefined; repo: string | undefined; number: string } | null {
  const segments = (path.endsWith("/") ? path.slice(0, -1) : path).split("/");
  const [root, owner, repo, pull, number, tab, commit, ...rest] = segments;
  if (root !== "" || pull !== "pull" || number === undefined || !/^\d+$/u.test(number)) {
    return null;
  }
  if (tab !== undefined && !PULL_REQUEST_TABS.has(tab)) {
    return null;
  }
  if (commit !== undefined && !COMMIT_SEGMENT.test(commit)) {
    return null;
  }
  return rest.length === 0 ? { owner, repo, number } : null;
}

/** The three captured parts as a schema-checked pull request, or `unparseable` when any of
 * them is not a name GitHub would issue. */
function githubPullRequest(
  owner: string | undefined,
  repo: string | undefined,
  number: string | undefined,
): PullRequestArgResult {
  const parsed = GitHubPullRequest.safeParse({
    host: GITHUB_HOST,
    owner,
    repo,
    number: number === undefined ? undefined : Number(number),
  });
  return parsed.success
    ? { ok: true, arg: { kind: "pullRequest", pullRequest: parsed.data } }
    : { ok: false, reason: "unparseable" };
}

/** `owner/repo` from a git remote URL, in every spelling git accepts for github.com:
 *
 * - `https://github.com/o/r`, `https://github.com/o/r.git`, with or without userinfo, a port,
 *   or a trailing slash;
 * - `git@github.com:o/r.git` (scp-like), with or without `.git` and a trailing slash;
 * - `ssh://git@github.com/o/r`, `ssh://git@ssh.github.com:443/o/r.git`, `git://github.com/o/r`.
 *
 * A remote on any other host — GitLab, a company server, a local path — is `notGitHub`; a
 * github.com remote whose path is not exactly `owner/repo` is `unparseable`. The URL git
 * reports is used as given: `git remote get-url` has already applied any `insteadOf`
 * rewriting, so a shorthand like `gh:o/r` arrives here as the URL it stands for. */
export function parseGitHubRemote(remote: string): GitHubRemoteResult {
  const value = remote.trim();
  const form = URL_FORM.exec(value)?.groups ?? SCP_FORM.exec(value)?.groups;
  if (form === undefined) {
    return { ok: false, reason: "notGitHub" };
  }
  const host = (form["host"] ?? "").toLowerCase();
  if (!GITHUB_REMOTE_HOSTS.has(host)) {
    return { ok: false, reason: "notGitHub" };
  }
  // Leading and trailing slashes off, then one `.git` off the repo (`withoutGitSuffix`).
  const segments = (form["path"] ?? "").replaceAll(/^\/+|\/+$/gu, "").split("/");
  if (segments.length !== 2) {
    return { ok: false, reason: "unparseable" };
  }
  const parsed = GitHubRepo.safeParse({ owner: segments[0], repo: withoutGitSuffix(segments[1]) });
  return parsed.success ? { ok: true, repo: parsed.data } : { ok: false, reason: "unparseable" };
}

/** A bare number made whole by the repository it was asked about. */
export function githubPullRequestOf(repo: GitHubRepo, number: number): PullRequest {
  return { host: GITHUB_HOST, owner: repo.owner, repo: repo.repo, number };
}

/** An owner or repository name as one component of a ref: lowercased, because GitHub's names
 * are case-insensitive, and with every `.` written `%2e`. The schemas admit names git refuses as
 * ref components — `.github` (a leading dot; one of the most common repository names there is),
 * `x.lock` (the lock suffix), `a..b` (a double dot) — and every one of those rules is about
 * dots, so encoding the dot removes them all at once. `%` itself never occurs in a validated
 * name, so the encoding is unambiguous and reversible, and git accepts it in a ref. Owners hold
 * no dots, but go through the same function so there is exactly one spelling of a name in a ref,
 * shared by every reader and writer (`pullRequestRef`, `placedWorktreeRef`). */
export function refComponent(name: string): string {
  return name.toLowerCase().replaceAll(".", "%2e");
}

/** The local ref a fetched pull request's head is kept under:
 * `refs/rvw/pr/<owner>/<repo>/<n>`, each name through `refComponent`. Its own namespace and
 * never a branch, so the reader's branch list stays theirs; and a ref, so it lives in the
 * repository's common git directory, where every worktree of it — the one Review Pull Request…
 * makes, and the reader's own checkout — sees the same commit. Written by that fetch
 * (`main/pull-request/flow.ts`), read back for the Copy & open on GitHub drift warning
 * (`lib/github-links.ts`'s `prHead`).
 *
 * **Deliberately not the flat `refs/rvw/pr/<n>` `next-features.md` names.** In a fork workflow
 * one checkout has remotes for two repositories — `origin` the reader's fork, `upstream` the
 * canonical one — and both number their pull requests from 1: fork #12 and upstream #12 would
 * overwrite each other's head, and the drift warning would compare against the wrong pull
 * request. */
export function pullRequestRef(pr: PullRequest): string {
  return `refs/rvw/pr/${refPath(pr)}`;
}

/** The commit Review Pull Request… last checked out in the pull request's worktree:
 * `refs/rvw/placed/<owner>/<repo>/<n>`, written after every create and move and deleted with the
 * worktree. It is what makes "the worktree holds commits nobody else has" mean only commits
 * *beyond what the app put there*: after a force-push that rewrote the pull request (an amend, a
 * rebase), the fetch moves `pullRequestRef` and the worktree's old head is reachable from no
 * other ref — without this one it would read as the reader's own work forever, and the worktree
 * could be neither moved nor removed. Under `refs/rvw` like the head, so the one
 * `--glob=refs/rvw` that counts fetched heads as safe counts this too. */
export function placedWorktreeRef(pr: PullRequest): string {
  return `refs/rvw/placed/${refPath(pr)}`;
}

/** `<owner>/<repo>/<n>` as ref components — the one place a pull request becomes a ref path. */
function refPath(pr: PullRequest): string {
  switch (pr.host) {
    case "github.com":
      return `${refComponent(pr.owner)}/${refComponent(pr.repo)}/${pr.number}`;
  }
}

/** The namespace every `pullRequestRef` lives under — what a "reachable from somewhere safe"
 * check names to count the fetched heads as safe (`git rev-list --glob=refs/rvw`, whose glob
 * matches nested refs). */
export const PULL_REQUEST_REF_NAMESPACE = "refs/rvw";

/** The https address a pull request's repository is cloned from, for the no-checkout fallback.
 * https rather than ssh because it is the spelling every machine can fetch: the reader's own
 * credential helper answers it, and a public repository needs none. */
export function pullRequestCloneUrl(pr: PullRequest): string {
  switch (pr.host) {
    case "github.com":
      return `https://${GITHUB_HOST}/${pr.owner}/${pr.repo}.git`;
  }
}

/** Whether a remote's `owner/repo` is the pull request's repository. Case-insensitive, because
 * GitHub's names are: `Acme/Widget` and `acme/widget` are one repository, and a checkout cloned
 * from either spelling must match a pull request pasted in the other. */
export function isPullRequestRepo(pr: PullRequest, remote: GitHubRepo): boolean {
  switch (pr.host) {
    case "github.com":
      return (
        pr.owner.toLowerCase() === remote.owner.toLowerCase() &&
        pr.repo.toLowerCase() === remote.repo.toLowerCase()
      );
  }
}

/** Whether two addresses name the same pull request — `isPullRequestRepo`'s case-folding, and the
 * same number. What scopes "the pull request that was just fetched" to the reviews of it. */
export function samePullRequest(a: PullRequest, b: PullRequest): boolean {
  return a.number === b.number && isPullRequestRepo(a, b);
}
