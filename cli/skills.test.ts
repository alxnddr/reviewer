import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { bundledSkillsRoot, findSkill, listSkills } from "./skills";

// The seam is that a future review lens appears in `rvw skills` by shipping its directory, with
// no code change here — so the enumeration is driven against a synthesized skills root, and the
// *real* bundled root is asserted separately to prove the shipped `present-review` description
// is read from its frontmatter rather than compiled in.

function skillsRoot(skills: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "reviewer-skills-"));
  for (const [name, contents] of Object.entries(skills)) {
    mkdirSync(join(root, name));
    writeFileSync(join(root, name, "SKILL.md"), contents);
  }
  return root;
}

const PRESENT = `---
name: present-review
description: Presents a review you have already performed in the Reviewer app. User-invoked.
disable-model-invocation: true
---

# present-review
`;

const SECURITY = `---
name: security-review
description: Reads a diff for injection, authz, and secret-handling defects.
---

# security-review
`;

describe("listSkills", () => {
  it("reads name and description from frontmatter, never a hard-coded list", () => {
    const result = listSkills(skillsRoot({ "present-review": PRESENT }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.skills).toHaveLength(1);
    expect(result.skills[0]).toMatchObject({
      name: "present-review",
      description:
        "Presents a review you have already performed in the Reviewer app. User-invoked.",
    });
  });

  it("lists a second skill with no code change, ordered stably by directory", () => {
    const result = listSkills(
      skillsRoot({ "present-review": PRESENT, "security-review": SECURITY }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.skills.map((skill) => skill.name)).toEqual(["present-review", "security-review"]);
    expect(result.skills[1]?.description).toContain("injection");
  });

  it("unwraps a quoted description rather than printing the quotes", () => {
    // Quoting is what an author reaches for the moment a description opens with a colon-bearing
    // clause; the quotes are YAML syntax, and printing them in the listing (and in --json) made
    // the tool look broken.
    const quoted = '---\nname: x\ndescription: "Reviews a diff: carefully, and reports."\n---\n';
    const result = listSkills(skillsRoot({ x: quoted }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.skills[0]?.description).toBe("Reviews a diff: carefully, and reports.");
  });

  it("folds a block-scalar description instead of printing the fold marker", () => {
    // Descriptions are long prose, so they get wrapped. Read line-at-a-time, the description
    // was the literal `>-` and every folded line under it was dropped — a listing that looks
    // like it worked while telling an agent nothing about the skill.
    const folded = `---
name: x
description: >-
  Reviews a diff for injection, authz, and secret-handling defects,
  and reports what it found.
---
`;
    const result = listSkills(skillsRoot({ x: folded }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.skills[0]?.description).toBe(
      "Reviews a diff for injection, authz, and secret-handling defects, and reports what it found.",
    );
  });

  it("skips a directory that carries no SKILL.md rather than failing the listing", () => {
    const root = skillsRoot({ "present-review": PRESENT });
    mkdirSync(join(root, "reference"));
    const result = listSkills(root);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.skills.map((skill) => skill.name)).toEqual(["present-review"]);
  });

  it("fails loudly on a SKILL.md missing name or description — a broken bundle, not a silent omission", () => {
    const noName = "---\ndescription: has no name\n---\n";
    const result = listSkills(skillsRoot({ broken: noName }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain("missing `name` or `description`");
  });

  it("fails loudly on frontmatter that is not valid YAML, naming the file and the reason", () => {
    // An unquoted `: ` is the case the hand-rolled parser accepted by splitting on the first
    // colon; YAML reads it as a nested mapping and rejects it, which is what every frontmatter
    // reader an agent harness has does too. The rejection has to stay scoped: a broken bundle
    // names the file it is broken in and why, rather than a bare "cannot list skills".
    const malformed = "---\nname: x\ndescription: Reviews a diff: carefully.\n---\n";
    const root = skillsRoot({ broken: malformed });
    const result = listSkills(root);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain(join(root, "broken", "SKILL.md"));
    expect(result.message).toContain("frontmatter is not valid YAML");
    // The position has to be the position in the *file* — the description is on line 3 of the
    // SKILL.md — or naming the file is worse than useless. The fenced block starts a line in.
    expect(result.message).toContain("line 3");
    // The parser's excerpt ends in a newline and the reporter adds its own; a message that
    // ends in a blank line reads as one that got cut off.
    expect(result.message).not.toMatch(/\s$/u);
  });

  it("fails loudly on frontmatter that parses but is not a mapping", () => {
    const result = listSkills(skillsRoot({ broken: "---\njust a sentence\n---\n" }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain("is not a block of `key: value` pairs");
  });

  it("fails loudly on a SKILL.md with no frontmatter fence at all", () => {
    const result = listSkills(skillsRoot({ broken: "# just a heading\n" }));
    expect(result.ok).toBe(false);
  });

  it("reports an unreadable skills directory rather than an empty listing", () => {
    const result = listSkills(join(tmpdir(), "reviewer-skills-does-not-exist"));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain("cannot read skills directory");
  });
});

describe("a broken install", () => {
  it("fails the listing loudly when a SKILL.md exists but cannot be read", () => {
    // Absence means "this directory is not a skill" and is skipped. Anything else — here, a
    // SKILL.md the process may not read — means the skill IS installed and the listing would
    // otherwise omit it, telling an agent a lens it can see on disk does not exist.
    const root = skillsRoot({ "present-review": PRESENT });
    const unreadable = join(root, "present-review", "SKILL.md");
    chmodSync(unreadable, 0o000);
    try {
      const result = listSkills(root);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.message).toContain("cannot read");
      expect(result.message).toContain(unreadable);
    } finally {
      chmodSync(unreadable, 0o644);
    }
  });

  it("skips a directory that simply has no SKILL.md", () => {
    const root = skillsRoot({ "present-review": PRESENT });
    mkdirSync(join(root, "not-a-skill"));
    const result = listSkills(root);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.skills.map((skill) => skill.name)).toEqual(["present-review"]);
  });
});

describe("findSkill", () => {
  it("matches on the frontmatter name and models absence as null", () => {
    const result = listSkills(skillsRoot({ "present-review": PRESENT }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(findSkill(result.skills, "present-review")?.name).toBe("present-review");
    expect(findSkill(result.skills, "no-such-skill")).toBeNull();
  });
});

describe("bundledSkillsRoot", () => {
  it("resolves the shipped skills beside the CLI, listing present-review from its frontmatter", () => {
    const result = listSkills(bundledSkillsRoot());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const present = findSkill(result.skills, "present-review");
    expect(present).not.toBeNull();
    expect(present?.description).toContain("Reviewer app");
    expect(present?.path).toMatch(/\/skills\/present-review\/SKILL\.md$/u);
  });
});
