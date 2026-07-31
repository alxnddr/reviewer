import { app, BrowserWindow } from "electron";
import { join } from "node:path";
import { optimizer } from "@electron-toolkit/utils";
import appIcon from "../../build/icon.png?asset";
import { IpcEvent } from "../shared/ipc";
import { crashLogPath, installCrashHandlers } from "./crash";
import { createGitRunner } from "./git/runner";
import { registerIpcHandlers } from "./ipc";
import { installApplicationMenu } from "./menu";
import { reviewPathFromArgv } from "./review/guard";
import { importReviewSessionFromArg } from "./review/handlers";
import { createReviewOpenQueue } from "./review/open-queue";
import { createProgressStore } from "./review/progress";
import { createSessionStore } from "./sessions";
import { flushSessionsThenTerminateGit } from "./shutdown";
import { applyPersistedTheme } from "./theme";
import { createMainWindow, whenPageLoaded } from "./window";

// Pin the product name imperatively so an unpackaged run matches the packaged app
// (electron-builder's `productName`). Without it Electron falls back to package.json `name`
// ("reviewer"), so the menu bar, notifications, and the userData directory would all read
// lowercase and diverge from prod. Set before the single-instance lock so the lock and the
// session store key off "Reviewer". (The dock *tooltip* still reads "Electron" in dev — that
// is the Electron.app bundle's own identity, and only becomes "Reviewer" once packaged.)
app.setName("Reviewer");

// Before anything that can throw, including the lock: from here on an escaped throw or
// rejection is logged where it can be retrieved instead of vanishing. `crashLogPath` reads
// `app.getPath`, which is why this sits below `setName` and not above it.
installCrashHandlers(crashLogPath());

if (app.requestSingleInstanceLock()) {
  const gitRunner = createGitRunner();
  const sessionStore = createSessionStore();
  // Beside the sessions store, in userData, for the same reason it is: this is the app's own
  // record of its reader, not the CLI's output — `~/.rvw/reviews` belongs to `rvw emit`, and
  // the app writing progress into it would make two programs owners of one directory.
  // `app.getPath` is only legal after `setName` above, which is why it is read here and not
  // at module scope.
  const progressStore = createProgressStore(join(app.getPath("userData"), "progress"));

  // macOS delivers a launch-by-file through `open-file` (dock drop / Finder
  // double-click), which can fire before `ready` on a cold start; the queue owns
  // the import → reveal ordering and the pre-ready buffering.
  const openQueue = createReviewOpenQueue({
    importSession: (absolutePath) =>
      importReviewSessionFromArg(gitRunner, sessionStore, progressStore, absolutePath),
    hasWindow: () => BrowserWindow.getAllWindows().length > 0,
    createWindow: () => {
      createMainWindow();
    },
    focusWindow: () => {
      const existing = BrowserWindow.getAllWindows()[0];
      if (existing !== undefined) {
        if (existing.isMinimized()) existing.restore();
        existing.focus();
      }
    },
    whenWindowReady: async () => {
      // The window exists from the moment `createMainWindow` returns, but its page does not:
      // a `send` before the load finishes is dropped without a trace. On a cold start the
      // import can win that race, so the push waits here for the page it is meant for.
      const target = BrowserWindow.getAllWindows()[0];
      if (target !== undefined) {
        await whenPageLoaded(target);
      }
    },
    notifySessionsChanged: () => {
      for (const window of BrowserWindow.getAllWindows()) {
        window.webContents.send(IpcEvent.sessionsChanged);
      }
    },
  });

  app.on("open-file", (event, filePath) => {
    // Denying the default keeps Electron from routing the path anywhere else; we
    // own delivery from here.
    event.preventDefault();
    openQueue.enqueue(filePath);
  });

  app.on("second-instance", (_event, argv, workingDirectory) => {
    // `reviewer path/to/x.reviewer.json` against a running app: resolve the arg
    // against the caller's cwd (guaranteed after `ready`), import, and re-list.
    const reviewPath = reviewPathFromArgv(argv, workingDirectory);
    if (reviewPath !== null) {
      openQueue.enqueue(reviewPath);
      return;
    }
    // No file arg — a plain relaunch is a focus request (macOS keeps the app
    // alive with zero windows; `open -n` / direct exec lands here, not `activate`).
    const existing = BrowserWindow.getAllWindows()[0];
    if (existing) {
      if (existing.isMinimized()) existing.restore();
      existing.focus();
    } else {
      createMainWindow();
    }
  });

  // Graceful shutdown: the pending session write lands before git children are
  // torn down.
  app.on("will-quit", () => {
    flushSessionsThenTerminateGit(sessionStore, gitRunner);
  });

  void app.whenReady().then(() => {
    app.on("browser-window-created", (_, window) => {
      optimizer.watchWindowShortcuts(window);
    });

    // macOS shows the dock icon, not the window icon (window.ts). A packaged app takes it from
    // the bundle's icon.icns, but an unpackaged run (`bun dev`, `electron-vite preview`) is the
    // bare Electron binary and would otherwise show Electron's default — set it explicitly so
    // dev matches the shipped icon. Harmless where the bundle already provides one.
    if (process.platform === "darwin") {
      app.dock?.setIcon(appIcon);
    }

    // The native About panel (macOS "About Reviewer", the Windows/Linux role) — named and
    // versioned from the app rather than showing Electron's defaults in an unpackaged run.
    app.setAboutPanelOptions({
      applicationName: "Reviewer",
      applicationVersion: app.getVersion(),
    });

    applyPersistedTheme();
    installApplicationMenu();
    registerIpcHandlers(gitRunner, sessionStore, progressStore);

    // A first-instance launch-by-file (`reviewer x.reviewer.json` cold start)
    // arrives on argv; queue it behind any `open-file` paths that landed early.
    const firstInstancePath = reviewPathFromArgv(process.argv, process.cwd());
    if (firstInstancePath !== null) {
      openQueue.enqueue(firstInstancePath);
    }

    createMainWindow();
    // Now the window exists, drain: each queued path imports then re-lists it.
    openQueue.markReady();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createMainWindow();
      }
    });
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
      app.quit();
    }
  });
} else {
  app.quit();
}
