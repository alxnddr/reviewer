import { useMemo } from "react";
import type { CodeViewOptions, FileDiffContentsLoader } from "@pierre/diffs";
import type { CommentSlot } from "../../../../shared/diff/comment-annotations";
import { expansionOptions } from "./expand-context";
import { activeDiffThemePair } from "./highlight-warmup";
import { DIFF_LAYOUT, DIFF_UNSAFE_CSS } from "./surface-style";
import type { DiffStyle } from "@/stores/ui-prefs";
import { useEffectiveDark, useThemeStore } from "@/stores/theme";

/** Everything the diff surface is configured with, in one object. Assembled here rather
 * than in the view because it is where the appearance stores meet the surface: the view
 * itself neither reads nor renders anything from them.
 *
 * enableGutterUtility surfaces the add affordance on line hover; its click is
 * wired through renderGutterUtility (Pierre rejects pairing that render
 * hook with onGutterUtilityClick — only one gutter API at a time).
 * enableLineSelection lets a gutter drag pick a multi-line range; the `+` reads
 * that selection at click time to add on a range. onLineSelected is left unwired
 * on purpose — it fires on a plain click, so wiring it to open the editor would
 * hijack every stray click; the `+` stays the one deliberate commit gesture. */
export function useDiffOptions(
  diffStyle: DiffStyle,
  /** Loads full file text so Pierre can expand unchanged context around a hunk;
   * null when no live repo backs the diff (a frozen artifact) or the selection
   * has no two readable refs — the expander is then off and no git read fires. */
  loadDiffFiles: FileDiffContentsLoader | null,
): CodeViewOptions<CommentSlot> {
  const dark = useEffectiveDark();
  const themeSelection = useThemeStore((state) => state.selection);

  return useMemo(
    (): CodeViewOptions<CommentSlot> => ({
      // themeType picks which side of the pool's light/dark pair this view paints, so it follows the
      // shell's appearance. `theme` mirrors the pool's active pair, but NOT to tokenize (a per-view
      // theme is disregarded once a worker pool is in use — the pool owns tokenizing, DiffThemeSync):
      // it is the render trigger for a same-appearance switch. Pierre's onThemeChange only invalidates
      // the element pool and never renders, so pushing a new pool theme alone leaves a mounted view
      // untouched when themeType doesn't change (dark→dark). Carrying the pair here makes CodeView's
      // options unequal across that switch, so it re-renders and re-highlights off the pool's new theme.
      themeType: dark ? "dark" : "light",
      theme: activeDiffThemePair(themeSelection),
      diffStyle,
      stickyHeaders: true,
      layout: DIFF_LAYOUT,
      hunkSeparators: "line-info",
      unsafeCSS: DIFF_UNSAFE_CSS,
      enableGutterUtility: true,
      enableLineSelection: true,
      // Context expansion: the loader is null unless a live repo backs the diff,
      // so a frozen artifact gets no expander and never fires a git read.
      ...expansionOptions(loadDiffFiles),
    }),
    [dark, themeSelection, diffStyle, loadDiffFiles],
  );
}
