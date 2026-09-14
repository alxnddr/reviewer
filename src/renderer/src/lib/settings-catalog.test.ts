import { describe, expect, it } from "vitest";
import { SETTING_KEYS } from "../../../shared/settings";
import { THEME_IDS } from "../../../shared/themes";
import {
  filterSettings,
  SETTING_ENTRIES,
  SETTING_GROUPS,
  settingPatch,
  settingSections,
} from "./settings-catalog";

// The catalog's own invariants — the ones the types cannot carry: that it is complete against
// the schema, that the search finds what a reader would type, and that the groups it renders
// are the groups it declares.

describe("SETTING_ENTRIES", () => {
  it("has exactly one row per key in the schema", () => {
    const keys = SETTING_ENTRIES.map((entry) => entry.key);
    expect(keys.toSorted()).toEqual(SETTING_KEYS.toSorted());
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("leaves no group empty", () => {
    for (const group of SETTING_GROUPS) {
      expect(
        SETTING_ENTRIES.some((entry) => entry.group === group.id),
        `${group.id} has no rows`,
      ).toBe(true);
    }
  });

  it("offers every curated theme, and only those", () => {
    const theme = SETTING_ENTRIES.find((entry) => entry.key === "theme");
    expect(theme?.kind).toBe("select");
    if (theme?.kind === "select") {
      expect(theme.options.map((option) => option.value)).toEqual([...THEME_IDS]);
    }
  });

  it("gives every row a label and a sentence", () => {
    for (const entry of SETTING_ENTRIES) {
      expect(entry.label.length, entry.key).toBeGreaterThan(0);
      expect(entry.description.length, entry.key).toBeGreaterThan(20);
    }
  });
});

describe("filterSettings", () => {
  it("is no filter when the query is blank", () => {
    expect(filterSettings(SETTING_ENTRIES, "")).toEqual([...SETTING_ENTRIES]);
    expect(filterSettings(SETTING_ENTRIES, "   ")).toEqual([...SETTING_ENTRIES]);
  });

  it("matches on the label, case aside", () => {
    expect(filterSettings(SETTING_ENTRIES, "LIGATURES").map((entry) => entry.key)).toEqual([
      "diffLigatures",
    ]);
  });

  it("matches on the description and the group title", () => {
    expect(filterSettings(SETTING_ENTRIES, "sideways").map((entry) => entry.key)).toEqual([
      "diffWrap",
    ]);
    const appearance = filterSettings(SETTING_ENTRIES, "appearance").map((entry) => entry.key);
    expect(appearance).toContain("theme");
    expect(appearance).not.toContain("diffTabSize");
  });

  it("needs every word, in any order", () => {
    // Line height is in: its sentence names the font size it multiplies.
    expect(filterSettings(SETTING_ENTRIES, "font diff").map((entry) => entry.key)).toEqual([
      "diffFontFamily",
      "diffFontSize",
      "diffLineHeight",
      "diffLigatures",
    ]);
    expect(filterSettings(SETTING_ENTRIES, "font theme")).toEqual([]);
  });
});

describe("settingSections", () => {
  it("keeps navigation order and drops a group the filter emptied", () => {
    expect(settingSections(SETTING_ENTRIES).map((section) => section.id)).toEqual(
      SETTING_GROUPS.map((group) => group.id),
    );
    const sections = settingSections(filterSettings(SETTING_ENTRIES, "tab"));
    expect(sections.map((section) => section.id)).toEqual(["diff"]);
    expect(sections[0]?.entries.map((entry) => entry.key)).toEqual(["diffTabSize"]);
  });
});

describe("settingPatch", () => {
  it("names the key with the value, and a reset with undefined", () => {
    expect(settingPatch("diffFontSize", 14)).toEqual({ diffFontSize: 14 });
    const reset = settingPatch("theme", undefined);
    expect("theme" in reset).toBe(true);
    expect(reset.theme).toBeUndefined();
  });
});
