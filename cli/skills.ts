import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { errorMessage, isNotFound } from "./errors";

// The discovery surface behind `rvw skills`: what review skills exist, read off disk rather
// than compiled in, so a future lens (security, performance) appears in the listing by adding
// its directory — no code change here. The CLI only enumerates and points at a path; the
// skills stay agent skills and this module never interprets a body.

/** One bundled review skill, as an agent needs it: what it is called, what it does, and
 * the path to open for the full instructions. `path` is absolute so it resolves from
 * whatever repo the agent is reviewing, never relative to their cwd. */
export type SkillSummary = {
  readonly name: string;
  readonly description: string;
  readonly path: string;
};

/** Enumerating reads our own bundled directory, so a malformed skill is a broken install,
 * not user error — it surfaces as a message the shell maps to exit 2 rather than a listing
 * that silently omits the skill an agent was looking for. */
export type SkillsResult = { ok: true; skills: SkillSummary[] } | { ok: false; message: string };

const SKILL_FILE = "SKILL.md";
const FRONTMATTER_FENCE = "---";

/** The review skills are CLI assets that ship *beside* the CLI, so the root is resolved from
 * this module's own location, never from `process.cwd()` — `rvw skills` run inside a foreign
 * repo must list the skills shipped with rvw, not whatever `skills/` that repo happens to have.
 * Both entrypoints that load this code sit exactly one directory below the install root
 * (`cli/index.ts` in the checkout, `dist/rvw.js` in the built bundle, which collapses this
 * module into it), so `..` is the root in both. A `--compile` binary would break that
 * invariant — one more reason the distribution is a bundle. */
export function bundledSkillsRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "skills");
}

/** Every skill under `root`, ordered by name so the listing is stable across filesystems.
 * A directory without a `SKILL.md` is not a skill and is skipped. Anything else — a
 * `SKILL.md` that cannot be read, or one lacking `name`/`description` — is a broken
 * install and fails the whole listing loudly, because the alternative is telling an agent
 * that the lens it is looking for does not exist. */
export function listSkills(root: string): SkillsResult {
  let entries: string[];
  try {
    entries = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch (error) {
    return { ok: false, message: `cannot read skills directory ${root}: ${errorMessage(error)}` };
  }

  const skills: SkillSummary[] = [];
  for (const entry of entries.toSorted()) {
    const path = join(root, entry, SKILL_FILE);
    let bytes: string;
    try {
      bytes = readFileSync(path, "utf8");
    } catch (error) {
      if (isNotFound(error)) {
        continue;
      }
      return { ok: false, message: `cannot read ${path}: ${errorMessage(error)}` };
    }
    const frontmatter = parseFrontmatter(bytes);
    const name = frontmatter.get("name");
    const description = frontmatter.get("description");
    if (name === undefined || description === undefined) {
      return { ok: false, message: `${path} frontmatter is missing \`name\` or \`description\`` };
    }
    skills.push({ name, description, path });
  }
  return { ok: true, skills };
}

/** The named skill, or `null` when no skill claims that name — absence is a real answer
 * the shell reports, not an exception. Matched on the frontmatter `name`, which is the
 * identity an agent has seen in the listing, not the directory it happens to live in. */
export function findSkill(skills: readonly SkillSummary[], name: string): SkillSummary | null {
  return skills.find((skill) => skill.name === name) ?? null;
}

/** The leading `---` fenced block as key/value pairs. Deliberately not a YAML parser: skill
 * frontmatter is flat `key: value` scalars, and the two keys read here are strings, so a
 * dependency would buy nothing and would have to be bundled. A value may contain `:` (the
 * descriptions do), so only the first colon separates. A file without a fence yields no
 * keys, which the caller reports as a missing `name`. */
function parseFrontmatter(bytes: string): ReadonlyMap<string, string> {
  const lines = bytes.split("\n");
  if (lines[0]?.trim() !== FRONTMATTER_FENCE) {
    return new Map();
  }
  const pairs = new Map<string, string>();
  for (const line of lines.slice(1)) {
    if (line.trim() === FRONTMATTER_FENCE) {
      break;
    }
    const separator = line.indexOf(":");
    if (separator === -1) {
      continue;
    }
    pairs.set(line.slice(0, separator).trim(), line.slice(separator + 1).trim());
  }
  return pairs;
}
