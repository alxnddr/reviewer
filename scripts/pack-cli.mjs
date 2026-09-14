import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

// Packs `rvw` for a machine without Reviewer.app — a Linux dev box, a CI image — as the
// `rvw-<version>-any.tar.gz` a release attaches and `scripts/install-cli.sh` installs:
//
//   bun run pack:cli                     # build:cli, then → dist/rvw-<version>-any.tar.gz
//   node scripts/pack-cli.mjs <out-dir>  # pack the dist/ build that is already there
//
// The layout is not written down here. It is read off `extraResources` in electron-builder.yml,
// the copy list that puts the same files inside the app, so the tarball unpacks into exactly the
// tree `bundledSkillsRoot` (cli/skills.ts) resolves against — `cli/rvw.js` one directory below
// `skills/` — with the `{"type":"module"}` manifest beside the bundle. A second, hand-kept list
// would be one more place for the drift `portability.test.ts` and `check-package.mjs` exist to
// catch: the manifest once shipped in one layout and not the other.
//
// "any" because nothing in it is native: the bundle is plain ESM for whatever node is on the PATH
// (portability.test.ts proves it resolves nothing from a node_modules), so one tarball serves
// every platform and arch. `cli/install-cli.test.ts` packs with this script and installs the result.

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The tarball's path, or why there is none. */
function pack(outDir) {
  const { version } = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8"));
  const copies = parseYaml(
    readFileSync(join(REPO_ROOT, "electron-builder.yml"), "utf8"),
  )?.extraResources;
  const readable =
    Array.isArray(copies) &&
    copies.length > 0 &&
    copies.every((copy) => typeof copy?.from === "string" && typeof copy?.to === "string");
  if (!readable) {
    return {
      ok: false,
      message:
        "electron-builder.yml's extraResources is no longer a list of { from, to } copies, " +
        "which is where pack-cli.mjs reads the tarball's layout from",
    };
  }
  const missing = copies
    .map((copy) => copy.from)
    .filter((from) => !existsSync(join(REPO_ROOT, from)));
  if (missing.length > 0) {
    return {
      ok: false,
      message: `nothing to pack at ${missing.join(", ")}: run \`bun run build:cli\` first, or \`bun run pack:cli\`, which does`,
    };
  }

  const stage = mkdtempSync(join(tmpdir(), "rvw-pack-"));
  try {
    for (const { from, to } of copies) {
      const target = join(stage, to);
      mkdirSync(dirname(target), { recursive: true });
      cpSync(join(REPO_ROOT, from), target, { recursive: true });
    }
    mkdirSync(outDir, { recursive: true });
    const tarball = join(outDir, `rvw-${version}-any.tar.gz`);
    // Both guards are for a pack made on a Mac, whose files carry extended attributes (at least
    // `com.apple.provenance`). `COPYFILE_DISABLE` stops bsdtar writing a `._name` AppleDouble entry
    // beside each one, which would unpack on Linux as stray files inside `skills/`; `--no-xattrs`
    // stops it recording them as pax headers, which GNU tar warns about once per file on unpack.
    // Both GNU tar and bsdtar accept the flag, so the release job's Linux pack is unchanged by it.
    const entries = readdirSync(stage).toSorted();
    const tar = spawnSync("tar", ["--no-xattrs", "-czf", tarball, "-C", stage, ...entries], {
      encoding: "utf8",
      env: { ...process.env, COPYFILE_DISABLE: "1" },
    });
    if (tar.error !== undefined) {
      return { ok: false, message: `could not run tar: ${tar.error.message}` };
    }
    if (tar.status !== 0) {
      return { ok: false, message: `tar failed: ${tar.stderr.trim()}` };
    }
    return { ok: true, tarball };
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

const result = pack(resolve(process.argv[2] ?? join(REPO_ROOT, "dist")));
if (result.ok) {
  // The path alone, on stdout, so a caller (the release job, the test) can capture it.
  console.log(result.tarball);
} else {
  console.error(`pack-cli: ${result.message}`);
  // Not `process.exit()`: stdout and stderr to a pipe are asynchronous on macOS, and exiting
  // discards what is still buffered — the same reason cli/index.ts sets the code and returns.
  process.exitCode = 1;
}
