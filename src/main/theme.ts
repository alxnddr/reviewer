import { nativeTheme } from "electron";
import { defaultTheme, resolveTheme, type ThemeId } from "../shared/contracts";
import { THEMES } from "../shared/themes";
import { readSettings } from "./settings";

// The theme is the one setting main has to act on itself: nativeTheme.themeSource drives the
// renderer's prefers-color-scheme AND the window backgroundColor (below), so one assignment keeps
// every surface in sync. Each theme pins its own appearance; until the user first picks one, the
// OS's current preference seeds the default. The choice itself is stored with the other settings
// (`settings.ts`) and changed through `user-settings.ts`; this module only applies it.

function currentSelection(): ThemeId {
  return readSettings().theme ?? defaultTheme(nativeTheme.shouldUseDarkColors);
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
  applyThemeSelection(currentSelection());
}

export function getThemeSelection(): ThemeId {
  return currentSelection();
}

/** Flips the OS-facing side of the theme. Does not persist: the caller is changing settings
 * as a whole and owns the write. */
export function applyThemeSelection(id: ThemeId): void {
  nativeTheme.themeSource = resolveTheme(id).appearance;
}
