import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { assertNever } from "../../shared/assert";
import { errnoCode } from "../../shared/errors";
import {
  BranchName,
  Commit,
  RepoInfo,
  type BranchList,
  type CommitLog,
  CommitSha,
  type DiffSelection,
  type FileAtRef,
  type FileContentsRequest,
  type FileContentsSource,
  type GitFailure,
  type GitResult,
  type LogEntry,
  type LogRange,
  type Patch,
  type RepoPath,
  type ReviewRef,
} from "../../shared/git";
import type { GitRunFailure, GitRunner } from "./runner";
import { redactUrlCredentials } from "../../shared/pull-request";
import { parseBranchList, parseCommitLog } from "./parse";
import { DIFF_ARGS, DIFF_CONFIG, committedDiffArgs, rangeSpec } from "../../shared/node/git-diff";

// Domain operations behind the git IPC channels. Every ref reaching this module has
// already passed the zod boundary. The byte-stable diff wire-format
// (DIFF_CONFIG/DIFF_ARGS) is shared so authoring and review capture identical bytes.

// Fields joined by %x1f (see parse.ts), records NUL-separated by -z.
const LOG_FORMAT = "--format=%H%x1f%h%x1f%an%x1f%aI%x1f%s";

/** The brush UI lists recent history, not the whole DAG; combined with the output
 * cap this keeps `git:log` bounded on very large repos. */
const LOG_MAX_COUNT = 2000;

function failure(gitFailure: GitFailure): { ok: false; failure: GitFailure } {
  return { ok: false, failure: gitFailure };
}

/** Collapses a runner failure to the typed IPC failure. stderr stops here: it is
 * logged for diagnosis and pattern-matched, never forwarded. */
function mapRunFailure(runFailure: GitRunFailure, repoPath: string): GitFailure {
  switch (runFailure.code) {
    case "gitMissing":
      return { code: "gitMissing" };
    case "cwdMissing":
      return { code: "notARepo", path: runFailure.cwd };
    case "outputOverflow":
      return { code: "outputOverflow", limitBytes: runFailure.limitBytes };
    case "timeout":
      return { code: "timeout" };
    case "cancelled":
      return { code: "cancelled" };
    case "exited": {
      console.error(`git exited with ${runFailure.exitCode ?? "signal"}: ${runFailure.stderr}`);
      // The second phrasing is git's answer inside a `.git` directory or a bare
      // repo: a real git dir, but no work tree — which is exactly as unusable to
      // us as a plain directory, and reads better than `unexpected`.
      if (/not a git repository|must be run in a work tree/iu.test(runFailure.stderr)) {
        return { code: "notARepo", path: repoPath };
      }
      if (
        /unknown revision|bad revision|ambiguous argument|not a valid (?:commit|object) name/iu.test(
          runFailure.stderr,
        )
      ) {
        return { code: "unknownRevision" };
      }
      return { code: "unexpected" };
    }
    default:
      return assertNever(runFailure);
  }
}

export async function validateRepo(runner: GitRunner, path: string): Promise<GitResult<RepoInfo>> {
  const result = await runner.run({ cwd: path, args: ["rev-parse", "--show-toplevel"] });
  if (!result.ok) return failure(mapRunFailure(result.failure, path));
  const toplevel = result.stdout.trim();
  try {
    return { ok: true, value: RepoInfo.parse({ path: toplevel, name: basename(toplevel) }) };
  } catch (error) {
    console.error("git rev-parse --show-toplevel output is not a usable repo path:", error);
    return failure({ code: "unexpected" });
  }
}

/** Which of `refs` are not commits in this repo — empty when every one resolves. One `rev-parse
 * --verify` per distinct ref rather than one call for all: git stops at the first bad revision,
 * and the answer wanted is *which* are missing, so a checkout lacking only `head` can say so.
 * `--quiet` makes "not a commit" exit 1 with nothing on stdout — git's defined answer, not a
 * failure — while anything else (no repo, a timeout) still is one. Every ref has passed the
 * `ReviewRef` schema, so `<ref>^{commit}` can be neither a flag nor a second argument. */
export async function resolveRefs(
  runner: GitRunner,
  repoPath: RepoPath,
  refs: readonly ReviewRef[],
): Promise<GitResult<ReviewRef[]>> {
  const missing: ReviewRef[] = [];
  for (const ref of new Set(refs)) {
    const result = await runner.run({
      cwd: repoPath,
      args: ["rev-parse", "--quiet", "--verify", `${ref}^{commit}`],
      okExitCodes: [0, 1],
    });
    if (!result.ok) return failure(mapRunFailure(result.failure, repoPath));
    if (result.stdout.trim().length === 0) {
      missing.push(ref);
    }
  }
  return { ok: true, value: missing };
}

export async function listBranches(
  runner: GitRunner,
  repoPath: RepoPath,
): Promise<GitResult<BranchList>> {
  const refsResult = await runner.run({
    cwd: repoPath,
    args: ["for-each-ref", "refs/heads", "--format=%(refname:short)"],
  });
  if (!refsResult.ok) return failure(mapRunFailure(refsResult.failure, repoPath));
  let branches: BranchName[];
  try {
    branches = parseBranchList(refsResult.stdout).map((name) => BranchName.parse(name));
  } catch (error) {
    console.error("git for-each-ref output did not match the expected format:", error);
    return failure({ code: "unexpected" });
  }

  const currentResult = await runner.run({ cwd: repoPath, args: ["branch", "--show-current"] });
  if (!currentResult.ok) return failure(mapRunFailure(currentResult.failure, repoPath));
  const currentName = currentResult.stdout.trim();
  let currentBranch: BranchName | null;
  try {
    currentBranch = currentName.length > 0 ? BranchName.parse(currentName) : null;
  } catch (error) {
    console.error("git branch --show-current output did not match the expected format:", error);
    return failure({ code: "unexpected" });
  }

  return {
    ok: true,
    value: {
      branches,
      defaultBranch: await detectDefaultBranch(runner, repoPath, branches, currentBranch),
      currentBranch,
    },
  };
}

/** Detection order: origin's HEAD if it names a local branch, then local
 * `main`, then `master`, then the current branch, then nothing. */
async function detectDefaultBranch(
  runner: GitRunner,
  repoPath: RepoPath,
  branches: BranchName[],
  currentBranch: BranchName | null,
): Promise<BranchName | null> {
  const originHead = await runner.run({
    cwd: repoPath,
    args: ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"],
  });
  if (originHead.ok) {
    const name = originHead.stdout.trim().replace(/^refs\/remotes\/origin\//u, "");
    const local = branches.find((branch) => branch === name);
    if (local !== undefined) return local;
  }
  return (
    branches.find((branch) => branch === "main") ??
    branches.find((branch) => branch === "master") ??
    currentBranch
  );
}

export async function getCommitLog(
  runner: GitRunner,
  repoPath: RepoPath,
  range: LogRange | null,
): Promise<GitResult<CommitLog>> {
  // Only HEAD's log carries the working tree: every other walk names a committed ref
  // — a review's `base..head`, or another branch's history — and uncommitted changes
  // belong to none of them. The picker keeps `range` null while it is listing the
  // checked-out branch precisely so that list keeps its working-tree row.
  let isDirty = false;
  if (range === null) {
    const statusResult = await runner.run({ cwd: repoPath, args: ["status", "--porcelain", "-z"] });
    if (!statusResult.ok) return failure(mapRunFailure(statusResult.failure, repoPath));
    isDirty = statusResult.stdout.length > 0;
  }

  // base/head already passed the ref deny-list; the two-dot `base..head` is one
  // argument, so no flag or rev-expression can smuggle past the spawn boundary — and a
  // lone `head` is the same guarded ref, so it cannot become a flag either.
  const logArgs = ["log", "-z", `--max-count=${LOG_MAX_COUNT}`, LOG_FORMAT];
  if (range !== null) {
    // A base narrows the walk to what `head` adds over it; without one, `head`'s own
    // history is the list — a branch the reviewer wants to read rather than compare.
    logArgs.push(range.base === null ? range.head : `${range.base}..${range.head}`);
  }
  // The same trailing separator every diff carries (`committedDiffArgs`): it tells git the
  // walk names revisions and nothing else, so a repo holding a file named like the branch
  // lists that branch's history instead of failing with "ambiguous argument".
  logArgs.push("--");
  const logResult = await runner.run({ cwd: repoPath, args: logArgs });

  let commits: LogEntry[];
  if (logResult.ok) {
    try {
      commits = parseCommitLog(logResult.stdout).map((parsed) => ({
        kind: "commit",
        commit: Commit.parse(parsed),
      }));
    } catch (error) {
      console.error("git log output did not match the expected format:", error);
      return failure({ code: "unexpected" });
    }
  } else if (
    logResult.failure.code === "exited" &&
    /does not have any commits yet/iu.test(logResult.failure.stderr)
  ) {
    // Unborn HEAD (fresh `git init`): an empty log, not an error — uncommitted
    // changes are still selectable.
    commits = [];
  } else {
    return failure(mapRunFailure(logResult.failure, repoPath));
  }

  const entries: LogEntry[] = isDirty ? [{ kind: "uncommitted" }, ...commits] : commits;
  return { ok: true, value: { entries } };
}

export async function getDiff(
  runner: GitRunner,
  repoPath: RepoPath,
  selection: DiffSelection,
): Promise<GitResult<Patch>> {
  switch (selection.kind) {
    case "branches":
    case "reviewRefs":
      // Three-dot (merge-base) semantics: only what `head` adds over the common
      // ancestor, matching how a PR is reviewed — and how a review artifact's
      // authored `base..head` is reproduced when it carries no frozen patch.
      return diffCommitted(runner, repoPath, [rangeSpec(selection.base, selection.head)]);
    case "commitRange": {
      const base = await resolveRangeBase(runner, repoPath, selection.first);
      if (!base.ok) return base;
      const ancestry = await verifyAncestry(runner, repoPath, selection.first, selection.last);
      if (!ancestry.ok) return ancestry;
      return diffCommitted(runner, repoPath, [base.value, selection.last]);
    }
    case "commitRangeWithUncommitted": {
      const base = await resolveRangeBase(runner, repoPath, selection.first);
      if (!base.ok) return base;
      const ancestry = await verifyAncestry(runner, repoPath, selection.first, "HEAD");
      if (!ancestry.ok) return ancestry;
      // A single rev diffs against the working tree, which is exactly the brush
      // ending on the uncommitted entry.
      return diffWorkingTree(runner, repoPath, [base.value]);
    }
    case "uncommitted": {
      const headResult = await runner.run({
        cwd: repoPath,
        args: ["rev-parse", "--quiet", "--verify", "HEAD"],
        okExitCodes: [0, 1],
      });
      if (!headResult.ok) return failure(mapRunFailure(headResult.failure, repoPath));
      const hasHead = headResult.stdout.trim().length > 0;
      // Unborn HEAD: everything staged is the diff against the empty index base.
      return hasHead
        ? diffWorkingTree(runner, repoPath, ["HEAD"])
        : diffWorkingTree(runner, repoPath, ["--cached"]);
    }
    default:
      return assertNever(selection);
  }
}

/** git's two ways of saying "no blob for this path at this ref": a path that never
 * existed in the tree, and one that exists in the work tree but not in this commit
 * (the added-file old side). Both are a normal typed absence, not a failure. */
function isPathAbsentAtRef(stderr: string): boolean {
  return /does not exist in|exists on disk, but not in/iu.test(stderr);
}

/** The rev a `git show <rev>:<path>` source reads its blob at. `worktree` has no rev
 * (it reads from disk) and is handled before this. A `CommitSha` is hex-only and a
 * `ReviewRef` deny-lists flags, so the interpolated rev can never become a flag or a
 * path segment; `^` and `HEAD` are fixed literals. `<commit>^` is the same
 * base a commit range diffs against (`resolveRangeBase`), so the old side aligns. */
function revForShowSource(
  source: Extract<FileContentsSource, { kind: "ref" | "parentOf" | "head" }>,
): string {
  switch (source.kind) {
    case "ref":
      return source.ref;
    case "parentOf":
      return `${source.commit}^`;
    case "head":
      return "HEAD";
    default:
      return assertNever(source);
  }
}

/** Full text of a file for context expansion — bytes only, no diff knowledge. A
 * `git show <rev>:<path>` source reads a blob (the validated rev
 * leads the single object argument, so the path can never become a flag, and git
 * returns the raw blob — no smudge/textconv filter). A `worktree` source reads the
 * new side of an uncommitted diff off disk. The runner's byte cap bounds the git
 * read like every other op. */
export async function getFileContents(
  runner: GitRunner,
  request: FileContentsRequest,
): Promise<GitResult<FileAtRef>> {
  const { repoPath, source, path } = request;
  if (source.kind === "worktree") {
    return readWorktreeFile(repoPath, path);
  }
  const result = await runner.run({
    cwd: repoPath,
    args: ["show", `${revForShowSource(source)}:${path}`],
  });
  if (result.ok) return { ok: true, value: { kind: "present", text: result.stdout } };
  if (result.failure.code === "exited" && isPathAbsentAtRef(result.failure.stderr)) {
    return { ok: true, value: { kind: "absent" } };
  }
  return failure(mapRunFailure(result.failure, repoPath));
}

/** The new side of an uncommitted diff is the working-tree file on disk — exactly
 * what `git diff` compared against, named by no ref. `path` is validated to reject any
 * `..` segment, so the join stays inside the repo top-level. A missing file
 * (or a path that resolved to a directory) is the deleted new side: a typed absence,
 * not a failure — mirroring `git show`'s absent-blob mapping. */
async function readWorktreeFile(repoPath: RepoPath, path: string): Promise<GitResult<FileAtRef>> {
  try {
    const text = await readFile(join(repoPath, path), "utf8");
    return { ok: true, value: { kind: "present", text } };
  } catch (error) {
    const code = errnoCode(error);
    if (code === "ENOENT" || code === "EISDIR") {
      return { ok: true, value: { kind: "absent" } };
    }
    return failure({ code: "unexpected" });
  }
}

/** The brush invariant `first` = oldest, endpoint = newest (git.ts) can't be
 * expressed in the type — assert it before diffing, or a reversed/disjoint pair
 * would silently produce a reversed diff instead of a typed failure. */
async function verifyAncestry(
  runner: GitRunner,
  repoPath: RepoPath,
  ancestor: string,
  descendant: string,
): Promise<GitResult<void>> {
  const result = await runner.run({
    cwd: repoPath,
    args: ["merge-base", "--is-ancestor", ancestor, descendant],
  });
  if (result.ok) return { ok: true, value: undefined };
  // Exit 1 is merge-base's defined "not an ancestor" answer, not an error.
  if (result.failure.code === "exited" && result.failure.exitCode === 1) {
    return failure({ code: "invalidRange" });
  }
  return failure(mapRunFailure(result.failure, repoPath));
}

/** Base rev for a brushed range starting at `first`: its parent, or — for a root
 * commit — the repo's empty tree (computed, not hardcoded, so SHA-256 repos work). */
async function resolveRangeBase(
  runner: GitRunner,
  repoPath: RepoPath,
  first: CommitSha,
): Promise<GitResult<string>> {
  const parentResult = await runner.run({
    cwd: repoPath,
    args: ["rev-parse", "--quiet", "--verify", `${first}^`],
    okExitCodes: [0, 1],
  });
  if (!parentResult.ok) return failure(mapRunFailure(parentResult.failure, repoPath));
  const parent = parentResult.stdout.trim();
  if (parent.length > 0) return { ok: true, value: parent };

  // `--verify` alone can't tell "root commit" from "sha doesn't exist" — confirm
  // the commit itself resolves before falling back to the empty tree.
  const commitResult = await runner.run({
    cwd: repoPath,
    args: ["rev-parse", "--quiet", "--verify", `${first}^{commit}`],
    okExitCodes: [0, 1],
  });
  if (!commitResult.ok) return failure(mapRunFailure(commitResult.failure, repoPath));
  if (commitResult.stdout.trim().length === 0) return failure({ code: "unknownRevision" });

  const emptyTree = await runner.run({
    cwd: repoPath,
    args: ["hash-object", "-t", "tree", "/dev/null"],
  });
  if (!emptyTree.ok) return failure(mapRunFailure(emptyTree.failure, repoPath));
  return { ok: true, value: emptyTree.stdout.trim() };
}

/** Diff between committed endpoints — no working-tree involvement. */
async function diffCommitted(
  runner: GitRunner,
  repoPath: RepoPath,
  revs: readonly string[],
): Promise<GitResult<Patch>> {
  const result = await runner.run({
    cwd: repoPath,
    args: committedDiffArgs(revs),
  });
  if (!result.ok) return failure(mapRunFailure(result.failure, repoPath));
  return { ok: true, value: { patch: result.stdout } };
}

/** Diff whose right side is the working tree: the tracked diff plus a generated
 * new-file patch per untracked file — never `git add -N`, which would mutate the
 * user's index. */
async function diffWorkingTree(
  runner: GitRunner,
  repoPath: RepoPath,
  revs: readonly string[],
): Promise<GitResult<Patch>> {
  const tracked = await diffCommitted(runner, repoPath, revs);
  if (!tracked.ok) return tracked;

  const untracked = await runner.run({
    cwd: repoPath,
    args: ["ls-files", "--others", "--exclude-standard", "-z"],
  });
  if (!untracked.ok) return failure(mapRunFailure(untracked.failure, repoPath));
  const untrackedPaths = untracked.stdout.split("\0").filter((path) => path.length > 0);

  const parts = [tracked.value.patch];
  let totalBytes = Buffer.byteLength(tracked.value.patch);
  for (const path of untrackedPaths) {
    // Exits 1 when the file has content (diff semantics); a genuinely empty new
    // file produces no output and is invisible in the patch — a known limit.
    const fileDiff = await runner.run({
      cwd: repoPath,
      args: [...DIFF_CONFIG, ...DIFF_ARGS, "--no-index", "--", "/dev/null", path],
      okExitCodes: [0, 1],
    });
    if (!fileDiff.ok) return failure(mapRunFailure(fileDiff.failure, repoPath));
    totalBytes += Buffer.byteLength(fileDiff.stdout);
    // Each spawn is capped individually; the concatenation must honor the same cap.
    if (totalBytes > runner.maxOutputBytes) {
      return failure({ code: "outputOverflow", limitBytes: runner.maxOutputBytes });
    }
    parts.push(fileDiff.stdout);
  }

  return { ok: true, value: { patch: parts.join("") } };
}

// ── Remotes, fetches and worktrees ──────────────────────────────────────────────────────────
//
// What Review Pull Request… asks of git (`main/pull-request/`): which remotes a checkout has, a
// fetch of a pull request's head into its own ref, a clone when there is no checkout, and the
// worktree the review is read in. Kept GitHub-agnostic like the rest of this module — the
// pull request layer decides which remote is the right one and which refs to name; these run
// what they are told, through the same argv-only runner, and answer in `GitFailure` codes.
//
// **What they write.** Unlike everything above, these write — and only what is the app's:
//
// - The fetch writes exactly the refs its refspecs name. `--refmap=` (empty) is what makes
//   "exactly" true: without it git also applies the remote's *configured* fetch refspecs to
//   whatever it fetched ("opportunistic remote-tracking update"), and a remote configured with
//   a mirror-style `+refs/heads/*:refs/heads/*` would have the base's fetch force-move the
//   reader's own local branch of that name. `--no-write-fetch-head` leaves FETCH_HEAD as their
//   last fetch wrote it, `--no-tags` keeps the remote's tags out of their tag list.
// - A worktree is a second working tree with its own HEAD and index, detached; adding,
//   switching and removing one edit only its own directory and `<git dir>/worktrees/<name>`.
// - The status and rev-list reads take no optional locks (`GIT_OPTIONAL_LOCKS=0`).
//
// **What they must not run.** A pull request's worktree is someone else's code checked out on
// the reader's machine, so every one of these ops runs with `UNTRUSTED_TREE_CONFIG`, which pins
// the three settings that make git execute a program *chosen by the working tree it is in*:
//
// - `core.hooksPath=/dev/null` — no hooks at all. A *relative* `core.hooksPath` (husky's
//   `.husky/_`, a common setup) resolves against the working tree a hook runs in, so `git switch`
//   in the worktree would run the pull request's own `.husky/post-checkout`; and `worktree add`
//   runs the reader's post-checkout with the pull request as its cwd, where an "install on
//   checkout" hook runs the pull request's install scripts. Nothing here needs a hook.
// - `core.fsmonitor=false` — a relative fsmonitor command resolves against the worktree too.
//   The built-in daemon is only a speed-up, and these ops touch one small tree.
// - `submodule.recurse=false` — a checkout that recursed would act on the pull request's own
//   `.gitmodules`.
//
// What is deliberately *not* pinned: filter and textconv drivers (`filter.<name>.*`,
// `diff.<name>.textconv`). The pull request's `.gitattributes` can select one, but only one the
// reader configured — git-lfs, most often — and a checkout without its smudge filter is a
// checkout of pointer files the agent would review as if they were the code. The ordinary read
// ops above stay as they were: none of them fires a hook, the diff already refuses external
// drivers (`DIFF_ARGS`' `--no-ext-diff`), and the one working-tree read that could consult an
// fsmonitor (the picker's `status`) only meets a pull request's tree if the reader opens the
// worktree as a plain repository — the same exposure their own agent's `git status` in that
// worktree has, and not one the app can remove for it. `DIFF_CONFIG` is not touched: its bytes
// are the patch's, shared with the CLI's capture.

/** The `-c` pins every Review Pull Request… operation runs under — see the section header. */
const UNTRUSTED_TREE_CONFIG = [
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "submodule.recurse=false",
] as const;

/** How long an operation that reaches a remote may take. Far past the runner's 30s default,
 * which is sized for local reads: the first fetch of a pull request on a large repository moves
 * real data, and a partial clone's checkout fetches every blob it writes. Still a bound, so a
 * remote that stops answering surfaces as `timeout` rather than a dialog that spins forever. */
const REMOTE_TIMEOUT_MS = 10 * 60 * 1000;

/** A clone fetches every commit and tree of the repository before it can check anything out,
 * which on a large one is minutes even blobless. */
const CLONE_TIMEOUT_MS = 30 * 60 * 1000;

/** The longest remote sentence `remoteFailed` carries — enough for one line of git's or the
 * host's own explanation, short enough to sit in a dialog. */
const REMOTE_DETAIL_MAX = 300;

/** What is stripped from a remote's line before it is shown: C0 and C1 control characters
 * (a terminal escape a remote sends must not reach a dialog as text), and the bidirectional
 * overrides and isolates, which can make a line read as something other than what it says. */
// oxlint-disable-next-line no-control-regex -- stripping control characters is the point
const UNSHOWABLE = /[\u0000-\u0009\u000B-\u001F\u007F-\u009F؜‎‏‪-‮⁦-⁩]/gu;

/** The one line of a failed remote operation's stderr worth showing a reader: the remote's own
 * explanation (`remote: …`) when it gave one, else git's last `fatal:`/`error:` line, else the
 * last line at all — unshowable characters stripped, URL credentials redacted (with the same
 * over-redacting rule the CLI prints with, `redactUrlCredentials`), capped. Exported for its
 * tests; the only caller is the mapping below. */
export function remoteFailureDetail(stderr: string): string {
  const lines = stderr
    .replaceAll(UNSHOWABLE, "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const remote = lines.find((line) => /^remote:\s*\S/u.test(line));
  const fatal = lines.findLast((line) => /^(?:fatal|error):/u.test(line));
  const chosen = redactUrlCredentials(remote ?? fatal ?? lines.at(-1) ?? "git gave no reason");
  return chosen.length > REMOTE_DETAIL_MAX ? `${chosen.slice(0, REMOTE_DETAIL_MAX - 1)}…` : chosen;
}

/** A failure of an operation that may have talked to a remote. git's stderr is read
 * conservatively, most specific first, and only on phrasings git and GitHub actually print.
 * Order matters where messages overlap: GitHub's ssh answer to a repository it will not show is
 * "Repository not found" *followed by* the same "Could not read from remote repository" an ssh
 * key refusal ends with, so not-found is asked before auth.
 *
 * What matches none of them depends on what the operation mostly is. A fetch or clone is about
 * the remote, so the remote's own line comes back as `remoteFailed`. A worktree add or switch
 * only *may* reach the remote (a partial clone's lazy blob fetch) and is otherwise local — a
 * path that already exists, a lock — so its unknowns map as any local operation's do, and never
 * read "could not talk to the remote" about something that never left the disk. Everything that
 * is not an `exited` failure (a timeout, a cancel, a missing cwd) maps as any other operation's
 * would. Exported for its tests. */
export function mapRemoteFailure(
  runFailure: GitRunFailure,
  repoPath: string,
  unknown: "remote" | "local" = "remote",
): GitFailure {
  if (runFailure.code !== "exited") {
    return mapRunFailure(runFailure, repoPath);
  }
  const { stderr } = runFailure;
  const missingRef = /couldn't find remote ref (\S+)/iu.exec(stderr)?.[1];
  if (missingRef !== undefined) {
    console.error(`git (remote) exited with ${runFailure.exitCode ?? "signal"}: ${stderr}`);
    return { code: "remoteRefMissing", ref: missingRef.slice(0, 512) };
  }
  if (
    /repository not found|repository '[^']*' not found|does not appear to be a git repository|returned error: 404/iu.test(
      stderr,
    )
  ) {
    console.error(`git (remote) exited with ${runFailure.exitCode ?? "signal"}: ${stderr}`);
    return { code: "remoteNotFound" };
  }
  if (
    /terminal prompts disabled|could not read (?:username|password)|authentication failed|invalid username or (?:password|token)|permission denied \(|host key verification failed|returned error: 40[13]/iu.test(
      stderr,
    )
  ) {
    console.error(`git (remote) exited with ${runFailure.exitCode ?? "signal"}: ${stderr}`);
    return { code: "authFailed" };
  }
  if (
    /could not resolve host|failed to connect to|connection (?:timed out|refused|reset)|network is unreachable|operation timed out|no route to host/iu.test(
      stderr,
    )
  ) {
    console.error(`git (remote) exited with ${runFailure.exitCode ?? "signal"}: ${stderr}`);
    return { code: "network" };
  }
  if (unknown === "local") {
    return mapRunFailure(runFailure, repoPath);
  }
  console.error(`git (remote) exited with ${runFailure.exitCode ?? "signal"}: ${stderr}`);
  if (/not a git repository|must be run in a work tree/iu.test(stderr)) {
    return { code: "notARepo", path: repoPath };
  }
  return { code: "remoteFailed", detail: remoteFailureDetail(stderr) };
}

/** One remote of a checkout: its name, and every URL it is known by — the URL as configured,
 * and as git will actually fetch it once `url.<base>.insteadOf` has rewritten it. Both, because
 * either may be the one that names the repository: a reader whose `gh:` shorthand expands to
 * github.com is only recognizable after the rewrite, and one whose github.com remote is
 * rewritten to a mirror only before it. */
export type GitRemote = { name: BranchName; urls: string[] };

/** The checkout's remotes. Two reads: `git config --get-regexp` for the configured URLs
 * (NUL-separated, so a URL is never split) and `git remote -v` for the rewritten ones. A remote
 * whose name is not a safe argv element (`BranchName`'s deny-list — git's own rules for remote
 * names, which also refuse a leading `-`) is dropped and logged rather than offered to a fetch. */
export async function listRemotes(
  runner: GitRunner,
  repoPath: string,
): Promise<GitResult<GitRemote[]>> {
  const configured = await runner.run({
    cwd: repoPath,
    args: ["config", "-z", "--get-regexp", String.raw`^remote\..+\.url$`],
    // 1 is `--get-regexp`'s "no such key": a checkout with no remotes, not a failure.
    okExitCodes: [0, 1],
  });
  if (!configured.ok) return failure(mapRunFailure(configured.failure, repoPath));
  const effective = await runner.run({ cwd: repoPath, args: ["remote", "-v"] });
  if (!effective.ok) return failure(mapRunFailure(effective.failure, repoPath));

  const urls = new Map<string, Set<string>>();
  const add = (name: string, url: string): void => {
    const set = urls.get(name) ?? new Set<string>();
    set.add(url);
    urls.set(name, set);
  };
  for (const record of configured.stdout.split("\0")) {
    // `remote.<name>.url\n<value>` — and a remote's name may itself hold dots.
    const match = /^remote\.(.+)\.url\n(.*)$/su.exec(record);
    if (match?.[1] !== undefined && match[2] !== undefined) {
      add(match[1], match[2]);
    }
  }
  for (const line of effective.stdout.split("\n")) {
    const match = /^(\S+)\t(.*) \(fetch\)$/u.exec(line);
    if (match?.[1] !== undefined && match[2] !== undefined) {
      add(match[1], match[2]);
    }
  }

  const remotes: GitRemote[] = [];
  for (const [name, set] of urls) {
    const parsed = BranchName.safeParse(name);
    if (parsed.success) {
      remotes.push({ name: parsed.data, urls: [...set] });
    } else {
      console.error(`Ignoring a remote whose name is not a safe argument: ${JSON.stringify(name)}`);
    }
  }
  return { ok: true, value: remotes };
}

/** The branch a remote's HEAD names (`refs/remotes/<remote>/HEAD`, which `git clone` and
 * `git remote set-head` write), or null when the checkout has never recorded one. */
export async function remoteDefaultBranch(
  runner: GitRunner,
  repoPath: string,
  remote: BranchName,
): Promise<GitResult<BranchName | null>> {
  const result = await runner.run({
    cwd: repoPath,
    args: ["symbolic-ref", "--quiet", `refs/remotes/${remote}/HEAD`],
    // `--quiet` makes "not a symbolic ref" exit 1 with nothing printed: git's answer, not a failure.
    okExitCodes: [0, 1],
  });
  if (!result.ok) return failure(mapRunFailure(result.failure, repoPath));
  const prefix = `refs/remotes/${remote}/`;
  const target = result.stdout.trim();
  if (!target.startsWith(prefix)) {
    return { ok: true, value: null };
  }
  const parsed = BranchName.safeParse(target.slice(prefix.length));
  return { ok: true, value: parsed.success ? parsed.data : null };
}

/** The branch `listBranches` would preselect — the same detection order — for a caller that
 * wants only that answer. */
export async function defaultBranch(
  runner: GitRunner,
  repoPath: string,
): Promise<GitResult<BranchName | null>> {
  const branches = await listBranches(runner, repoPath);
  return branches.ok ? { ok: true, value: branches.value.defaultBranch } : branches;
}

/** `git fetch <remote> <refspecs…>`, with the reader's own credentials and nothing else of
 * theirs touched (the section header: `--refmap=`, `--no-write-fetch-head`, `--no-tags`), and
 * `--no-recurse-submodules` keeping it to this repository. `detached` so ssh cannot sit on a
 * terminal prompt (see `GitRunRequest.detached`), and cancellable through `signal`. Every
 * refspec is built by the caller from validated names; the remote is a validated `BranchName`,
 * so neither can become a flag. */
export async function fetchRefspecs(
  runner: GitRunner,
  repoPath: string,
  remote: BranchName,
  refspecs: readonly string[],
  signal?: AbortSignal,
): Promise<GitResult<void>> {
  const result = await runner.run({
    cwd: repoPath,
    args: [
      ...UNTRUSTED_TREE_CONFIG,
      "fetch",
      "--quiet",
      "--no-tags",
      "--no-write-fetch-head",
      "--no-recurse-submodules",
      "--refmap=",
      remote,
      ...refspecs,
    ],
    timeoutMs: REMOTE_TIMEOUT_MS,
    detached: true,
    ...(signal === undefined ? {} : { signal }),
  });
  return result.ok
    ? { ok: true, value: undefined }
    : failure(mapRemoteFailure(result.failure, repoPath));
}

/** `git clone --filter=blob:none <url> <name>` inside `parentDir`: a partial clone, whose
 * commits and trees arrive now, along with the files of the commit it checks out; every other
 * file's contents arrive the first time a checkout or a diff needs them. `--` ends the options,
 * so neither the URL nor the name can be read as one. Answers the new checkout's toplevel. */
export async function clonePartial(
  runner: GitRunner,
  parentDir: string,
  url: string,
  name: string,
  signal?: AbortSignal,
): Promise<GitResult<RepoInfo>> {
  const result = await runner.run({
    cwd: parentDir,
    args: [...UNTRUSTED_TREE_CONFIG, "clone", "--quiet", "--filter=blob:none", "--", url, name],
    timeoutMs: CLONE_TIMEOUT_MS,
    detached: true,
    ...(signal === undefined ? {} : { signal }),
  });
  if (!result.ok) return failure(mapRemoteFailure(result.failure, parentDir));
  return validateRepo(runner, join(parentDir, name));
}

/** The commit `ref` names, or null when it names none. `--quiet --verify` answers "no such
 * commit" as exit 1 with nothing on stdout — git's defined answer, not a failure. `ref` is
 * built by the caller from validated parts. */
export async function resolveCommit(
  runner: GitRunner,
  repoPath: string,
  ref: string,
): Promise<GitResult<CommitSha | null>> {
  const result = await runner.run({
    cwd: repoPath,
    args: ["rev-parse", "--quiet", "--verify", `${ref}^{commit}`],
    okExitCodes: [0, 1],
  });
  if (!result.ok) return failure(mapRunFailure(result.failure, repoPath));
  const sha = CommitSha.safeParse(result.stdout.trim());
  return { ok: true, value: sha.success ? sha.data : null };
}

/** One entry of `git worktree list`: where it is, what it has checked out, and what git says
 * about its state. `main` is the repository's own entry, which git always lists first — a
 * working tree, or for a bare repository the bare directory itself (`bare`); `branch` is the
 * branch checked out there, null when detached; `prunable` is a registration whose directory
 * is gone; `locked` is git's lock and its reason (`""` when locked without one, null when not
 * locked) — `initializing` is the lock `worktree add` holds while it writes the tree, so a
 * worktree still locked that way is one whose checkout never finished. */
export type WorktreeEntry = {
  path: string;
  head: CommitSha | null;
  branch: string | null;
  main: boolean;
  bare: boolean;
  prunable: boolean;
  locked: string | null;
};

/** Every worktree of the repository `repoPath` belongs to — the same list from any of them,
 * main first. `--porcelain -z` (git 2.36) so a path is never split on a newline. */
export async function listWorktrees(
  runner: GitRunner,
  repoPath: string,
): Promise<GitResult<WorktreeEntry[]>> {
  const result = await runner.run({
    cwd: repoPath,
    args: ["worktree", "list", "--porcelain", "-z"],
  });
  if (!result.ok) return failure(mapRunFailure(result.failure, repoPath));
  const entries: WorktreeEntry[] = [];
  // Records are attribute lines, each NUL-terminated, separated by an empty one.
  for (const record of result.stdout.split("\0\0")) {
    const lines = record.split("\0").filter((line) => line.length > 0);
    const path = lines.find((line) => line.startsWith("worktree "))?.slice("worktree ".length);
    if (path === undefined) {
      continue;
    }
    const head = CommitSha.safeParse(lines.find((line) => line.startsWith("HEAD "))?.slice(5));
    const branch = lines.find((line) => line.startsWith("branch "))?.slice("branch ".length);
    entries.push({
      path,
      head: head.success ? head.data : null,
      branch: branch === undefined ? null : branch.replace(/^refs\/heads\//u, ""),
      main: entries.length === 0,
      bare: lines.includes("bare"),
      prunable: lines.some((line) => line === "prunable" || line.startsWith("prunable ")),
      locked: lockReason(lines),
    });
  }
  return { ok: true, value: entries };
}

/** A porcelain record's `locked` line: its reason, `""` for a bare `locked`, null for none. */
function lockReason(lines: readonly string[]): string | null {
  const line = lines.find((candidate) => candidate === "locked" || candidate.startsWith("locked "));
  return line === undefined ? null : line.slice("locked".length).trim();
}

/** Points `ref` at `sha` — a ref the caller owns (under `refs/rvw/`), never one of the
 * reader's. */
export async function updateRef(
  runner: GitRunner,
  repoPath: string,
  ref: string,
  sha: CommitSha,
): Promise<GitResult<void>> {
  const result = await runner.run({ cwd: repoPath, args: ["update-ref", ref, sha] });
  return result.ok
    ? { ok: true, value: undefined }
    : failure(mapRunFailure(result.failure, repoPath));
}

/** Deletes `ref` — again one the caller owns. A ref that is already gone is not a failure. */
export async function deleteRef(
  runner: GitRunner,
  repoPath: string,
  ref: string,
): Promise<GitResult<void>> {
  const result = await runner.run({ cwd: repoPath, args: ["update-ref", "-d", ref] });
  return result.ok
    ? { ok: true, value: undefined }
    : failure(mapRunFailure(result.failure, repoPath));
}

/** Whether a working tree has anything a removal or a checkout would lose in its files:
 * modified or staged tracked files, or untracked ones. Ignored files do not count — they are
 * what `git worktree remove` itself deletes without asking (a build output, an installed
 * `node_modules`), which is why the dialog's confirmation says so. */
export async function hasUncommittedChanges(
  runner: GitRunner,
  worktreePath: string,
): Promise<GitResult<boolean>> {
  // `--untracked-files=normal` spelled out: a reader's `status.showUntrackedFiles=no` would
  // otherwise hide exactly the files an agent leaves behind, and call the tree clean.
  const result = await runner.run({
    cwd: worktreePath,
    args: [...UNTRUSTED_TREE_CONFIG, "status", "--porcelain", "-z", "--untracked-files=normal"],
  });
  if (!result.ok) return failure(mapRunFailure(result.failure, worktreePath));
  return { ok: true, value: result.stdout.length > 0 };
}

/** Whether the worktree's HEAD has commits no ref holds: no branch, tag or remote-tracking
 * branch, and no `safeRefsGlob` ref (`refs/rvw`, the fetched pull request heads). A clean
 * status says nothing about these — an agent that *committed* on the detached HEAD leaves a
 * clean tree — and they are lost the moment the worktree is removed or moved (they become
 * unreachable, and `gc` takes them). `--glob` with no wildcard implies `/*`, and its match
 * crosses `/`, so the nested `refs/rvw/pr/<owner>/<repo>/<n>` refs count. */
export async function hasUnreachableCommits(
  runner: GitRunner,
  worktreePath: string,
  safeRefsGlob: string,
): Promise<GitResult<boolean>> {
  const result = await runner.run({
    cwd: worktreePath,
    args: [
      "rev-list",
      "-1",
      "HEAD",
      "--not",
      "--branches",
      "--tags",
      "--remotes",
      `--glob=${safeRefsGlob}`,
    ],
  });
  if (!result.ok) return failure(mapRunFailure(result.failure, worktreePath));
  return { ok: true, value: result.stdout.trim().length > 0 };
}

/** `git worktree add --detach <path> <ref>` from `repoPath`: a new working tree at `path` on
 * `ref`'s commit, on no branch, with no hook run (`UNTRUSTED_TREE_CONFIG`). `path` is absolute
 * (it cannot be read as a flag) and `ref` is built by the caller. Detached, because in a
 * partial clone the checkout fetches the blobs it writes — but deliberately *not* cancellable:
 * a checkout stopped halfway is a truncated tree an agent could be sent to review, so Cancel
 * waits for it (only the timeout stops it, gracefully — `KILL_GRACE_MS`). */
export async function addDetachedWorktree(
  runner: GitRunner,
  repoPath: string,
  path: string,
  ref: string,
): Promise<GitResult<void>> {
  const result = await runner.run({
    cwd: repoPath,
    args: [...UNTRUSTED_TREE_CONFIG, "worktree", "add", "--quiet", "--detach", path, ref],
    timeoutMs: REMOTE_TIMEOUT_MS,
    detached: true,
  });
  return result.ok
    ? { ok: true, value: undefined }
    : failure(mapRemoteFailure(result.failure, repoPath, "local"));
}

/** Moves a worktree's detached HEAD to `ref` — `git switch --detach`, run inside it, so the
 * repository's other working trees are untouched, and with no hook run: this is the step that
 * would otherwise run the pull request's own `post-checkout`. The caller has already
 * established that the worktree has nothing to lose; git would refuse to overwrite local
 * changes anyway. */
export async function switchDetached(
  runner: GitRunner,
  worktreePath: string,
  ref: string,
): Promise<GitResult<void>> {
  // Not cancellable, for `addDetachedWorktree`'s reason: half a switch is a tree that is
  // neither the old head nor the new one.
  const result = await runner.run({
    cwd: worktreePath,
    args: [...UNTRUSTED_TREE_CONFIG, "switch", "--quiet", "--detach", ref],
    timeoutMs: REMOTE_TIMEOUT_MS,
    detached: true,
  });
  return result.ok
    ? { ok: true, value: undefined }
    : failure(mapRemoteFailure(result.failure, worktreePath, "local"));
}

/** `git worktree remove <path>` from `repoPath`, never `--force`: git itself refuses a worktree
 * with modified or untracked files, and that refusal is answered as `dirty` — a value, because
 * "it has changes, so it stays" is the policy working, not git failing. A registration whose
 * directory was deleted by hand is cleared the same way (git removes its bookkeeping). A local
 * operation, mapped as one. */
export async function removeWorktree(
  runner: GitRunner,
  repoPath: string,
  path: string,
): Promise<GitResult<"removed" | "dirty">> {
  const result = await runner.run({
    cwd: repoPath,
    args: [...UNTRUSTED_TREE_CONFIG, "worktree", "remove", path],
  });
  if (result.ok) return { ok: true, value: "removed" };
  if (
    result.failure.code === "exited" &&
    /contains modified or untracked files/iu.test(result.failure.stderr)
  ) {
    return { ok: true, value: "dirty" };
  }
  return failure(mapRunFailure(result.failure, repoPath));
}
