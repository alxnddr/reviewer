import { app, dialog } from "electron";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { inspect } from "node:util";

// The floor under the main process. Everywhere else failure is handled where it happens — a
// failed write is logged and swallowed, a bad path answers null — but a throw that escapes
// to the top has nowhere to report itself: `whenReady().then(…)` in index.ts turns one into
// an unhandled rejection, and `getWindowBackground` throws by design when a persisted theme
// id is not in the curated set, from inside `createMainWindow`.
//
// Electron does show its own "A JavaScript error occurred in the main process" box for
// these, but it stands down the moment anything else listens (it checks `listenerCount > 1`),
// and it leaves nothing a reader can send back: an unpackaged run's stderr goes to the
// terminal nobody kept, a packaged one's goes nowhere at all. So this owns both halves — the
// retrievable file *and* the dialog Electron would have shown.

const CRASH_LOG_NAME = "main-crash.log";

type CrashKind = "uncaughtException" | "unhandledRejection";

/** The crash log's home: the platform log directory (`~/Library/Logs/Reviewer` on macOS,
 * `userData/logs` elsewhere) — where a reader, or someone told to go look, already expects
 * to find one. Only legal after `app.setName`, like every other `getPath` call. */
export function crashLogPath(): string {
  return join(app.getPath("logs"), CRASH_LOG_NAME);
}

/** A stack when there is one, otherwise the value itself — `Promise.reject("nope")` is legal
 * and its text is the only thing there is to log. `inspect` rather than `String` so an
 * object reason reads as its contents instead of `[object Object]`, and because it cannot
 * itself throw on a hostile `toString`. */
function describeCrash(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ?? `${error.name}: ${error.message}`;
  }
  return inspect(error, { depth: 3 });
}

/** Append one record, newest last. Best-effort: a crash log that throws while logging a
 * crash would replace the diagnosis with a second, worse one. Also echoed to stderr, so a
 * `bun dev` run still reports in the terminal where everything else in main does. */
function recordCrash(logFile: string, kind: CrashKind, error: unknown): void {
  const detail = describeCrash(error);
  console.error(`${kind}:`, error);
  try {
    mkdirSync(dirname(logFile), { recursive: true });
    appendFileSync(logFile, `\n[${new Date().toISOString()}] ${kind}\n${detail}\n`, "utf8");
  } catch (writeError) {
    console.error("Crash record could not be written:", writeError);
  }
}

/** Install the two top-level handlers. Call as early as possible — before the single-instance
 * lock, so a throw during setup is covered too.
 *
 * Neither kind quits the app: Electron's own default does not either, and the crash this was
 * written for (a window that failed to create) leaves an app whose menu still works and whose
 * reader can quit it themselves, having read the dialog. Exiting would take that dialog off
 * the screen along with the app. */
export function installCrashHandlers(logFile: string): void {
  // The first crash only. A rejection loop would otherwise stack one modal per iteration,
  // and every one of them is already in the file.
  let announced = false;

  const handle = (kind: CrashKind, error: unknown): void => {
    recordCrash(logFile, kind, error);
    if (announced) {
      return;
    }
    announced = true;
    dialog.showErrorBox(
      "Reviewer hit an unexpected error",
      `${kind}\n\n${describeCrash(error)}\n\nWritten to ${logFile}.`,
    );
  };

  process.on("uncaughtException", (error) => {
    handle("uncaughtException", error);
  });
  process.on("unhandledRejection", (reason) => {
    handle("unhandledRejection", reason);
  });
}
