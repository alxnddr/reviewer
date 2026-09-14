import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { minimalRepo, REPO_ROOT } from "./fixtures";

// `rvw` for a machine without Reviewer.app, end to end: `scripts/pack-cli.mjs` packs the tarball a
// release attaches, `scripts/install-cli.sh` installs it into a throwaway `$HOME`, and every verb
// below runs through the launcher that install wrote — never the bundle directly. That chain is
// what a Linux box gets, so it is what is driven; `portability.test.ts` already proves the bundle
// itself runs outside the checkout.
//
// The installer runs under `sh`, which is dash on the Linux CI runner: the shell a box is likely to
// have, and one that rejects the bashisms macOS's bash-backed `sh` lets through, so the check lane
// is where a non-POSIX edit to the script fails.
//
// Every home directory has an apostrophe in it. The launcher names its bundle as a single-quoted
// shell word, and a naively quoted path ends that word early — the case
// `src/main/cli-install.test.ts` pins for the macOS launcher.

const INSTALLER = join(REPO_ROOT, "scripts", "install-cli.sh");
const { version } = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as {
  version: string;
};

let root = "";
let tarball = "";
let homes = 0;

type Home = {
  readonly home: string;
  readonly dataRoot: string;
  readonly bundle: string;
  readonly shim: string;
};

function freshHome(): Home {
  homes += 1;
  const home = join(root, `it's home ${homes}`);
  mkdirSync(home);
  const dataRoot = join(home, ".local", "share", "rvw");
  return {
    home,
    dataRoot,
    bundle: join(dataRoot, version, "cli", "rvw.js"),
    shim: join(home, ".local", "bin", "rvw"),
  };
}

/** The environment a box's login shell would hand both the installer and `rvw`: its own `HOME`,
 * a PATH with node on it and without that home's `~/.local/bin`, and a temp dir inside the suite's
 * root so nothing is left in the real one. */
function envFor(home: Home): NodeJS.ProcessEnv {
  return { PATH: process.env.PATH ?? "", HOME: home.home, TMPDIR: root };
}

function install(home: Home, ...args: readonly string[]): SpawnSyncReturns<string> {
  return spawnSync("sh", [INSTALLER, ...args], { env: envFor(home), encoding: "utf8" });
}

/** Runs the installed launcher by its path, the way a shell that found it on PATH would. */
function launch(
  home: Home,
  cwd: string,
  args: readonly string[],
  input?: string,
): SpawnSyncReturns<string> {
  return spawnSync(home.shim, args, {
    cwd,
    env: envFor(home),
    encoding: "utf8",
    ...(input === undefined ? {} : { input }),
  });
}

beforeAll(() => {
  // Resolved, because node reports the bundle's path with symlinks resolved and macOS's temp dir
  // is one (/var → /private/var): `--version` is asserted against a path built from this root.
  root = realpathSync(mkdtempSync(join(tmpdir(), "rvw-linux-")));
  // Packed from the dist/ build `cli/bundle.setup.ts` finished before any worker started, into
  // this suite's own root — never into dist/, which other suites are reading.
  const packed = spawnSync(
    "node",
    [join(REPO_ROOT, "scripts", "pack-cli.mjs"), join(root, "out")],
    {
      encoding: "utf8",
    },
  );
  expect(packed.status, packed.stderr).toBe(0);
  tarball = packed.stdout.trim();
}, 60_000);

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("the release tarball", () => {
  it("is named for the version and unpacks into the app's extraResources layout, and nothing else", () => {
    expect(basename(tarball)).toBe(`rvw-${version}-any.tar.gz`);
    const listed = spawnSync("tar", ["-tzf", tarball], { encoding: "utf8" });
    expect(listed.status, listed.stderr).toBe(0);
    const entries = listed.stdout.split("\n").filter((entry) => entry !== "");

    // The three things `bundledSkillsRoot` and the manifest need, where they need them.
    expect(entries).toContain("cli/rvw.js");
    expect(entries).toContain("cli/package.json");
    expect(entries).toContain("skills/present-review/SKILL.md");
    expect([...new Set(entries.map((entry) => entry.split("/")[0]))].toSorted()).toEqual([
      "cli",
      "skills",
    ]);
    // bsdtar's AppleDouble sidecars, which a pack on a Mac would otherwise ship into skills/.
    expect(entries.filter((entry) => basename(entry).startsWith("._"))).toEqual([]);
  });
});

describe("install-cli.sh", () => {
  it("installs a launcher that runs every verb an agent needs, from a foreign repo", () => {
    const home = freshHome();
    const installed = install(home, tarball);
    expect(installed.status, installed.stderr).toBe(0);
    // The home's bin dir is not on this PATH, and a reader who is not told so has an `rvw` that
    // their shell cannot find.
    expect(installed.stdout).toContain("is not on your PATH");

    const repo = minimalRepo();
    try {
      const reported = launch(home, repo.path, ["--version"]);
      expect(reported.status, reported.stderr).toBe(0);
      expect(reported.stdout.trim()).toBe(`${version} (${home.bundle})`);

      const skills = launch(home, repo.path, ["skills", "--json"]);
      expect(skills.status, skills.stderr).toBe(0);
      const listed = JSON.parse(skills.stdout) as { name: string; path: string }[];
      expect(listed.map((skill) => skill.name)).toContain("present-review");
      for (const skill of listed) {
        expect(skill.path.startsWith(join(home.dataRoot, version, "skills"))).toBe(true);
      }

      const schema = launch(home, repo.path, ["schema", "--json"]);
      expect(schema.status, schema.stderr).toBe(0);
      expect(JSON.parse(schema.stdout)).toMatchObject({ title: ".reviewer.json" });

      const out = join(repo.path, "change.reviewer.json");
      const draft = JSON.stringify({
        comments: [{ file: "a.txt", side: "additions", startLine: 2, endLine: 2, body: "why" }],
        layers: [
          {
            label: "All",
            summary: "the change",
            ranges: [
              { file: "a.txt", side: "additions", startLine: 2, endLine: 4 },
              { file: "a.txt", side: "deletions", startLine: 2, endLine: 2 },
            ],
          },
        ],
      });
      const emitted = launch(
        home,
        repo.path,
        ["emit", "--base", repo.base, "--embed-patch", "--no-open", "--out", out],
        draft,
      );
      expect(emitted.status, `${emitted.stdout}${emitted.stderr}`).toBe(0);
      const artifact = JSON.parse(readFileSync(out, "utf8")) as { patch?: unknown };
      expect(typeof artifact.patch).toBe("string");
    } finally {
      rmSync(repo.path, { recursive: true, force: true });
    }
  });

  it("reinstalls in place and prunes the versions the launcher no longer names", () => {
    const home = freshHome();
    expect(install(home, tarball).status).toBe(0);
    mkdirSync(join(home.dataRoot, "0.0.1", "cli"), { recursive: true });

    const again = install(home, tarball);
    expect(again.status, again.stderr).toBe(0);
    // Its own launcher is recognised as its own, apostrophe and all, so nothing claims a rival.
    expect(again.stdout).not.toContain("had not written");
    expect(readdirSync(home.dataRoot)).toEqual([version]);
    expect(launch(home, home.home, ["--version"]).status).toBe(0);
  });

  it("refuses a tarball that is not an rvw release, and installs nothing", () => {
    const home = freshHome();
    const source = join(root, `not-rvw-${homes}`);
    mkdirSync(source);
    writeFileSync(join(source, "hello.txt"), "hello\n");
    const bogus = join(root, `not-rvw-${homes}.tar.gz`);
    expect(spawnSync("tar", ["-czf", bogus, "-C", source, "hello.txt"]).status).toBe(0);

    const refused = install(home, bogus);
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain("is not an rvw release");
    expect(existsSync(home.shim)).toBe(false);
    // The staging directory went with the failure rather than lingering beside future installs.
    expect(readdirSync(home.dataRoot)).toEqual([]);
  });

  it("--uninstall removes the launcher and every installed version, and a second one is a no-op", () => {
    const home = freshHome();
    expect(install(home, tarball).status).toBe(0);

    const removed = install(home, "--uninstall");
    expect(removed.status, removed.stderr).toBe(0);
    expect(existsSync(home.shim)).toBe(false);
    expect(existsSync(home.dataRoot)).toBe(false);

    const again = install(home, "--uninstall");
    expect(again.status, again.stderr).toBe(0);
    expect(again.stdout).toContain("nothing to remove");
  });

  it("--uninstall leaves an rvw it did not write alone", () => {
    const home = freshHome();
    mkdirSync(join(home.home, ".local", "bin"), { recursive: true });
    writeFileSync(home.shim, "#!/bin/sh\necho some other rvw\n", { mode: 0o755 });

    const result = install(home, "--uninstall");
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain("not a launcher this script wrote");
    expect(readFileSync(home.shim, "utf8")).toContain("some other rvw");
  });

  it("writes a launcher that removes itself once its bundle is gone", () => {
    const home = freshHome();
    expect(install(home, tarball).status).toBe(0);
    rmSync(home.dataRoot, { recursive: true, force: true });

    const stale = launch(home, home.home, ["--version"]);
    expect(stale.status).toBe(127);
    expect(stale.stderr).toContain("removed stale launcher");
    expect(existsSync(home.shim)).toBe(false);
  });

  it("rejects a malformed invocation with exit 2, before touching anything", () => {
    const home = freshHome();
    for (const args of [
      ["--frobnicate"],
      [tarball, "--version", "1.0.0"],
      ["--uninstall", tarball],
      ["--version"],
    ]) {
      const result = install(home, ...args);
      expect(result.status, args.join(" ")).toBe(2);
    }
    expect(existsSync(join(home.home, ".local"))).toBe(false);
  });
});
