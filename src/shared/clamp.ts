/** `value` held inside `[min, max]`. Written out as `Math.min(Math.max(…))` at a dozen call
 * sites before this — index stepping, drag positions, heading depth — where the nesting reads
 * inside-out from what it does and a transposed pair of bounds is invisible on the page.
 *
 * An inverted pair (`max` below `min`, which is what an empty list's `length - 1` gives)
 * answers `max`, exactly as the nested form did — kept rather than asserted away so no call
 * site changes meaning. The index-stepping callers all rule that case out first, or drop the
 * out-of-range index as a miss. */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
