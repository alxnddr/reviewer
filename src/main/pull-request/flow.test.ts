import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { githubPullRequestOf, type PullRequest } from "../../shared/pull-request";
import { createGitRunner, type GitRunRequest, type GitRunner } from "../git/runner";
import { checkReviewSource } from "../review/source";
import type { CheckoutMemory } from "./checkouts";
import { checkoutKey } from "./checkouts";
import {
  adoptCheckout,
  cloneCheckout,
  cloneQueueKey,
  locateCheckout,
  preparePullRequest,
  readPullRequestHead,
  removePullRequestWorktree,
  type PullRequestDeps,
} from "./flow";
import { createKeyedQueue } from "./queue";
import { listPullRequestWorktrees, pullRequestOfWorktree, worktreeLocation } from "./worktrees";

// Review Pull Request… end to end, against real repositories and with no network. A local bare
// repository plays GitHub: it carries `refs/pull/<n>/head` the way GitHub's does, and every
// "github.com" remote in the fixtures is rewritten to it by `url.<base>.insteadOf` in a git
// config the *code under test* reads (`GIT_CONFIG_GLOBAL`, which the runner passes through) —
// so the remotes are spelled as GitHub remotes when the flow matches them, and fetch from the
// bare repository when it fetches. `file://` rather than a bare path, so a partial clone is a
// real one (git ignores `--filter` for a local-path clone).
//
// The pull request is hostile in the one way that matters here: it commits an executable
// `.husky/post-checkout`, and the reader's checkout points `core.hooksPath` at `.husky` the way
// husky sets it up — relative, so in a worktree of the pull request it names the pull request's
// own file. The hook appends to `HOOK_RAN` under the fixture root; every test that checks out
// the pull request asserts that file never appears.
//
// The fixtures are built with their own neutralized environment, as `git/ops.test.ts` builds
// its own (`cli/fixtures.ts` is the CLI's and outside this project's tsconfig), and with hooks
// off, so a fixture step inside a worktree can never be what writes the marker.

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
  return execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
    cwd,
    encoding: "utf8",
    env: FIXTURE_ENV,
  }).trim();
}

type Result<T> = { ok: true; value: T } | { ok: false; failure: unknown };

function expectOk<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`Expected ok, got ${JSON.stringify(result.failure)}`);
  return result.value;
}

function expectFailure<T>(result: Result<T>): unknown {
  if (result.ok) throw new Error(`Expected a failure, got ${JSON.stringify(result.value)}`);
  return result.failure;
}

/** A map standing in for the app store, like `handlers.test.ts`'s relocations. */
function memoryCheckouts(): CheckoutMemory & { entries: Map<string, string> } {
  const entries = new Map<string, string>();
  return {
    entries,
    get: (target) => entries.get(checkoutKey(target)) ?? null,
    remember: (target, path) => {
      entries.set(checkoutKey(target), path);
    },
    forget: (target) => {
      entries.delete(checkoutKey(target));
    },
  };
}

const runner = createGitRunner();

/** The budget for the hook and the tests that run a dozen or more real git processes each —
 * the default 5s is what the CLI's spawning suites already trip under a loaded parallel run. */
const SLOW_MS = 30_000;

/** Pull request `number` of the fixture repository, spelled the way a reader pastes it. */
function pr(number: number): PullRequest {
  return githubPullRequestOf({ owner: "Acme", repo: "Widget" }, number);
}
const PR_7 = pr(7);

let root: string;
let hub: string;
let user: string;
let forky: string;
let stranger: string;
let worktrees: string;
let hookMarker: string;
let previousGlobalConfig: string | undefined;
let prSha: string;
let mainSha: string;

/** Every ref of a repository outside the app's own `refs/rvw/`, with what it points at. */
function refsOutsideRvw(repo: string): string {
  return git(repo, "for-each-ref", "--format=%(refname) %(objectname)")
    .split("\n")
    .filter((line) => !line.startsWith("refs/rvw/"))
    .join("\n");
}

/** The reader's checkout, as the test leaves it: what must be identical after every step. */
function userState(): Record<string, string> {
  return {
    head: git(user, "rev-parse", "HEAD"),
    branch: git(user, "branch", "--show-current"),
    status: git(user, "status", "--porcelain"),
    uncommitted: readFileSync(join(user, "README.md"), "utf8"),
    untracked: readFileSync(join(user, "notes.txt"), "utf8"),
    refs: refsOutsideRvw(user),
    stash: git(user, "stash", "list", "--format=%H %s"),
  };
}

function depsWith(overrides: Partial<PullRequestDeps> = {}): PullRequestDeps {
  return {
    runner,
    knownRepoPaths: () => Promise.resolve([stranger, user]),
    openRepoPaths: () => [],
    checkouts: memoryCheckouts(),
    worktreesRoot: () => Promise.resolve(worktrees),
    ...overrides,
  };
}

/** Opens pull request `number` on the "GitHub" repository, at the fixture pull request's head. */
function openPullRequest(number: number): void {
  git(hub, "update-ref", `refs/pull/${number}/head`, prSha);
}

/** Force-pushes a new head for a pull request on the "GitHub" repository. */
function pushPullRequest(number: number, file: string): string {
  const seed = join(root, "seed");
  git(seed, "checkout", "-q", "feature");
  writeFileSync(join(seed, file), `${file}\n`);
  git(seed, "add", ".");
  git(seed, "commit", "-q", "-m", `touch ${file}`);
  const sha = git(seed, "rev-parse", "HEAD");
  git(seed, "push", "-q", "--force", hub, `HEAD:refs/pull/${number}/head`);
  git(seed, "checkout", "-q", "main");
  return sha;
}

function request(number: number, repoPath = user, base = "main") {
  return { pullRequest: pr(number), checkout: { repoPath, remote: "origin" }, base };
}

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "reviewer-pr-flow-")));
  hub = join(root, "github", "widget.git");
  worktrees = join(root, "worktrees");
  hookMarker = join(root, "HOOK_RAN");
  mkdirSync(worktrees);

  // The upstream history: main, and a feature branch someone opened a pull request from — one
  // that ships a post-checkout hook.
  const seed = join(root, "seed");
  mkdirSync(seed);
  git(seed, "init", "-q", "-b", "main");
  writeFileSync(join(seed, "README.md"), "widget\n");
  git(seed, "add", ".");
  git(seed, "commit", "-q", "-m", "init");
  git(seed, "checkout", "-q", "-b", "feature");
  writeFileSync(join(seed, "feature.txt"), "feature\n");
  mkdirSync(join(seed, ".husky"));
  writeFileSync(
    join(seed, ".husky", "post-checkout"),
    `#!/bin/sh\necho "PR HOOK RAN in $PWD" >> "${hookMarker}"\n`,
  );
  chmodSync(join(seed, ".husky", "post-checkout"), 0o755);
  git(seed, "add", ".");
  git(seed, "commit", "-q", "-m", "feature");
  prSha = git(seed, "rev-parse", "HEAD");
  git(seed, "checkout", "-q", "main");
  mkdirSync(join(root, "github"));
  git(root, "clone", "-q", "--bare", seed, hub);
  openPullRequest(7);
  git(hub, "config", "uploadpack.allowFilter", "true");
  git(hub, "config", "uploadpack.allowAnySHA1InWant", "true");

  // The config every git the code under test spawns reads: GitHub's addresses, in each
  // spelling the fixtures use, rewritten to the bare repository.
  const config = join(root, "gitconfig");
  writeFileSync(
    config,
    [
      `[url "file://${hub}"]`,
      "\tinsteadOf = git@github.com:Acme/Widget.git",
      "\tinsteadOf = https://github.com/acme/widget.git",
      "\tinsteadOf = https://github.com/Acme/Widget.git",
      // Repository names git refuses as ref components, all served by the same repository.
      "\tinsteadOf = https://github.com/acme/.github.git",
      "\tinsteadOf = https://github.com/acme/x.lock.git",
      "\tinsteadOf = https://github.com/acme/a..b.git",
      "[user]",
      "\tname = Fixture",
      "\temail = fixture@test.local",
      "",
    ].join("\n"),
  );
  previousGlobalConfig = process.env["GIT_CONFIG_GLOBAL"];
  process.env["GIT_CONFIG_GLOBAL"] = config;

  // The reader's checkout: cloned from "GitHub", its origin spelled the ssh way, husky's
  // relative hooks path, on a branch of their own with a commit, a stash, an uncommitted edit
  // and an untracked file.
  user = join(root, "user");
  git(root, "clone", "-q", hub, user);
  git(user, "remote", "set-url", "origin", "git@github.com:Acme/Widget.git");
  git(user, "config", "core.hooksPath", ".husky");
  git(user, "checkout", "-q", "-b", "mine");
  writeFileSync(join(user, "mine.txt"), "mine\n");
  git(user, "add", ".");
  git(user, "commit", "-q", "-m", "mine");
  writeFileSync(join(user, "mine.txt"), "stashed\n");
  git(user, "stash", "-q");
  writeFileSync(join(user, "README.md"), "widget, edited and not committed\n");
  writeFileSync(join(user, "notes.txt"), "untracked notes\n");
  mainSha = git(user, "rev-parse", "origin/main");

  // A fork workflow: origin is the reader's fork, upstream the pull request's repository.
  forky = join(root, "forky");
  git(root, "clone", "-q", hub, forky);
  git(forky, "remote", "set-url", "origin", "https://github.com/someone/widget.git");
  git(forky, "remote", "add", "upstream", "https://github.com/acme/widget.git");

  // A repository the app knows that has nothing to do with this pull request.
  stranger = join(root, "stranger");
  mkdirSync(stranger);
  git(stranger, "init", "-q", "-b", "main");
  git(stranger, "remote", "add", "origin", "https://github.com/other/thing.git");
}, SLOW_MS);

afterAll(() => {
  if (previousGlobalConfig === undefined) {
    delete process.env["GIT_CONFIG_GLOBAL"];
  } else {
    process.env["GIT_CONFIG_GLOBAL"] = previousGlobalConfig;
  }
  rmSync(root, { recursive: true, force: true });
});

describe("worktreeLocation", () => {
  it("lays a pull request out as <owner>/<repo>-<n>, lowercased, and reads it back", () => {
    const path = worktreeLocation(worktrees, PR_7);
    expect(path).toBe(join(worktrees, "acme", "widget-7"));
    expect(pullRequestOfWorktree(worktrees, path)).toEqual({
      host: "github.com",
      owner: "acme",
      repo: "widget",
      number: 7,
    });
  });

  it("keeps owners and repositories with dashes apart", () => {
    const a = worktreeLocation(worktrees, githubPullRequestOf({ owner: "a-b", repo: "c" }, 1));
    const b = worktreeLocation(worktrees, githubPullRequestOf({ owner: "a", repo: "b-c" }, 1));
    expect(a).not.toBe(b);
    expect(pullRequestOfWorktree(worktrees, b)).toMatchObject({ owner: "a", repo: "b-c" });
  });

  it("refuses to read anything outside the root, or not shaped like a worktree, as one", () => {
    expect(pullRequestOfWorktree(worktrees, join(root, "user"))).toBeNull();
    expect(pullRequestOfWorktree(worktrees, join(worktrees, "acme"))).toBeNull();
    expect(pullRequestOfWorktree(worktrees, join(worktrees, "acme", "widget"))).toBeNull();
    expect(pullRequestOfWorktree(worktrees, join(worktrees, "..", "user", "x-1"))).toBeNull();
  });
});

describe("locateCheckout", () => {
  it("finds a known checkout whose remote names the repository, in any spelling and case", async () => {
    const located = expectOk(await locateCheckout(depsWith(), PR_7));
    expect(located).toEqual({
      kind: "found",
      checkout: { repo: { path: user, name: "user" }, remote: "origin" },
      base: { name: "main", from: "remoteHead" },
    });
  });

  it("picks the remote that names the repository, not origin, in a fork", async () => {
    const located = expectOk(
      await locateCheckout(depsWith({ knownRepoPaths: () => Promise.resolve([forky]) }), PR_7),
    );
    expect(located).toMatchObject({ kind: "found", checkout: { remote: "upstream" } });
  });

  it("answers notFound when no known repository matches", async () => {
    const located = expectOk(
      await locateCheckout(depsWith({ knownRepoPaths: () => Promise.resolve([stranger]) }), PR_7),
    );
    expect(located).toEqual({ kind: "notFound" });
  });

  it("prefers the remembered checkout, and forgets one that is wrong rather than unreachable", async () => {
    const checkouts = memoryCheckouts();
    const deps = depsWith({ checkouts });
    checkouts.remember(PR_7, forky);
    expect(expectOk(await locateCheckout(deps, PR_7))).toMatchObject({
      checkout: { repo: { path: forky } },
    });

    // Wrong: a repository whose remotes do not name it, and a directory that is no repository.
    checkouts.remember(PR_7, stranger);
    expect(expectOk(await locateCheckout(deps, PR_7))).toMatchObject({
      checkout: { repo: { path: user } },
    });
    expect(checkouts.entries.size).toBe(0);
    const plain = join(root, "plain-directory");
    mkdirSync(plain);
    checkouts.remember(PR_7, plain);
    expectOk(await locateCheckout(deps, PR_7));
    expect(checkouts.entries.size).toBe(0);

    // Unreachable, not wrong: a directory that is not there (an unmounted volume looks the
    // same), and git itself missing — the memory survives both, and the search still answers.
    const unmounted = join(root, "Volumes", "External", "widget");
    checkouts.remember(PR_7, unmounted);
    expect(expectOk(await locateCheckout(deps, PR_7))).toMatchObject({
      checkout: { repo: { path: user } },
    });
    expect(checkouts.get(PR_7)).toBe(unmounted);
    const noGit = depsWith({
      checkouts,
      runner: createGitRunner({ gitBinary: "/nonexistent/git" }),
    });
    checkouts.remember(PR_7, user);
    expect(expectOk(await locateCheckout(noGit, PR_7))).toEqual({ kind: "notFound" });
    expect(checkouts.get(PR_7)).toBe(user);
  });
});

describe("adoptCheckout", () => {
  it("refuses a located repository with no remote for the pull request, and remembers nothing", async () => {
    const checkouts = memoryCheckouts();
    const result = await adoptCheckout(depsWith({ checkouts }), PR_7, stranger);
    expect(expectFailure(result)).toEqual({ code: "noMatchingRemote", repo: stranger });
    expect(checkouts.entries.size).toBe(0);
  });

  it("remembers a located checkout for the repository's next pull request", async () => {
    const checkouts = memoryCheckouts();
    expectOk(await adoptCheckout(depsWith({ checkouts }), PR_7, join(user, ".")));
    expect(checkouts.entries.get("github.com/acme/widget")).toBe(user);
  });
});

describe("preparePullRequest", () => {
  it(
    "fetches into a worktree, runs no hook, keeps the reader's checkout, and never moves work",
    async () => {
      const before = userState();
      const deps = depsWith();

      const prepared = expectOk(await preparePullRequest(deps, request(7)));
      const path = join(worktrees, "acme", "widget-7");
      expect(prepared).toEqual({
        worktree: path,
        head: prSha,
        base: "origin/main",
        change: "created",
      });
      expect(git(path, "rev-parse", "HEAD")).toBe(prSha);
      expect(git(path, "branch", "--show-current")).toBe("");
      // The ref is namespaced by owner and repository (`pullRequestRef`).
      expect(git(user, "rev-parse", "refs/rvw/pr/acme/widget/7")).toBe(prSha);
      expect(git(user, "rev-parse", "refs/remotes/origin/main")).toBe(mainSha);
      // The pull request's own post-checkout, under the reader's relative hooksPath: not run.
      expect(existsSync(join(path, ".husky", "post-checkout"))).toBe(true);
      expect(existsSync(hookMarker)).toBe(false);
      expect(userState()).toEqual(before);

      // The ref lives in the common git dir: the worktree, the checkout and the app all see it.
      expect(expectOk(await readPullRequestHead(runner, path, PR_7))).toBe(prSha);
      expect(expectOk(await readPullRequestHead(runner, user, PR_7))).toBe(prSha);
      expect(expectOk(await readPullRequestHead(runner, user, pr(70)))).toBeNull();

      // A tab open on the worktree leads back to the checkout, not to the worktree itself.
      expect(
        expectOk(
          await locateCheckout(depsWith({ knownRepoPaths: () => Promise.resolve([path]) }), PR_7),
        ),
      ).toMatchObject({ kind: "found", checkout: { repo: { path: user } } });

      // Again, with nothing new on the remote: the same worktree, not moved.
      expect(expectOk(await preparePullRequest(deps, request(7))).change).toBe("current");

      // A force-push: the clean worktree follows the pull request to its new head — still
      // without running the hook the switch would otherwise fire.
      const pushed = pushPullRequest(7, "second.txt");
      const moved = expectOk(await preparePullRequest(deps, request(7)));
      expect(moved).toMatchObject({ worktree: path, head: pushed, change: "moved" });
      expect(git(path, "rev-parse", "HEAD")).toBe(pushed);
      expect(existsSync(hookMarker)).toBe(false);

      // Each kind of work in the worktree keeps it where it is, while the ref itself moves.
      const third = pushPullRequest(7, "third.txt");
      const refusesToMove = async (reason: string): Promise<void> => {
        expect(expectFailure(await preparePullRequest(deps, request(7)))).toEqual({
          code: "worktreeDirty",
          path,
          reason,
        });
        expect(git(path, "rev-parse", "HEAD")).toBe(pushed);
        expect(git(user, "rev-parse", "refs/rvw/pr/acme/widget/7")).toBe(third);
      };
      // An untracked file.
      writeFileSync(join(path, "agent-notes.md"), "left by the agent\n");
      await refusesToMove("uncommitted");
      expect(readFileSync(join(path, "agent-notes.md"), "utf8")).toBe("left by the agent\n");
      rmSync(join(path, "agent-notes.md"));
      // A tracked modification.
      writeFileSync(join(path, "feature.txt"), "edited\n");
      await refusesToMove("uncommitted");
      git(path, "checkout", "--", "feature.txt");
      // A staged change.
      writeFileSync(join(path, "staged.txt"), "staged\n");
      git(path, "add", "staged.txt");
      await refusesToMove("uncommitted");
      git(path, "rm", "-q", "--cached", "staged.txt");
      rmSync(join(path, "staged.txt"));
      // A commit on the detached HEAD — a clean status, and work all the same.
      writeFileSync(join(path, "fix.txt"), "fix\n");
      git(path, "add", "fix.txt");
      git(path, "commit", "-q", "-m", "agent fix");
      const agentCommit = git(path, "rev-parse", "HEAD");
      expect(git(path, "status", "--porcelain")).toBe("");
      expect(expectFailure(await preparePullRequest(deps, request(7)))).toEqual({
        code: "worktreeDirty",
        path,
        reason: "commits",
      });
      expect(git(path, "rev-parse", "HEAD")).toBe(agentCommit);
      git(path, "switch", "-q", "--detach", pushed);

      // A branch someone switched the worktree to: theirs now, so not moved off it.
      git(path, "switch", "-q", "-c", "readers-branch");
      expect(expectFailure(await preparePullRequest(deps, request(7)))).toEqual({
        code: "worktreeOnBranch",
        path,
        branch: "readers-branch",
      });
      git(path, "switch", "-q", "--detach", pushed);
      git(user, "branch", "-q", "-D", "readers-branch");

      // The directory deleted by hand: the stale registration is cleared and the worktree remade.
      rmSync(path, { recursive: true, force: true });
      const remade = expectOk(await preparePullRequest(deps, request(7)));
      expect(remade).toMatchObject({ head: third, change: "created" });
      expect(git(path, "rev-parse", "HEAD")).toBe(third);

      expect(existsSync(hookMarker)).toBe(false);
      expect(userState()).toEqual(before);
    },
    SLOW_MS,
  );

  it("tells a missing pull request from a missing base", async () => {
    const deps = depsWith();
    expect(expectFailure(await preparePullRequest(deps, request(99)))).toEqual({
      code: "prNotFound",
    });
    expect(expectFailure(await preparePullRequest(deps, request(7, user, "nope")))).toEqual({
      code: "baseNotFound",
      base: "nope",
    });
  });

  it("re-matches the remote it is handed rather than trusting it", async () => {
    const deps = depsWith();
    expect(expectFailure(await preparePullRequest(deps, request(7, forky)))).toEqual({
      code: "noMatchingRemote",
      repo: forky,
    });
    expect(expectFailure(await preparePullRequest(deps, request(7, stranger)))).toEqual({
      code: "noMatchingRemote",
      repo: stranger,
    });
  });

  it("writes nothing over a directory, or a link, it did not make", async () => {
    openPullRequest(8);
    const taken = join(worktrees, "acme", "widget-8");
    mkdirSync(taken, { recursive: true });
    writeFileSync(join(taken, "mine.txt"), "someone's\n");
    expect(expectFailure(await preparePullRequest(depsWith(), request(8)))).toEqual({
      code: "worktreePathTaken",
      path: taken,
    });
    expect(readFileSync(join(taken, "mine.txt"), "utf8")).toBe("someone's\n");
    rmSync(taken, { recursive: true, force: true });

    // A dangling symlink, which `existsSync` would call absent: refused as taken, and said so
    // as a local fact — never "could not talk to the remote".
    symlinkSync(join(root, "nowhere"), taken);
    expect(expectFailure(await preparePullRequest(depsWith(), request(8)))).toEqual({
      code: "worktreePathTaken",
      path: taken,
    });
    rmSync(taken);
  });

  it("never moves the reader's own branches through a mirror-style fetch refspec", async () => {
    // `+refs/heads/*:refs/heads/*` would have the base's fetch force-move the local `main`
    // (git's opportunistic remote-tracking update) — unless the fetch passes `--refmap=`.
    openPullRequest(12);
    const mirror = join(root, "mirror");
    git(root, "clone", "-q", hub, mirror);
    git(mirror, "remote", "set-url", "origin", "git@github.com:Acme/Widget.git");
    git(mirror, "config", "remote.origin.fetch", "+refs/heads/*:refs/heads/*");
    git(mirror, "checkout", "-q", "-b", "work");
    writeFileSync(join(mirror, "local.txt"), "local\n");
    git(mirror, "add", ".");
    git(mirror, "commit", "-q", "-m", "local main");
    const localMain = git(mirror, "rev-parse", "HEAD");
    git(mirror, "branch", "-f", "main", localMain);
    const before = refsOutsideRvw(mirror);

    expectOk(await preparePullRequest(depsWith(), request(12, mirror)));
    expect(git(mirror, "rev-parse", "main")).toBe(localMain);
    expect(refsOutsideRvw(mirror)).toBe(before);
  });

  it("reports a remote that is not there as such", async () => {
    const lost = join(root, "lost");
    git(root, "clone", "-q", hub, lost);
    // No `.git`, so none of the suite's own rewrites (all spelled with it) is a prefix of it,
    // and this checkout's own rewrite sends it to a repository that does not exist.
    git(lost, "remote", "set-url", "origin", "https://github.com/acme/widget");
    git(
      lost,
      "config",
      `url.file://${join(root, "nowhere.git")}.insteadOf`,
      "https://github.com/acme/widget",
    );
    const failure = expectFailure(await preparePullRequest(depsWith(), request(7, lost)));
    expect(failure).toEqual({ code: "git", failure: { code: "remoteNotFound" } });
  });

  it("answers cancelled, and runs nothing, once Cancel has fired", async () => {
    const cancel = new AbortController();
    cancel.abort();
    openPullRequest(13);
    expect(expectFailure(await preparePullRequest(depsWith(), request(13), cancel.signal))).toEqual(
      { code: "cancelled" },
    );
    expect(git(user, "for-each-ref", "refs/rvw/pr/acme/widget/13")).toBe("");
  });
});

describe("removePullRequestWorktree", () => {
  it(
    "refuses what it must not remove, and removes a worktree that holds nothing",
    async () => {
      openPullRequest(9);
      const before = userState();
      const prepared = expectOk(await preparePullRequest(depsWith(), request(9)));
      const path = prepared.worktree;
      const refuses = async (failure: unknown): Promise<void> => {
        expect(expectFailure(await removePullRequestWorktree(depsWith(), path))).toEqual(failure);
        expect(existsSync(path)).toBe(true);
      };

      expect(
        expectFailure(
          await removePullRequestWorktree(depsWith({ openRepoPaths: () => [path] }), path),
        ),
      ).toEqual({ code: "worktreeOpen", path });

      // Untracked, modified, staged, and committed-on-detached-HEAD: each one is kept.
      writeFileSync(join(path, "scratch.txt"), "work\n");
      await refuses({ code: "worktreeDirty", path, reason: "uncommitted" });
      rmSync(join(path, "scratch.txt"));
      writeFileSync(join(path, "feature.txt"), "edited\n");
      await refuses({ code: "worktreeDirty", path, reason: "uncommitted" });
      git(path, "checkout", "--", "feature.txt");
      writeFileSync(join(path, "staged.txt"), "staged\n");
      git(path, "add", "staged.txt");
      await refuses({ code: "worktreeDirty", path, reason: "uncommitted" });
      git(path, "rm", "-q", "--cached", "staged.txt");
      rmSync(join(path, "staged.txt"));
      writeFileSync(join(path, "fix.txt"), "fix\n");
      git(path, "add", "fix.txt");
      git(path, "commit", "-q", "-m", "agent fix");
      await refuses({ code: "worktreeDirty", path, reason: "commits" });
      expect(
        (await listPullRequestWorktrees(runner, worktrees)).find((row) => row.path === path),
      ).toMatchObject({ changes: "commits", branch: null });
      git(path, "switch", "-q", "--detach", prSha);

      // Not one of ours: the reader's checkout, and a link planted where a worktree goes that
      // points at a clean worktree of the reader's elsewhere.
      expect(expectFailure(await removePullRequestWorktree(depsWith(), user))).toEqual({
        code: "notAWorktree",
        path: user,
      });
      const elsewhere = join(root, "readers-own-worktree");
      git(user, "worktree", "add", "-q", "--detach", elsewhere, mainSha);
      const planted = join(worktrees, "acme", "widget-99");
      symlinkSync(elsewhere, planted);
      expect(expectFailure(await removePullRequestWorktree(depsWith(), planted))).toEqual({
        code: "notAWorktree",
        path: planted,
      });
      expect(existsSync(join(elsewhere, "README.md"))).toBe(true);
      expect(
        (await listPullRequestWorktrees(runner, worktrees)).find((row) => row.path === planted),
      ).toMatchObject({ checkout: null });
      rmSync(planted);
      git(user, "worktree", "remove", elsewhere);

      expect(
        (await listPullRequestWorktrees(runner, worktrees)).find((row) => row.path === path),
      ).toEqual({
        path,
        pullRequest: { host: "github.com", owner: "acme", repo: "widget", number: 9 },
        checkout: user,
        head: prSha,
        changes: "none",
        branch: null,
        locked: null,
      });

      // What `rvw emit --pr` writes in the worktree when the agent passes
      // `--base <remote>/<base>`: the worktree as `repo`, and both refs as shas (`cli/range.ts`
      // resolves a detached HEAD and a remote-tracking ref alike).
      const origin = {
        repo: { path, name: "widget-9" },
        base: mainSha,
        head: prSha,
        patch: null,
        reviewedHead: prSha,
        pr: pr(9),
      };
      expect((await checkReviewSource(runner, path, origin)).kind).toBe("live");

      expect(expectOk(await removePullRequestWorktree(depsWith(), path))).toEqual({ path });
      expect(existsSync(path)).toBe(false);
      expect(git(user, "worktree", "list", "--porcelain")).not.toContain(path);
      // The ref stays, so the review written in the worktree relocates to the checkout — the
      // existing Locate Repository… check, unchanged, says it is live there.
      expect(git(user, "rev-parse", "refs/rvw/pr/acme/widget/9")).toBe(prSha);
      expect((await checkReviewSource(runner, path, origin)).kind).toBe("repoMissing");
      expect(await checkReviewSource(runner, user, origin)).toEqual({
        kind: "live",
        repo: { path: user, name: "user" },
      });
      expect(existsSync(hookMarker)).toBe(false);
      expect(userState()).toEqual(before);
    },
    SLOW_MS,
  );

  it(
    "removes a worktree someone switched to a branch, and keeps the branch",
    async () => {
      openPullRequest(10);
      const path = expectOk(await preparePullRequest(depsWith(), request(10))).worktree;
      git(path, "switch", "-q", "-c", "kept-branch");
      expect(
        (await listPullRequestWorktrees(runner, worktrees)).find((row) => row.path === path),
      ).toMatchObject({ changes: "none", branch: "kept-branch" });
      expect(expectOk(await removePullRequestWorktree(depsWith(), path))).toEqual({ path });
      expect(git(user, "rev-parse", "kept-branch")).toBe(prSha);
      git(user, "branch", "-q", "-D", "kept-branch");
    },
    SLOW_MS,
  );
});

describe("a bare repository with worktrees", () => {
  it(
    "is found, adopted, given a worktree and has it removed, all from the bare directory",
    async () => {
      openPullRequest(11);
      const bare = join(root, "layout", "widget.git");
      mkdirSync(join(root, "layout"));
      git(root, "clone", "-q", "--bare", hub, bare);
      git(bare, "remote", "set-url", "origin", "https://github.com/acme/widget.git");
      const own = join(root, "layout", "main");
      git(bare, "worktree", "add", "-q", own, "main");
      const known = depsWith({ knownRepoPaths: () => Promise.resolve([own]) });

      const located = expectOk(await locateCheckout(known, pr(11)));
      expect(located).toMatchObject({
        kind: "found",
        checkout: { repo: { path: bare, name: "widget.git" }, remote: "origin" },
      });
      expect(expectOk(await adoptCheckout(known, pr(11), own))).toEqual(located);

      const prepared = expectOk(await preparePullRequest(known, request(11, bare)));
      expect(git(prepared.worktree, "rev-parse", "HEAD")).toBe(prSha);
      expect(
        (await listPullRequestWorktrees(runner, worktrees)).find(
          (row) => row.path === prepared.worktree,
        ),
      ).toMatchObject({ checkout: bare, changes: "none" });

      expect(expectOk(await removePullRequestWorktree(known, prepared.worktree))).toEqual({
        path: prepared.worktree,
      });
      expect(git(bare, "worktree", "list", "--porcelain")).not.toContain(prepared.worktree);
      expect(existsSync(hookMarker)).toBe(false);
    },
    SLOW_MS,
  );
});

describe("cloneCheckout", () => {
  it(
    "clones a partial copy into the picked folder and adopts it",
    async () => {
      const parent = join(root, "clones");
      mkdirSync(parent);
      const checkouts = memoryCheckouts();
      const located = expectOk(await cloneCheckout(depsWith({ checkouts }), PR_7, parent));
      const clone = join(parent, "Widget");
      expect(located).toMatchObject({
        kind: "found",
        checkout: { repo: { path: clone }, remote: "origin" },
      });
      expect(git(clone, "config", "remote.origin.promisor")).toBe("true");
      expect(checkouts.entries.get("github.com/acme/widget")).toBe(clone);

      expect(expectFailure(await cloneCheckout(depsWith(), PR_7, parent))).toEqual({
        code: "cloneTargetExists",
        path: clone,
      });
      // A directory that was there before is never what a failed clone cleans up.
      expect(existsSync(join(clone, ".git"))).toBe(true);
    },
    SLOW_MS,
  );
});

/** Pushes a *rewritten* head for a pull request — the same tree under a different commit on
 * the old head's parent, what an amend or a rebase force-pushes — so the old head is reachable
 * from nothing on the remote. */
function rewritePullRequest(number: number, oldHead: string): string {
  const seed = join(root, "seed");
  const rewritten = git(
    seed,
    "commit-tree",
    `${oldHead}^{tree}`,
    "-p",
    `${oldHead}^`,
    "-m",
    `rewritten ${number} ${Date.now()}`,
  );
  git(seed, "push", "-q", "--force", hub, `${rewritten}:refs/pull/${number}/head`);
  return rewritten;
}

/** The real runner, with `intercept` given each request first: it may act on it (abort a
 * signal, stand in for git) or return null to let the real git run. */
function interceptingRunner(
  intercept: (request: GitRunRequest) => ReturnType<GitRunner["run"]> | null,
): GitRunner {
  return {
    ...runner,
    run: (spawned) => intercept(spawned) ?? runner.run(spawned),
  };
}

describe("a pull request whose history was rewritten", () => {
  it(
    "is followed by a clean worktree, and its worktree can still be removed",
    async () => {
      const deps = depsWith();
      const first = pushPullRequest(14, "fourteen.txt");
      const path = expectOk(await preparePullRequest(deps, request(14))).worktree;
      expect(git(user, "rev-parse", "refs/rvw/placed/acme/widget/14")).toBe(first);

      // An amend force-pushed: the worktree's head is now reachable only from the placed ref,
      // which is what keeps it from reading as "commits nobody else has".
      const amended = rewritePullRequest(14, first);
      expect(expectOk(await preparePullRequest(deps, request(14)))).toMatchObject({
        head: amended,
        change: "moved",
      });
      expect(git(path, "rev-parse", "HEAD")).toBe(amended);

      // Rewritten again, then removed without being moved: Remove is not refused either.
      rewritePullRequest(14, amended);
      // Fetched straight from the stand-in remote by path: the fixture env has no rewrites.
      git(user, "fetch", "-q", "--refmap=", hub, "+refs/pull/14/head:refs/rvw/pr/acme/widget/14");
      expect(
        (await listPullRequestWorktrees(runner, worktrees)).find((row) => row.path === path),
      ).toMatchObject({ changes: "none" });
      expect(expectOk(await removePullRequestWorktree(deps, path))).toEqual({ path });
      expect(git(user, "for-each-ref", "refs/rvw/placed/acme/widget/14")).toBe("");

      // A commit of the reader's own on top still counts — "commits" means beyond the placed one.
      const again = expectOk(await preparePullRequest(deps, request(14))).worktree;
      writeFileSync(join(again, "mine.txt"), "mine\n");
      git(again, "add", "mine.txt");
      git(again, "commit", "-q", "-m", "reader's own");
      expect(expectFailure(await removePullRequestWorktree(deps, again))).toEqual({
        code: "worktreeDirty",
        path: again,
        reason: "commits",
      });
    },
    SLOW_MS,
  );
});

describe("a checkout that never finished", () => {
  it(
    "is never reported current, moved or removed while git holds it locked",
    async () => {
      openPullRequest(15);
      const deps = depsWith();
      const path = expectOk(await preparePullRequest(deps, request(15))).worktree;
      // What a `worktree add` killed mid-checkout leaves behind.
      git(user, "worktree", "lock", "--reason", "initializing", path);
      const locked = { code: "worktreeLocked", path, checkout: user, reason: "initializing" };

      // Same head as before: the locked tree is not "current".
      expect(expectFailure(await preparePullRequest(deps, request(15)))).toEqual(locked);
      pushPullRequest(15, "fifteen.txt");
      expect(expectFailure(await preparePullRequest(deps, request(15)))).toEqual(locked);
      expect(git(path, "rev-parse", "HEAD")).toBe(prSha);
      expect(expectFailure(await removePullRequestWorktree(deps, path))).toEqual(locked);
      expect(
        (await listPullRequestWorktrees(runner, worktrees)).find((row) => row.path === path),
      ).toMatchObject({ locked: "initializing" });

      git(user, "worktree", "unlock", path);
      expectOk(await removePullRequestWorktree(deps, path));
    },
    SLOW_MS,
  );

  it(
    "lets a checkout under way finish when Cancel fires, rather than leaving it half-made",
    async () => {
      openPullRequest(16);
      const cancel = new AbortController();
      let checkoutSignal: AbortSignal | undefined;
      const deps = depsWith({
        runner: interceptingRunner(({ args, signal }) => {
          // Cancel lands the moment the checkout starts.
          if (args.includes("worktree") && args.includes("add")) {
            checkoutSignal = signal;
            cancel.abort();
          }
          return null;
        }),
      });
      const prepared = expectOk(await preparePullRequest(deps, request(16), cancel.signal));
      expect(prepared.change).toBe("created");
      // The checkout was never handed the signal Cancel fires.
      expect(checkoutSignal).toBeUndefined();
      expect(git(prepared.worktree, "rev-parse", "HEAD")).toBe(prSha);
      expect(git(prepared.worktree, "status", "--porcelain")).toBe("");
      expect(git(user, "worktree", "list", "--porcelain")).not.toContain("locked");
    },
    SLOW_MS,
  );

  it(
    "removes what a cancelled clone left, so the retry is not refused",
    async () => {
      const parent = join(root, "cancelled-clones");
      mkdirSync(parent);
      const target = join(parent, "Widget");
      const deps = depsWith({
        runner: interceptingRunner(({ args }) => {
          if (!args.includes("clone")) {
            return null;
          }
          // A clone stopped partway: its directory begun, git gone.
          mkdirSync(join(target, ".git"), { recursive: true });
          writeFileSync(join(target, "partial"), "half\n");
          return Promise.resolve({ ok: false, failure: { code: "cancelled" } });
        }),
      });
      expect(expectFailure(await cloneCheckout(deps, PR_7, parent))).toEqual({
        code: "cancelled",
      });
      expect(existsSync(target)).toBe(false);
      expectOk(await cloneCheckout(depsWith(), PR_7, parent));
      expect(existsSync(join(target, ".git"))).toBe(true);
    },
    SLOW_MS,
  );
});

describe("two clones into one folder", () => {
  it(
    "are queued, so one's failed cleanup never removes the other's directory",
    async () => {
      const parent = join(root, "racing-clones");
      mkdirSync(parent);
      // The same repository spelled two ways: one directory on a case-insensitive volume, and
      // one queue key either way.
      const lower = githubPullRequestOf({ owner: "acme", repo: "widget" }, 7);
      expect(cloneQueueKey(parent, lower)).toBe(cloneQueueKey(parent, PR_7));

      // The second clone is the real one; it says when its git has finished.
      let secondCloned = (): void => {};
      const secondDone = new Promise<void>((resolve) => {
        secondCloned = resolve;
      });
      const watched = depsWith({
        runner: {
          ...runner,
          run: async (spawned) => {
            const result = await runner.run(spawned);
            if (spawned.args.includes("clone")) secondCloned();
            return result;
          },
        },
      });
      // The first gets as far as making its directory, then fails — the case whose cleanup
      // removes `<parent>/<repo>`. It holds the failure until the second has run to the end, or
      // long enough that it would have, so the overlap is certain rather than up to timing:
      // unqueued, the second clones into this directory and every interleaving loses one of them;
      // queued, the second has not started, and the deadline lets this one go first.
      const failing = depsWith({
        runner: interceptingRunner(({ args }) => {
          if (!args.includes("clone")) {
            return null;
          }
          mkdirSync(join(parent, "Widget", ".git"), { recursive: true });
          const deadline = new Promise((resolve) => {
            setTimeout(resolve, 300);
          });
          return Promise.race([secondDone, deadline]).then(() => ({
            ok: false as const,
            failure: { code: "cancelled" as const },
          }));
        }),
      });
      const exclusive = createKeyedQueue();
      const [first, second] = await Promise.all([
        exclusive([cloneQueueKey(parent, PR_7)], () => cloneCheckout(failing, PR_7, parent)),
        exclusive([cloneQueueKey(parent, lower)], () => cloneCheckout(watched, lower, parent)),
      ]);
      expect(expectFailure(first)).toEqual({ code: "cancelled" });
      const clone = expectOk(second);
      expect(clone.kind).toBe("found");
      if (clone.kind !== "found") return;
      // The second clone ran after the first had cleaned up, and is still there, whole.
      expect(git(clone.checkout.repo.path, "rev-parse", "--is-inside-work-tree")).toBe("true");
      expect(git(clone.checkout.repo.path, "config", "remote.origin.promisor")).toBe("true");
    },
    SLOW_MS,
  );
});

describe("a placed ref that could not be written", () => {
  it(
    "leaves a move reported as the move it was, and is written by the next run",
    async () => {
      const logged = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        openPullRequest(18);
        const deps = depsWith();
        const path = expectOk(await preparePullRequest(deps, request(18))).worktree;
        const placedRef = "refs/rvw/placed/acme/widget/18";
        expect(git(user, "rev-parse", placedRef)).toBe(prSha);

        const pushed = pushPullRequest(18, "eighteen.txt");
        const refusing = depsWith({
          runner: interceptingRunner(({ args }) =>
            args.includes("update-ref") && args.includes(placedRef)
              ? Promise.resolve({
                  ok: false,
                  failure: { code: "exited", exitCode: 128, stderr: "fatal: cannot lock ref" },
                })
              : null,
          ),
        });
        // The switch happened, so the answer is the switch — not a failure that would send the
        // reader to retry it.
        expect(expectOk(await preparePullRequest(refusing, request(18)))).toMatchObject({
          worktree: path,
          head: pushed,
          change: "moved",
        });
        expect(git(path, "rev-parse", "HEAD")).toBe(pushed);
        expect(git(user, "rev-parse", placedRef)).toBe(prSha);
        expect(logged).toHaveBeenCalledWith(
          expect.stringContaining("placed ref"),
          expect.anything(),
        );

        // The next run finds the worktree current and writes the ref it missed.
        expect(expectOk(await preparePullRequest(deps, request(18))).change).toBe("current");
        expect(git(user, "rev-parse", placedRef)).toBe(pushed);
      } finally {
        logged.mockRestore();
      }
    },
    SLOW_MS,
  );
});

describe("repository names git refuses as ref components", () => {
  it(
    "fetch, place, read back and remove for .github, x.lock and a..b",
    async () => {
      const odd = join(root, "odd-names");
      git(root, "clone", "-q", hub, odd);
      git(odd, "remote", "remove", "origin");
      const names = [
        { remote: "dot", repo: ".github", ref: "%2egithub" },
        { remote: "lock", repo: "x.lock", ref: "x%2elock" },
        { remote: "dots", repo: "a..b", ref: "a%2e%2eb" },
      ];
      for (const { remote, repo } of names) {
        git(odd, "remote", "add", remote, `https://github.com/acme/${repo}.git`);
      }
      openPullRequest(17);
      const deps = depsWith({ knownRepoPaths: () => Promise.resolve([odd]) });
      for (const { remote, repo, ref } of names) {
        const target = githubPullRequestOf({ owner: "acme", repo }, 17);
        expect(expectOk(await locateCheckout(deps, target))).toMatchObject({
          checkout: { repo: { path: odd }, remote },
        });
        const prepared = expectOk(
          await preparePullRequest(deps, {
            pullRequest: target,
            checkout: { repoPath: odd, remote },
            base: "main",
          }),
        );
        expect(prepared.worktree).toBe(join(worktrees, "acme", `${repo}-17`));
        expect(git(odd, "rev-parse", `refs/rvw/pr/acme/${ref}/17`)).toBe(prSha);
        expect(git(odd, "rev-parse", `refs/rvw/placed/acme/${ref}/17`)).toBe(prSha);
        expect(expectOk(await readPullRequestHead(runner, prepared.worktree, target))).toBe(prSha);
        expect(
          (await listPullRequestWorktrees(runner, worktrees)).find(
            (row) => row.path === prepared.worktree,
          ),
        ).toMatchObject({ pullRequest: { repo }, checkout: odd, changes: "none" });
        expect(expectOk(await removePullRequestWorktree(deps, prepared.worktree))).toEqual({
          path: prepared.worktree,
        });
      }
    },
    SLOW_MS,
  );
});
