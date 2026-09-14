import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// theme.ts drives `nativeTheme`; electron-store, one import further down, only needs electron's
// default export to be destructurable — it falls back to the `cwd` this test hands it.
const electron = vi.hoisted(() => ({
  nativeTheme: { themeSource: "system", shouldUseDarkColors: false },
}));
vi.mock("electron", () => ({ nativeTheme: electron.nativeTheme, default: {} }));

import { configureAppStore } from "./store";
import { applyPersistedTheme, getThemeSelection, getWindowBackground } from "./theme";
import { getUserSettings, setUserSettings } from "./user-settings";

let tempDirs: string[] = [];

function makeStoreDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "reviewer-theme-"));
  tempDirs.push(dir);
  configureAppStore({ directory: dir });
  return dir;
}

function writeSettingsFile(dir: string, contents: unknown): void {
  writeFileSync(join(dir, "settings.json"), JSON.stringify(contents));
}

afterEach(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tempDirs = [];
  configureAppStore();
  electron.nativeTheme.themeSource = "system";
  electron.nativeTheme.shouldUseDarkColors = false;
});

describe("theme selection", () => {
  it("seeds the OS preference until the user has chosen", () => {
    makeStoreDir();
    electron.nativeTheme.shouldUseDarkColors = true;

    const dark = getThemeSelection();
    applyPersistedTheme();
    expect(electron.nativeTheme.themeSource).toBe("dark");

    electron.nativeTheme.shouldUseDarkColors = false;
    expect(getThemeSelection()).not.toBe(dark);
  });

  it("persists the choice for the next launch", () => {
    const dir = makeStoreDir();

    setUserSettings({ theme: "dracula" });
    expect(electron.nativeTheme.themeSource).toBe("dark");

    configureAppStore({ directory: dir });
    expect(getThemeSelection()).toBe("dracula");
  });

  it("goes back to following the OS when the theme is reset", () => {
    makeStoreDir();
    electron.nativeTheme.shouldUseDarkColors = true;
    setUserSettings({ theme: "github-light" });
    expect(electron.nativeTheme.themeSource).toBe("light");

    setUserSettings({});
    expect(electron.nativeTheme.themeSource).toBe("dark");
    expect(getThemeSelection()).toBe("pierre-dark");
  });

  it("hands the renderer only the reader's settings, never the install's flags", () => {
    const dir = makeStoreDir();
    writeSettingsFile(dir, { theme: "nord", diffFontSize: 15, onboarded: true });

    expect(getUserSettings()).toEqual({ theme: "nord", diffFontSize: 15 });

    // And a write of the reader's settings leaves the flag standing.
    setUserSettings({ diffWrap: true });
    configureAppStore({ directory: dir });
    expect(getUserSettings()).toEqual({ diffWrap: true });
    expect(JSON.parse(readFileSync(join(dir, "settings.json"), "utf8"))).toEqual({
      diffWrap: true,
      onboarded: true,
    });
  });

  it("reads the settings file once across the whole startup path", () => {
    const dir = makeStoreDir();
    writeSettingsFile(dir, { theme: "nord" });

    // The three calls startup makes: the pre-paint background, the themeSource assignment before
    // the first window, and the renderer's theme:get.
    const background = getWindowBackground();
    applyPersistedTheme();
    expect(getThemeSelection()).toBe("nord");

    // Only one of them may have touched the disk, which is observable by moving the disk out from
    // under them: a re-reading implementation would start answering "dracula" here.
    writeSettingsFile(dir, { theme: "dracula" });
    expect(getThemeSelection()).toBe("nord");
    expect(getWindowBackground()).toBe(background);

    // …and the file really did change, so the assertions above are about the cache.
    configureAppStore({ directory: dir });
    expect(getThemeSelection()).toBe("dracula");
    expect(getWindowBackground()).not.toBe(background);
  });
});
