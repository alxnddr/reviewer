import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { bundledSkillsRoot, findSkill, listSkills } from "./skills";

// The seam is that a future review lens appears in `rvw skills` by shipping its directory, with
// no code change here — so the enumeration is driven against a synthesized skills root, and the
// *real* bundled root is asserted separately to prove the shipped `authoring-review` description
// is read from its frontmatter rather than compiled in.

function skillsRoot(skills: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "reviewer-skills-"));
  for (const [name, contents] of Object.entries(skills)) {
    mkdirSync(join(root, name));
    writeFileSync(join(root, name, "SKILL.md"), contents);
  }
  return root;
}

const AUTHORING = `---
name: authoring-review
description: Reviews a git range and authors a .reviewer.json. User-invoked.
disable-model-invocation: true
---

# authoring-review
`;

const SECURITY = `---
name: security-review
description: Reads a diff for injection, authz, and secret-handling defects.
---

# security-review
`;

describe("listSkills", () => {
  it("reads name and description from frontmatter, never a hard-coded list", () => {
    const result = listSkills(skillsRoot({ "authoring-review": AUTHORING }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.skills).toHaveLength(1);
    expect(result.skills[0]).toMatchObject({
      name: "authoring-review",
      description: "Reviews a git range and authors a .reviewer.json. User-invoked.",
    });
  });

  it("lists a second skill with no code change, ordered stably by directory", () => {
    const result = listSkills(
      skillsRoot({ "authoring-review": AUTHORING, "security-review": SECURITY }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.skills.map((skill) => skill.name)).toEqual([
      "authoring-review",
      "security-review",
    ]);
    expect(result.skills[1]?.description).toContain("injection");
  });

  it("keeps a description containing a colon intact, splitting only on the first one", () => {
    const withColon = "---\nname: x\ndescription: Reviews a diff: carefully, and reports.\n---\n";
    const result = listSkills(skillsRoot({ x: withColon }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.skills[0]?.description).toBe("Reviews a diff: carefully, and reports.");
  });

  it("skips a directory that carries no SKILL.md rather than failing the listing", () => {
    const root = skillsRoot({ "authoring-review": AUTHORING });
    mkdirSync(join(root, "reference"));
    const result = listSkills(root);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.skills.map((skill) => skill.name)).toEqual(["authoring-review"]);
  });

  it("fails loudly on a SKILL.md missing name or description — a broken bundle, not a silent omission", () => {
    const noName = "---\ndescription: has no name\n---\n";
    const result = listSkills(skillsRoot({ broken: noName }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain("missing `name` or `description`");
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
    const root = skillsRoot({ "authoring-review": AUTHORING });
    const unreadable = join(root, "authoring-review", "SKILL.md");
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
    const root = skillsRoot({ "authoring-review": AUTHORING });
    mkdirSync(join(root, "not-a-skill"));
    const result = listSkills(root);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.skills.map((skill) => skill.name)).toEqual(["authoring-review"]);
  });
});

describe("findSkill", () => {
  it("matches on the frontmatter name and models absence as null", () => {
    const result = listSkills(skillsRoot({ "authoring-review": AUTHORING }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(findSkill(result.skills, "authoring-review")?.name).toBe("authoring-review");
    expect(findSkill(result.skills, "no-such-skill")).toBeNull();
  });
});

describe("bundledSkillsRoot", () => {
  it("resolves the shipped skills beside the CLI, listing authoring-review from its frontmatter", () => {
    const result = listSkills(bundledSkillsRoot());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const authoring = findSkill(result.skills, "authoring-review");
    expect(authoring).not.toBeNull();
    expect(authoring?.description).toContain(".reviewer.json");
    expect(authoring?.path).toMatch(/\/skills\/authoring-review\/SKILL\.md$/);
  });
});
