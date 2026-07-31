import { BranchName, CommitSha } from "../src/shared/git";
import { git } from "./git";
import type { CliError } from "./errors";

// Which diff a verb is about, worked out rather than demanded. `rvw emit` and `rvw diff` take
// the same optional `--repo/--base/--head` and both resolve them here, so an agent standing in
// the repo it just reviewed types none of them and still gets the range it means.
//
// Two decisions live here and nowhere else. The first is what a default *is*: the repo is the
// cwd's work-tree toplevel, the head is the branch that is checked out, and the base is the
// fork point — against the branch's upstream, else against the repo's default branch. Nothing
// is guessed past that. A repo with neither an upstream nor a default branch fails naming
// `--base`, because a silently-wrong range is a review of the wrong diff, which is worse than
// no review at all.
//
// The second is what reaches the artifact. `emit` writes refs the app re-derives its diff from
// later, so the stored form has to say what the author meant: a **branch name** when the input
// names one — the review then follows the branch, which is the whole point of reviewing a
// branch — and the **resolved sha** for everything else. A tag, a rev expression, a
// remote-tracking ref, and above all `HEAD`, which names a different commit every time it is
// read: an artifact carrying the literal `HEAD` re-points itself the next time anyone opens it.
// Resolution goes through `git rev-parse --verify <ref>^{commit}`, so any revision git
// understands is accepted; the deny-list below is what runs *before* that spawn, the same
// validate-then-spawn posture `cli/git.ts` takes.

/** The range flags every live-range verb shares, all optional — each absent one is resolved
 * from the repo the caller is standing in. */
export type RangeFlags = {
  readonly repo?: string;
  readonly base?: string;
  readonly head?: string;
};

/** A range resolved to the exact three values an artifact carries: the canonical work-tree
 * toplevel and two artifact-ready refs (a branch name or a full sha, never a rev expression
 * and never `HEAD`). What `emit` writes and `diff` captures — one shape, so the two verbs
 * cannot disagree about what `--base main` meant. */
export type ResolvedRange = {
  readonly repoPath: string;
  readonly base: string;
  readonly head: string;
};

export type RangeResult =
  | { readonly ok: true; readonly range: ResolvedRange }
  | { readonly ok: false; readonly error: CliError };

// The pre-spawn deny-list for a revision *expression* — deliberately far looser than
// `BranchName`, because `HEAD~2`, `v1^`, `@{upstream}` and a short sha are all things git
// resolves and an agent will type. What it still refuses is what could change the meaning of
// the spawn rather than of the revision: control bytes and whitespace (a NUL truncates an
// argument mid-spawn), and a leading `-`, which git would read as a flag. Everything git's own
// revision grammar uses is left alone — `rev-parse --verify` is the authority on whether the
// expression names a commit, and it answers before any diff is captured.
// oxlint-disable-next-line no-control-regex -- rejecting control bytes is the point of this deny-list
const REVISION_FORBIDDEN = /[\u0000-\u0020\u007F]/u;

/** The two spellings of "wherever HEAD happens to point". Resolved to a sha unconditionally,
 * never stored as written: they are the one input whose meaning is guaranteed to change. */
const MOVING_REFS = new Set(["HEAD", "@"]);

function usableRevision(input: string): boolean {
  return (
    input.length > 0 &&
    input.length <= 255 &&
    !REVISION_FORBIDDEN.test(input) &&
    !input.startsWith("-")
  );
}

function badRef(flag: string, input: string, detail: string): CliError {
  return { code: "badRef", message: `${flag} ${input} ${detail}` };
}

/** The repo, the base, and the head — each taken from its flag when given and resolved from
 * the repo otherwise. Order matters: the repo is settled first because every later question is
 * asked *of* it, and the head before the base because the default base is a fork point and a
 * fork point needs two endpoints. `env` and `cwd` are the caller's (`cli/context.ts`) rather
 * than the process's, so a test proves the defaults without changing directory and every git
 * child below spawns into an environment the caller chose. */
export function resolveRange(env: NodeJS.ProcessEnv, flags: RangeFlags, cwd: string): RangeResult {
  const toplevel = git(env, flags.repo ?? cwd, ["rev-parse", "--show-toplevel"]);
  if (!toplevel.ok) {
    return { ok: false, error: { code: "gitFailed", message: toplevel.message } };
  }
  const repoPath = toplevel.stdout.trim();

  const head =
    flags.head === undefined
      ? defaultHead(env, repoPath)
      : resolveRef(env, repoPath, "--head", flags.head);
  if (!head.ok) {
    return head;
  }

  const base =
    flags.base === undefined
      ? defaultBase(env, repoPath, head.ref)
      : resolveRef(env, repoPath, "--base", flags.base);
  if (!base.ok) {
    return base;
  }

  return { ok: true, range: { repoPath, base: base.ref, head: head.ref } };
}

type RefResult =
  | { readonly ok: true; readonly ref: string }
  | { readonly ok: false; readonly error: CliError };

/** One given ref turned into the form the artifact stores. Validated, then resolved, then
 * *classified*: `--symbolic-full-name` says whether the input was a local branch, and only a
 * local branch is written back as written. A remote-tracking ref, a tag, and a rev expression
 * all become the sha they named, because none of them is a thing the reader is meant to follow
 * — and `HEAD`/`@` short-circuit to the sha before the question is even asked. */
function resolveRef(env: NodeJS.ProcessEnv, repo: string, flag: string, input: string): RefResult {
  if (!usableRevision(input)) {
    return {
      ok: false,
      error: badRef(
        flag,
        input,
        "is not a usable revision (no spaces, control bytes, or leading -)",
      ),
    };
  }

  const verified = git(env, repo, ["rev-parse", "--verify", `${input}^{commit}`]);
  if (!verified.ok) {
    return { ok: false, error: badRef(flag, input, "is not a commit this repo can resolve") };
  }
  const sha = verified.stdout.trim();
  if (!CommitSha.safeParse(sha).success) {
    return {
      ok: false,
      error: badRef(flag, input, `resolved to ${sha}, which is not a commit sha`),
    };
  }

  if (MOVING_REFS.has(input)) {
    return { ok: true, ref: sha };
  }

  const branch = localBranchName(env, repo, input);
  return { ok: true, ref: branch ?? sha };
}

/** The local branch `input` names, or null when it names anything else. `--symbolic-full-name`
 * prints `refs/heads/<name>` for a branch, `refs/remotes/...`/`refs/tags/...` for the other
 * ref kinds, and nothing at all for a sha or a rev expression — so one call separates the ref
 * that should follow the branch from the refs that should be pinned. The name is re-parsed
 * through `BranchName`: it is about to be written into an artifact whose schema will demand it,
 * and a ref git accepts but the schema would not must fall back to the sha rather than emit a
 * file that cannot be re-read. */
function localBranchName(env: NodeJS.ProcessEnv, repo: string, input: string): string | null {
  const symbolic = git(env, repo, ["rev-parse", "--symbolic-full-name", input]);
  if (!symbolic.ok) {
    return null;
  }
  const full = symbolic.stdout.trim();
  const prefix = "refs/heads/";
  if (!full.startsWith(prefix)) {
    return null;
  }
  const name = full.slice(prefix.length);
  return BranchName.safeParse(name).success ? name : null;
}

/** The head nobody named: the branch that is checked out, so the review follows it, falling
 * back to the resolved sha on a detached HEAD. An unborn branch has no commit to review, and
 * that surfaces as the `rev-parse` failure it is. */
function defaultHead(env: NodeJS.ProcessEnv, repo: string): RefResult {
  const symbolic = git(env, repo, ["symbolic-ref", "--short", "--quiet", "HEAD"]);
  if (symbolic.ok) {
    const name = symbolic.stdout.trim();
    if (BranchName.safeParse(name).success) {
      return { ok: true, ref: name };
    }
  }
  const detached = git(env, repo, ["rev-parse", "--verify", "HEAD^{commit}"]);
  if (!detached.ok) {
    return {
      ok: false,
      error: {
        code: "gitFailed",
        message: `${repo} has no commit at HEAD to review — pass --head explicitly`,
      },
    };
  }
  return { ok: true, ref: detached.stdout.trim() };
}

/** The base nobody named: the fork point of `head`, which is the commit a reader would call
 * "where this work started". Tried in the order of how much the repo actually knows — the
 * branch's own upstream first, then the repo's default branch (`origin/HEAD`, then the two
 * names a repo without a remote almost always uses). The result is always a **sha**, because a
 * base is a fixed point: a base stored as `origin/main` would slide forward every fetch and
 * quietly shrink the review. When nothing answers, that is reported rather than papered over
 * with a guess — the one thing a review range must never be. */
function defaultBase(env: NodeJS.ProcessEnv, repo: string, head: string): RefResult {
  for (const candidate of baseCandidates(env, repo)) {
    const forkPoint = git(env, repo, ["merge-base", candidate, head]);
    if (!forkPoint.ok) {
      continue;
    }
    const sha = forkPoint.stdout.trim();
    if (CommitSha.safeParse(sha).success) {
      return { ok: true, ref: sha };
    }
  }
  return {
    ok: false,
    error: {
      code: "noBase",
      message: `cannot work out a base for ${head}: no upstream, and no default branch (origin/HEAD, main, master) — pass --base explicitly`,
    },
  };
}

/** The refs a fork point may be measured from, best first. Each is checked to exist before it
 * is offered, so `merge-base` is only ever asked about a ref the repo has. */
function baseCandidates(env: NodeJS.ProcessEnv, repo: string): string[] {
  const candidates: string[] = [];
  const upstream = git(env, repo, [
    "rev-parse",
    "--abbrev-ref",
    "--symbolic-full-name",
    "@{upstream}",
  ]);
  if (upstream.ok && upstream.stdout.trim().length > 0) {
    candidates.push(upstream.stdout.trim());
  }
  const originHead = git(env, repo, ["rev-parse", "--abbrev-ref", "origin/HEAD"]);
  if (originHead.ok && originHead.stdout.trim().length > 0) {
    candidates.push(originHead.stdout.trim());
  }
  for (const fallback of ["main", "master"]) {
    if (git(env, repo, ["rev-parse", "--verify", "--quiet", `${fallback}^{commit}`]).ok) {
      candidates.push(fallback);
    }
  }
  return candidates;
}
