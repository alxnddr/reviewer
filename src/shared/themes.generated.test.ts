import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { THEMES } from "./themes.generated";

// Guards the seam between design/globals.css (chrome + diff-signal CSS) and themes.generated.ts
// (runtime metadata): a theme the menu offers but the CSS can't paint fails here instead of shipping.
const GLOBALS = readFileSync(
  fileURLToPath(new URL("../../design/globals.css", import.meta.url)),
  "utf8",
);

const DIFF_TOKENS = [
  "--diff-surface",
  "--diff-add-bg",
  "--diff-del-bg",
  "--diff-add-fg",
  "--diff-del-fg",
];

describe("generated globals.css", () => {
  it("carries one html[data-theme] block per curated theme", () => {
    for (const theme of THEMES) {
      expect(GLOBALS).toContain(`html[data-theme="${theme.id}"] {`);
    }
  });

  it("defines the full diff-signal set inside every theme block", () => {
    for (const theme of THEMES) {
      const start = GLOBALS.indexOf(`html[data-theme="${theme.id}"] {`);
      const block = GLOBALS.slice(start, GLOBALS.indexOf("\n}", start));
      for (const token of DIFF_TOKENS) {
        expect(block).toContain(`${token}:`);
      }
      expect(block).toContain("--background:");
    }
  });

  it("emits the shared Tailwind color mapping exactly once", () => {
    expect(GLOBALS.match(/^@theme inline \{/gm)?.length).toBe(1);
  });
});
