#!/usr/bin/env node
import { run } from "@stricli/core";
import { writeAgentHeader } from "./agent-header";
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
// leaves the outcome in the context's `exitCode`; the one thing this file adds is the guarantee
// the exit-code contract always holds — a command's own 0/1/2 passes through, Stricli's negative
// scan/routing failures and its (positive) command-throw code are both mapped to 2 (the latter
// by the app's `determineExitCode`, see app.ts), and a rejected run (should not happen —
// Stricli catches its own errors) still exits 2 rather than crashing with an accidental code.
// So nothing but 0/1/2 ever leaves the process. Nothing imports this module; it is executed,
// so it needs no import.meta.main guard.

const context = buildContext(process);
const inputs = process.argv.slice(2);

// Above Stricli's help, never inside it: a bare `rvw` is an agent asking what this is, and
// the answer has to be the first line it reads rather than the seventh (see agent-header.ts).
writeAgentHeader(context, inputs);

// `process.exitCode`, never `process.exit()`. On macOS — the only platform this ships for —
// stdout to a *pipe* is asynchronous, and `process.exit()` tears the process down without
// flushing it, so anything still buffered is discarded. That silently truncated `rvw diff` at
// the pipe buffer while a redirect to a file (synchronous) stayed whole — precisely inverting
// which case has to be trustworthy, since the documented use is piping the patch into an agent
// that then authors anchors against it. Setting the code and letting the event loop drain
// exits with the same status once the writes have actually landed; nothing here holds the loop
// open afterwards (every child process the CLI runs goes through `spawnSync`, and the draft on
// stdin is read with a synchronous `readFileSync(0)`), so the process still ends immediately.
run(app, inputs, context)
  .then(() => {
    process.exitCode = normalizeExitCode(context.process.exitCode);
  })
  .catch(() => {
    process.exitCode = EXIT_CANNOT_RUN;
  });
