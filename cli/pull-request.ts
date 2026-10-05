import {
  githubPullRequestOf,
  parseGitHubRemote,
  parsePullRequestArg,
  redactUrlCredentials,
  type PullRequest,
  type PullRequestArg,
} from "../src/shared/pull-request";
import { assertNever } from "../src/shared/assert";
import { git } from "./git";
import type { CliError } from "./errors";

// `rvw emit --pr`: the pull request a review is of, from whatever the caller typed.
//
// Two steps, split where the I/O is. Reading the value is pure (`shared/pull-request.ts`) and
// runs before the draft is read or a ref is resolved, because a typo in `--pr` is a fact about
// the call. Completing a bare number needs `owner/repo`, which only the checkout's `origin`
// remote knows, so that step runs once the range has said which repo this is — and it is the
// one git call `--pr` costs. Nothing here reaches the network: `rvw` records the pull request
// it was told about and never checks that it exists (`next-features.md`, B1), so it holds no
// credential and has no reason to.
//
// The sentences are composed here and nowhere else, from the parse's codes — the rule every
// cannot-run in `cli/errors.ts` follows — and each one ends with what to pass instead, because
// the remedy for all of them is the same: spell the pull request out in full.

/** The accepted spellings, quoted in every refusal so the caller does not have to look them up. */
const SPELLINGS = "its URL (https://github.com/owner/repo/pull/123), owner/repo#123, or its number";

export type PullRequestArgRead =
  | { readonly ok: true; readonly arg: PullRequestArg }
  | { readonly ok: false; readonly error: CliError };

export type PullRequestResolution =
  | { readonly ok: true; readonly pr: PullRequest }
  | { readonly ok: false; readonly error: CliError };

/** The `--pr` value read, or the cannot-run that says why it names no pull request. */
export function readPullRequestArg(text: string): PullRequestArgRead {
  const parsed = parsePullRequestArg(text);
  if (parsed.ok) {
    return parsed;
  }
  // Echoed back so the caller sees what was refused — minus any credential a pasted URL
  // carried in its userinfo (`redactUrlCredentials`).
  const shown = redactUrlCredentials(text);
  switch (parsed.reason) {
    case "notGitHub":
      return badPullRequest(
        `--pr ${shown} is not a github.com pull request: only github.com is supported`,
      );
    case "unparseable":
      return badPullRequest(`--pr ${shown} names no pull request: pass ${SPELLINGS}`);
    default:
      return assertNever(parsed.reason);
  }
}

/** The pull request whole: as given, or a bare number completed from `repoPath`'s `origin`. */
export function resolvePullRequest(
  env: NodeJS.ProcessEnv,
  repoPath: string,
  arg: PullRequestArg,
): PullRequestResolution {
  switch (arg.kind) {
    case "pullRequest":
      return { ok: true, pr: arg.pullRequest };
    case "number":
      return completeFromOrigin(env, repoPath, arg.number);
    default:
      return assertNever(arg);
  }
}

/** `owner/repo` for a bare number, read off the `origin` remote. `remote get-url` rather than
 * the raw `remote.origin.url` config: it applies `insteadOf` rewriting, so a shorthand the
 * user configured arrives as the URL git would actually fetch from. */
function completeFromOrigin(
  env: NodeJS.ProcessEnv,
  repoPath: string,
  number: number,
): PullRequestResolution {
  // In a fork workflow `origin` is the fork, not the repository the pull request is on, which is
  // why every refusal here names the two spellings that need no remote at all.
  const fullForm = `pass the pull request's URL or owner/repo#${number}`;
  const remote = git(env, repoPath, ["remote", "get-url", "origin"]);
  if (!remote.ok) {
    // No `origin` at all is the common case here; git's own sentence says which it was.
    return badPullRequest(
      `--pr ${number} takes its repository from the origin remote, which ${repoPath} cannot answer (${remote.message}): ${fullForm}`,
    );
  }
  const url = remote.stdout.trim();
  const parsed = parseGitHubRemote(url);
  if (parsed.ok) {
    return { ok: true, pr: githubPullRequestOf(parsed.repo, number) };
  }
  switch (parsed.reason) {
    case "notGitHub":
      return badPullRequest(
        `--pr ${number}: origin is ${redactUrlCredentials(url)}, not a github.com repository, and only github.com is supported — if this checkout mirrors one, ${fullForm}`,
      );
    case "unparseable":
      return badPullRequest(
        `--pr ${number}: origin is ${redactUrlCredentials(url)}, which names no github.com owner/repo: ${fullForm}`,
      );
    default:
      return assertNever(parsed.reason);
  }
}

function badPullRequest(message: string): { readonly ok: false; readonly error: CliError } {
  return { ok: false, error: { code: "badPullRequest", message } };
}
