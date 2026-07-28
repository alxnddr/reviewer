import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { app } from "electron";
import * as z from "zod";
import { ThemeId } from "../shared/contracts";

// App-level preferences (not per-repo session state). `theme` is absent until the user first picks
// one; main then seeds the OS-appropriate default, so the unset state is modelled rather than
// papered over with a placeholder.
export const Settings = z.object({
  theme: ThemeId.optional(),
  // Whether the first-run guide has been through once. Absent means "never launched this app
  // before", which is exactly the condition the guide opens on — so the unset state carries the
  // meaning and there is no separate "first launch" record to keep in sync with it.
  onboarded: z.boolean().optional(),
});
export type Settings = z.infer<typeof Settings>;

const DEFAULT_SETTINGS: Settings = {};

/** Tolerant by design: a corrupt or stale settings file must never block startup. */
export function parseSettings(raw: string): Settings {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return DEFAULT_SETTINGS;
  }
  const result = Settings.safeParse(json);
  return result.success ? result.data : DEFAULT_SETTINGS;
}

function settingsPath(): string {
  return join(app.getPath("userData"), "settings.json");
}

export function readSettings(): Settings {
  let raw: string;
  try {
    raw = readFileSync(settingsPath(), "utf8");
  } catch {
    return DEFAULT_SETTINGS;
  }
  return parseSettings(raw);
}

export function writeSettings(settings: Settings): void {
  writeFileSync(settingsPath(), JSON.stringify(settings, null, 2));
}
