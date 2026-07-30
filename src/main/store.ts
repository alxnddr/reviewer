import Store from "electron-store";

// One electron-store instance for everything the main process persists at app level: the user's
// preferences today, window geometry next. Sharing it buys three things — a single atomic write
// path (conf writes through `atomically`: temp file, then rename, so a crash mid-write leaves the
// previous file whole rather than truncated), a single file to reason about, and a single place a
// test can point somewhere other than electron's userData.
//
// The layout is a flat bag of top-level keys, one owner per key, which is exactly what the
// hand-rolled `settings.json` this replaced already wrote. Existing files are therefore adopted as
// they are — no migration step, no reset for anyone who has already picked a theme — and
// `scripts/reset-state.mjs` still reads the file as plain JSON.

export type AppStoreOptions = {
  /** Overrides electron-store's userData default; tests point it at a temp dir. */
  directory?: string;
};

/** Untyped by design: each owner validates its own keys on read, the way `settings.ts` does. */
export type AppStore = Store<Record<string, unknown>>;

let store: AppStore | null = null;
let configured: AppStoreOptions = {};

/** Re-seats the store on a new directory and drops the current instance. Tests call this; the app
 * leaves the userData default alone. */
export function configureAppStore(options: AppStoreOptions = {}): void {
  configured = options;
  store = null;
}

export function appStore(): AppStore {
  // clearInvalidConfig makes electron-store answer {} for corrupt JSON instead of throwing, the
  // same call `sessions.ts` makes: a damaged preferences file must never block startup.
  store ??= new Store<Record<string, unknown>>({
    name: "settings",
    clearInvalidConfig: true,
    ...(configured.directory === undefined ? {} : { cwd: configured.directory }),
  });
  return store;
}
