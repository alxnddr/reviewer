// A file name as `git diff` wrote it, back to the name itself.
//
// git C-quotes a path it considers unusual: the whole name in double quotes, with `\"`, `\\`,
// `\t`, `\n` and the other C escapes, and — while `core.quotePath` is on, git's default and the
// code host's — every byte outside printable ASCII as a three-digit octal escape, so
// `11.常用.md` is written `"a/11.\345\270\270\347\224\250.md"`. This app's own capture turns
// `core.quotePath` off (`shared/node/git-diff.ts`), but even then git still quotes a name that
// holds a `"`, a backslash, a tab or a newline. So the same file can reach the app spelled two
// ways, and only one of them is the name a reader (or an agent writing an anchor) sees.
//
// The patch parser (`@pierre/diffs`, through `shared/diff/patch.ts`) does not undo any of it, and
// leaves one of two shapes: from a `diff --git` header it strips the quotes and the `a/`/`b/`
// prefix but keeps the escapes (`Day01-20/11.\345\270….md`); from a `rename to` line it keeps the
// quotes as well (`"new\tq.txt"`). `unquoteGitPath` takes either back to the name. It is applied
// where two diffs' names are *compared* (`remote-diff.ts`, the check against GitHub's diff), not
// inside `parsePatch`: every placement against a diff the app parses itself stays byte-for-byte
// what it was, because the anchors stored against those names were written against them.
//
// **What it decides by, and the limit of that.** The parser does not say whether a name came from
// a quoted form, so the backslash does: git quotes every name that needs an escape, and a quoted
// name always holds at least one backslash (the escape that made it need quoting), while git
// never writes a backslash in a name it left unquoted — a backslash is itself one of the
// characters that forces quoting. So a name with no backslash is taken as it is, surrounding
// quotes and all (a file really named `"abc"` stays `"abc"`), and only a name with one is read as
// git's escaped spelling. The limit: that reading is applied to whatever it is given, so a string
// that is *already* a decoded name and happens to contain a backslash (`a\101` meant literally)
// would be decoded again — the function is not idempotent on such names. Every name here comes
// straight from a diff git (or the code host) wrote, or from an anchor written against one,
// so it is read exactly once.

/** The single-character C escapes git writes inside a quoted name. */
const SIMPLE_ESCAPES: Readonly<Record<string, number>> = {
  a: 0x07,
  b: 0x08,
  t: 0x09,
  n: 0x0a,
  v: 0x0b,
  f: 0x0c,
  r: 0x0d,
  '"': 0x22,
  "\\": 0x5c,
};

const UTF8 = new TextEncoder();

/** A path as git printed it — quoted (`"a\tb"`), escaped with the quotes already stripped
 * (`a\tb`), or plain — as the name it stands for, UTF-8 decoded. A name with no backslash comes
 * back exactly as it went in, quotes included; an escape git would never write (`\q`, a
 * truncated `\34`) is kept literally rather than guessed at. */
export function unquoteGitPath(name: string): string {
  if (!name.includes("\\")) {
    return name;
  }
  const quoted = name.length >= 2 && name.startsWith('"') && name.endsWith('"');
  const body = quoted ? name.slice(1, -1) : name;
  const bytes: number[] = [];
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index] ?? "";
    if (char !== "\\") {
      // A code point at a time, so a surrogate pair stays one character.
      const point = body.codePointAt(index) ?? 0;
      const text = String.fromCodePoint(point);
      bytes.push(...UTF8.encode(text));
      index += text.length - 1;
      continue;
    }
    const next = body[index + 1] ?? "";
    const octal = /^[0-3][0-7]{2}$/u.exec(body.slice(index + 1, index + 4));
    if (octal !== null) {
      bytes.push(Number.parseInt(octal[0], 8));
      index += 3;
    } else if (next in SIMPLE_ESCAPES) {
      bytes.push(SIMPLE_ESCAPES[next] ?? 0);
      index += 1;
    } else {
      bytes.push(0x5c);
    }
  }
  return new TextDecoder("utf-8").decode(new Uint8Array(bytes));
}
