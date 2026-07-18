import { describe, expect, it } from "vitest";
import { defaultTheme, resolveTheme, ThemeId } from "./contracts";

describe("resolveTheme", () => {
  it("resolves a curated id to its own appearance", () => {
    expect(resolveTheme("dracula")).toEqual({ id: "dracula", appearance: "dark" });
    expect(resolveTheme("github-light")).toEqual({ id: "github-light", appearance: "light" });
  });

  it("falls back to the light default for an id no longer in the set", () => {
    // A stale persisted id fails ThemeId validation upstream; resolveTheme is the last line of
    // defence so a bad value never leaves the app unthemed.
    expect(resolveTheme("removed-theme" as ThemeId)).toEqual({
      id: "pierre-light",
      appearance: "light",
    });
  });
});

describe("defaultTheme", () => {
  it("seeds the OS-appropriate default when nothing is chosen yet", () => {
    expect(defaultTheme(true)).toBe("pierre-dark");
    expect(defaultTheme(false)).toBe("pierre-light");
  });
});

describe("ThemeId", () => {
  it("accepts every curated id and rejects unknown or removed values", () => {
    expect(ThemeId.safeParse("dracula").success).toBe(true);
    // "system" was the removed follow-the-OS mode; it is no longer a valid selection.
    expect(ThemeId.safeParse("system").success).toBe(false);
    expect(ThemeId.safeParse("solarized").success).toBe(false);
  });
});
