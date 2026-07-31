import { buildApplication, buildRouteMap, type Application, type RouteMap } from "@stricli/core";
import { EXIT_CANNOT_RUN, type LocalContext } from "./context";
import { emitCommand } from "./commands/emit";
import { checkCommand } from "./commands/check";
import { diffCommand } from "./commands/diff";
import { openCommand } from "./commands/open";
import { schemaCommand } from "./commands/schema";
import { skillsCommand } from "./commands/skills";
import { versionLine } from "./version";

// The `rvw` application: one route map over the six review verbs, all live. The surface is
// ordered the way it is used — `emit` presents a review, `check` and `diff` support authoring
// one, `open` re-opens it, `schema` and `skills` say what the shapes and the instructions are.
//
// Six rather than eight, because three of the old verbs were the same work under other names:
// `validate` was `check` without its second half, `coverage` was `check --coverage` plus a
// second copy of `emit`'s capture path, and `anchors` existed so an agent could hand-author
// against a diff `rvw diff` now simply prints. Every verb an agent has to choose between is a
// chance to choose wrong, so overlapping ones were folded rather than kept as aliases.
//
// Stricli supplies routing, `--help`, and argument scanning for the whole surface, so every
// command declares flags and positionals one way and shares one help/usage system. This module
// is pure data (no process, no I/O) — the entrypoint binds it to the real process, and tests
// bind it to capturing streams.

const routes = buildRouteMap<
  "emit" | "check" | "diff" | "open" | "schema" | "skills",
  LocalContext
>({
  routes: {
    emit: emitCommand,
    check: checkCommand,
    diff: diffCommand,
    open: openCommand,
    schema: schemaCommand,
    skills: skillsCommand,
  },
  docs: {
    brief: "rvw — present a review in Reviewer",
    // The pointer an agent needs first is printed *above* this block by the entrypoint, not
    // in it (see agent-header.ts): Stricli puts the usage listing before the description, so
    // anything stated here is already the seventh line of the answer.
    fullDescription:
      "Portable CLI a coding agent uses to hand a review it has already written to the Reviewer app.",
  },
});

/** Wrap a route map in the `rvw` application config. `determineExitCode` is the load-
 * bearing part: Stricli reports a command body that *throws* as its own positive
 * `CommandRunError` (1), which our contract would misread as "ran, found problems" —
 * so every command-thrown exception is mapped to 2 (the shell could not run). A command
 * that means "problems" returns normally after setting exit code 1; it never throws.
 * Exposed so the tests exercise this exact policy against a throwing command. */
export function buildRvwApplication(routeMap: RouteMap<LocalContext>): Application<LocalContext> {
  return buildApplication(routeMap, {
    name: "rvw",
    determineExitCode: () => EXIT_CANNOT_RUN,
    // Multi-word flags are declared camelCase but typed kebab on the wire (`--require-complete`,
    // not `--requireComplete`) — the convention every command's flags follow.
    scanner: { caseStyle: "allow-kebab-for-camel" },
    // `--version`/`-v`, registered by Stricli for free. Only `currentVersion` is supplied:
    // `getLatestVersion` is the optional half that would reach the network on every run, and a
    // tool an agent shells out to has no business doing that. What the line says is version.ts's.
    versionInfo: { currentVersion: versionLine() },
  });
}

export const app = buildRvwApplication(routes);
