import { useEffect, useState, type RefObject } from "react";

/** True while the element's content is wider than the box holding it — i.e. while
 * `truncate` is actually eliding something. Two surfaces ask it: the tooltip kit,
 * to arm a hint only where there is clipped text to recover, and the tab strip, to
 * fade a name only where one is actually cut off. Both want the same measurement,
 * so it is one hook rather than two that drift.
 *
 * Re-measures on every resize, which is what a dragged sidebar seam, a resized
 * window or a strip of tabs compressing as siblings open and close all produce.
 *
 * `contentKey` re-measures when the text changes inside a box that did not: a tab
 * renamed in the same slot clips differently, and no resize is observed for it.
 * Pass `null` when the content is not a string the caller can key on.
 *
 * `enabled` is for callers that only sometimes need the answer — an always-on hint
 * never pays for an observer. Callers that always need it leave it alone. */
export function useOverflowing(
  ref: RefObject<HTMLElement | null>,
  contentKey: string | null,
  enabled = true,
): boolean {
  const [overflowing, setOverflowing] = useState(false);

  useEffect(() => {
    if (!enabled) {
      return;
    }
    const element = ref.current;
    if (element === null) {
      return;
    }
    const measure = (): void => {
      setOverflowing(element.scrollWidth > element.clientWidth);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref, enabled, contentKey]);

  return overflowing;
}
