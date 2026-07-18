import { app, BrowserWindow, dialog, type MessageBoxOptions } from "electron";
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

export async function installCliCommand(): Promise<void> {
  const cli = bundledCliPath();
  if (!existsSync(cli)) {
    await show({
      type: "error",
      message: "Command-line tool not found",
      detail: app.isPackaged
        ? "The bundled rvw CLI is missing from this build."
        : "Build it first in development: bun run build:cli.",
    });
    return;
  }

  const staged = join(mkdtempSync(join(tmpdir(), "rvw-install-")), "rvw");
  writeFileSync(staged, shimScript(cli), { mode: 0o755 });
  const installed = await runPrivileged(
    `mkdir -p '${INSTALL_DIR}' && cp -f '${staged}' '${LINK_PATH}' && chmod 755 '${LINK_PATH}'`,
  );

  await show(
    installed
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
