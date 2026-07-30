import { shortRef } from "./refs";

// What a tab is called.
//
// It used to be the repository's name, which is the one fact every tab in a strip full of
// reviews shares: four tabs reading `reviewer · reviewer · reviewer · reviewer` name the
// folder the reader already knows they are in and say nothing about which of the four
// reviews is inside. A tab has one job — to be the thing you click when you want *that*
// review back — and a name that is identical across the strip cannot do it.
//
// So a tab is named after its content, in the same order of preference the recents picker
// uses (see `recentTitle`): the sentence someone wrote to name the change, else the branch
// it is about, else — for a plain repository session, which is the only kind of tab that is
// genuinely about a folder — the repository. Same rule in both places, so a review is
// called the same thing in the picker it was opened from and the tab it opened into.
//
// Uniqueness is the other half, and it cannot come from the name alone: two reviews can
// carry the same title, and two checkouts of one project have the same folder name. So the
// strip is named as a *set* (`tabNames`), and only the names that collide take a qualifier —
// a tab that is already unique never pays for its neighbours.

/** Everything that can name a tab, pulled out of the session slice so the naming is pure.
 *
 * `title` and `head` are null on a plain repository session (⌘O), which is what makes the
 * fallback to the repository name a statement about that kind of tab rather than a
 * last-resort guess: a folder someone opened to browse is about the folder. */
export type TabSubject = {
  repoName: string;
  repoPath: string;
  /** The review's authored tour-doc title, when it has one. */
  title: string | null;
  /** The review's head endpoint — a branch name or a sha. */
  head: string | null;
};

/** The folder above the repository, which is what tells two checkouts of one project apart:
 * `~/work/reviewer` and `~/oss/reviewer` are both "reviewer" and neither is the other. Empty
 * when there is no parent to name (a repo at the filesystem root, or a path from another
 * machine that arrived as a bare name). */
function parentDirName(path: string): string {
  const segments = path.split("/").filter((segment) => segment.length > 0);
  return segments.at(-2) ?? "";
}

/** What one tab is called, ignoring its neighbours. */
export function tabName(subject: TabSubject): string {
  const title = subject.title?.trim() ?? "";
  if (title !== "") {
    return title;
  }
  if (subject.head !== null && subject.head.trim() !== "") {
    return shortRef(subject.head);
  }
  return subject.repoName;
}

/** The candidates a colliding name may be qualified by, in the order they are tried: the
 * project, then the branch, then the folder the project sits in. Each is skipped when it
 * repeats what the name already says — appending `reviewer` to a tab called `reviewer`
 * lengthens it without distinguishing it from the tab beside it. */
function qualifiers(subject: TabSubject, name: string): string[] {
  const candidates = [
    subject.repoName,
    subject.head === null ? "" : shortRef(subject.head),
    parentDirName(subject.repoPath),
  ];
  return candidates.filter((candidate) => candidate !== "" && candidate !== name);
}

/** The whole strip's names, in the order the tabs are in.
 *
 * Duplicates are qualified with the first candidate that actually separates them from the
 * other tabs sharing the name — trying, rather than assuming, is what keeps `Fix the parser`
 * twice in one repo from becoming `Fix the parser · reviewer` twice. Two tabs that agree on
 * every fact a name can be built from stay identical, which is honest: nothing on either
 * one distinguishes it, and the hover hint carries the path for the reader who needs to be
 * sure. */
export function tabNames(subjects: readonly TabSubject[]): string[] {
  const names = subjects.map((subject) => tabName(subject));
  const shared = new Map<string, number[]>();
  for (const [index, name] of names.entries()) {
    shared.set(name, [...(shared.get(name) ?? []), index]);
  }
  const resolved = [...names];
  for (const [name, indexes] of shared) {
    if (indexes.length < 2) {
      continue;
    }
    // The qualified form is only an improvement if it is *distinct*: a candidate every
    // colliding tab answers the same way leaves the strip exactly as ambiguous as it was.
    const options = indexes.map((index) => {
      const subject = subjects[index];
      return subject === undefined ? [] : qualifiers(subject, name);
    });
    const depth = Math.max(...options.map((option) => option.length));
    for (let level = 0; level < depth; level += 1) {
      const picked = options.map((option) => option[level] ?? null);
      const distinct = new Set(picked.filter((value) => value !== null));
      if (distinct.size !== picked.length) {
        continue;
      }
      for (const [position, index] of indexes.entries()) {
        const qualifier = picked[position];
        if (qualifier !== undefined && qualifier !== null) {
          resolved[index] = `${name} · ${qualifier}`;
        }
      }
      break;
    }
  }
  return resolved;
}
