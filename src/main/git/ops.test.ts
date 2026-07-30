import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { GitResult } from "../../shared/git";
import { getCommitLog, getDiff, getFileContents, listBranches, validateRepo } from "./ops";
import { createGitRunner } from "./runner";

// Integration suite against fixture repos built by real git in a temp dir.
// Fixture construction is isolated from the developer's git config; the code
// under test must itself be config-proof.

const FIXTURE_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "Fixture",
  GIT_AUTHOR_EMAIL: "fixture@test.local",
  GIT_COMMITTER_NAME: "Fixture",
  GIT_COMMITTER_EMAIL: "fixture@test.local",
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: FIXTURE_ENV });
}

function expectOk<T>(result: GitResult<T>): T {
  if (!result.ok) throw new Error(`Expected ok result, got: ${JSON.stringify(result.failure)}`);
  return result.value;
}

function expectFailure<T>(result: GitResult<T>): { code: string } {
  if (result.ok) throw new Error("Expected a failure result");
  return result.failure;
}

const runner = createGitRunner();

let root: string;
/** Full history + branch + dirty working tree; never mutated by tests. */
let workRepo: string;
/** One commit, clean working tree. */
let cleanRepo: string;
/** Fresh init, unborn HEAD: one staged file, one untracked file. */
let unbornRepo: string;
/** A branch and a tracked file that share a name — the repo where a walk that names the ref
 * without a `--` separator is refused as ambiguous. */
let ambiguousRepo: string;

let rootSha: string;
let extendSha: string;
let renameSha: string;

beforeAll(() => {
  // realpath because macOS tmpdir is symlinked (/var → /private/var) and
  // `rev-parse --show-toplevel` reports the physical path.
  root = realpathSync(mkdtempSync(join(tmpdir(), "reviewer-ops-test-")));

  workRepo = join(root, "work");
  mkdirSync(workRepo);
  git(workRepo, "init", "-b", "main");
  writeFileSync(join(workRepo, "alpha.txt"), "alpha one\n");
  git(workRepo, "add", ".");
  git(workRepo, "commit", "-m", "add alpha");
  rootSha = git(workRepo, "rev-parse", "HEAD").trim();

  writeFileSync(join(workRepo, "alpha.txt"), "alpha one\nalpha two\n");
  writeFileSync(join(workRepo, "beta.txt"), "beta content\n");
  git(workRepo, "add", ".");
  git(workRepo, "commit", "-m", "extend alpha, add beta");
  extendSha = git(workRepo, "rev-parse", "HEAD").trim();

  git(workRepo, "mv", "beta.txt", "gamma.txt");
  git(workRepo, "commit", "-m", "rename beta to gamma");
  renameSha = git(workRepo, "rev-parse", "HEAD").trim();

  git(workRepo, "branch", "feature/delta");
  git(workRepo, "checkout", "-q", "feature/delta");
  writeFileSync(join(workRepo, "delta.txt"), "delta content\n");
  git(workRepo, "add", ".");
  git(workRepo, "commit", "-m", "add delta");
  git(workRepo, "checkout", "-q", "main");

  // main moves on after the branch point: three-dot diffs must not show this.
  writeFileSync(join(workRepo, "alpha.txt"), "alpha one\nalpha two\nalpha main\n");
  git(workRepo, "add", ".");
  git(workRepo, "commit", "-m", "main moves on");

  // Dirty working tree: one tracked modification, one untracked file.
  writeFileSync(join(workRepo, "alpha.txt"), "alpha one\nalpha two\nalpha main\nalpha dirty\n");
  writeFileSync(join(workRepo, "epsilon.txt"), "epsilon content\n");

  cleanRepo = join(root, "clean");
  mkdirSync(cleanRepo);
  git(cleanRepo, "init", "-b", "main");
  writeFileSync(join(cleanRepo, "only.txt"), "only\n");
  git(cleanRepo, "add", ".");
  git(cleanRepo, "commit", "-m", "only commit");

  ambiguousRepo = join(root, "ambiguous");
  mkdirSync(ambiguousRepo);
  git(ambiguousRepo, "init", "-b", "main");
  writeFileSync(join(ambiguousRepo, "topic"), "a file named exactly like the branch\n");
  git(ambiguousRepo, "add", ".");
  git(ambiguousRepo, "commit", "-m", "add topic");
  git(ambiguousRepo, "branch", "topic");

  unbornRepo = join(root, "unborn");
  mkdirSync(unbornRepo);
  git(unbornRepo, "init", "-b", "main");
  writeFileSync(join(unbornRepo, "staged.txt"), "staged content\n");
  git(unbornRepo, "add", "staged.txt");
  writeFileSync(join(unbornRepo, "loose.txt"), "loose content\n");
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("validateRepo", () => {
  it("resolves a repo and normalizes to the work-tree toplevel", async () => {
    const subdir = join(workRepo, "nested");
    mkdirSync(subdir, { recursive: true });
    const fromRoot = expectOk(await validateRepo(runner, workRepo));
    const fromSubdir = expectOk(await validateRepo(runner, subdir));
    expect(fromRoot).toEqual({ path: workRepo, name: basename(workRepo) });
    expect(fromSubdir).toEqual(fromRoot);
  });

  it("reports notARepo for a plain directory", async () => {
    const plain = join(root, "plain");
    mkdirSync(plain, { recursive: true });
    expect(expectFailure(await validateRepo(runner, plain)).code).toBe("notARepo");
  });

  it("reports notARepo for a path that does not exist", async () => {
    expect(expectFailure(await validateRepo(runner, join(root, "gone"))).code).toBe("notARepo");
  });

  it("reports notARepo for a git directory, which is a repo but not a work tree", async () => {
    // git answers "must be run in a work tree" here rather than "not a git
    // repository"; both mean the same thing to a caller that needs to read files.
    expect(expectFailure(await validateRepo(runner, join(workRepo, ".git"))).code).toBe("notARepo");
  });
});

describe("listBranches", () => {
  it("lists branches with the default and current branch", async () => {
    const list = expectOk(await listBranches(runner, workRepo));
    expect(list.branches).toContain("main");
    expect(list.branches).toContain("feature/delta");
    expect(list.defaultBranch).toBe("main");
    expect(list.currentBranch).toBe("main");
  });
});

describe("getCommitLog", () => {
  it("lists commits newest first with an uncommitted entry on a dirty tree", async () => {
    const log = expectOk(await getCommitLog(runner, workRepo, null));
    expect(log.entries[0]).toEqual({ kind: "uncommitted" });
    const commits = log.entries.flatMap((entry) => (entry.kind === "commit" ? [entry.commit] : []));
    expect(commits).toHaveLength(4);
    expect(commits.map((commit) => commit.subject)).toEqual([
      "main moves on",
      "rename beta to gamma",
      "extend alpha, add beta",
      "add alpha",
    ]);
    expect(commits[3]?.sha).toBe(rootSha);
    expect(commits[0]?.author).toBe("Fixture");
  });

  it("omits the uncommitted entry on a clean tree", async () => {
    const log = expectOk(await getCommitLog(runner, cleanRepo, null));
    expect(log.entries).toHaveLength(1);
    expect(log.entries[0]?.kind).toBe("commit");
  });

  it("treats an unborn HEAD as an empty log, keeping the uncommitted entry", async () => {
    const log = expectOk(await getCommitLog(runner, unbornRepo, null));
    expect(log.entries).toEqual([{ kind: "uncommitted" }]);
  });

  it("lists only base..head for a review range, without the uncommitted entry", async () => {
    const log = expectOk(
      await getCommitLog(runner, workRepo, { base: "main", head: "feature/delta" }),
    );
    // Two-dot base..head: only what feature/delta adds over main, never the dirty
    // working tree (a review is between two committed refs).
    expect(log.entries.every((entry) => entry.kind === "commit")).toBe(true);
    const subjects = log.entries.flatMap((entry) =>
      entry.kind === "commit" ? [entry.commit.subject] : [],
    );
    expect(subjects).toContain("add delta");
    expect(subjects).not.toContain("main moves on");
  });

  it("lists a branch's whole history when the range carries no base", async () => {
    // The picker asking "show me this branch" rather than "compare these two": the walk
    // is `git log <head>`, so it reaches back past the merge base to the root commit.
    const log = expectOk(
      await getCommitLog(runner, workRepo, { base: null, head: "feature/delta" }),
    );
    const subjects = log.entries.flatMap((entry) =>
      entry.kind === "commit" ? [entry.commit.subject] : [],
    );
    expect(subjects).toContain("add delta");
    expect(subjects).toContain("add alpha");
    // Still a committed ref, so still no working-tree row — that belongs to HEAD alone.
    expect(log.entries.every((entry) => entry.kind === "commit")).toBe(true);
  });

  it("walks a ref a file of the same name would otherwise make ambiguous", async () => {
    // Without the trailing `--`, git refuses `log topic` in a repo that also has a file
    // called `topic` ("ambiguous argument … both revision and filename"), which
    // `mapRunFailure` reads as `unknownRevision` — so the picker tells the reviewer the
    // revision no longer exists, about a branch it listed a moment earlier.
    const log = expectOk(await getCommitLog(runner, ambiguousRepo, { base: null, head: "topic" }));
    const subjects = log.entries.flatMap((entry) =>
      entry.kind === "commit" ? [entry.commit.subject] : [],
    );
    expect(subjects).toEqual(["add topic"]);
  });
});

describe("getDiff", () => {
  it("branches: three-dot semantics show only what head adds over the merge base", async () => {
    const { patch } = expectOk(
      await getDiff(runner, workRepo, { kind: "branches", base: "main", head: "feature/delta" }),
    );
    expect(patch).toMatch(/^diff --git a\/delta\.txt b\/delta\.txt/u);
    expect(patch).toContain("+delta content");
    expect(patch).not.toContain("alpha");
  });

  it("branches: a head ref deleted since it was persisted is unknownRevision", async () => {
    // The restore case: a session persisted base...head whose head branch no
    // longer exists in the repo maps to the typed per-tab failure, never a crash.
    const failure = expectFailure(
      await getDiff(runner, workRepo, { kind: "branches", base: "main", head: "feature/gone" }),
    );
    expect(failure.code).toBe("unknownRevision");
  });

  it("reviewRefs: reproduces a review's authored base..head with sha endpoints", async () => {
    // A review pins its authored diff by sha: the same three-dot semantics as
    // branches, so the endpoints can be full shas the branch pickers never hold.
    const { patch } = expectOk(
      await getDiff(runner, workRepo, { kind: "reviewRefs", base: rootSha, head: extendSha }),
    );
    expect(patch).toContain("+alpha two");
    expect(patch).toContain("diff --git a/beta.txt b/beta.txt");
    expect(patch).not.toContain("gamma.txt");
  });

  it("reviewRefs: an endpoint missing from the repo is unknownRevision, never a crash", async () => {
    // A review authored against history this clone no longer has (a gc'd sha, a
    // vanished branch) maps to the typed per-tab failure, never a crash or a spawn.
    const failure = expectFailure(
      await getDiff(runner, workRepo, { kind: "reviewRefs", base: "main", head: "feature/gone" }),
    );
    expect(failure.code).toBe("unknownRevision");
  });

  it("commitRange: spans from the first commit's parent through the last", async () => {
    const { patch } = expectOk(
      await getDiff(runner, workRepo, { kind: "commitRange", first: extendSha, last: renameSha }),
    );
    expect(patch).toContain("+alpha two");
    expect(patch).toContain("diff --git a/gamma.txt b/gamma.txt");
    expect(patch).not.toContain("beta.txt");
  });

  it("commitRange: a single commit keeps rename detection", async () => {
    const { patch } = expectOk(
      await getDiff(runner, workRepo, { kind: "commitRange", first: renameSha, last: renameSha }),
    );
    expect(patch).toContain("rename from beta.txt");
    expect(patch).toContain("rename to gamma.txt");
  });

  it("commitRange: a root commit diffs against the empty tree", async () => {
    const { patch } = expectOk(
      await getDiff(runner, workRepo, { kind: "commitRange", first: rootSha, last: rootSha }),
    );
    expect(patch).toContain("new file mode");
    expect(patch).toContain("+alpha one");
  });

  it("commitRange: a reversed range is invalidRange, not a silent reversed diff", async () => {
    const failure = expectFailure(
      await getDiff(runner, workRepo, { kind: "commitRange", first: renameSha, last: rootSha }),
    );
    expect(failure.code).toBe("invalidRange");
  });

  it("commitRange: a well-formed but nonexistent sha is unknownRevision", async () => {
    const missing = "deadbeef".repeat(5);
    const failure = expectFailure(
      await getDiff(runner, workRepo, { kind: "commitRange", first: missing, last: missing }),
    );
    expect(failure.code).toBe("unknownRevision");
  });

  it("commitRangeWithUncommitted: spans commits, tracked changes, and untracked files", async () => {
    const { patch } = expectOk(
      await getDiff(runner, workRepo, { kind: "commitRangeWithUncommitted", first: renameSha }),
    );
    expect(patch).toContain("rename from beta.txt");
    expect(patch).toContain("+alpha dirty");
    expect(patch).toContain("diff --git a/epsilon.txt b/epsilon.txt");
    expect(patch).toContain("+epsilon content");
  });

  it("uncommitted: shows tracked modifications and untracked files as new-file patches", async () => {
    const { patch } = expectOk(await getDiff(runner, workRepo, { kind: "uncommitted" }));
    expect(patch).toMatch(/^diff --git a\/alpha\.txt b\/alpha\.txt/u);
    expect(patch).toContain("+alpha dirty");
    expect(patch).toContain("diff --git a/epsilon.txt b/epsilon.txt");
    expect(patch).toContain("new file mode");
  });

  it("uncommitted: an empty selection on a clean tree is an empty patch, not an error", async () => {
    const { patch } = expectOk(await getDiff(runner, cleanRepo, { kind: "uncommitted" }));
    expect(patch).toBe("");
  });

  it("uncommitted: an unborn HEAD diffs the index and untracked files", async () => {
    const { patch } = expectOk(await getDiff(runner, unbornRepo, { kind: "uncommitted" }));
    expect(patch).toContain("+staged content");
    expect(patch).toContain("+loose content");
  });

  it("returns the typed overflow failure, never a truncated patch, when a diff exceeds the cap", async () => {
    const cappedRunner = createGitRunner({ maxOutputBytes: 1024 });
    const bigRepo = join(root, "big");
    mkdirSync(bigRepo, { recursive: true });
    git(bigRepo, "init", "-b", "main");
    writeFileSync(join(bigRepo, "seed.txt"), "seed\n");
    git(bigRepo, "add", ".");
    git(bigRepo, "commit", "-m", "seed");
    writeFileSync(join(bigRepo, "huge.txt"), "x\n".repeat(4096));

    const failure = expectFailure(await getDiff(cappedRunner, bigRepo, { kind: "uncommitted" }));
    expect(failure).toEqual({ code: "outputOverflow", limitBytes: 1024 });
  });

  it("caps the concatenated patch even when each spawn stays under the limit", async () => {
    const cappedRunner = createGitRunner({ maxOutputBytes: 1024 });
    const manyRepo = join(root, "many");
    mkdirSync(manyRepo, { recursive: true });
    git(manyRepo, "init", "-b", "main");
    writeFileSync(join(manyRepo, "seed.txt"), "seed\n");
    git(manyRepo, "add", ".");
    git(manyRepo, "commit", "-m", "seed");
    // Three untracked files, each patch ~400 bytes: individually under the cap,
    // combined over it.
    for (const name of ["one", "two", "three"]) {
      writeFileSync(join(manyRepo, `${name}.txt`), `${name}\n`.repeat(60));
    }

    const failure = expectFailure(await getDiff(cappedRunner, manyRepo, { kind: "uncommitted" }));
    expect(failure).toEqual({ code: "outputOverflow", limitBytes: 1024 });
  });
});

describe("getFileContents", () => {
  it("returns the full file text at a known ref", async () => {
    const result = expectOk(
      await getFileContents(runner, {
        repoPath: workRepo,
        source: { kind: "ref", ref: rootSha },
        path: "alpha.txt",
      }),
    );
    expect(result).toEqual({ kind: "present", text: "alpha one\n" });
  });

  it("reads the same path at a later ref where its contents differ", async () => {
    const result = expectOk(
      await getFileContents(runner, {
        repoPath: workRepo,
        source: { kind: "ref", ref: extendSha },
        path: "beta.txt",
      }),
    );
    expect(result).toEqual({ kind: "present", text: "beta content\n" });
  });

  it("reads a commit's parent side via parentOf (<commit>^), the base a range diffs against", async () => {
    // extendSha's parent is the root commit, where alpha.txt is still its one line.
    const result = expectOk(
      await getFileContents(runner, {
        repoPath: workRepo,
        source: { kind: "parentOf", commit: extendSha },
        path: "alpha.txt",
      }),
    );
    expect(result).toEqual({ kind: "present", text: "alpha one\n" });
  });

  it("reads the committed HEAD side via the head source", async () => {
    // HEAD is main's tip after it moved on; alpha.txt carries its third line there.
    const result = expectOk(
      await getFileContents(runner, {
        repoPath: workRepo,
        source: { kind: "head" },
        path: "alpha.txt",
      }),
    );
    expect(result).toEqual({ kind: "present", text: "alpha one\nalpha two\nalpha main\n" });
  });

  it("reads the working-tree side off disk, including uncommitted edits", async () => {
    // The dirty working tree appends a fourth line the HEAD blob does not have — the
    // uncommitted diff's new side, which no ref names.
    const result = expectOk(
      await getFileContents(runner, {
        repoPath: workRepo,
        source: { kind: "worktree" },
        path: "alpha.txt",
      }),
    );
    expect(result).toEqual({
      kind: "present",
      text: "alpha one\nalpha two\nalpha main\nalpha dirty\n",
    });
  });

  it("maps a working-tree path with no file to the typed absent variant", async () => {
    // A file deleted in the working tree has no new-side blob: absence, not a failure.
    const result = expectOk(
      await getFileContents(runner, {
        repoPath: workRepo,
        source: { kind: "worktree" },
        path: "does-not-exist.txt",
      }),
    );
    expect(result).toEqual({ kind: "absent" });
  });

  it("maps a path that never existed at the ref to the typed absent variant", async () => {
    // beta.txt is added only at extendSha; at the root commit it has no blob — the
    // added-file old side the loader turns into Pierre's oldFile: null.
    const result = expectOk(
      await getFileContents(runner, {
        repoPath: workRepo,
        source: { kind: "ref", ref: rootSha },
        path: "beta.txt",
      }),
    );
    expect(result).toEqual({ kind: "absent" });
  });

  it("maps a path present on disk but absent from the ref to the absent variant", async () => {
    // epsilon.txt is an untracked working-tree file: git reports it "exists on disk,
    // but not in <ref>" — the second phrasing of absence, still not an error.
    const result = expectOk(
      await getFileContents(runner, {
        repoPath: workRepo,
        source: { kind: "ref", ref: rootSha },
        path: "epsilon.txt",
      }),
    );
    expect(result).toEqual({ kind: "absent" });
  });

  it("bounds the read by the runner's byte cap, never returning a truncated file", async () => {
    const cappedRunner = createGitRunner({ maxOutputBytes: 1024 });
    const bigRepo = join(root, "big-file");
    mkdirSync(bigRepo, { recursive: true });
    git(bigRepo, "init", "-b", "main");
    writeFileSync(join(bigRepo, "huge.txt"), "x\n".repeat(4096));
    git(bigRepo, "add", ".");
    git(bigRepo, "commit", "-m", "huge");

    const failure = expectFailure(
      await getFileContents(cappedRunner, {
        repoPath: bigRepo,
        source: { kind: "ref", ref: "main" },
        path: "huge.txt",
      }),
    );
    expect(failure).toEqual({ code: "outputOverflow", limitBytes: 1024 });
  });
});
