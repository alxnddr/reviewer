import { describe, expect, it } from "vitest";
import { parseSettings } from "./settings";

describe("parseSettings", () => {
  it("parses a valid settings file", () => {
    expect(parseSettings('{"theme":"dracula"}')).toEqual({ theme: "dracula" });
  });

  it("leaves the theme unset when the field is missing", () => {
    expect(parseSettings("{}")).toEqual({});
  });

  it("falls back to an unset theme on corrupt JSON", () => {
    expect(parseSettings("{not json")).toEqual({});
  });

  it("carries the first-run flag, and leaves it unset when absent", () => {
    expect(parseSettings('{"onboarded":true}')).toEqual({ onboarded: true });
    // Unset is the meaningful state — it is what "never launched this before" looks like.
    expect(parseSettings('{"theme":"dracula"}')).toEqual({ theme: "dracula" });
  });

  it("falls back to an unset theme on an unknown or removed value", () => {
    expect(parseSettings('{"theme":"solarized"}')).toEqual({});
    // "system" was the removed follow-the-OS mode.
    expect(parseSettings('{"theme":"system"}')).toEqual({});
  });
});
