import { SETTINGS_DEFAULTS } from "../../../shared/settings";

// The fonts the code-font picker can offer: the monospace families installed on this machine,
// behind the one the app ships with. Every line is a DOM or platform call, so like the rest of
// the DOM-only helpers it is untested and says so.
//
// Chromium's Local Font Access API (`queryLocalFonts`) lists every installed face but says
// nothing about whether one is monospace, and a picker of six hundred families is not a
// picker. So each family is measured: a run of the narrowest Latin glyph against a run of the
// widest, drawn on an offscreen canvas in that family — equal widths is what monospace means,
// and a family that is not actually usable falls back to the canvas default (proportional) and
// fails the same test. The check is a few milliseconds for two hundred families, so the list is
// rebuilt each time the dialog opens rather than cached against fonts installed mid-session.
//
// Electron grants the local-fonts permission by default and, unlike a browser, does not require
// a user gesture for the call; if either ever changes the picker offers only the bundled font,
// which is the state every other platform would be in anyway.

type LocalFont = { readonly family: string };

/** The API as Chromium exposes it; not in lib.dom yet. */
type FontQueryingWindow = Window & {
  queryLocalFonts?: () => Promise<readonly LocalFont[]>;
};

/** Glyph runs long enough that a sub-pixel difference in advance width shows. The space is
 * in the set for the symbol fonts: one with no Latin glyphs at all draws every letter as the
 * same missing-glyph box, which passes a letters-only test, but its space keeps its own width. */
const RUNS = [
  "iiiiiiiiiiiiiiiiiiii",
  "WWWWWWWWWWWWWWWWWWWW",
  "....................",
  "                    ",
];

function isMonospace(context: CanvasRenderingContext2D, family: string): boolean {
  // Quoted, always: a family with a leading digit or a space is not a valid unquoted token.
  context.font = `16px "${family.replaceAll('"', "")}"`;
  const widths = RUNS.map((run) => context.measureText(run).width);
  const first = widths[0] ?? 0;
  return first > 0 && widths.every((width) => Math.abs(width - first) < 0.5);
}

/** Installed monospace families, sorted, with the bundled default first — that one is a web
 * font the app carries, not something the OS knows about, so the query never lists it. */
export async function listMonospaceFonts(): Promise<string[]> {
  const query = (window as FontQueryingWindow).queryLocalFonts;
  const bundled = SETTINGS_DEFAULTS.diffFontFamily;
  if (query === undefined) {
    return [bundled];
  }
  let faces: readonly LocalFont[];
  try {
    faces = await query.call(window);
  } catch (error) {
    console.error("Installed fonts could not be listed:", error);
    return [bundled];
  }
  const context = document.createElement("canvas").getContext("2d");
  if (context === null) {
    return [bundled];
  }
  const families = [...new Set(faces.map((face) => face.family))]
    .filter((family) => family !== bundled && isMonospace(context, family))
    .toSorted((a, b) => a.localeCompare(b));
  return [bundled, ...families];
}
