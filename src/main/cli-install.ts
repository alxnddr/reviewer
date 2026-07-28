import { app, BrowserWindow, dialog, type MessageBoxOptions } from "electron";
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { CliInstallResult, CliStatus } from "../shared/cli";

const INSTALL_DIR = "/usr/local/bin";
const LINK_PATH = `${INSTALL_DIR}/rvw`;

/** The rvw bundle shipped inside the app (electron-builder extraResources), or the
 * dev build under dist/ when running unpackaged. */
function bundledCliPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, "cli", "rvw.js")
    : join(app.getAppPath(), "dist", "rvw.js");
}

/** A launcher that runs the app-bundled CLI and deletes itself the first time it is
 * invoked after the app is gone — so trashing Reviewer.app leaves no stray command. */
function shimScript(cliPath: string): string {
  return [
    "#!/bin/sh",
    `RVW='${cliPath}'`,
    'if [ ! -f "$RVW" ]; then',
    '  rm -f "$0" 2>/dev/null',
    '  echo "rvw: Reviewer.app is gone — removed stale launcher." >&2',
    "  exit 127",
    "fi",
    'exec node "$RVW" "$@"',
    "",
  ].join("\n");
}

function runPlain(command: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile("/bin/sh", ["-c", command], (error) => resolve(error === null));
  });
}

/** One admin prompt (Touch ID / password) via AppleScript, as Xcode and VS Code do. */
function runElevated(command: string): Promise<boolean> {
  const escaped = command.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return new Promise((resolve) => {
    execFile(
      "osascript",
      ["-e", `do shell script "${escaped}" with administrator privileges`],
      (error) => resolve(error === null),
    );
  });
}

/** Try as the user first; only prompt for admin when /usr/local/bin is not writable
 * (the common case on Apple Silicon and fresh installs). */
async function runPrivileged(command: string): Promise<boolean> {
  return (await runPlain(command)) || runElevated(command);
}

function show(options: MessageBoxOptions): Promise<unknown> {
  const window = BrowserWindow.getFocusedWindow();
  return window ? dialog.showMessageBox(window, options) : dialog.showMessageBox(options);
}

/** Directories a shell searches before /usr/local/bin on a normal macOS setup. Not read from
 * the environment on purpose: a GUI app's `PATH` is launchd's, not the one the reader's
 * terminal uses, so asking `process.env.PATH` would answer confidently about the wrong shell.
 * These three are where a stray `rvw` actually ends up. */
function shadowDirs(): string[] {
  return [join(homedir(), ".local", "bin"), join(homedir(), "bin"), "/opt/homebrew/bin"];
}

/** Every rival launcher on the box: a file named `rvw` in one of those directories that is
 * not already ours.
 *
 * Our own shim copied or linked into one of them is not a rival — it runs the same bundle —
 * so a candidate naming the bundle we install is skipped, which is also what makes the
 * takeover below idempotent. A candidate we cannot read counts: an unreadable `rvw` earlier
 * on the path answers the agent exactly as well as a readable one. */
function shadowingPaths(): string[] {
  const ours = bundledCliPath();
  return shadowDirs()
    .map((dir) => join(dir, "rvw"))
    .filter((candidate) => {
      if (!existsSync(candidate)) {
        return false;
      }
      try {
        return !readFileSync(candidate, "utf8").includes(ours);
      } catch {
        return true;
      }
    });
}

/** What the app can say about the launcher without touching it. Read fresh on every call —
 * `rvw` can arrive or leave from a terminal while the app is open, and a cached answer would
 * have the first-run guide asking someone to install what they just installed. */
export function cliStatus(): CliStatus {
  return {
    // The launcher is a /usr/local/bin shim invoked from a POSIX shell; nothing here has a
    // Windows equivalent yet, so the guide states the manual `node …/rvw.js` route instead
    // of offering a button that cannot work.
    supported: process.platform === "darwin",
    installed: existsSync(LINK_PATH),
    path: LINK_PATH,
    // The first one only: the reader is being told a fact about their PATH, not handed an
    // inventory, and the button that resolves it resolves all of them at once.
    shadowedBy: shadowingPaths()[0]?.replace(homedir(), "~") ?? null,
  };
}

/** Write the launcher, then report where that left things. Shows no dialog of its own —
 * the caller (a menu item, or the first-run guide) owns how the outcome is told, and the
 * guide's own status line says it better in place than a modal over it would. */
export async function installCli(): Promise<CliInstallResult> {
  const cli = bundledCliPath();
  if (!existsSync(cli)) {
    return { status: cliStatus(), problem: "missingBundle" };
  }

  try {
    const staged = join(mkdtempSync(join(tmpdir(), "rvw-install-")), "rvw");
    writeFileSync(staged, shimScript(cli), { mode: 0o755 });
    await runPrivileged(
      `mkdir -p '${INSTALL_DIR}' && cp -f '${staged}' '${LINK_PATH}' && chmod 755 '${LINK_PATH}'`,
    );
    // Then take over every launcher that would have answered first. Installing has to mean
    // "`rvw` now runs this app", full stop — writing one file and leaving a stale shim from
    // some earlier setup to win the PATH is the failure this whole check exists to catch,
    // and telling the reader to go delete a file themselves is not a fix, it is homework.
    //
    // Overwritten rather than deleted: something put an `rvw` at that path and may expect one
    // there, and ours is a two-line shim that runs the current bundle and removes itself when
    // the app is gone. Both paths then point at the same place, so the PATH order stops
    // mattering — and a second run finds nothing left to do.
    for (const rival of shadowingPaths()) {
      await runPrivileged(`cp -f '${staged}' '${rival}' && chmod 755 '${rival}'`);
    }
  } catch {
    // Staging failed (no writable tmp, …) — same outcome for the reader as a refused
    // /usr/local/bin, and the status below is still the honest answer.
  }

  // Disk decides, not the shell's exit code: a cancelled admin prompt and a failed copy
  // are the same "still not there", and a launcher that is there is installed.
  const status = cliStatus();
  return { status, problem: status.installed ? null : "writeFailed" };
}

export async function installCliCommand(): Promise<void> {
  const { status, problem } = await installCli();
  if (problem === "missingBundle") {
    await show({
      type: "error",
      message: "Command-line tool not found",
      detail: app.isPackaged
        ? "The bundled rvw CLI is missing from this build."
        : "Build it first in development: bun run build:cli.",
    });
    return;
  }

  await show(
    status.installed
      ? {
          type: "info",
          message: "rvw installed",
          detail: `Run \`rvw\` from your terminal (${LINK_PATH}). It follows app updates, and removes itself if you delete Reviewer.`,
        }
      : {
          type: "error",
          message: "Could not install rvw",
          detail: `Writing ${LINK_PATH} failed or was cancelled.`,
        },
  );
}

export async function uninstallCliCommand(): Promise<void> {
  if (!existsSync(LINK_PATH)) {
    await show({
      type: "info",
      message: "rvw is not installed",
      detail: `Nothing to remove at ${LINK_PATH}.`,
    });
    return;
  }

  const removed = await runPrivileged(`rm -f '${LINK_PATH}'`);
  await show(
    removed
      ? { type: "info", message: "rvw removed", detail: `Deleted ${LINK_PATH}.` }
      : {
          type: "error",
          message: "Could not remove rvw",
          detail: `Deleting ${LINK_PATH} failed or was cancelled.`,
        },
  );
}
