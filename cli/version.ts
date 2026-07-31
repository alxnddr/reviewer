import { fileURLToPath } from "node:url";
import { version } from "../package.json";

// What `rvw --version` answers — which is two questions, not one.
//
// The number is read from `package.json` rather than written here, so the version the CLI reports
// cannot drift from the one the app ships under. `bun build` inlines the import, which is what
// makes it safe to ask for: the answer is fixed at build time, so it needs no `package.json`
// beside the bundle at runtime — and there is none, since the installed launcher runs a single
// file (`Reviewer.app/Contents/Resources/cli/rvw.js`) out of a directory that holds only it and
// the ESM manifest.
//
// The path is the other half, and the reason the flag matters more here than usual:
// `src/main/cli-install.ts` hunts for stale `rvw` shims that win the PATH, and the first thing
// its reader needs when it reports one is which `rvw` they are actually running. Nothing could
// answer that before this flag existed.

/** The version this build was cut from — `package.json`'s. Imported by name rather than as the
 * whole document so the bundler keeps this one field: the alternative writes the repo's entire
 * dependency list into a file that ships. */
export const VERSION: string = version;

/** The file this `rvw` was loaded from. Resolved from this module's own location, the way
 * `bundledSkillsRoot()` resolves the skills: `bun build` collapses every module into
 * `dist/rvw.js`, so in anything that ships this *is* the bundle — an installed shim's
 * `exec node "$RVW"` reports the bundle it named rather than the shim that named it. Unbundled
 * (`bun cli/index.ts`, vitest) nothing is collapsed and the answer is this source file rather
 * than the entrypoint beside it; it still names the checkout the run came out of, which is the
 * question being asked. */
export function bundlePath(): string {
  return fileURLToPath(import.meta.url);
}

/** The one line `--version` prints: what this build is, and where it is running from. */
export function versionLine(): string {
  return `${VERSION} (${bundlePath()})`;
}
