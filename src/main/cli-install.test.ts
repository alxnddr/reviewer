import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// What is under test is *how* the install steps reach the OS, not the install landing: every
// spawn the module makes is mocked, so nothing here writes to /usr/local/bin or asks for a
// password. `homedir` is mocked with it — the shadowing scan reads the real one otherwise, and
// a machine with an `rvw` already in ~/.local/bin would have the suite chasing its own launcher.
const mocks = vi.hoisted(() => ({
  home: "",
  appPath: "",
  calls: [] as { bin: string; argv: readonly string[] }[],
  /** When set, everything but the admin prompt fails — i.e. /usr/local/bin is not writable. */
  refuseUnprivileged: false,
}));

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  execFile: (bin: string, argv: readonly string[], done: (error: Error | null) => void) => {
    mocks.calls.push({ bin, argv });
    const elevated = bin.endsWith("osascript");
    done(mocks.refuseUnprivileged && !elevated ? new Error("Permission denied") : null);
  },
}));
vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:os")>()),
  homedir: () => mocks.home,
}));
vi.mock("electron", () => ({
  app: { isPackaged: false, getAppPath: () => mocks.appPath },
  BrowserWindow: { getFocusedWindow: () => null },
  dialog: { showMessageBox: vi.fn().mockResolvedValue({}) },
}));

const { cliStatus, installCli } = await import("./cli-install");

let root = "";

/** A home directory with the app checked out inside it, named by the caller: the apostrophe
 * cases hand in a name that a naively quoted shell string would end an argument on. */
function makeHome(name: string): void {
  mocks.home = join(root, name);
  mocks.appPath = join(mocks.home, "Reviewer");
  mkdirSync(join(mocks.appPath, "dist"), { recursive: true });
  writeFileSync(
    join(mocks.appPath, "dist", "rvw.js"),
    `process.stdout.write("bundle " + process.argv.slice(2).join(" "));\n`,
  );
}

/** Somebody else's `rvw`, earlier on the PATH than /usr/local/bin. This is the one privileged
 * command whose target sits under the home directory, so it is the one an apostrophe there
 * can break — and the one the install has to still recognise as its own afterwards. */
function plantRival(): string {
  const rival = join(mocks.home, ".local", "bin", "rvw");
  mkdirSync(dirname(rival), { recursive: true });
  writeFileSync(rival, "#!/bin/sh\necho some other rvw\n");
  return rival;
}

/** The file the install stages and then copies into place, as named to the copy. */
function stagedShim(): string {
  const copy = mocks.calls.find((call) => call.bin.endsWith("/cp"));
  return copy?.argv[1] ?? "";
}

/** The command an admin prompt was asked to run, back out of its AppleScript string literal.
 * One left-to-right pass undoes both escapes AppleScript needs (`\\` and `\"`). */
function elevatedScripts(): string[] {
  return mocks.calls
    .filter((call) => call.bin.endsWith("osascript"))
    .map((call) =>
      /^do shell script "(.*)" with administrator privileges$/su.exec(call.argv[1] ?? ""),
    )
    .map((match) => (match?.[1] ?? "").replaceAll(/\\(.)/gsu, "$1"));
}

/** Carry out the admin prompt's own command against the test's home directory — the same shell
 * it would have used, minus the privileges. The spawns are mocked, so this is what actually
 * puts the shim on disk. Picked out by the test root rather than by the rival's path: the rival
 * is in the script *quoted*, apostrophe and all, which is the thing under test. */
function runElevatedForReal(): void {
  const script = elevatedScripts().find((candidate) => candidate.includes(root));
  expect(script).toBeDefined();
  execFileSync("/bin/sh", ["-c", script ?? ""]);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "reviewer-cli-install-"));
  mocks.calls = [];
  mocks.refuseUnprivileged = false;
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  // The staging directory is the one thing the install leaves outside `root`: it is written
  // under the real $TMPDIR, and the copy that would normally consume it never ran here.
  const staged = stagedShim();
  if (staged) {
    rmSync(dirname(staged), { recursive: true, force: true });
  }
});

describe("installing the rvw launcher", () => {
  it("hands each step to the OS as argv, with no shell to re-read the paths", async () => {
    makeHome("plain");

    await installCli();

    expect(mocks.calls.slice(0, 3)).toEqual([
      { bin: "/bin/mkdir", argv: ["-p", "/usr/local/bin"] },
      { bin: "/bin/cp", argv: ["-f", stagedShim(), "/usr/local/bin/rvw"] },
      { bin: "/bin/chmod", argv: ["755", "/usr/local/bin/rvw"] },
    ]);
    for (const call of mocks.calls) {
      expect(call.argv).not.toContain("-c");
    }
  });

  it("stages a shim a real shell runs, from a home directory with an apostrophe in it", async () => {
    makeHome("O'Brien");

    await installCli();

    const output = execFileSync("/bin/sh", [stagedShim(), "hello"], { encoding: "utf8" });
    expect(output).toBe("bundle hello");
  });

  it("quotes the admin prompt's command so the shell reads the paths back whole", async () => {
    makeHome("O'Brien");
    const rival = plantRival();
    mocks.refuseUnprivileged = true;

    await installCli();
    runElevatedForReal();

    expect(readFileSync(rival, "utf8")).toBe(readFileSync(stagedShim(), "utf8"));
  });

  it("knows its own shim again once installed, so a second run has nothing to take over", async () => {
    makeHome("O'Brien");
    plantRival();
    mocks.refuseUnprivileged = true;

    await installCli();
    runElevatedForReal();

    // The shim names the bundle the way a shell reads it, not the way `join` spells it: an
    // apostrophe is `'\''` in there. Matching the raw path instead would have the app calling
    // the launcher it just wrote a rival, and every later run copying over itself for ever.
    expect(cliStatus().shadowedBy).toBeNull();
  });
});
