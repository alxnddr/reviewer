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

  it("falls back to an unset theme on an unknown or removed value", () => {
    expect(parseSettings('{"theme":"solarized"}')).toEqual({});
    // "system" was the removed follow-the-OS mode.
    expect(parseSettings('{"theme":"system"}')).toEqual({});
  });
});
