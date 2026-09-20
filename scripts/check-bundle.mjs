import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Asserts on the *built* renderer — what `electron-vite build` actually emitted under
// `out/renderer`, not what the source says it should. Run it after a build:
//
//   bun run build && bun run check:bundle
//
// One claim: **a review with no mermaid fence never loads mermaid.** The library is the
// largest dependency in the renderer (its core chunk is over a megabyte and its `elk` layout
// another three), and the whole case for shipping it rested on nobody paying for it who did
// not open a diagram.
//
// `MermaidDiagram.test.ts` already holds the *source* to that — one `import("mermaid")`, no
// static import anywhere in `src/`. This holds the *artifact*, because the property is the
// bundler's to break without a line of `src/` changing: a `manualChunks` entry, an
// `optimizeDeps`/`inlineDynamicImports` flip, or a second package that imports mermaid
// statically would each fold the library into what the window loads at launch, and every
// source test would stay green. It is a script behind a build rather than a vitest case for
// the reason `check-package.mjs` is: the suite does not build the renderer (sixteen seconds,
// against a suite that runs in a few), and a test that silently skips when `out/` is absent
// or stale asserts nothing.
//
// A runtime probe was tried first and does not work: under `file://`,
// `performance.getEntriesByType("resource")` lists no script at all, so "the chunk was not
// fetched" and "the API saw nothing" are the same observation.
//
// How it decides, without executing anything:
//
//   1. The *launch set* is `index.html`'s module scripts and modulepreload links, closed over
//      **static** imports (`import … from "./x.js"`, `import "./x.js"`, `export … from`).
//      That is exactly what the window fetches before any code runs. A dynamic `import(` is
//      not followed — it is the one edge that is allowed to lead to mermaid.
//   2. Mermaid's code is recognized by a sentence, not by a file name: Vite names chunks
//      after whatever it likes, and `mermaid-*.js` in this build is *Shiki's grammar for
//      highlighting mermaid source*, which belongs in nobody's way. The marker is a
//      user-facing error string from mermaid's type detection — a minifier renames
//      identifiers, never string literals.
//   3. The marker must be found somewhere. If it is found nowhere the check has gone blind
//      (mermaid reworded the sentence, or stopped shipping), and says so instead of passing.

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RENDERER = join(REPO_ROOT, "out", "renderer");
const INDEX = join(RENDERER, "index.html");

/** A string literal out of mermaid's `detectType`, thrown when a text names no diagram. */
const MERMAID_MARKER = "No diagram type detected";

// A static import or re-export of a relative chunk, minified or not. The run between the
// keyword and the specifier may hold bindings but never a parenthesis, which is what keeps
// `import("./x.js")` out; `[\s{*"']` after the keyword keeps `importScripts` and
// `import.meta` out.
const STATIC_EDGE =
  /(?:^|[;}\n])\s*(?:import|export)(?=[\s{*"'])[^"'()]*?["'](?<spec>\.{1,2}\/[^"']+)["']/gu;
const DYNAMIC_EDGE = /\bimport\(\s*["'](?<spec>\.{1,2}\/[^"']+)["']\s*\)/gu;
const HTML_ROOT =
  /<(?:script\b[^>]*\bsrc|link\b[^>]*\brel="modulepreload"[^>]*\bhref)="(?<spec>[^"]+\.js)"/gu;

const problems = [];
const checked = [];

function finish() {
  console.log("\nBuilt renderer — out/renderer");
  for (const line of checked) {
    console.log(`  ✓ ${line}`);
  }
  for (const line of problems) {
    console.log(`  ✗ ${line}`);
  }
  if (problems.length > 0) {
    console.error("\nThe built renderer is not what it should be — see above.\n");
    process.exitCode = 1;
    return;
  }
  console.log("");
}

/** `out/renderer`-relative posix path of what `spec` names from inside `from`. */
function resolveSpec(from, spec) {
  return posix.normalize(posix.join(posix.dirname(from), spec));
}

function edges(file, pattern) {
  const text = readFileSync(join(RENDERER, file), "utf8");
  return [...text.matchAll(pattern)]
    .map((match) => resolveSpec(file, match.groups.spec))
    .filter((target) => existsSync(join(RENDERER, target)));
}

function check() {
  if (!existsSync(INDEX)) {
    problems.push("out/renderer/index.html is missing. Build first: bun run build");
    return;
  }

  const roots = [...readFileSync(INDEX, "utf8").matchAll(HTML_ROOT)].map((match) =>
    posix.normalize(match.groups.spec),
  );
  if (roots.length === 0) {
    problems.push("index.html names no module script — nothing to walk from");
    return;
  }

  const launch = new Set();
  const queue = [...roots];
  while (queue.length > 0) {
    const file = queue.pop();
    if (launch.has(file) || !existsSync(join(RENDERER, file))) {
      continue;
    }
    launch.add(file);
    queue.push(...edges(file, STATIC_EDGE));
  }

  const scripts = readdirSync(join(RENDERER, "assets"))
    .filter((name) => name.endsWith(".js"))
    .map((name) => `assets/${name}`);
  const mermaid = scripts.filter((file) =>
    readFileSync(join(RENDERER, file), "utf8").includes(MERMAID_MARKER),
  );
  if (mermaid.length === 0) {
    problems.push(
      `no chunk under out/renderer/assets contains ${JSON.stringify(MERMAID_MARKER)} — the ` +
        "marker this check recognizes mermaid by is gone, so it can no longer see what it " +
        "guards. Pick a new string literal out of node_modules/mermaid/dist.",
    );
    return;
  }

  const atLaunch = mermaid.filter((file) => launch.has(file));
  if (atLaunch.length > 0) {
    problems.push(
      `mermaid is in what the window loads at launch (${atLaunch.join(", ")}): something ` +
        "imports it statically, or the bundler was told to fold it in. It must be reachable " +
        'only through the `import("mermaid")` in components/MermaidDiagram.tsx.',
    );
    // Whether it is *also* reached lazily is not worth asking of a build that already loads
    // it eagerly — the answer would be noise under the line that matters.
    return;
  }
  checked.push(
    `the launch set (${launch.size} file${launch.size === 1 ? "" : "s"} from ` +
      `${roots.join(", ")}) does not contain mermaid (${mermaid.join(", ")})`,
  );

  // The other half: kept out of the launch set by being *lazy*, not by being unreachable. A
  // build that dropped the dynamic edge would pass the assertion above and draw nothing.
  const lazily = [...launch].filter((file) =>
    edges(file, DYNAMIC_EDGE).some((target) => mermaid.includes(target)),
  );
  if (lazily.length === 0) {
    problems.push(
      `nothing in the launch set reaches ${mermaid.join(", ")} through a dynamic import( — ` +
        "a mermaid fence would have no way to load the library",
    );
  } else {
    checked.push(`${lazily.join(", ")} reaches it through a dynamic import(`);
  }
}

check();
finish();
