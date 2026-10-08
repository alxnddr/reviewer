import { useLayoutEffect, useState, type RefObject } from "react";

/** The element's content-box width in px, kept current by a `ResizeObserver` — what the guide's
 * measured drawings (the treemap, the chapter strip, the flow's wrap width) lay themselves out
 * against, so a dragged sidebar seam re-flows them like text. Zero until the first measure: a
 * caller draws nothing at zero rather than a layout for a guessed width.
 *
 * Rounded to whole px so sub-pixel jitter during a resize does not re-run a layout that would
 * come out the same. DOM-only, so untested by the repo's rule; every layout it feeds is a pure
 * function with its own tests. */
export function useElementWidth(ref: RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const element = ref.current;
    if (element === null) {
      return;
    }
    const measure = (): void => setWidth(Math.round(element.clientWidth));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return width;
}
