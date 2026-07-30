import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { parseSettings, readSettings, writeSettings, type Settings } from "./settings";
import { configureAppStore } from "./store";

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));

let tempDirs: string[] = [];

/** A settings directory pointed at by the shared app store, as a fresh install would be. */
function makeStoreDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "reviewer-settings-"));
  tempDirs.push(dir);
  configureAppStore({ directory: dir });
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs) {
    // Restored first: the read-only-filesystem test leaves its directory unwritable.
    chmodSync(dir, 0o700);
    rmSync(dir, { recursive: true, force: true });
  }
  tempDirs = [];
  configureAppStore();
});

function settingsPath(dir: string): string {
  return join(dir, "settings.json");
}

function readFile(dir: string): Record<string, unknown> {
  return JSON.parse(readFileSync(settingsPath(dir), "utf8")) as Record<string, unknown>;
}

function writeFile(dir: string, contents: string): void {
  writeFileSync(settingsPath(dir), contents);
}

/** A relaunch: the process is gone, so the in-memory copy goes with it and the next read has to
 * come off disk. */
function restart(dir: string): void {
  configureAppStore({ directory: dir });
}

describe("parseSettings", () => {
  it("parses a valid settings file", () => {
    expect(parseSettings({ theme: "dracula" })).toEqual({ theme: "dracula" });
  });

  it("leaves the theme unset when the field is missing", () => {
    expect(parseSettings({})).toEqual({});
  });

  it("falls back to defaults on a shape that is not a settings object", () => {
    expect(parseSettings(null)).toEqual({});
    expect(parseSettings("dracula")).toEqual({});
  });

  it("carries the first-run flag, and leaves it unset when absent", () => {
    expect(parseSettings({ onboarded: true })).toEqual({ onboarded: true });
    // Unset is the meaningful state — it is what "never launched this before" looks like.
    expect(parseSettings({ theme: "dracula" })).toEqual({ theme: "dracula" });
  });

  it("falls back to an unset theme on an unknown or removed value", () => {
    expect(parseSettings({ theme: "solarized" })).toEqual({});
    // "system" was the removed follow-the-OS mode.
    expect(parseSettings({ theme: "system" })).toEqual({});
  });

  it("ignores keys another owner put in the same file", () => {
    expect(parseSettings({ theme: "nord", window: { width: 1280 } })).toEqual({ theme: "nord" });
  });
});

describe("readSettings / writeSettings", () => {
  it("round-trips the theme and the first-run flag across a restart", () => {
    const dir = makeStoreDir();
    writeSettings({ theme: "dracula", onboarded: true });

    restart(dir);
    expect(readSettings()).toEqual({ theme: "dracula", onboarded: true });
  });

  it("adopts a settings.json written by the pre-store build", () => {
    const dir = makeStoreDir();
    // Byte-for-byte what the old hand-rolled writer left behind: top-level keys, indented.
    writeFile(dir, `${JSON.stringify({ theme: "nord", onboarded: true }, null, 2)}\n`);

    expect(readSettings()).toEqual({ theme: "nord", onboarded: true });

    // And the next write keeps the rest of it rather than resetting the reader's preferences.
    writeSettings({ ...readSettings(), theme: "dracula" });
    restart(dir);
    expect(readSettings()).toEqual({ theme: "dracula", onboarded: true });
  });

  it("starts from defaults on a corrupt file, and repairs it on the next write", () => {
    const dir = makeStoreDir();
    writeFile(dir, '{"theme":"dra');

    expect(readSettings()).toEqual({});

    writeSettings({ theme: "nord" });
    restart(dir);
    expect(readSettings()).toEqual({ theme: "nord" });
    expect(readFile(dir)).toEqual({ theme: "nord" });
  });

  it("creates the settings directory when it does not exist yet", () => {
    const dir = join(makeStoreDir(), "nested", "userData");
    configureAppStore({ directory: dir });

    expect(readSettings()).toEqual({});

    writeSettings({ onboarded: true });
    restart(dir);
    expect(readSettings()).toEqual({ onboarded: true });
  });

  it("keeps the choice in memory when the filesystem refuses the write", () => {
    if (process.getuid?.() === 0) {
      // root writes to a read-only directory anyway, so there is nothing to observe.
      return;
    }
    const dir = makeStoreDir();
    writeSettings({ theme: "nord" });
    chmodSync(dir, 0o500);

    // Applying wins over persisting: the write fails loudly for the caller to log, but the
    // process keeps answering with what the user just chose.
    expect(() => writeSettings({ theme: "dracula", onboarded: true })).toThrow();
    expect(readSettings()).toEqual({ theme: "dracula", onboarded: true });

    // Disk still holds the last write that landed, and the next one that can land does.
    chmodSync(dir, 0o700);
    expect(readFile(dir)).toEqual({ theme: "nord" });
    writeSettings(readSettings());
    restart(dir);
    expect(readSettings()).toEqual({ theme: "dracula", onboarded: true });
  });

  it("reads the file once and answers later calls from memory", () => {
    const dir = makeStoreDir();
    writeSettings({ theme: "dracula" });
    expect(readSettings()).toEqual({ theme: "dracula" });

    // theme.ts calls through on every window creation and every theme:get; none of them may
    // touch the disk again, which is only observable by changing the disk underneath.
    writeFile(dir, JSON.stringify({ theme: "nord" }));
    expect(readSettings()).toEqual({ theme: "dracula" });

    // The rewrite really did land — the assertion above is about the cache, not a no-op write.
    restart(dir);
    expect(readSettings()).toEqual({ theme: "nord" });
  });

  it("carries through keys owned by another part of the app", () => {
    const dir = makeStoreDir();
    // What task 060's window state will look like sitting in the same file.
    writeFile(dir, JSON.stringify({ theme: "nord", window: { width: 1440, maximized: true } }));

    writeSettings({ ...readSettings(), onboarded: true });

    expect(readFile(dir)).toEqual({
      theme: "nord",
      onboarded: true,
      window: { width: 1440, maximized: true },
    });
  });

  it("drops a preference that the written value no longer carries", () => {
    const dir = makeStoreDir();
    writeSettings({ theme: "nord", onboarded: true });

    writeSettings({ theme: "nord" });

    expect(readFile(dir)).toEqual({ theme: "nord" });
  });
});

// Durability, exercised against real processes rather than a mocked filesystem: the failure this
// task exists to remove is a truncate-then-write interrupted partway, which only shows up when
// something interrupts a write for real. A padded value widens the window: a truncate-then-write
// leaves the file incomplete for as long as it takes to lay a megabyte down — long enough that a
// reader lands in it — while a temp-file-plus-rename writer is indivisible at any size.
const PADDING = "x".repeat(1024 * 1024);

/** Hammers `writeSettings` in a tight loop. It writes once before announcing itself, so the file
 * exists by the time the parent starts killing and sampling. */
function writerScript(dir: string): string {
  return [
    `import { configureAppStore } from ${JSON.stringify(join(MODULE_DIR, "store.ts"))};`,
    `import { writeSettings } from ${JSON.stringify(join(MODULE_DIR, "settings.ts"))};`,
    `configureAppStore({ directory: ${JSON.stringify(dir)} });`,
    `const themes = ["dracula", "nord"];`,
    `let n = 0;`,
    `writeSettings({ theme: "dracula", onboarded: true });`,
    `process.stdout.write("ready\\n");`,
    `for (;;) {`,
    `  writeSettings({ theme: themes[n++ % themes.length], onboarded: true });`,
    `}`,
  ].join("\n");
}

type Writer = { process: ChildProcess; failure: () => string };

async function startWriter(dir: string, index: number): Promise<Writer> {
  const script = join(dir, `writer-${index}.ts`);
  writeFileSync(script, writerScript(dir));
  // Run under bun: the writer imports the module under test directly, so what is being killed is
  // this codebase's write path and not a re-spelling of it. (`cli/bundle.setup.ts` already makes
  // bun a requirement of the suite.)
  const child = spawn("bun", [script], { stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    stderr += chunk;
  });
  await new Promise<void>((resolve, reject) => {
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      if (chunk.includes("ready")) {
        resolve();
      }
    });
    child.on("exit", () =>
      reject(new Error(`settings writer died before its first write:\n${stderr}`)),
    );
    child.on("error", reject);
  });
  return { process: child, failure: () => `settings writer died mid-run:\n${stderr}` };
}

/** The writers are the only thing putting the file under stress, so a sampling loop that ran
 * against a writer which had already died would assert nothing. Their stderr is captured rather
 * than discarded so that failure names itself. */
async function expectStillWriting(writer: Writer): Promise<void> {
  // One turn of the event loop first: the sampling loop above it is synchronous, so a child that
  // exited during it has not been reaped yet and `exitCode` would still read as null.
  await delay(0);
  expect(writer.process.exitCode, writer.failure()).toBeNull();
}

function kill({ process: child }: Writer): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    // Already gone: `exit` has fired and will not fire again, so waiting for it would hang until
    // the test's own timeout rather than reporting whatever killed it.
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    child.on("exit", () => resolve());
    child.kill("SIGKILL");
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** The file as a reader would find it after a crash: complete JSON, the settings intact, and the
 * bytes another owner put there still whole. */
function expectIntact(dir: string): void {
  const raw = readFileSync(settingsPath(dir), "utf8");
  let parsed: unknown;
  expect(() => {
    parsed = JSON.parse(raw);
  }, `settings.json was left unparseable (${raw.length} bytes)`).not.toThrow();
  const settings: Settings = parseSettings(parsed);
  expect(settings.onboarded).toBe(true);
  expect(settings.theme === "dracula" || settings.theme === "nord").toBe(true);
  expect((parsed as Record<string, unknown>).padding).toBe(PADDING);
}

describe("settings durability", () => {
  it("replaces the file instead of truncating it in place", () => {
    const dir = makeStoreDir();
    writeSettings({ theme: "nord" });
    const first = statSync(settingsPath(dir)).ino;

    writeSettings({ theme: "dracula" });

    // The signature of a temp-file-plus-rename: a new inode is moved over the old one, so the
    // path a crash or a concurrent reader looks at is never a half-filled file. An in-place
    // truncate-then-write — what this replaced — keeps the same inode across both writes.
    expect(statSync(settingsPath(dir)).ino).not.toBe(first);
  });

  it("survives a SIGKILL landing mid-write", async () => {
    const dir = makeStoreDir();
    writeFile(dir, JSON.stringify({ padding: PADDING }));

    for (let attempt = 0; attempt < 6; attempt++) {
      const writer = await startWriter(dir, attempt);
      // Read the way the next launch would, over and over while the writer runs: every instant of
      // the file, mid-write included, has to be a whole one.
      const deadline = Date.now() + 100;
      while (Date.now() < deadline) {
        expectIntact(dir);
      }
      await expectStillWriting(writer);
      await kill(writer);
      // And the state the kill froze it in is the one the next launch gets.
      expectIntact(dir);
    }
  }, 30_000);

  it("stays readable while several processes write it at once", async () => {
    const dir = makeStoreDir();
    writeFile(dir, JSON.stringify({ padding: PADDING }));

    const writers = await Promise.all([0, 1, 2].map((index) => startWriter(dir, index)));
    try {
      // Sampled from a fourth process's point of view — the app's own next launch reading the
      // file while the previous instance is still writing it.
      for (let sample = 0; sample < 40; sample++) {
        expectIntact(dir);
        await delay(5);
      }
      for (const writer of writers) {
        await expectStillWriting(writer);
      }
    } finally {
      await Promise.all(writers.map((writer) => kill(writer)));
    }
    expectIntact(dir);
  }, 30_000);
});
