import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// The handlers are invoked directly rather than through `process.emit`: emitting a real
// uncaughtException inside a test runner is caught by the runner's own listener and reported
// as a failure, and what matters here is what our listener writes, not who else hears it.
const electron = vi.hoisted(() => ({
  logsDir: "/logs",
  showErrorBox: vi.fn(),
}));
vi.mock("electron", () => ({
  app: { getPath: (name: string) => (name === "logs" ? electron.logsDir : "/unused") },
  dialog: { showErrorBox: electron.showErrorBox },
  default: {},
}));

import { crashLogPath, installCrashHandlers } from "./crash";

type ProcessListener = (...args: unknown[]) => void;
type CrashEvent = "uncaughtException" | "unhandledRejection";

let tempDirs: string[] = [];
let installed: [CrashEvent, ProcessListener][] = [];

function makeLogFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "reviewer-crash-"));
  tempDirs.push(dir);
  // Inside a directory that does not exist yet — the log path's parent is created on demand,
  // exactly as it will be on a first run.
  return join(dir, "logs", "main-crash.log");
}

/** Install, then hand back the two listeners that were added, so a crash can be delivered to
 * them without emitting a process-wide event. */
function installAndCapture(logFile: string): {
  uncaught: (error: unknown) => void;
  rejection: (reason: unknown) => void;
} {
  const beforeUncaught = new Set<unknown>(process.listeners("uncaughtException"));
  const beforeRejection = new Set<unknown>(process.listeners("unhandledRejection"));
  installCrashHandlers(logFile);
  const uncaught = process
    .listeners("uncaughtException")
    .filter((listener) => !beforeUncaught.has(listener)) as ProcessListener[];
  const rejection = process
    .listeners("unhandledRejection")
    .filter((listener) => !beforeRejection.has(listener)) as ProcessListener[];
  expect(uncaught).toHaveLength(1);
  expect(rejection).toHaveLength(1);
  const [uncaughtListener] = uncaught;
  const [rejectionListener] = rejection;
  if (uncaughtListener === undefined || rejectionListener === undefined) {
    throw new Error("crash handlers were not installed");
  }
  installed.push(
    ["uncaughtException", uncaughtListener],
    ["unhandledRejection", rejectionListener],
  );
  return {
    uncaught: (error) => uncaughtListener(error, "uncaughtException"),
    rejection: (reason) =>
      rejectionListener(
        reason,
        Promise.reject(reason).catch(() => {}),
      ),
  };
}

afterEach(() => {
  for (const [event, listener] of installed) {
    process.off(event, listener);
  }
  installed = [];
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tempDirs = [];
  electron.showErrorBox.mockClear();
  vi.restoreAllMocks();
});

describe("installCrashHandlers", () => {
  it("writes an escaped throw to the log with its stack", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const logFile = makeLogFile();
    const handlers = installAndCapture(logFile);

    handlers.uncaught(new Error("resolved theme is not in the curated set"));

    const log = readFileSync(logFile, "utf8");
    expect(log).toContain("uncaughtException");
    expect(log).toContain("resolved theme is not in the curated set");
    // The stack, not just the message — the whole point is being able to find the thrower.
    expect(log).toContain("crash.test.ts");
  });

  it("logs an unhandled rejection, including one with a non-Error reason", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const logFile = makeLogFile();
    const handlers = installAndCapture(logFile);

    handlers.rejection("nope");

    const log = readFileSync(logFile, "utf8");
    expect(log).toContain("unhandledRejection");
    expect(log).toContain("nope");
  });

  it("appends every crash but shows only the first dialog", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const logFile = makeLogFile();
    const handlers = installAndCapture(logFile);

    handlers.rejection(new Error("first"));
    handlers.rejection(new Error("second"));
    handlers.uncaught(new Error("third"));

    const log = readFileSync(logFile, "utf8");
    expect(log).toContain("first");
    expect(log).toContain("second");
    expect(log).toContain("third");
    expect(electron.showErrorBox).toHaveBeenCalledTimes(1);
    expect(electron.showErrorBox.mock.calls[0]?.[1]).toContain(logFile);
  });

  it("survives a log file it cannot write, without throwing from the handler", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    // A path whose parent cannot be created: `mkdir -p` under a regular file fails.
    const dir = mkdtempSync(join(tmpdir(), "reviewer-crash-"));
    tempDirs.push(dir);
    const blocked = join(dir, "logs");
    writeFileSync(blocked, "not a directory");
    const handlers = installAndCapture(join(blocked, "main-crash.log"));

    expect(() => handlers.uncaught(new Error("boom"))).not.toThrow();
    expect(consoleError).toHaveBeenCalledWith(
      "Crash record could not be written:",
      expect.anything(),
    );
  });
});

describe("crashLogPath", () => {
  it("names one file inside the platform log directory", () => {
    expect(crashLogPath()).toBe(join("/logs", "main-crash.log"));
  });
});
