import { useSyncExternalStore } from "react";
import { create } from "zustand";
import {
  defaultTheme,
  resolveTheme,
  type ResolvedTheme,
  type ThemeId,
} from "../../../shared/contracts";

// The selection is owned by main (nativeTheme.themeSource drives this window's prefers-color-scheme
// and the window background), but the *applied* theme — the html[data-theme] chrome block and the
// .dark class — is set here: each theme pins its own appearance, so the OS media query alone can't
// tell the renderer which of the curated themes to paint. Until main answers, the OS preference seeds
// the first-paint default (the same one main already painted the window with).

function darkQuery(): MediaQueryList {
  return window.matchMedia("(prefers-color-scheme: dark)");
}

function resolveFor(selection: ThemeId | null): ResolvedTheme {
  // Before hydration nothing is chosen yet — seed the OS-appropriate default.
  return resolveTheme(selection ?? defaultTheme(darkQuery().matches));
}

/** Apply the resolved theme to <html>: `data-theme` selects the chrome + diff-signal token block,
 * the `.dark` class drives Tailwind's dark variant, color-scheme, and the shadow-DOM diff consumers.
 * Instant by design — transitions are suppressed around the swap so a theme change never animates. */
function applyResolvedTheme(resolved: ResolvedTheme): void {
  const root = document.documentElement;
  root.classList.add("no-transitions");
  root.dataset.theme = resolved.id;
  root.classList.toggle("dark", resolved.appearance === "dark");
  // Resolve styles now so the swap is committed before transitions come back.
  void getComputedStyle(root).backgroundColor;
  requestAnimationFrame(() => root.classList.remove("no-transitions"));
}

type ThemeState = {
  // null until hydrated from main; before that the OS-seeded default renders, matching what main
  // already applied to the window.
  selection: ThemeId | null;
  setSelection: (selection: ThemeId) => Promise<void>;
};

export const useThemeStore = create<ThemeState>((set) => ({
  selection: null,
  setSelection: async (selection) => {
    set({ selection });
    // Apply directly rather than waiting on main's prefers-color-scheme flip: a same-appearance
    // switch (e.g. pierre-dark → dracula) doesn't change the media query, so it would never arrive.
    applyResolvedTheme(resolveFor(selection));
    if (window.reviewer) {
      try {
        // main flips nativeTheme (prefers-color-scheme + window background); the applied class/attr
        // above is what recolours the chrome.
        await window.reviewer.setThemeSelection(selection);
      } catch (error) {
        console.error("Theme selection could not be applied:", error);
      }
    }
  },
}));

function subscribeToRootClass(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
  return () => observer.disconnect();
}

/** True while the shell renders dark. The `.dark` class is the single render-side truth (applied by
 * initTheme in both the Electron and browser-gate paths), so consumers that cannot inherit CSS — the
 * shadow-DOM diff surface — follow it here. */
export function useEffectiveDark(): boolean {
  return useSyncExternalStore(subscribeToRootClass, () =>
    document.documentElement.classList.contains("dark"),
  );
}

/** Called once at module load in main.tsx, before the first render. */
export function initTheme(): void {
  // First paint: apply the OS-seeded default until main answers with the persisted pick. No OS
  // media listener — a chosen theme pins its own appearance and never follows the OS.
  applyResolvedTheme(resolveFor(useThemeStore.getState().selection));
  const bridge = window.reviewer;
  if (bridge) {
    void bridge.getThemeSelection().then((selection) => {
      // A pick made before hydration resolves wins over the persisted value.
      useThemeStore.setState((state) => {
        if (state.selection !== null) {
          return state;
        }
        applyResolvedTheme(resolveFor(selection));
        return { selection };
      });
    });
  } else {
    // Outside Electron (no bridge) settle on the OS-appropriate default so the store carries a
    // concrete theme for the menu to reflect.
    useThemeStore.setState((state) =>
      state.selection === null ? { selection: defaultTheme(darkQuery().matches) } : state,
    );
  }
}
