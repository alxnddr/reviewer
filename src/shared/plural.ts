/** A count and the noun it counts: `1 file`, `3 files`. Every surface that prints a count
 * followed by its noun goes through this — it was four byte-identical copies and a scattering
 * of inline `=== 1` ternaries, which is one careless edit away from a `1 files` somewhere.
 * (A phrase whose singular *drops* the number — "its file" vs "its 3 files", LayerIntro —
 * is a different sentence, not this one, and stays written out where it is said.)
 *
 * Deliberately not `Intl.PluralRules`: the nouns are a small fixed set chosen by the code,
 * not by data (file, comment, line, review, commit), every one of them regular, and nothing
 * in the app is localized. The day either of those stops being true, this is the one place
 * that has to change. */
export function countLabel(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}
