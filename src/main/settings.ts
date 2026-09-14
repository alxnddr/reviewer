import * as z from "zod";
import { SETTING_KEYS, Settings } from "../shared/settings";
import { appStore, type AppStore } from "./store";

// What main keeps in `settings.json`: the reader's settings — the contract in
// `shared/settings.ts`, which the renderer and the IPC rows share — plus the one flag that is
// this install's rather than the reader's. Every value here is absent until set; the unset
// state is modelled rather than papered over with a placeholder, and every key salvages on its
// own, so one hand-edited value cannot cost the file.
export const SettingsFile = Settings.extend({
  // Whether the first-run guide has been through once. Absent means "never launched this app
  // before", which is exactly the condition the guide opens on — so the unset state carries the
  // meaning and there is no separate "first launch" record to keep in sync with it.
  onboarded: z.boolean().optional().catch(undefined),
});
export type SettingsFile = z.infer<typeof SettingsFile>;

const DEFAULT_SETTINGS: SettingsFile = {};

/** The keys this module owns in the shared app store. Anything else on disk belongs to another
 * owner and rides through a write untouched. */
const OWNED_KEYS: ReadonlySet<string> = new Set(Object.keys(SettingsFile.shape));

/** Tolerant by design: a corrupt or stale settings file must never block startup. */
export function parseSettings(raw: unknown): SettingsFile {
  const result = SettingsFile.safeParse(raw);
  return result.success ? result.data : DEFAULT_SETTINGS;
}

// Memory is authoritative once read, disk is a write-through copy — the same shape `sessions.ts`
// uses. electron-store re-reads the file on every `get` (conf keeps no cache of its own), and
// `theme.ts` asks for the selection from `getWindowBackground()`, `applyPersistedTheme()`, and
// every `settings:get` IPC, so without this the file would be read several times before the first
// frame. The cache is keyed on the store instance rather than a flag, so re-pointing the store
// drops the stale value with it.
let cache: { store: AppStore; settings: SettingsFile } | null = null;

export function readSettings(): SettingsFile {
  try {
    const store = appStore();
    if (cache?.store !== store) {
      cache = { store, settings: parseSettings(store.store) };
    }
    return cache.settings;
  } catch (error) {
    // Corrupt JSON is already answered as {} by clearInvalidConfig; this is everything else —
    // permissions, an unreadable device — and startup continues on the defaults.
    console.error("Settings unreadable, starting from defaults:", error);
    return DEFAULT_SETTINGS;
  }
}

export function writeSettings(settings: SettingsFile): void {
  const store = appStore();
  // Memory first, and before the write that can throw: callers apply the change either way
  // (`theme.ts` flips the theme before it persists), so an unwritable disk must not leave this
  // process disagreeing with itself for the rest of the run.
  cache = { store, settings };
  // One whole-file write rather than a key at a time, so the file only ever moves between two
  // complete states: keys another owner wrote (window geometry, …) are carried across, and a
  // preference dropped from `settings` leaves disk with it.
  const carried = Object.entries(store.store).filter(([key]) => !OWNED_KEYS.has(key));
  const owned = Object.entries(settings).filter(([, value]) => value !== undefined);
  store.store = Object.fromEntries([...carried, ...owned]);
}

/** The reader's settings alone — the file with this module's own flags left out, which is
 * the shape the renderer is handed and hands back. */
export function readUserSettings(): Settings {
  const file = readSettings();
  const settings: Settings = {};
  for (const key of SETTING_KEYS) {
    const value = file[key];
    if (value !== undefined) {
      // Same key on both sides of a schema and its extension; the cast only spans the loop.
      (settings as Record<string, unknown>)[key] = value;
    }
  }
  return settings;
}

/** Replaces the reader's settings whole and keeps the file's own flags. Whole rather than
 * merged: a key absent from `next` is a setting reset to its default, and a merge would keep
 * the old choice alive on disk. */
export function writeUserSettings(next: Settings): void {
  const file = readSettings();
  const kept: SettingsFile = {};
  for (const [key, value] of Object.entries(file)) {
    if (!SETTING_KEYS.includes(key as keyof Settings)) {
      (kept as Record<string, unknown>)[key] = value;
    }
  }
  writeSettings({ ...kept, ...next });
}
