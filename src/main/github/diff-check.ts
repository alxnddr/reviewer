import { ANALYSIS_CACHE_KEY, parsePatch } from "../../shared/diff/patch";
import {
  anchorsOutsideDiff,
  remoteDiffIndex,
  type RemoteDiffIndex,
} from "../../shared/diff/remote-diff";
import type { CommitSha } from "../../shared/git";
import type {
  GitHubDiffCheck,
  GitHubDiffCheckRequest,
  GitHubResult,
} from "../../shared/github-ipc";
import { pullRequestLabel, type PullRequest } from "../../shared/pull-request";
import { ANONYMOUS, authScope, type GitHubAuth, type GitHubClient } from "./client";
import { getComparisonDiff, type PullRequestReader } from "./rest";

// B4 (`next-features.md`): for a review of a pull request, would GitHub take each comment as a
// line comment? Main asks GitHub for the pull request (its head) and — only when that head is
// the commit the review read — for GitHub's own diff of it, then places every anchor against that
// diff with the app's one placement rule (`shared/diff/remote-diff.ts`). The answer is derived
// state: the renderer holds it on the session's slice and never persists it (the
// inputs-not-derived precedent), so a relaunch asks again.
//
// **Spending the unauthenticated budget (60 requests an hour, per network) carefully.**
//
//   - The head is read first, and the diff only when it matches `reviewedHead`. A pull request
//     that has moved costs one request and answers `moved`: GitHub's diff at another commit says
//     nothing about the reviewed lines.
//   - The head comes from the shared pull request reader (`rest.ts`'s `createPullRequestReader`),
//     so a check right after the dialog looked the same pull request up reuses that answer.
//   - GitHub's diff is asked for *pinned to two commits* — the compare of the pull request's base
//     sha and its head (`rest.ts`'s `getComparisonDiff`, the same merge-base diff the pull request
//     shows) — and cached here, as its hunk geometry only (`diffGeometry` — not the lines, which
//     can run to megabytes), keyed on the pull request and those two shas. Key and content are
//     the same two commits by construction, so a head read from the memo a minute ago can never
//     file a newer head's diff under an older key (which asking `/pulls/<n>` for the diff could).
//     A new head, or a base that moved (a retarget, the base branch advancing), is a new key and
//     a fresh diff. `base.sha` is the base as GitHub last recorded it for the pull request, which
//     may lag the branch; until it moves, the check describes the diff GitHub itself is showing.
//     The cache is small (`MAX_CACHED`) and in memory, gone at quit; a concurrent second ask for
//     the same diff waits on the first one's request rather than making its own.
//   - A check asked `fresh` (the one after Review Pull Request… fetches) reads the head past the
//     memo: the fetch may just have seen the pull request move, and a head remembered from before
//     it would say it had not.
//   - The renderer asks once per session derivation and again after Review Pull Request…
//     fetches the same pull request (`stores/review/effects.ts`), never on a timer, a focus or a
//     tab switch; and only for a review that has a comment written for the author, because the
//     only surfaces that read the answer sit on those comments.
//
// A failure — a private repository (`notFound` without a token), a spent limit, no network — is
// returned as is, and the renderer treats it as "not checked": the local diff is trusted and the
// tooltip says, quietly, that it was not checked.
//
// **With a token (Layer C).** When main holds a token for the pull request's owner, the check
// asks with it (`handlers.ts` picks it per request), which reaches a private repository and the
// token's own, larger limit. Everything kept is keyed by who asked (`authScope`) as well as by the
// pull request and the commits, so a diff read with a token — possibly of a private repository —
// is never served to an anonymous ask. The poster (`posting.ts`) reads the same cache through
// `indexAt`, at the reviewed commit whatever the head is now: the comments it posts pin to that
// commit, so that is the diff GitHub places them on.

/** How many diffs' indexes are kept. An index is small — four numbers a hunk, a name or two a
 * file — so this bounds the count of pull requests, not memory that matters. */
const MAX_CACHED = 16;

export type DiffChecker = {
  /** B4's check, asked as `auth` (anonymous unless main holds a token for the owner). */
  check: (
    request: GitHubDiffCheckRequest,
    auth?: GitHubAuth,
  ) => Promise<GitHubResult<GitHubDiffCheck>>;
  /** GitHub's diff of the pull request from `baseSha` to `head`, as an index — cached. */
  indexAt: (
    pr: PullRequest,
    head: CommitSha,
    baseSha: CommitSha,
    auth: GitHubAuth,
  ) => Promise<GitHubResult<RemoteDiffIndex>>;
};

/** A pull request's diff at a head and a base, asked as one credential, as a cache key:
 * case-folded, because GitHub's names are case-insensitive and two spellings of one repository
 * are one diff. */
function cacheKey(pr: PullRequest, head: string, baseSha: string, auth: GitHubAuth): string {
  return `${authScope(auth)}|${pullRequestLabel(pr).toLowerCase()}@${head}..${baseSha}`;
}

export function createDiffChecker(
  client: GitHubClient,
  readPullRequest: PullRequestReader,
): DiffChecker {
  /** In insertion order, oldest first — a `Map`'s own order is the eviction order, and a hit is
   * re-inserted to make it the newest. Holds the in-flight promise, so concurrent asks share one
   * request; a failure is taken out again so the next ask retries. */
  const diffs = new Map<string, Promise<GitHubResult<RemoteDiffIndex>>>();

  const indexAt = (
    pr: PullRequest,
    head: CommitSha,
    baseSha: CommitSha,
    auth: GitHubAuth,
  ): Promise<GitHubResult<RemoteDiffIndex>> => {
    const key = cacheKey(pr, head, baseSha, auth);
    const cached = diffs.get(key);
    if (cached !== undefined) {
      diffs.delete(key);
      diffs.set(key, cached);
      return cached;
    }
    const pending: Promise<GitHubResult<RemoteDiffIndex>> = getComparisonDiff(
      client,
      pr,
      baseSha,
      head,
      auth,
    ).then((diff) => {
      if (!diff.ok) {
        // Only this ask's own entry: an evicted-then-re-asked key holds a newer request.
        if (diffs.get(key) === pending) {
          diffs.delete(key);
        }
        return diff;
      }
      // Parsed once, cut to an index, and the parse let go.
      return { ok: true, value: remoteDiffIndex(parsePatch(diff.value, ANALYSIS_CACHE_KEY)) };
    });
    diffs.set(key, pending);
    for (const oldest of diffs.keys()) {
      if (diffs.size <= MAX_CACHED) {
        break;
      }
      diffs.delete(oldest);
    }
    return pending;
  };

  return {
    indexAt,
    check: async ({ pullRequest, reviewedHead, anchors, fresh }, auth = ANONYMOUS) => {
      const info = await readPullRequest(pullRequest, { fresh: fresh === true, auth });
      if (!info.ok) {
        return info;
      }
      const { head, baseSha } = info.value;
      if (head !== reviewedHead) {
        return { ok: true, value: { kind: "moved", head } };
      }
      const index = await indexAt(pullRequest, head, baseSha, auth);
      if (!index.ok) {
        return index;
      }
      return {
        ok: true,
        value: {
          kind: "compared",
          head,
          outside: anchorsOutsideDiff(anchors, index.value.geometry),
        },
      };
    },
  };
}
