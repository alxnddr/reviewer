import { nativeTheme } from "electron";
import { defaultTheme, resolveTheme, type ThemeId } from "../shared/contracts";
import { THEMES } from "../shared/themes";
import { readSettings, writeSettings } from "./settings";

// The theme lives in main: nativeTheme.themeSource drives the renderer's prefers-color-scheme AND the
// window backgroundColor (below), so one assignment keeps every surface in sync. Each theme pins its
// own appearance; until the user first picks one, the OS's current preference seeds the default.

function currentSelection(): ThemeId {
  return readSettings().theme ?? defaultTheme(nativeTheme.shouldUseDarkColors);
}

function themeSourceFor(id: ThemeId): typeof nativeTheme.themeSource {
  return resolveTheme(id).appearance;
}

/** The pre-first-paint window background of the theme that will render — its chrome background. Hex,
 * because Electron's `backgroundColor` parses colors, not `oklch()`. */
export function getWindowBackground(): string {
  const { id } = resolveTheme(currentSelection());
  const meta = THEMES.find((theme) => theme.id === id);
  if (meta === undefined) {
    throw new Error("resolved theme is not in the curated set");
  }
  return meta.windowBackground;
}

/** Called before the first window is created so frame one paints the persisted theme. */
export function applyPersistedTheme(): void {
  nativeTheme.themeSource = themeSourceFor(currentSelection());
}

export function getThemeSelection(): ThemeId {
  return currentSelection();
}

export function setThemeSelection(id: ThemeId): void {
  nativeTheme.themeSource = themeSourceFor(id);
  // Applying wins over persisting: a failed write (read-only disk, …) must not reject the IPC after
  // the theme already flipped — the choice just won't survive a restart.
  try {
    writeSettings({ ...readSettings(), theme: id });
  } catch (error) {
    console.error("Theme selection could not be persisted:", error);
  }
}
