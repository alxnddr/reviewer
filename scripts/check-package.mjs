import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import asar from "@electron/asar";
import { FuseV1Options, getCurrentFuseWire } from "@electron/fuses";

// Asserts on the *packaged* app — what electron-builder actually produced, not what
// `electron-builder.yml` says it should. Run it after `electron-builder --mac --dir`:
//
//   bunx electron-builder --mac --dir && bun run check:package
//
// It exists because two shipped defects were invisible to every other check in the repo: the
// `files:` list was a denylist that swept `.claude/`, `scratch-demo/` and `shots/` into the
// asar, and `extraResources` copied the CLI bundle without the `{"type":"module"}` manifest
// that makes it runnable. Both are properties of the artifact, so only the artifact can
// disprove them.
//
// Three parts. Two because the app's contents have two halves: `app.asar` is the allowlist from
// `files:`, and the `Contents/Resources` tree beside it is the `extraResources` copy list — the
// CLI never enters the archive, so listing the asar alone would say nothing about whether `rvw`
// shipped. The third is the Electron binary itself: the `electronFuses:` that close the ways to
// run code as Reviewer other than its own asar, and the signature flipping them invalidates.
// Those are bytes in a Mach-O, invisible from the yaml and from every test — a renamed option is
// silently ignored and an app with a broken signature does not launch.
//
// An explicit path checks that `.app` instead of the one under dist/:
//
//   node scripts/check-package.mjs /tmp/Reviewer.app
//
// which is how a check that is supposed to fail can be shown to: copy the build, break the copy
// (flip a fuse back with @electron/fuses' `flipFuses`), and point this at it.

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DIST = join(REPO_ROOT, "dist");

// Everything `files:` in electron-builder.yml allows, plus the production `node_modules`
// electron-builder adds itself. An allowlist rather than a list of the three directories that
// once leaked: the failure mode is "something new started shipping", and only an allowlist
// notices a name nobody thought to forbid. Widening it is a deliberate edit, which is the point.
const ASAR_ALLOWED = new Set(["node_modules", "out", "package.json", "LICENSE"]);

/** The unpacked `.app` under `dist/`. electron-builder names the directory after the target
 * arch — `mac-arm64`, `mac-x64`, `mac-universal` — so it is matched by prefix rather than
 * spelled out, and a build for two arches is reported rather than silently half-checked. */
function packagedApp() {
  const dirs = existsSync(DIST) ? readdirSync(DIST).filter((name) => name.startsWith("mac")) : [];
  const apps = dirs.flatMap((dir) =>
    readdirSync(join(DIST, dir))
      .filter((name) => name.endsWith(".app"))
      .map((name) => join(DIST, dir, name)),
  );
  if (apps.length !== 1) {
    console.error(
      apps.length === 0
        ? "No packaged app under dist/. Build one first: bunx electron-builder --mac --dir"
        : `Expected one packaged app under dist/, found ${apps.length}:\n  ${apps.join("\n  ")}`,
    );
    process.exit(1);
  }
  return apps[0];
}

const app = process.argv[2] === undefined ? packagedApp() : resolve(process.argv[2]);
if (!existsSync(join(app, "Contents", "Resources", "app.asar"))) {
  console.error(`${app} is not a packaged Reviewer.app (no Contents/Resources/app.asar)`);
  process.exit(1);
}
const resources = join(app, "Contents", "Resources");
const problems = [];
const checked = [];

// --- app.asar: nothing beyond the `files:` allowlist ------------------------------------
const archive = join(resources, "app.asar");
const entries = asar.listPackage(archive, { isPack: false });
// listPackage yields absolute-looking archive paths ("/out/main/index.js"); the segment after
// the leading slash is the top-level name.
const top = new Set(entries.map((entry) => entry.split("/")[1]));
const unexpected = [...top].filter((name) => !ASAR_ALLOWED.has(name)).toSorted();
if (unexpected.length > 0) {
  problems.push(
    `app.asar ships ${unexpected.length} entr${unexpected.length === 1 ? "y" : "ies"} the ` +
      `files: allowlist does not name: ${unexpected.join(", ")}`,
  );
} else {
  checked.push(
    `app.asar top level is ${[...top].toSorted().join(", ")} (${entries.length} entries)`,
  );
}

// The allowlist above only reports what is *extra*, so a `files:` edit that dropped `out/**`
// would pass it and ship an app that installs and cannot start. package.json is Electron's
// entrypoint manifest and `main` names the file it loads first: ask the archive what it claims,
// then whether it kept it.
const present = new Set(entries);
if (present.has("/package.json")) {
  const main = JSON.parse(asar.extractFile(archive, "package.json").toString("utf8")).main;
  const entry = typeof main === "string" ? `/${main.replace(/^\.\//u, "")}` : null;
  if (entry === null) {
    problems.push("app.asar's package.json names no `main` — Electron has no entrypoint to load");
  } else if (present.has(entry)) {
    checked.push(`app.asar carries the entrypoint its package.json names (${entry})`);
  } else {
    problems.push(`app.asar names ${entry} as its entrypoint but does not contain it`);
  }
} else {
  problems.push("app.asar has no package.json — Electron has no entrypoint manifest to read");
}

// --- Contents/Resources: the extraResources copy list ------------------------------------
/** Reports a required extraResources path, and returns its contents when it is a readable
 * file — an empty or missing copy is the regression, not the presence of the name. */
function shipped(relative) {
  const path = join(resources, relative);
  if (!existsSync(path)) {
    problems.push(`Contents/Resources/${relative} is missing from the packaged app`);
    return null;
  }
  const stat = statSync(path);
  if (stat.isDirectory()) {
    if (readdirSync(path).length === 0) {
      problems.push(`Contents/Resources/${relative} shipped empty`);
      return null;
    }
    checked.push(`Contents/Resources/${relative} shipped`);
    return null;
  }
  if (stat.size === 0) {
    problems.push(`Contents/Resources/${relative} shipped empty`);
    return null;
  }
  checked.push(`Contents/Resources/${relative} shipped (${stat.size} bytes)`);
  return readFileSync(path, "utf8");
}

shipped("cli/rvw.js");
shipped("skills");
const manifest = shipped("cli/package.json");
// The manifest is only worth shipping for what it declares: without `type: module` the ESM
// bundle beside it runs on a Node new enough to detect module syntax and dies on older ones.
if (manifest !== null) {
  let type = null;
  try {
    type = JSON.parse(manifest).type;
  } catch {
    // Reported below as the same failure a wrong `type` is: the file does not do its job.
  }
  if (type !== "module") {
    problems.push(
      `Contents/Resources/cli/package.json does not declare {"type":"module"} (got ${JSON.stringify(type)})`,
    );
  }
}

// --- The Electron binary: fuses -----------------------------------------------------------
// What `electronFuses:` in electron-builder.yml asks for, by @electron/fuses' own names so the
// index into the wire comes from the library rather than a number copied here. The yaml says why
// each is set; this says only that the packaged binary agrees. Read programmatically, not by
// parsing `electron-fuses read`: Electron's wire is longer than the enum this @electron/fuses
// knows (43 has a ninth fuse), and the CLI prints that one as "undefined is Enabled".
const FUSE_OFF = 48; // ASCII "0"
const FUSE_ON = 49; // ASCII "1"
const REQUIRED_FUSES = [
  ["RunAsNode", false],
  ["EnableNodeOptionsEnvironmentVariable", false],
  ["EnableNodeCliInspectArguments", false],
  ["OnlyLoadAppFromAsar", true],
  ["EnableEmbeddedAsarIntegrityValidation", true],
];

/** One fuse's reported state in words — a byte that is neither "0" nor "1" (114, "removed" by
 * Electron; or absent past the end of the wire) is named as such rather than read as off. */
function fuseState(byte) {
  if (byte === FUSE_ON) return "on";
  if (byte === FUSE_OFF) return "off";
  return byte === undefined ? "absent from the wire" : `in state ${byte}, neither on nor off`;
}

// getCurrentFuseWire reads the first wire in the Electron Framework binary. electron-builder
// builds one arch per `.app` here (mac-arm64); a universal build carries a second slice it
// would not look at.
let wire = null;
try {
  wire = await getCurrentFuseWire(app);
} catch (error) {
  problems.push(
    `could not read the Electron fuse wire: ${error instanceof Error ? error.message : error}`,
  );
}
if (wire !== null && wire.version !== "1") {
  problems.push(`the Electron fuse wire is version ${wire.version}; this check reads version 1`);
} else if (wire !== null) {
  const wrong = [];
  for (const [name, want] of REQUIRED_FUSES) {
    const index = FuseV1Options[name];
    if (index === undefined) {
      wrong.push(`${name} is not a fuse @electron/fuses knows`);
      continue;
    }
    const got = fuseState(wire[index]);
    if (got !== (want ? "on" : "off")) {
      wrong.push(`${name} is ${got}, want ${want ? "on" : "off"}`);
    }
  }
  if (wrong.length > 0) {
    problems.push(
      `Electron fuses are not what electron-builder.yml's electronFuses: asks for — ` +
        wrong.join("; "),
    );
  } else {
    checked.push(
      `Electron fuses: ${REQUIRED_FUSES.map(([name, want]) => `${name} ${want ? "on" : "off"}`).join(", ")}`,
    );
  }
}

// --- The Electron binary: signature -------------------------------------------------------
// Flipping a fuse edits the Electron Framework after the linker signed it ad hoc. With no
// signing identity electron-builder does not re-sign, so unless `resetAdHocDarwinSignature`
// re-signs it the bundle's seal no longer matches and `open` will not launch it — a build that
// passes everything above and cannot start. `--deep` because the edited binary is nested code.
const codesign = spawnSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", app], {
  encoding: "utf8",
});
if (codesign.error !== undefined) {
  problems.push(`could not run codesign: ${codesign.error.message}`);
} else if (codesign.status === 0) {
  checked.push("codesign --verify --deep --strict accepts the bundle's signature");
} else {
  problems.push(
    `codesign --verify rejects the bundle (exit ${codesign.status}) — macOS will not launch it: ` +
      codesign.stderr.trim().replaceAll("\n", " / "),
  );
}

// Repo-relative for the usual dist/ build, absolute for an explicit path outside the repo.
const shown = app.startsWith(REPO_ROOT + sep) ? app.slice(REPO_ROOT.length + 1) : app;
console.log(`\nPackaged app — ${shown}`);
for (const line of checked) {
  console.log(`  ✓ ${line}`);
}
for (const line of problems) {
  console.log(`  ✗ ${line}`);
}
if (problems.length > 0) {
  console.error("\nThe packaged app is not what it should be — see above.\n");
  process.exit(1);
}
console.log("");
