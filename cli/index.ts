#!/usr/bin/env node
import { run } from "@stricli/core";
import { app } from "./app";
import { buildContext, normalizeExitCode, EXIT_CANNOT_RUN } from "./context";

// The interpreter named here must be `node`, not `bun`, and the reason is not preference:
// `bun build` treats a `#!/usr/bin/env bun` entrypoint as a bun-only artifact, stamps the
// output `// @bun`, and emits a bundle that throws inside Stricli's router under any other
// runtime. The distributed `dist/rvw.js` must run under the Node that Electron embeds, so the
// shebang stays `node` — which bun honors too, since `bun run cli` and `bun dist/rvw.js` name
// the interpreter themselves.

// The single agent-facing entrypoint (`rvw`): the thin effectful shell over the Stricli
// application and the reused review cores. Stricli scans the args, routes to a command, and
// leaves the outcome in `process.exitCode`; the one thing this file adds is the guarantee the
// exit-code contract always holds — a command's own 0/1/2 passes through, Stricli's negative
// scan/routing failures and its (positive) command-throw code are both mapped to 2 (the latter
// by the app's `determineExitCode`, see app.ts), and a rejected run (should not happen —
// Stricli catches its own errors) still exits 2 rather than crashing with an accidental code.
// So nothing but 0/1/2 ever leaves the process. Nothing imports this module; it is executed,
// so it needs no import.meta.main guard.

const context = buildContext(process);

run(app, process.argv.slice(2), context)
  .then(() => process.exit(normalizeExitCode(context.process.exitCode)))
  .catch(() => process.exit(EXIT_CANNOT_RUN));
