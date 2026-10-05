import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

// `rvw` never holds, reads or forwards a GitHub credential, and has no way to reach GitHub at all
// (`next-features.md`, Decisions and C4). `rvw` is what the reader's agents run, so this is the
// line the threat model draws: whatever an agent can make `rvw` do, talking to GitHub with a token
// is not among it. The app posts; the CLI records which pull request a review is of (`--pr`) and
// stays offline.
//
// Asserted against the source, in the form of `src/renderer/src/dom-ids.test.ts`, because nothing
// else can see it: an `api.github.com` in a URL string or an `env["GITHUB_TOKEN"]` read typechecks
// like anything else. Every file under `cli/` is read — tests included, since a test helper that
// read a token from the environment would be the same leak one step removed — except this one,
// which has to spell what it forbids. Each rule is proved to bite on a planted sample.
//
// **And the bundle that ships**, `dist/rvw.js` (built once for the suite by `bundle.setup.ts`):
// the source scan sees `cli/` only, but the bundle is every module `rvw` imports, transitively —
// `src/shared/`, `src/tools/`, dependencies. It is held to the same rules plus three more a
// credential path would leave in it: an `Authorization` header, `gh auth token`, and `hosts.yml`
// (where `gh` keeps its token). Prose in `src/shared/` that names `api.github.com` in a comment is
// not in it — the bundler drops comments, and nothing of the app's GitHub code is imported.

const CLI_ROOT = __dirname;
const THIS_FILE = __filename;
const BUNDLE = join(CLI_ROOT, "..", "dist", "rvw.js");

const FORBIDDEN: Readonly<Record<string, RegExp>> = {
  githubApi: /api\.github\.com/iu,
  githubToken: /\bGITHUB_TOKEN\b/u,
  ghToken: /\bGH_TOKEN\b/u,
};

/** What a credential path would leave in the bundle, beyond the source rules. */
const FORBIDDEN_IN_BUNDLE: Readonly<Record<string, RegExp>> = {
  ...FORBIDDEN,
  authorizationHeader: /\bauthorization\b/iu,
  ghAuthToken: /gh\s+auth\s+token|["']auth["']\s*,\s*["']token["']/iu,
  ghHostsFile: /hosts\.ya?ml/iu,
};

function forbiddenIn(text: string, rules: Readonly<Record<string, RegExp>> = FORBIDDEN): string[] {
  return Object.entries(rules)
    .filter(([, pattern]) => pattern.test(text))
    .map(([name]) => name);
}

function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "node_modules") {
        found.push(...sourceFiles(path));
      }
    } else if (/\.(?:ts|mts|mjs|js)$/u.test(entry.name) && path !== THIS_FILE) {
      found.push(path);
    }
  }
  return found;
}

describe("rvw and GitHub credentials", () => {
  it("the rules bite", () => {
    expect(forbiddenIn('fetch("https://api.github.com/user")')).toEqual(["githubApi"]);
    expect(forbiddenIn('const token = env["GITHUB_TOKEN"];')).toEqual(["githubToken"]);
    expect(forbiddenIn("process.env.GH_TOKEN ?? ''")).toEqual(["ghToken"]);
    // `github.com` itself is fine: `--pr` parses pull request URLs, which never reach the network.
    expect(forbiddenIn("https://github.com/acme/widget/pull/12")).toEqual([]);
  });

  it("nothing under cli/ mentions GitHub's API or reads a GitHub token", () => {
    const files = sourceFiles(CLI_ROOT);
    expect(files.length).toBeGreaterThan(10);
    const offenders = files.flatMap((path) => {
      const rules = forbiddenIn(readFileSync(path, "utf8"));
      return rules.length === 0 ? [] : [`${relative(CLI_ROOT, path)}: ${rules.join(", ")}`];
    });
    expect(offenders).toEqual([]);
  });

  it("the bundle rules bite", () => {
    expect(forbiddenIn('headers: { Authorization: "Bearer " + t }', FORBIDDEN_IN_BUNDLE)).toEqual([
      "authorizationHeader",
    ]);
    expect(forbiddenIn("spawnSync('gh', ['auth', 'token'])", FORBIDDEN_IN_BUNDLE)).toEqual([
      "ghAuthToken",
    ]);
    expect(forbiddenIn("execSync('gh auth token')", FORBIDDEN_IN_BUNDLE)).toEqual(["ghAuthToken"]);
    expect(forbiddenIn("join(home, '.config/gh/hosts.yml')", FORBIDDEN_IN_BUNDLE)).toEqual([
      "ghHostsFile",
    ]);
  });

  it("the shipped bundle, every transitive import included, reaches for no GitHub credential", () => {
    const bundle = readFileSync(BUNDLE, "utf8");
    expect(bundle.length).toBeGreaterThan(100_000);
    expect(forbiddenIn(bundle, FORBIDDEN_IN_BUNDLE)).toEqual([]);
  });
});
