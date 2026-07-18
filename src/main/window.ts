import { BrowserWindow, nativeTheme } from "electron";
import { join } from "node:path";
import { is } from "@electron-toolkit/utils";
import appIcon from "../../build/icon.png?asset";
import { openExternalUrl } from "./external-links";
import { getWindowBackground } from "./theme";

export function createMainWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 500,
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
    window.show();
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

  if (is.dev && process.env["ELECTRON_RENDERER_URL"]) {
    void window.loadURL(process.env["ELECTRON_RENDERER_URL"]);
  } else {
    void window.loadFile(join(__dirname, "../renderer/index.html"));
  }

  return window;
}
