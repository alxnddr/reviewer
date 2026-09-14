import { defaultTheme } from "../shared/contracts";
import type { Settings } from "../shared/settings";
import { nativeTheme } from "electron";
import { readUserSettings, writeUserSettings } from "./settings";
import { applyThemeSelection } from "./theme";

// The `settings:get` / `settings:set` pair, as main answers it. The renderer holds the
// authoritative copy of the reader's settings and sends the whole record back after every
// change; main's job is to apply the one setting that reaches past the renderer — the theme,
// through nativeTheme — and to persist the record.

export function getUserSettings(): Settings {
  return readUserSettings();
}

export function setUserSettings(next: Settings): void {
  // Applying wins over persisting: a failed write (read-only disk, …) must not reject the IPC
  // after the theme already flipped — the choice just won't survive a restart. A reset theme
  // goes back to following the OS, the same seed a fresh install gets.
  applyThemeSelection(next.theme ?? defaultTheme(nativeTheme.shouldUseDarkColors));
  try {
    writeUserSettings(next);
  } catch (error) {
    console.error("Settings could not be persisted:", error);
  }
}
