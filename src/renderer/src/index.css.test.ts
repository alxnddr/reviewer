import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// One rule about the stylesheet, enforced here because breaking it is invisible until the app
// is packaged and installed on someone else's machine.
//
// The production build runs index.css through Lightning CSS (Tailwind's optimizer), which
// reads `-webkit-foo` and `foo` as one property declared twice: it keeps the LAST of the two
// and prints it back with only the prefixes that declaration carried. Whether the standard
// property is then re-added depends on Lightning CSS's own per-property target data, so the
// outcome of hand-writing a prefix is a coin flip decided inside a dependency —
//
//   user-select      standard re-added for Chrome/Firefox, so the pair survived
//   backdrop-filter  the webkit form is believed to cover every target, so it did NOT
//
// and the second one shipped. `backdrop-filter: blur(40px)` followed by its `-webkit-` twin
// collapsed to `-webkit-backdrop-filter` alone, which Chromium does not implement at all
// (`CSS.supports("-webkit-backdrop-filter", "blur(1px)")` is false). Every packaged build
// painted the glass surfaces as a flat 32% tint with no blur and no saturate, over fully
// legible text, while `bun dev` — where Lightning CSS never runs — looked correct.
//
// The `@supports` guard around those rules could not catch it: its `or` arm tests the
// unprefixed property, which is exactly the declaration the collapse had just removed, so the
// condition stayed true and the opaque fallback stayed off.
//
// So: declare standard properties only and let the build add the prefixes. It does that from
// the bare declaration anyway, which makes every hand-written prefix either redundant or, as
// here, destructive.

const CSS = readFileSync(join(__dirname, "index.css"), "utf8");

/** Declarations only — `::-webkit-scrollbar` is a selector, and `-webkit-app-region` has no
 * standard twin to be collapsed into. */
function prefixedDeclarations(css: string): string[] {
  return [...css.matchAll(/(?:^|[;{])\s*(-(?:webkit|moz|ms|o)-[a-z-]+)\s*:/gu)].map(
    (match) => match[1] ?? "",
  );
}

/** The prefixes with no unprefixed form to lose — allowed, because nothing can collapse. */
const NO_STANDARD_TWIN = new Set(["-webkit-app-region"]);

function literal(value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

describe("index.css", () => {
  it("hand-writes no vendor prefix that the build would collapse", () => {
    const offenders = prefixedDeclarations(CSS).filter(
      (property) => !NO_STANDARD_TWIN.has(property),
    );
    expect(offenders).toEqual([]);
  });

  it("declares the glass blur on the standard property", () => {
    // The two declarations the collapse ate, matched at the start of a declaration so a
    // `-webkit-` twin cannot satisfy the assertion on its own.
    for (const value of [
      "blur(40px) saturate(190%)",
      "blur(30px) saturate(180%) brightness(1.6)",
    ]) {
      const declared = new RegExp(`(?:^|[;{\\s])backdrop-filter:\\s*${literal(value)};`, "mu");
      expect(CSS).toMatch(declared);
    }
  });
});
