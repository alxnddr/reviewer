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
  type CommitSha,
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
} from "../../shared/git";
import type { GitRunFailure, GitRunner } from "./runner";
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
