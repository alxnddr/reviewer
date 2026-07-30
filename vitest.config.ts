import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Anchored on this file, not `process.cwd()` — and via `import.meta.url` rather than
// `import.meta.dirname`, which is the same reason `vite.preview.config.mts` does: Vite's
// esbuild-bundling fallback rewrites `import.meta.url` back to the original config's URL
// and leaves `import.meta.dirname` pointing at wherever the bundle was written.
const ROOT = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  // The renderer's own alias, so a test can import a component the way the component
  // imports its neighbours. Same form as `electron.vite.config.ts`: a bare `@` matches
  // only itself and `@/…`, so scoped packages (`@pierre/diffs`) are left alone.
  resolve: {
    alias: { "@": resolve(ROOT, "src/renderer/src") },
  },
  test: {
    include: ["src/**/*.test.ts", "cli/**/*.test.ts"],
    environment: "node",
    // The CLI suites spawn the distributed bundle; one build before any worker starts keeps
    // parallel files from writing and reading `dist/rvw.js` at the same time.
    globalSetup: ["./cli/bundle.setup.ts"],
  },
});
