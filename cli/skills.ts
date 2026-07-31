import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { errnoCode, errorMessage } from "../src/shared/errors";

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
 * `SKILL.md` that cannot be read, one whose frontmatter is not parseable YAML, or one
 * lacking `name`/`description` — is a broken install and fails the whole listing loudly,
 * because the alternative is telling an agent that the lens it is looking for does not
 * exist. */
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
      // Absence is the one error read as an answer rather than a failure: a directory
      // without a `SKILL.md` is not a skill. Every other read error (permissions, a
      // directory where the file belongs, a symlink loop) means the path exists and could
      // not be read — a broken install, not a missing one, and it fails the listing.
      if (errnoCode(error) === "ENOENT") {
        continue;
      }
      return { ok: false, message: `cannot read ${path}: ${errorMessage(error)}` };
    }
    const frontmatter = parseFrontmatter(bytes);
    if (!frontmatter.ok) {
      return { ok: false, message: `${path} frontmatter ${frontmatter.reason}` };
    }
    const name = frontmatter.fields.get("name");
    const description = frontmatter.fields.get("description");
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

/** The fenced block's string fields, or why it could not be read — the two outcomes the
 * caller turns into a listing or a scoped failure. */
type FrontmatterResult =
  | { ok: true; fields: ReadonlyMap<string, string> }
  | { ok: false; reason: string };

/** The leading `---` fenced block, parsed as the YAML it declares itself to be. This was
 * hand-rolled — frontmatter is flat `key: value` scalars and only two string keys are read,
 * so the argument was that a parser buys nothing — but descriptions are long prose, and prose
 * is exactly what authors quote and fold. Read a line at a time, `description: "Foo: bar"`
 * kept its quotes and `description: >-` yielded the fold marker `>-` while the folded text
 * below it was dropped (or, if a continuation line held a colon, invented a key from it).
 * Both print as the description, in the listing and in `--json`, and neither reads as a bug
 * in rvw. What the ~230 KB `yaml` adds to the (unminified) bundle buys is that class of
 * confidently wrong output, not a failure rate.
 *
 * The strictness comes with it: an unquoted `Foo: bar` is a nested mapping, not a scalar, so
 * a description that used to be silently split on the first colon now fails the listing by
 * name. That is affordable because the skills ship beside the CLI and `skills.test.ts` parses
 * the real bundled root — the error lands on whoever writes the SKILL.md, not on whoever runs
 * `rvw skills`.
 *
 * Only string values are kept: `name` and `description` are strings, and a `SKILL.md` whose
 * `name` parsed as a number or a list has no name as far as this module is concerned. A file
 * without a fence yields no fields, which the caller reports as a missing `name`. */
function parseFrontmatter(bytes: string): FrontmatterResult {
  const lines = bytes.split("\n");
  if (lines[0]?.trim() !== FRONTMATTER_FENCE) {
    return { ok: true, fields: new Map() };
  }
  // The closing fence ends the document; without one the rest of the file is the block, which
  // is what the line-at-a-time parser did and is the reading that yields the clearest error.
  // The opening fence is handed to the parser as a blank line rather than dropped, so `yaml`'s
  // "at line N" counts lines of the *file* — the number an author goes and looks at — instead
  // of lines of the block, one short of it.
  const close = lines.findIndex((line, index) => index > 0 && line.trim() === FRONTMATTER_FENCE);
  const block = ["", ...lines.slice(1, close === -1 ? undefined : close)].join("\n");
  let document: unknown;
  try {
    document = parseYaml(block);
  } catch (error) {
    // A parse error carries a caret-marked excerpt and ends in a newline; the reporter adds
    // its own, and a cannot-run that ends in a blank line reads as output that got cut off.
    return { ok: false, reason: `is not valid YAML: ${errorMessage(error).trimEnd()}` };
  }
  // An empty block is no fields rather than an error: "missing `name` or `description`" says
  // more about that file than "not a mapping" does. A scalar or a list is neither.
  if (document === null || document === undefined) {
    return { ok: true, fields: new Map() };
  }
  if (typeof document !== "object" || Array.isArray(document)) {
    return { ok: false, reason: "is not a block of `key: value` pairs" };
  }
  const fields = new Map<string, string>();
  for (const [key, value] of Object.entries(document)) {
    if (typeof value === "string") {
      fields.set(key, value);
    }
  }
  return { ok: true, fields };
}
