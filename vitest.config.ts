import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "cli/**/*.test.ts"],
    environment: "node",
    // The CLI suites spawn the distributed bundle; one build before any worker starts keeps
    // parallel files from writing and reading `dist/rvw.js` at the same time.
    globalSetup: ["./cli/bundle.setup.ts"],
  },
});
