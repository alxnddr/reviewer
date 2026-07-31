import { useEffect, useRef, type ReactElement, type ReactNode } from "react";
import { WorkerPoolContextProvider, useWorkerPool } from "@pierre/diffs/react";
import HighlightWorker from "@pierre/diffs/worker/worker.js?worker";
import {
  activeDiffThemePair,
  CORE_HIGHLIGHT_LANGUAGES,
  DEFAULT_DIFF_THEME,
  HIGHLIGHT_ENGINE,
  warmHighlighter,
} from "@/lib/diff/highlight-warmup";
import { useThemeStore } from "@/stores/theme";

// Assumed core count when navigator.hardwareConcurrency is unavailable (0/NaN).
const FALLBACK_CORE_COUNT = 4;
// Hard ceiling on the pool regardless of core count — see resolvePoolSize below. Both constants
// are 4 today, but they mean different things and may drift independently (e.g. the acceptance
// criteria on the task that introduced this cap call out trying 6 as the ceiling if 4 is slow).
const MAX_POOL_SIZE = 4;

/** Diff highlighting is bursty and cache-backed (fileDiff.cacheKey), not throughput-bound, so the
 * pool is capped at MAX_POOL_SIZE even on many-core machines: the library's own default is 8, and
 * each worker is initialized with the full resolved theme/grammar payload, so an uncapped pool on
 * a 16-core box spawns 16 isolates for one-file-at-a-time work. Exported for testing. */
export function resolvePoolSize(hardwareConcurrency: number): number {
  return Math.min(hardwareConcurrency || FALLBACK_CORE_COUNT, MAX_POOL_SIZE);
}

/** Syncs the pool's global diff theme to the selection. The pool owns the tokenizing `theme` globally
 * (a per-CodeView theme is disregarded once a pool is in use), so it is pushed here, not from DiffView.
 * setRenderOptions clears the render cache and re-highlights in place (no remount, scroll preserved),
 * so it is called only when the pair actually changes — compared by key below. It does NOT by itself
 * repaint a mounted view on a same-appearance switch (Pierre's onThemeChange only invalidates the
 * element pool, never renders); the diff view's options carry the matching render trigger
 * (`use-diff-options.ts`). */
function DiffThemeSync(): null {
  const pool = useWorkerPool();
  const selection = useThemeStore((state) => state.selection);
  const applied = useRef<string | null>(null);
  useEffect(() => {
    if (pool === undefined) {
      return;
    }
    const pair = activeDiffThemePair(selection);
    const key = `${pair.light}|${pair.dark}`;
    if (applied.current === key) {
      return;
    }
    applied.current = key;
    void pool.setRenderOptions({ theme: pair });
  }, [pool, selection]);
  return null;
}

// Fired at module load — the earliest point, before this component first renders and
// constructs the pool — so the theme + core-grammar imports are already resolving by the
// time the first diff needs them. The renderer always has a window; the guard only keeps
// the import-time work out of any non-DOM context that pulls this module in.
if (typeof window !== "undefined") {
  warmHighlighter();
}

type DiffWorkerPoolProps = {
  children: ReactNode;
};

/** Shiki highlighting always runs in these workers, never the UI thread. The pool boots the
 * workers with the default Pierre pair AND the core grammars resolved, so a diff of a core language
 * paints with no per-language resolve-then-colour flash (its grammar is already on the worker, not
 * fetched on first view). DiffThemeSync then drives the active theme onto the pool. */
export function DiffWorkerPool({ children }: DiffWorkerPoolProps): ReactElement {
  return (
    <WorkerPoolContextProvider
      poolOptions={{
        workerFactory: () => new HighlightWorker(),
        poolSize: resolvePoolSize(navigator.hardwareConcurrency),
      }}
      highlighterOptions={{
        theme: DEFAULT_DIFF_THEME,
        // The workers are what render the diffs, so they must own the grammars up front:
        // seeded here, a `.ts`/`.tsx`/… diff never waits on an on-demand grammar resolve.
        langs: CORE_HIGHLIGHT_LANGUAGES,
        preferredHighlighter: HIGHLIGHT_ENGINE,
      }}
    >
      <DiffThemeSync />
      {children}
    </WorkerPoolContextProvider>
  );
}
