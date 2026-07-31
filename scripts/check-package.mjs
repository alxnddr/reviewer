import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import asar from "@electron/asar";

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
// Two halves, because the app has two: `app.asar` is the allowlist from `files:`, and the
// `Contents/Resources` tree beside it is the `extraResources` copy list — the CLI never enters
// the archive, so listing the asar alone would say nothing about whether `rvw` shipped.

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

const app = packagedApp();
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

console.log(`\nPackaged app — ${app.slice(REPO_ROOT.length + 1)}`);
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
