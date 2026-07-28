import { readSettings, writeSettings } from "./settings";

// One bit, in app settings rather than in session state: the guide is about this install —
// what the app is, and the command that feeds it — not about any one repo, and a reader who
// has been through it should not meet it again after closing their last tab.

export function hasOnboarded(): boolean {
  return readSettings().onboarded === true;
}

export function markOnboarded(): void {
  try {
    writeSettings({ ...readSettings(), onboarded: true });
  } catch (error) {
    // Same rule as the theme: a failed write must not reject the IPC. The reader is done
    // with the guide either way; the only cost is that it offers itself again next launch.
    console.error("Onboarding completion could not be persisted:", error);
  }
}
