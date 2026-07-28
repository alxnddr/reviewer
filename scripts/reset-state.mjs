import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Puts this machine back to a first launch, so the onboarding path can be tested the way a
// new user meets it: `bun run reset`, or `bun run dev:fresh` to reset and start in one go.
//
// Three pieces of state decide what that path looks like, and testing the guide means
// clearing all three — a leftover in any one of them silently changes the screen you get:
//
//   the first-run flag   in settings.json; set once the guide is finished or skipped, and
//                        the reason it never opens again
//   the open tabs        in sessions.json; a restored session outranks the guide, which
//                        waits behind it, so a stale tab means an app that looks unchanged
//   the rvw launcher     at /usr/local/bin/rvw; while it is there, step two opens already
//                        satisfied and the missing-CLI banner has nothing to say
//
// The theme is deliberately not touched: it is a preference the reader chose, not first-run
// state, and having it snap back to the default on every reset is its own small annoyance.

const KEEP_TABS = process.argv.includes("--keep-tabs");
const KEEP_CLI = process.argv.includes("--keep-cli");
const FORCE = process.argv.includes("--force");

const LINK_PATH = "/usr/local/bin/rvw";

/** Electron's userData directory for this app — the same path `app.getPath("userData")`
 * resolves to, which is keyed off `app.setName("Reviewer")` in src/main/index.ts. */
function userDataDir() {
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "Reviewer");
  }
  if (process.platform === "win32") {
    return join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "Reviewer");
  }
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "Reviewer");
}

/** True when something that looks like this app is running. Resetting underneath a live
 * window is the one way this script can appear to do nothing: main holds both files in
 * memory and writes them back on change and on quit, so the reset would be undone by the
 * app you were about to test. Advisory only — `--force` runs anyway. */
function appIsRunning() {
  if (process.platform === "win32") {
    return false;
  }
  for (const pattern of [
    "Reviewer.app/Contents/MacOS/Reviewer",
    "node_modules/electron/dist/Electron.app",
    "node_modules/electron/dist/electron",
  ]) {
    try {
      execFileSync("pgrep", ["-f", pattern], { stdio: "ignore" });
      return true;
    } catch {
      // pgrep exits 1 with no match, which is the answer rather than a failure.
    }
  }
  return false;
}

const done = [];
const skipped = [];

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/** Clears the flag but keeps the file: the theme lives beside it. */
function resetFirstRunFlag(dir) {
  const path = join(dir, "settings.json");
  const settings = readJson(path);
  if (settings === null) {
    skipped.push("guide — no settings file yet, so it already opens on launch");
    return;
  }
  if (settings.onboarded === undefined) {
    skipped.push("guide — already unseen");
    return;
  }
  delete settings.onboarded;
  writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`);
  done.push("guide — will open again on the next launch");
}

/** Empties the tab strip. The old file is kept beside it rather than deleted: this is the
 * one piece of state a reset can destroy that the reader might want back, and restoring it
 * is `mv sessions.json.bak sessions.json`. */
function resetSessions(dir) {
  const path = join(dir, "sessions.json");
  const sessions = readJson(path);
  if (sessions === null) {
    skipped.push("tabs — none stored");
    return;
  }
  const count = Array.isArray(sessions.sessions) ? sessions.sessions.length : 0;
  if (count === 0 && sessions.activeSessionId === null) {
    skipped.push("tabs — already empty");
    return;
  }
  copyFileSync(path, `${path}.bak`);
  // The store's own shape, minus the sessions: keeping `version` means the next launch reads
  // this as an empty store of the current schema rather than salvaging an unversioned one.
  writeFileSync(
    path,
    `${JSON.stringify({ ...sessions, sessions: [], activeSessionId: null }, null, 2)}\n`,
  );
  done.push(`tabs — cleared ${count} (kept a copy at sessions.json.bak)`);
}

/** Removes the launcher, escalating only if it has to: /usr/local/bin is writable without a
 * password on plenty of machines, and the ones where it is not get one sudo prompt on the
 * terminal this was run from. Mirrors how the app installs it. */
function removeCli() {
  if (!existsSync(LINK_PATH)) {
    skipped.push("rvw — not installed");
    return;
  }
  try {
    rmSync(LINK_PATH);
  } catch {
    console.log(`Removing ${LINK_PATH} needs an admin password.`);
    try {
      execFileSync("sudo", ["rm", "-f", LINK_PATH], { stdio: "inherit" });
    } catch {
      // Cancelled or refused — reported below, not thrown: the rest of the reset stands.
    }
  }
  if (existsSync(LINK_PATH)) {
    skipped.push(`rvw — still at ${LINK_PATH}; remove it with: sudo rm ${LINK_PATH}`);
  } else {
    done.push(`rvw — removed ${LINK_PATH}`);
  }
}

if (appIsRunning() && !FORCE) {
  console.error(
    [
      "Reviewer looks like it is still running.",
      "",
      "Quit it first — a live app holds this state in memory and writes it back on quit, so",
      "the reset would be undone by the very window you were about to test in.",
      "",
      "Run with --force to reset anyway.",
    ].join("\n"),
  );
  process.exit(1);
}

const dir = userDataDir();
resetFirstRunFlag(dir);
if (KEEP_TABS) {
  skipped.push("tabs — kept (--keep-tabs)");
} else {
  resetSessions(dir);
}
if (KEEP_CLI) {
  skipped.push("rvw — kept (--keep-cli)");
} else {
  removeCli();
}

console.log(`\nReset for a first launch — ${dir}`);
for (const line of done) {
  console.log(`  ✓ ${line}`);
}
for (const line of skipped) {
  console.log(`  · ${line}`);
}
console.log("\nNext: bun run dev\n");
