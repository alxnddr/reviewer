import { describe, expect, it } from "vitest";
import {
  DIFF_FONT_SIZE,
  diffLineHeightPx,
  githubLogin,
  mergeSettings,
  resolveSettings,
  SETTING_KEYS,
  Settings,
  SETTINGS_DEFAULTS,
} from "./settings";

// The contract's two promises: a bad value costs one key and not the file, and what is stored
// is only ever a choice — never a default written down, never an `undefined` written down.

describe("Settings", () => {
  it("salvages every other key when one is unreadable", () => {
    const parsed = Settings.parse({ theme: "nord", diffFontSize: "big", diffWrap: true });
    expect(parsed).toEqual({ theme: "nord", diffWrap: true });
    expect(parsed.diffFontSize).toBeUndefined();
  });

  it("treats a value the dialog could never have written as never chosen", () => {
    expect(Settings.parse({ diffFontSize: DIFF_FONT_SIZE.max + 1 }).diffFontSize).toBeUndefined();
    expect(Settings.parse({ diffFontSize: 13.5 }).diffFontSize).toBeUndefined();
    expect(Settings.parse({ diffLineHeight: 0.5 }).diffLineHeight).toBeUndefined();
    expect(Settings.parse({ theme: "solarized" }).theme).toBeUndefined();
    expect(Settings.parse({ diffFontFamily: "   " }).diffFontFamily).toBeUndefined();
  });

  it("never sends evidence to a change's author unless the reader chose to", () => {
    // The default is the safety property: evidence is written to the reader, so a copy for the
    // author leaves it out until someone turns it on — and a hand-edited value that is not a
    // boolean reads as never chosen, which is that same off.
    expect(SETTINGS_DEFAULTS.postableIncludesEvidence).toBe(false);
    expect(
      Settings.parse({ postableIncludesEvidence: "yes" }).postableIncludesEvidence,
    ).toBeUndefined();
    expect(resolveSettings({}, { systemDark: false }).postableIncludesEvidence).toBe(false);
  });

  it("reads a blank prompt template as never chosen, and keeps a real one whole", () => {
    expect(Settings.parse({ pullRequestPrompt: "   " }).pullRequestPrompt).toBeUndefined();
    expect(Settings.parse({ pullRequestPrompt: 42 }).pullRequestPrompt).toBeUndefined();
    expect(Settings.parse({ pullRequestPrompt: " review {pr}\nplease " }).pullRequestPrompt).toBe(
      "review {pr}\nplease",
    );
    expect(resolveSettings({}, { systemDark: false }).pullRequestPrompt).toContain("--pr {pr}");
  });

  it("holds the GitHub username to GitHub's login charset, and reads unset as no login", () => {
    expect(Settings.parse({ githubUsername: "octo-cat" }).githubUsername).toBe("octo-cat");
    // Each of these would otherwise reach the inbox search as a qualifier of its own.
    for (const bad of ["octo cat", "a:b", "-octo", "octo/cat", ""]) {
      expect(Settings.parse({ githubUsername: bad }).githubUsername, bad).toBeUndefined();
    }
    expect(githubLogin(resolveSettings({}, { systemDark: false }))).toBeNull();
    expect(githubLogin(resolveSettings({ githubUsername: "octocat" }, { systemDark: false }))).toBe(
      "octocat",
    );
  });

  it("still fails whole on something that is not a settings object", () => {
    expect(Settings.safeParse(null).success).toBe(false);
    expect(Settings.safeParse("nord").success).toBe(false);
  });

  it("trims the font family it stores", () => {
    expect(Settings.parse({ diffFontFamily: "  JetBrains Mono " }).diffFontFamily).toBe(
      "JetBrains Mono",
    );
  });
});

describe("resolveSettings", () => {
  it("fills every unchosen key from the defaults, and the theme from the OS", () => {
    expect(resolveSettings({}, { systemDark: true })).toEqual({
      theme: "pierre-dark",
      ...SETTINGS_DEFAULTS,
    });
    expect(resolveSettings({}, { systemDark: false }).theme).toBe("pierre-light");
  });

  it("lets a choice win over the OS and the defaults", () => {
    const resolved = resolveSettings(
      { theme: "github-light", diffFontSize: 16 },
      { systemDark: true },
    );
    expect(resolved.theme).toBe("github-light");
    expect(resolved.diffFontSize).toBe(16);
    expect(resolved.diffTabSize).toBe(SETTINGS_DEFAULTS.diffTabSize);
  });

  it("decides every key the schema declares", () => {
    const resolved = resolveSettings({}, { systemDark: false });
    for (const key of SETTING_KEYS) {
      expect(resolved[key], key).toBeDefined();
    }
  });
});

describe("mergeSettings", () => {
  it("applies a choice without touching the others", () => {
    expect(mergeSettings({ theme: "nord" }, { diffFontSize: 14 })).toEqual({
      theme: "nord",
      diffFontSize: 14,
    });
  });

  it("removes the key on a reset rather than storing undefined", () => {
    const merged = mergeSettings({ theme: "nord", diffFontSize: 14 }, { diffFontSize: undefined });
    expect(merged).toEqual({ theme: "nord" });
    expect("diffFontSize" in merged).toBe(false);
  });

  it("leaves the input alone", () => {
    const current: Settings = { theme: "nord" };
    mergeSettings(current, { theme: undefined, diffWrap: true });
    expect(current).toEqual({ theme: "nord" });
  });
});

describe("diffLineHeightPx", () => {
  it("lands on Pierre's own 20px row at the defaults", () => {
    expect(diffLineHeightPx(SETTINGS_DEFAULTS)).toBe(20);
  });

  it("rounds to whole pixels for the virtualizer", () => {
    expect(diffLineHeightPx({ diffFontSize: 15, diffLineHeight: 1.5 })).toBe(23);
  });
});
