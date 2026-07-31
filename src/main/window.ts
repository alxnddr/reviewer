import { BrowserWindow, nativeTheme, type WebContents } from "electron";
import { join } from "node:path";
import { is } from "@electron-toolkit/utils";
import appIcon from "../../build/icon.png?asset";
import { openExternalUrl } from "./external-links";
import { getWindowBackground } from "./theme";
import { MIN_WINDOW_SIZE, restoreWindowPlacement, trackWindowState } from "./window-state";

/** Whose page has finished loading. Recorded here, where the listener is attached before the
 * load is even started, rather than inferred later from `isLoading()` — which is false both
 * before navigation begins and after it ends, and cannot tell a caller which. */
const loadedContents = new WeakSet<WebContents>();

/** Resolves once `window` can receive a `webContents.send`: before its page has loaded, a
 * send is silently dropped, and main has exactly one push to deliver on a cold start (a CLI
 * review's `sessionsChanged`) that can be ready before the page is.
 *
 * A failed load and a closed window resolve too. The send they were holding is lost either
 * way, and a caller left waiting on a page that will never arrive is a hang. */
export function whenPageLoaded(window: BrowserWindow): Promise<void> {
  if (loadedContents.has(window.webContents)) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    // Whichever arrives first wins and takes the other two down with it — the window
    // outlives this wait, and a listener left on it would too.
    const settle = (): void => {
      window.webContents.off("did-finish-load", onLoaded);
      window.webContents.off("did-fail-load", onFailed);
      window.off("closed", settle);
      resolve();
    };
    const onLoaded = (): void => {
      settle();
    };
    // A sub-resource that 404s is not the page failing, so only the main frame's counts —
    // `once` would spend itself on the first stylesheet that went missing.
    const onFailed = (
      _event: unknown,
      _code: number,
      _description: string,
      _url: string,
      isMainFrame: boolean,
    ): void => {
      if (isMainFrame) {
        settle();
      }
    };
    window.webContents.on("did-finish-load", onLoaded);
    window.webContents.on("did-fail-load", onFailed);
    window.on("closed", settle);
  });
}

export function createMainWindow(): BrowserWindow {
  // Where the last run left it, already clamped onto a display that exists now (window-state.ts);
  // the 1280×800 default on a first launch. Read before construction and off the same store the
  // theme just read, so nothing here is between the window and its first paint.
  const placement = restoreWindowPlacement();
  const window = new BrowserWindow({
    width: placement.width,
    height: placement.height,
    // Omitted rather than passed as undefined when there is no saved position: it is Electron's
    // absent-coordinate behaviour — centre on the primary display — that is being asked for.
    ...(placement.x === undefined || placement.y === undefined
      ? {}
      : { x: placement.x, y: placement.y }),
    minWidth: MIN_WINDOW_SIZE.width,
    minHeight: MIN_WINDOW_SIZE.height,
    show: false,
    // Windows/Linux draw the window's own icon (taskbar, title bar). macOS ignores this and
    // shows the dock icon instead — set for that platform in `index.ts` via `app.dock`.
    icon: appIcon,
    backgroundColor: getWindowBackground(),
    titleBarStyle: "hiddenInset",
    // Centers the lights in the renderer's 40px title bar (12px-high glyphs). The
    // buttons are OS-drawn (fixed size) and the ~54px cluster needs x=20 + the
    // shell's pl-24 gutter to clear, so the bar height is the only space lever.
    trafficLightPosition: { x: 20, y: 14 },
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
    },
  });

  window.on("ready-to-show", () => {
    // Maximize before the window is ever on screen, so a restored-maximized launch does not
    // flash at its restored-down size first. Here rather than straight after construction
    // because `maximize()` shows a hidden window on Windows, which would put a blank frame up
    // ahead of the first paint — the thing `show: false` is here to prevent.
    if (placement.maximized) {
      window.maximize();
    }
    window.show();
  });

  // From here on every move, resize, and maximize is written back for the next launch.
  trackWindowState(window);

  // Registered before the load below, so `whenPageLoaded` can never miss the event it waits on.
  window.webContents.on("did-finish-load", () => {
    loadedContents.add(window.webContents);
  });

  const applyThemeBackground = (): void => {
    window.setBackgroundColor(getWindowBackground());
  };
  nativeTheme.on("updated", applyThemeBackground);
  window.on("closed", () => {
    nativeTheme.off("updated", applyThemeBackground);
  });

  window.webContents.setWindowOpenHandler(({ url }) => {
    openExternalUrl(url);
    return { action: "deny" };
  });

  // The renderer is a single page: a page-initiated reload (location.reload(),
  // Vite's dev full-reload) re-navigates to the current URL and must pass; any
  // other target is either an <a> to the outside world (route to the OS
  // browser) or hostile (drop it).
  window.webContents.on("will-navigate", (event, url) => {
    if (url === window.webContents.getURL()) {
      return;
    }
    event.preventDefault();
    openExternalUrl(url);
  });

  // The only two pages this app ever loads. `ipc-registry.ts` checks an invoking frame's URL
  // against the same pair, so a change here belongs there too.
  if (is.dev && process.env["ELECTRON_RENDERER_URL"]) {
    void window.loadURL(process.env["ELECTRON_RENDERER_URL"]);
  } else {
    void window.loadFile(join(__dirname, "../renderer/index.html"));
  }

  return window;
}
