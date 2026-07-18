import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Builds the distributed `dist/rvw.js` once, before any test worker starts.
//
// Two suites drive the bundle (`portability.test.ts`, `exit-gate.test.ts`) and vitest runs test
// files in parallel workers. If each built it itself, two `bun build` processes would write the
// same `dist/rvw.js` while the other worker copied it — a partially-written bundle node cannot
// parse, flaking the one gate whose whole purpose is never to report a false result. Building
// here leaves exactly one writer, finished before any reader exists.
//
// It shells out to the real `build:cli` script rather than re-spelling its flags, so the bundle
// under test is byte-for-byte the one `bun run build:cli` ships and cannot drift from it.

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export default function setup(): void {
  const build = spawnSync("bun", ["run", "build:cli"], { cwd: REPO_ROOT, encoding: "utf8" });
  if (build.status !== 0) {
    throw new Error(`build:cli failed: ${build.stderr}`);
  }
}
