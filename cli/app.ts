import { buildApplication, buildRouteMap, type Application, type RouteMap } from "@stricli/core";
import { EXIT_CANNOT_RUN, type LocalContext } from "./context";
import { validateCommand } from "./commands/validate";
import { coverageCommand } from "./commands/coverage";
import { anchorsCommand } from "./commands/anchors";
import { emitCommand } from "./commands/emit";
import { checkCommand } from "./commands/check";
import { skillsCommand } from "./commands/skills";
import { schemaCommand } from "./commands/schema";
import { openCommand } from "./commands/open";

// The `rvw` application: one route map over the eight review verbs, all live. Stricli
// supplies routing, `--help`, and argument scanning for the whole surface, so every command
// declares flags and positionals one way and shares one help/usage system. This module is
// pure data (no process, no I/O) — the entrypoint binds it to the real process, and tests
// bind it to capturing streams.

const routes = buildRouteMap<
  "validate" | "coverage" | "anchors" | "emit" | "check" | "skills" | "schema" | "open",
  LocalContext
>({
  routes: {
    validate: validateCommand,
    coverage: coverageCommand,
    anchors: anchorsCommand,
    emit: emitCommand,
    check: checkCommand,
    skills: skillsCommand,
    schema: schemaCommand,
    open: openCommand,
  },
  docs: {
    brief: "rvw — the review authoring toolchain",
    fullDescription: "Portable CLI a coding agent uses while authoring a review artifact.",
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
  });
}

export const app = buildRvwApplication(routes);
