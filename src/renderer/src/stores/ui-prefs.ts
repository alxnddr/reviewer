import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

// App-wide view preferences: choices that belong to the reader, not to a review. They are
// deliberately *not* in the review store — that store's persistence is per-session write-back
// over IPC (`bridge.updateSession`, debounced, cancelled on close), so anything living there is
// either a slice field or transient app state. A preference is neither: it outlives every
// session, and switching tabs must not change it.
//
// localStorage is the right home for exactly that reason — one key, whole-value, no session in
// the picture. The shell already keeps the rail width there (AppShell's `useDefaultLayout`).
// `createJSONStorage` swallows a throwing getter and hands back `undefined`, which persist
// degrades into a plain store (a warn, and sets that don't survive), so the node test env — where
// there is no such global — still constructs this cleanly.

export type DiffStyle = "split" | "unified";

/** localStorage is input, not state: it is hand-editable, and a key written by a future version
 * of this store outlives the downgrade. So the stored value is checked rather than trusted —
 * `diffStyle` is typed as the union and every consumer switches on it, so a bare cast would put
 * a value in there that no branch handles. */
function isDiffStyle(value: unknown): value is DiffStyle {
  return value === "split" || value === "unified";
}

/** `railCollapsed`'s half of the same rule. A boolean looks like it needs no check, which is
 * exactly why it gets one: a hand-edited `"false"` or `0` would otherwise be cast straight into
 * a field the shell branches on, and `"false"` is truthy. */
function isBoolean(value: unknown): value is boolean {
  return typeof value === "boolean";
}

/** The single localStorage key. Namespaced so it reads as ours next to
 * `react-resizable-panels`' own entry (see AppShell's `useDefaultLayout`). */
export const UI_PREFS_STORAGE_KEY = "reviewer:ui";

type UiPrefs = {
  /** Split ⇄ unified diff layout, driven by the title bar's DiffStyleToggle. */
  diffStyle: DiffStyle;
  setDiffStyle: (style: DiffStyle) => void;
  /** The rail put away, driven by the title bar's SidebarToggle and by ⌘B. Only whether it is
   * away — the *width* it comes back to stays where it already was, in
   * `react-resizable-panels`' own layout entry, so the two are never two answers to one
   * question (AppShell says how that is kept true through a collapse). */
  railCollapsed: boolean;
  setRailCollapsed: (collapsed: boolean) => void;
  toggleRail: () => void;
};

// The curried `create<T>()(…)` form is required, not stylistic: with a middleware in the way,
// the single-call `create<T>(…)` cannot infer the mutators and the types collapse.
export const useUiPrefsStore = create<UiPrefs>()(
  persist(
    (set) => ({
      diffStyle: "split",
      setDiffStyle: (style) => {
        set({ diffStyle: style });
      },
      railCollapsed: false,
      setRailCollapsed: (collapsed) => {
        set({ railCollapsed: collapsed });
      },
      toggleRail: () => {
        set((state) => ({ railCollapsed: !state.railCollapsed }));
      },
    }),
    {
      name: UI_PREFS_STORAGE_KEY,
      storage: createJSONStorage(() => localStorage),
      // Only the data, never the actions. JSON.stringify would drop the setter anyway, but
      // saying so keeps a later non-persisted field from silently ending up on disk.
      partialize: (state) => ({ diffStyle: state.diffStyle, railCollapsed: state.railCollapsed }),
      // Replaces persist's default spread-over-current merge, which would take whatever the key
      // held. An unreadable value leaves the default standing and is not rewritten: the reader's
      // next click is what overwrites it, so nothing is destroyed on the way past. Per key, not
      // per file — one unreadable field must not cost the other its stored choice, which is the
      // same salvage rule `shared/settings.ts` states for the settings on disk.
      merge: (persisted, current) => {
        const stored = (persisted ?? {}) as { diffStyle?: unknown; railCollapsed?: unknown };
        return {
          ...current,
          ...(isDiffStyle(stored.diffStyle) ? { diffStyle: stored.diffStyle } : {}),
          ...(isBoolean(stored.railCollapsed) ? { railCollapsed: stored.railCollapsed } : {}),
        };
      },
    },
  ),
);
