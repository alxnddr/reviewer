import * as z from "zod";
import { ThemeId } from "../shared/contracts";
import { appStore, type AppStore } from "./store";

// App-level preferences (not per-repo session state). `theme` is absent until the user first picks
// one; main then seeds the OS-appropriate default, so the unset state is modelled rather than
// papered over with a placeholder.
export const Settings = z.object({
  theme: ThemeId.optional(),
  // Whether the first-run guide has been through once. Absent means "never launched this app
  // before", which is exactly the condition the guide opens on — so the unset state carries the
  // meaning and there is no separate "first launch" record to keep in sync with it.
  onboarded: z.boolean().optional(),
});
export type Settings = z.infer<typeof Settings>;

const DEFAULT_SETTINGS: Settings = {};

/** The keys this module owns in the shared app store. Anything else on disk belongs to another
 * owner and rides through a write untouched. */
const OWNED_KEYS: ReadonlySet<string> = new Set(Object.keys(Settings.shape));

/** Tolerant by design: a corrupt or stale settings file must never block startup. */
export function parseSettings(raw: unknown): Settings {
  const result = Settings.safeParse(raw);
  return result.success ? result.data : DEFAULT_SETTINGS;
}

// Memory is authoritative once read, disk is a write-through copy — the same shape `sessions.ts`
// uses. electron-store re-reads the file on every `get` (conf keeps no cache of its own), and
// `theme.ts` asks for the selection from `getWindowBackground()`, `applyPersistedTheme()`, and
// every `theme:get` IPC, so without this the file would be read several times before the first
// frame. The cache is keyed on the store instance rather than a flag, so re-pointing the store
// drops the stale value with it.
let cache: { store: AppStore; settings: Settings } | null = null;

export function readSettings(): Settings {
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

export function writeSettings(settings: Settings): void {
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
