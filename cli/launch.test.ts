import { describe, expect, it } from "vitest";
import { APP_BUNDLE_ID, launchCommandFor, launchReviewer } from "./launch";

// The launch decision is pure (platform → argument vector) and is proven here without an
// installed app and without spawning: the argv that reaches the app, and the refusal on a
// platform Reviewer does not ship for, are the whole contract `rvw open` rests on. The
// effectful spawn arm (a real `/usr/bin/open`) is intentionally not driven from a test — its
// outcome depends on whether Reviewer is installed on the running machine, which is not a
// property of this code.

describe("launchCommandFor", () => {
  it("hands macOS the absolute path on the app's argv, addressed by bundle id", () => {
    const command = launchCommandFor("darwin", "/abs/change.reviewer.json");
    expect(command).not.toBeNull();
    // `-b <id>` finds the app wherever installed; `--args <abs path>` lands on the app's
    // process.argv, where `reviewPathFromArgv` reads it — the argv path, not a document-type
    // open, so no Info.plist association is required. `-n` makes running and cold one path.
    expect(command).toEqual({
      file: "/usr/bin/open",
      args: ["-n", "-b", APP_BUNDLE_ID, "--args", "/abs/change.reviewer.json"],
    });
  });

  it("resolves the launcher absolutely so a PATH shim cannot intercept the open", () => {
    const command = launchCommandFor("darwin", "/abs/x.reviewer.json");
    expect(command?.file).toBe("/usr/bin/open");
  });

  it("has no app to launch on a platform Reviewer does not ship for", () => {
    expect(launchCommandFor("linux", "/abs/x.reviewer.json")).toBeNull();
    expect(launchCommandFor("win32", "/abs/x.reviewer.json")).toBeNull();
  });
});

describe("launchReviewer", () => {
  it("refuses an unsupported platform with a message that names the manual open, never spawning", () => {
    const result = launchReviewer("linux", "/abs/x.reviewer.json");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a refusal");
    // The message must point the user at the app's own open affordances, since there is no
    // installed Reviewer for `rvw` to drive on this platform.
    expect(result.message).toContain("File → Open");
    expect(result.message).toContain("/abs/x.reviewer.json");
  });
});
