import { create, type StoreApi, type UseBoundStore } from "zustand";
import {
  mergeSettings,
  resolveSettings,
  type ResolvedSettings,
  type Settings,
  type SettingsPatch,
} from "../../../shared/settings";
import { applySettings, systemPrefersDark } from "../lib/apply-settings";

// The reader's settings, in the renderer. Main owns the copy on disk and the one setting that
// reaches past this window (the theme, through nativeTheme); this store owns the copy that is
// *applied* — the html[data-theme] attribute, the diff's typography variables — and the dialog
// that edits it. Kept out of the review store for the reason the onboarding and recents
// stores are: nothing here belongs to a session, and the settings have to be in force before
// there is one.
//
// Two records, never one. `settings` is what is stored — only the choices made, `null` until
// main has answered — and `resolved` is what is applied, every key decided. Keeping the stored
// record is what lets the dialog know which rows to offer a reset on, and sending it back
// *whole* after every change (the `updateSession` shape) is what makes a reset a real removal
// on disk rather than a key set to its default.
//
// A factory rather than a bare `create()` because the one effect here — writing the resolved
// record into the document — is DOM, and the suite has none: tests build an instance around a
// recording function and assert on what would have been applied.

type SettingsState = {
  /** The stored choices, or null until main answers. Before that the OS-seeded defaults are
   * in force, which is what main already painted the window with. */
  settings: Settings | null;
  /** What the app is applying right now. Re-derived from `settings` on every change. */
  resolved: ResolvedSettings;
  /** The OS preference the unchosen theme follows. Read once at init; a chosen theme pins its
   * own appearance and never follows the OS, and an unchosen one following it *live* would
   * repaint the app under a reader who never asked. */
  systemDark: boolean;
  dialogOpen: boolean;
  /** Applies the OS seed and asks main for the stored record. Called once before first render. */
  init: () => Promise<void>;
  /** Changes some settings: a key set to `undefined` goes back to its default. */
  update: (patch: SettingsPatch) => Promise<void>;
  openDialog: () => void;
  closeDialog: () => void;
  toggleDialog: () => void;
};

export type SettingsStore = UseBoundStore<StoreApi<SettingsState>>;

type SettingsStoreEnv = {
  /** Writes a resolved record into the document (`lib/apply-settings`). */
  apply: (next: ResolvedSettings, previous: ResolvedSettings | null) => void;
  systemPrefersDark: () => boolean;
};

export function createSettingsStore(env: SettingsStoreEnv): SettingsStore {
  return create<SettingsState>((set, get) => ({
    settings: null,
    // The real OS answer arrives in `init`; a store built outside a window (the tests) has
    // no preference to read, and a light seed is the same one the fresh-install path takes.
    resolved: resolveSettings({}, { systemDark: false }),
    systemDark: false,
    dialogOpen: false,

    init: async () => {
      const systemDark = env.systemPrefersDark();
      const resolved = resolveSettings(get().settings ?? {}, { systemDark });
      // First paint: the OS-seeded default until main answers with the stored record.
      env.apply(resolved, null);
      set({ systemDark, resolved });

      const bridge = window.reviewer;
      if (!bridge) {
        return;
      }
      const stored = await bridge.getSettings();
      // A choice made before hydration resolved wins over the stored record: the reader is
      // looking at what they just picked, and main has already been told about it.
      if (get().settings !== null) {
        return;
      }
      const next = resolveSettings(stored, { systemDark });
      env.apply(next, get().resolved);
      set({ settings: stored, resolved: next });
    },

    update: async (patch) => {
      const { settings, resolved, systemDark } = get();
      const next = mergeSettings(settings ?? {}, patch);
      const nextResolved = resolveSettings(next, { systemDark });
      // Apply directly rather than waiting on main: a same-appearance theme switch never
      // changes prefers-color-scheme, so nothing would come back to trigger it, and a font
      // change is the renderer's alone.
      env.apply(nextResolved, resolved);
      set({ settings: next, resolved: nextResolved });
      const bridge = window.reviewer;
      if (!bridge) {
        return;
      }
      try {
        await bridge.setSettings(next);
      } catch (error) {
        console.error("Settings could not be saved:", error);
      }
    },

    openDialog: () => set({ dialogOpen: true }),
    closeDialog: () => set({ dialogOpen: false }),
    toggleDialog: () => set((state) => ({ dialogOpen: !state.dialogOpen })),
  }));
}

/** The app's one instance. `init` runs from main.tsx before the first render, so the theme is
 * on <html> before anything paints. */
export const useSettingsStore: SettingsStore = createSettingsStore({
  apply: applySettings,
  systemPrefersDark,
});
