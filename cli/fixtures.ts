import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { MAX_PATCH_BYTES } from "../src/shared/git-diff";

// The harness for the CLI suites that must run `rvw` the way an agent does: as the
// distributed bundle, under `node`, from a git repo that is not this checkout and has no
// `node_modules` anywhere above it. Two suites need it — `portability.test.ts` (the bundle
// resolves nothing from the repo it reviews) and `exit-gate.test.ts` (the whole authoring loop
// composed in a foreign repo) — so the build-install-spawn harness lives here once rather than
// being copied into each. Test-support only; nothing in `cli/index.ts`'s import graph reaches
// it, so it is never bundled.

// `fileURLToPath`, not `new URL(...).pathname` — the latter is not a filesystem path (it keeps
// percent-escapes, and on Windows yields `/C:/…`), the same reason `cli/skills.ts` resolves its
// root that way.
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** A git repo the CLI is driven against: two commits, no dependencies, isolated from the
 * developer's git config. `path` is also the root to remove when the suite ends. */
export type ForeignRepo = { readonly path: string; readonly base: string; readonly head: string };

/** The bundle as an agent receives it: `dist/rvw.js` under a throwaway install root that
 * carries its skills and nothing else. `root` is the directory to remove when done. */
export type InstalledCli = { readonly root: string; readonly bundle: string };

/** One `rvw` invocation's outcome. The streams stay separate because the exit-code contract
 * is only half the claim — a refusal must also put its locator on **stderr** and leave stdout
 * free of a report nobody computed. */
export type RvwResult = {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
};

// Fixture repos are built with the developer's git config neutralized: a global
// `diff.noprefix` or a rename-detection setting would otherwise decide what the patch looks
// like, and the capture must pin the wire format itself.
const FIXTURE_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "Fixture",
  GIT_AUTHOR_EMAIL: "fixture@test.local",
  GIT_COMMITTER_NAME: "Fixture",
  GIT_COMMITTER_EMAIL: "fixture@test.local",
};

function git(cwd: string, ...args: readonly string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", env: FIXTURE_ENV });
  if (result.status !== 0) {
    throw new Error(`fixture git ${args.join(" ")} failed: ${result.stderr}`);
  }
  return result.stdout;
}

/** `mkdtemp` under macOS's `/var/folders` symlink; the real path is what `git rev-parse
 * --show-toplevel` reports, so a fixture that compares against the artifact's `repo` must
 * resolve it here rather than assert on a path git will never print. */
function tempRoot(prefix: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

function write(root: string, path: string, contents: string | Uint8Array): void {
  const file = join(root, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, contents);
}

/** Install the distributed bundle — with its skills — into a throwaway root that has no
 * `node_modules` above it. If `rvw` silently resolved `@pierre/diffs` from Reviewer's own
 * `node_modules`, this copy would break, which is exactly the regression it guards. The
 * `<root>/dist/rvw.js` + `<root>/skills` layout is the one `rvw skills` resolves
 * against, so it is preserved rather than flattened. `dist/package.json` travels with
 * the bundle: it is what declares the ESM the bundle is written in, so an install without it
 * would only run on a Node new enough to guess. That this install synthesizes the layout is
 * why `portability.test.ts` also reads `electron-builder.yml` — a manifest copied here and not
 * into the packaged app is the drift a green suite once hid.
 *
 * Copy only: `cli/bundle.setup.ts` built `dist/rvw.js` before any worker started, so nothing is
 * writing it while suites running in parallel read it. */
export function installBundle(): InstalledCli {
  const root = tempRoot("rvw-install-");
  mkdirSync(join(root, "dist"));
  for (const artifact of ["rvw.js", "package.json"]) {
    const source = join(REPO_ROOT, "dist", artifact);
    if (!existsSync(source)) {
      throw new Error(`${source} is missing — cli/bundle.setup.ts should have built it`);
    }
    cpSync(source, join(root, "dist", artifact));
  }
  cpSync(join(REPO_ROOT, "skills"), join(root, "skills"), {
    recursive: true,
  });
  return { root, bundle: join(root, "dist", "rvw.js") };
}

/** Invoke the installed bundle under **Node** from inside the foreign repo — the interpreter
 * an agent's machine has, and the one that catches the shebang regression (`bun build` stamps
 * a `#!/usr/bin/env bun` entrypoint bun-only, and the bundle then throws inside Stricli's
 * router under Node). The repo's own path is the cwd, so an omitted `--repo` means what an
 * agent means. `stdin` is what makes the piped-draft path testable at all: `rvw emit` reads fd
 * 0, which only a real child process has. */
export function rvw(
  cli: InstalledCli,
  repo: ForeignRepo,
  args: readonly string[],
  stdin?: string,
): RvwResult {
  const result = spawnSync("node", [cli.bundle, ...args], {
    cwd: repo.path,
    encoding: "utf8",
    // The same cap the CLI's own git runner uses, not `spawnSync`'s 1 MB default: a suite that
    // proves a multi-megabyte patch reaches the pipe intact must be able to *read* it, and the
    // default would kill the child with ENOBUFS and report the truncation as the harness's.
    maxBuffer: MAX_PATCH_BYTES,
    ...(stdin === undefined ? {} : { input: stdin }),
  });
  return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

/** Stamp a two-commit history over whatever `writeHead` changes, and return both endpoints as
 * full shas. Shas rather than branch names because a test that names its endpoints exactly is
 * a test whose assertions cannot be satisfied by the wrong commit; the *defaults* are what
 * `emit.test.ts` and `live-range.test.ts` drive against a two-branch fixture. */
function commitPair(root: string, writeHead: (root: string) => void): ForeignRepo {
  git(root, "add", "-A");
  git(root, "commit", "-qm", "base");
  const base = git(root, "rev-parse", "HEAD").trim();

  writeHead(root);
  git(root, "add", "-A");
  git(root, "commit", "-qm", "head");
  const head = git(root, "rev-parse", "HEAD").trim();

  return { path: root, base, head };
}

function initRepo(prefix: string): string {
  const root = tempRoot(prefix);
  git(root, "init", "-q", "-b", "main", ".");
  return root;
}

/** The smallest foreign repo that still has both sides of a diff: one file, one rewritten line
 * and one appended line. Enough to prove the bundle runs and captures a real range. */
export function minimalRepo(): ForeignRepo {
  const root = initRepo("rvw-foreign-");
  write(root, "a.txt", "one\ntwo\nthree\n");
  return commitPair(root, (head) => write(head, "a.txt", "one\nTWO\nthree\nfour\n"));
}

// The oversized fixture: a range whose diff is measured in megabytes, so a suite can assert
// that all of stdout survives the pipe. Size is the entire point — macOS's pipe buffer is 64 KB
// and stdout-to-a-pipe is asynchronous, so a patch that fits in the buffer proves nothing about
// whether the entrypoint flushes what it wrote (see cli/index.ts).
//
// Every *other* line is rewritten rather than a contiguous block, and that shape is load-bearing
// too: it yields one changed span per changed line instead of one span for the whole file, so
// `rvw check --coverage --json` — the other verb that can outgrow the buffer — has a report worth
// megabytes to print rather than four lines.
const BULK_LINES = 20_000;
const BULK_PADDING = "x".repeat(48);

function bulkContents(rewritten: boolean): string {
  const lines = Array.from({ length: BULK_LINES }, (_, index) => {
    const marker = rewritten && index % 2 === 0 ? "changed " : "";
    return `line ${index + 1} ${marker}${BULK_PADDING}`;
  });
  return `${lines.join("\n")}\n`;
}

/** The coverable changed-line count of `bulkyRepo`'s range — half the file's lines, counted on
 * both the deletion and the addition side, so `BULK_LINES / 2 * 2`. Exported so a suite can
 * assert a coverage report arrived *whole* rather than as a prefix that happened to parse. */
export const BULK_COVERABLE_LINES = BULK_LINES;

/** A foreign repo whose `base...head` patch is well past 1 MB: one file, half its lines
 * rewritten. `bulk.txt` is text (a binary blob would be non-coverable and produce no patch body
 * at all), and there is only one file because what is being measured is bytes on stdout, not
 * the classification of a change. */
export function bulkyRepo(): ForeignRepo {
  const root = initRepo("rvw-bulky-");
  write(root, "bulk.txt", bulkContents(false));
  return commitPair(root, (head) => write(head, "bulk.txt", bulkContents(true)));
}

// The exit-gate fixture: a change shaped like a real one, so the gate exercises every
// classification it needs rather than a happy two-liner.
//
//   assets/logo.png    binary      — non-coverable, and never reported as a gap
//   docs/CHANGELOG.md  additions   — the file easy to forget: the coverage gap the gate catches
//   src/engine.ts      two hunks   — a multi-hunk file, both sides, far apart
//   src/new-name.ts    pure rename — non-coverable (100% similarity: content untouched)
//   src/util.ts        one hunk    — a second coverable file, so "covered" is not one file's luck
//
// Eight coverable changed lines in total. The line numbers are asserted, not assumed: every
// anchor the gate authors is checked to fall inside a span `rvw diff --json` actually printed.
const ENGINE_BASE = Array.from({ length: 20 }, (_, index) => `l${index + 1}`).join("\n");
const ENGINE_HEAD = ENGINE_BASE.replace("l2\n", "l2 changed\n").replace("l18\n", "l18 changed\n");
const PNG_BASE = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);
const PNG_HEAD = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xfe]);

/** The multi-file, multi-hunk foreign repo the exit gate walks: a coverage gap to find, two
 * non-coverable files to report honestly, and enough real line numbers that an anchor must be
 * read rather than guessed. */
export function walkthroughRepo(): ForeignRepo {
  const root = initRepo("rvw-walkthrough-");
  write(root, "assets/logo.png", PNG_BASE);
  write(root, "docs/CHANGELOG.md", "# Changelog\n");
  write(root, "src/engine.ts", `${ENGINE_BASE}\n`);
  write(root, "src/old-name.ts", "moved\ncontent\n");
  write(root, "src/util.ts", "u1\nu2\nu3\n");

  return commitPair(root, (head) => {
    write(head, "assets/logo.png", PNG_HEAD);
    write(head, "docs/CHANGELOG.md", "# Changelog\n\n- the forgotten line\n");
    write(head, "src/engine.ts", `${ENGINE_HEAD}\n`);
    write(head, "src/util.ts", "u1\nu2 changed\nu3\n");
    git(head, "mv", "src/old-name.ts", "src/new-name.ts");
  });
}
