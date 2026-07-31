import { useLayoutEffect, type DependencyList } from "react";

type ScrollIntoViewByIdOptions = ScrollIntoViewOptions & {
  /** An extra gate, read off the element once it has been found. For the caller whose
   * "is it actually out of view" question the browser's own minimal scroll does not
   * settle — see `TabBar`, where an unconditional nudge leaves the strip resting a few
   * px in. Absent means "always scroll", which is what the other callers want. */
  when?: (element: HTMLElement) => boolean;
};

/** Put the reader back where they were: find the element carrying `id` and scroll it
 * into view whenever `deps` change. Four surfaces do this — the overview returning to
 * the chapter the reader came out of, the comment rail following an `n`/`p` walk, the
 * layer tree following a selection made somewhere else, and the tab strip following an
 * activation from the menu — and they were four hand-rolled copies of this effect.
 *
 * `id` is `null` when there is nothing to restore, and an id that matches nothing (a
 * collapsed rail, a row not mounted yet) is a no-op rather than an error. Ids here are
 * data — a layer id, a uuid — so the lookup is `getElementById` and never a selector;
 * `dom-ids.test.ts` says why.
 *
 * `useLayoutEffect`, not `useEffect`, and that is half the point of having one of these:
 * the scroll has to land before the browser paints, or the reader sees one frame at the
 * old offset and then a jump. `CommentEditor`'s mount focus is the same rule.
 *
 * `deps` is what the restoration is *about* — the id's source, plus whatever mounts the
 * element it names — rather than everything the effect touches. The callers spelled that
 * out when this was four effects and they still do. */
export function useScrollIntoViewById(
  id: string | null,
  options: ScrollIntoViewByIdOptions,
  deps: DependencyList,
): void {
  // oxlint-disable react-hooks/exhaustive-deps -- the caller's list is the whole point:
  // `id` and `options` are rebuilt every render out of values already inside it, so keying
  // on them too would re-scroll on every render. The rule can only see that the list is not
  // an array literal here.
  useLayoutEffect(() => {
    if (id === null) {
      return;
    }
    const element = document.getElementById(id);
    if (element === null) {
      return;
    }
    const { when, ...scroll } = options;
    if (when !== undefined && !when(element)) {
      return;
    }
    element.scrollIntoView(scroll);
  }, deps);
  // oxlint-enable react-hooks/exhaustive-deps
}
