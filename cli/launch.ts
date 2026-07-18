import { spawnSync } from "node:child_process";
import { errorMessage } from "./errors";

// The one seam `rvw open` launches the installed app through (the mirror of `cli/git.ts`:
// a pure decision plus a thin spawn). The app already owns every arrival path — a cold
// launch reads the review off `process.argv`, a launch while it is running bounces through
// `second-instance` — so the launcher's only job is to hand the app an absolute artifact
// path by the OS mechanism that reaches those handlers. It returns a typed outcome rather
// than exiting; the command body owns the 0/2 exit-code contract.

/** The installed app's identity, mirrored from `electron-builder.yml` (`appId` /
 * `productName`). The launcher targets the app by *bundle id*, not by name or install path:
 * an id survives a rename, cannot collide with another app also called Reviewer, and lets
 * LaunchServices find the app wherever the user installed it — so `rvw` never has to know
 * where the `.app` lives. These two constants are the runtime half of the same fact the
 * yaml declares to the packager; they must be changed together. */
export const APP_BUNDLE_ID = "dev.al.reviewer";
export const APP_PRODUCT_NAME = "Reviewer";

/** macOS's launcher, addressed absolutely rather than through `PATH`. `open` is always
 * `/usr/bin/open`; resolving it by name would let a shadowing shim earlier on `PATH`
 * intercept the launch — the same hardening posture the git runner takes. */
const MACOS_OPEN = "/usr/bin/open";

/** The launch either dispatched, or the reason it could not — never a throw. A failure is
 * always a shell-cannot-run (exit 2): a bad path was already rejected upstream, so the only
 * ways to reach here failing are an app that is not installed, a platform with no Reviewer
 * build, or the launcher binary itself being unavailable. */
export type LaunchResult = { readonly ok: true } | { readonly ok: false; readonly message: string };

/** The OS command that asks the installed Reviewer to open `absolutePath`, or `null` on a
 * platform Reviewer does not ship for. Pure, so the platform routing and the exact argument
 * vector are tested without an installed app and without spawning. */
export type LaunchCommand = { readonly file: string; readonly args: readonly string[] };

/** Reviewer ships for macOS today (`electron-builder.yml` builds only `mac`), so darwin is
 * the one platform with an app to launch; every other platform returns `null` and the
 * caller reports how to open the file by hand. On darwin:
 *
 *   open -n -b <bundleId> --args <absolutePath>
 *
 * `-n` always starts a fresh instance, and that is deliberate — it makes the running and the
 * cold cases one code path the app already handles: a fresh instance either wins the single-
 * instance lock and reads the review off its own argv (cold), or loses it and hands its argv
 * to the primary through `second-instance`, which imports the review and focuses (running).
 * `--args` puts the path on the app's `process.argv`, where `reviewPathFromArgv` finds it —
 * so this needs no `.reviewer.json` document-type declaration in the app's Info.plist, only
 * the argv handling that already exists. The path must be absolute: a `second-instance`
 * resolves a relative arg against the *new* instance's working directory, which an `open`
 * launch does not control. */
export function launchCommandFor(
  platform: NodeJS.Platform,
  absolutePath: string,
): LaunchCommand | null {
  if (platform === "darwin") {
    return { file: MACOS_OPEN, args: ["-n", "-b", APP_BUNDLE_ID, "--args", absolutePath] };
  }
  return null;
}

/** Dispatch the launch for the current platform. `absolutePath` must already be a resolved,
 * validated `.reviewer.json` path — the launcher does not re-check it; content and existence
 * are the command body's and the app's jobs. `open -n` returns as soon as the launch is
 * handed to LaunchServices, so a `0` exit means "the app was asked to open it", not "the app
 * finished opening it"; a non-zero exit is the app not being installed (unknown bundle id)
 * or a launch refusal, surfaced as a message the command maps to exit 2. */
export function launchReviewer(platform: NodeJS.Platform, absolutePath: string): LaunchResult {
  const command = launchCommandFor(platform, absolutePath);
  if (command === null) {
    return {
      ok: false,
      message: `rvw open launches the macOS ${APP_PRODUCT_NAME} app; on ${platform} open ${absolutePath} from ${APP_PRODUCT_NAME}'s File → Open, or drag it onto the window`,
    };
  }

  let result;
  try {
    result = spawnSync(command.file, [...command.args], { encoding: "utf8" });
  } catch (error) {
    return { ok: false, message: `could not launch ${APP_PRODUCT_NAME}: ${errorMessage(error)}` };
  }
  if (result.error !== undefined) {
    return {
      ok: false,
      message: `could not launch ${APP_PRODUCT_NAME}: ${errorMessage(result.error)}`,
    };
  }
  if (result.status !== 0) {
    // A non-zero `open` is almost always an unknown bundle id — the app is not installed.
    // Surface stderr so "Unable to find application …" reaches the agent rather than a bare code.
    const detail = (result.stderr ?? "").trim() || `exit ${result.status ?? "signal"}`;
    return {
      ok: false,
      message: `could not launch ${APP_PRODUCT_NAME} (is it installed?): ${detail}`,
    };
  }
  return { ok: true };
}
