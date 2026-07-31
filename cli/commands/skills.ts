import { buildCommand } from "@stricli/core";
import { bundledSkillsRoot, findSkill, listSkills, type SkillSummary } from "../skills";
import { EXIT_READY, type LocalContext } from "../context";
import { writeCannotRun, writeJson } from "../errors";

// `rvw skills [<name>]` — what reviews this toolchain can run. An agent landing in an
// unfamiliar repo asks the tool, not out-of-band prose. The listing is read from the bundled
// skills directory, so a future lens appears by shipping its directory. Naming one prints its
// path, which the agent then opens for the full instructions: the CLI enumerates and points,
// it never interprets or executes a skill.

type SkillsFlags = {
  readonly json?: boolean;
};

export const skillsCommand = buildCommand<SkillsFlags, [string | undefined], LocalContext>({
  docs: {
    brief: "List the bundled review skills, or print one skill's path",
    fullDescription: [
      "With no argument, lists every bundled review skill with its description. With a skill",
      "name, prints that skill's absolute path so you can open its instructions. The listing is",
      "read from the skills directory shipped beside the CLI, not from the repo you are",
      "reviewing, so it is the same wherever you run it. Exit 0 on a listing or a found skill;",
      "2 when the skills directory cannot be read or no skill claims the name.",
    ].join("\n"),
    customUsage: ["", "--json", "present-review", "present-review --json"],
  },
  parameters: {
    flags: {
      json: {
        kind: "boolean",
        brief: "Emit the structured SkillSummary list (or the named skill) as JSON on stdout",
        optional: true,
      },
    },
    positional: {
      kind: "tuple",
      parameters: [{ brief: "Name of one skill to locate", parse: String, optional: true }],
    },
  },
  func(this: LocalContext, flags: SkillsFlags, name: string | undefined): void {
    const root = bundledSkillsRoot();
    const result = listSkills(root);
    if (!result.ok) {
      writeCannotRun(this, flags.json, { code: "skillsUnreadable", message: result.message });
      return;
    }

    if (name === undefined) {
      writeListing(this, flags, result.skills);
      this.process.exitCode = EXIT_READY;
      return;
    }

    const skill = findSkill(result.skills, name);
    if (skill === null) {
      // Not a review problem (exit 1) — there is no review here. The agent asked for a skill
      // that does not exist, so the command could not run: name the ones that do.
      const known = result.skills.map((each) => each.name).join(", ");
      writeCannotRun(this, flags.json, {
        code: "noSuchSkill",
        message: `no skill named ${name}${known === "" ? "" : ` — try: ${known}`}`,
      });
      return;
    }

    if (flags.json === true) {
      writeJson(this, skill);
    } else {
      this.process.stdout.write(`${skill.path}\n`);
    }
    this.process.exitCode = EXIT_READY;
  },
});

/** The listing on either channel. An empty skills directory prints an honest "no skills"
 * rather than silent success, so a broken bundle reads as broken. */
function writeListing(
  context: LocalContext,
  flags: SkillsFlags,
  skills: readonly SkillSummary[],
): void {
  if (flags.json) {
    writeJson(context, skills);
    return;
  }
  if (skills.length === 0) {
    context.process.stdout.write("no review skills bundled\n");
    return;
  }
  for (const skill of skills) {
    context.process.stdout.write(`${skill.name}\n  ${skill.description}\n  ${skill.path}\n`);
  }
}
