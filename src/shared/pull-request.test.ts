import { describe, expect, it } from "vitest";
import {
  githubPullRequestOf,
  parseGitHubRemote,
  parsePullRequestArg,
  pullRequestLabel,
  pullRequestUrl,
  placedWorktreeRef,
  pullRequestRef,
  redactUrlCredentials,
  type PullRequest,
} from "./pull-request";

// The spellings of a pull request and of a github.com remote. Every accepted spelling is
// asserted to the exact value it names, and every refusal to the code it is refused with,
// because the CLI composes a different sentence for each code and a refusal that drifted from
// `notGitHub` to `unparseable` would tell a GitLab user to fix a typo they did not make.

const PR: PullRequest = { host: "github.com", owner: "acme", repo: "widgets", number: 42 };

describe("parsePullRequestArg", () => {
  it("reads a pull request URL, whatever tab, slash, query or fragment follows it", () => {
    for (const url of [
      "https://github.com/acme/widgets/pull/42",
      "https://github.com/acme/widgets/pull/42/",
      "https://github.com/acme/widgets/pull/42/files",
      "https://github.com/acme/widgets/pull/42/changes#diff-abc",
      "https://github.com/acme/widgets/pull/42/commits?w=1",
      "https://www.github.com/acme/widgets/pull/42",
      "http://github.com/acme/widgets/pull/42",
      "HTTPS://GitHub.com/acme/widgets/pull/42",
      "  https://github.com/acme/widgets/pull/42\n",
      "https://github.com/acme/widgets/pull/42/checks",
      "https://github.com/acme/widgets/pull/42/files/0123abc",
      "https://github.com/acme/widgets/pull/42/changes/0123abc..4567def",
      "https://github.com/acme/widgets/pull/42/commits/0123456789abcdef0123456789abcdef01234567",
      // A token in the userinfo is skipped, and one holding an `@` does not fool the host.
      "https://user:p@ss@github.com/acme/widgets/pull/42",
      // The pastes that lose their scheme.
      "github.com/acme/widgets/pull/42",
      "www.github.com/acme/widgets/pull/42/files",
      // `.git` off the repo, as the remote parse does, so the two compare like with like.
      "https://github.com/acme/widgets.git/pull/42",
    ]) {
      expect(parsePullRequestArg(url), url).toEqual({
        ok: true,
        arg: { kind: "pullRequest", pullRequest: PR },
      });
    }
  });

  it("reads owner/repo#n, and a bare number with or without its #", () => {
    for (const slug of ["acme/widgets#42", "acme/widgets.git#42"]) {
      expect(parsePullRequestArg(slug), slug).toEqual({
        ok: true,
        arg: { kind: "pullRequest", pullRequest: PR },
      });
    }
    for (const bare of ["42", "#42", " 42 "]) {
      expect(parsePullRequestArg(bare), bare).toEqual({
        ok: true,
        arg: { kind: "number", number: 42 },
      });
    }
  });

  it("keeps the owner's and the repo's case as written — a URL's host is case-blind, its path is not", () => {
    const parsed = parsePullRequestArg("https://github.com/Acme/Widgets.js/pull/7");
    expect(parsed).toEqual({
      ok: true,
      arg: {
        kind: "pullRequest",
        pullRequest: { host: "github.com", owner: "Acme", repo: "Widgets.js", number: 7 },
      },
    });
  });

  it("refuses a URL on another host as notGitHub", () => {
    for (const url of [
      "https://gitlab.com/acme/widgets/-/merge_requests/42",
      "https://github.example.com/acme/widgets/pull/42",
      "https://bitbucket.org/acme/widgets/pull-requests/42",
    ]) {
      expect(parsePullRequestArg(url), url).toEqual({ ok: false, reason: "notGitHub" });
    }
  });

  it("refuses anything that names no pull request, or one GitHub could not have issued", () => {
    for (const text of [
      "",
      "0",
      "#0",
      "-3",
      "4.2",
      "99999999999999999999",
      "acme/widgets",
      "acme/widgets#",
      "acme/widgets#0",
      "acme#42",
      "a/b/c#42",
      "-acme/widgets#42",
      "acme/..#42",
      "acme/wid gets#42",
      "https://github.com/acme/widgets",
      "https://github.com/acme/widgets/issues/42",
      "https://github.com/acme/widgets/pulls/42",
      "https://github.com/acme/widgets/pull/abc",
      "https://github.com/acme/widgets/pull/0",
      "https://github.com/acme/../pull/42",
      "ssh://github.com/acme/widgets/pull/42",
      // Empty segments are refused, not collapsed into a pull request.
      "https://github.com//acme//widgets//pull//42",
      "https://github.com/acme/widgets/pull//42",
      // Nothing after the number but a known tab and, under it, one commit or range.
      "https://github.com/acme/widgets/pull/42/../../../x",
      "https://github.com/acme/widgets/pull/42/./files",
      "https://github.com/acme/widgets/pull/42/conversation",
      "https://github.com/acme/widgets/pull/42/files/not-a-sha",
      "https://github.com/acme/widgets/pull/42/files/0123abc/more",
      "https://github.com/./widgets/pull/42",
      "https://github.com/acme/./pull/42",
      // An explicit port is not how anyone reaches github.com's pages.
      "https://github.com:443/acme/widgets/pull/42",
      "https://github.com:8443/acme/widgets/pull/42",
      "ftp.github.com/acme/widgets/pull/42",
    ]) {
      expect(parsePullRequestArg(text), text).toEqual({ ok: false, reason: "unparseable" });
    }
  });
});

describe("parseGitHubRemote", () => {
  const WIDGETS = { ok: true, repo: { owner: "acme", repo: "widgets" } };

  it("reads every spelling git uses for a github.com remote, with or without .git and a trailing slash", () => {
    for (const remote of [
      "https://github.com/acme/widgets",
      "https://github.com/acme/widgets.git",
      "https://github.com/acme/widgets/",
      "https://github.com/acme/widgets.git/",
      "https://user@github.com/acme/widgets.git",
      "https://x-access-token:secret@github.com/acme/widgets.git",
      "https://github.com:443/acme/widgets.git",
      "http://github.com/acme/widgets",
      "git@github.com:acme/widgets.git",
      "git@github.com:acme/widgets",
      "git@github.com:acme/widgets/",
      "git@github.com:/acme/widgets.git",
      "github.com:acme/widgets.git",
      "ssh://git@github.com/acme/widgets",
      "ssh://git@github.com/acme/widgets.git",
      "ssh://git@ssh.github.com:443/acme/widgets.git",
      "git+ssh://git@github.com/acme/widgets.git",
      "git://github.com/acme/widgets.git",
      "https://GitHub.com/acme/widgets\n",
      "https://user:p@ss@github.com/acme/widgets.git",
    ]) {
      expect(parseGitHubRemote(remote), remote).toEqual(WIDGETS);
    }
  });

  it("keeps a repo name that merely contains .git, and strips only the suffix", () => {
    expect(parseGitHubRemote("git@github.com:acme/widgets.github.io.git")).toEqual({
      ok: true,
      repo: { owner: "acme", repo: "widgets.github.io" },
    });
  });

  it("refuses a remote on any other host, or no host at all, as notGitHub", () => {
    for (const remote of [
      "https://gitlab.com/acme/widgets.git",
      "git@gitlab.com:acme/widgets.git",
      "ssh://git@bitbucket.org/acme/widgets.git",
      "https://github.example.com/acme/widgets.git",
      "https://notgithub.com/acme/widgets.git",
      "/srv/git/widgets.git",
      "../widgets",
      "file:///srv/git/widgets.git",
      "",
    ]) {
      expect(parseGitHubRemote(remote), remote).toEqual({ ok: false, reason: "notGitHub" });
    }
  });

  it("refuses a github.com remote whose path is not exactly owner/repo", () => {
    for (const remote of [
      "https://github.com/acme",
      "https://github.com/acme/widgets/tree/main",
      "git@github.com:acme.git",
      "https://github.com/acme/..",
      "https://github.com/-acme/widgets",
    ]) {
      expect(parseGitHubRemote(remote), remote).toEqual({ ok: false, reason: "unparseable" });
    }
  });
});

describe("the pull request's spellings once known", () => {
  it("is completed from the repository a bare number was asked about", () => {
    expect(githubPullRequestOf({ owner: "acme", repo: "widgets" }, 42)).toEqual(PR);
  });

  it("has a page and a short label", () => {
    expect(pullRequestUrl(PR)).toBe("https://github.com/acme/widgets/pull/42");
    expect(pullRequestLabel(PR)).toBe("acme/widgets#42");
  });
});

describe("redactUrlCredentials", () => {
  it("drops the whole userinfo, through the last @ before the path", () => {
    expect(redactUrlCredentials("https://user:p@ss@gitlab.com/o/r.git")).toBe(
      "https://gitlab.com/o/r.git",
    );
    expect(redactUrlCredentials("https://glpat-SECRET@gitlab.com/o/r/-/merge_requests/1")).toBe(
      "https://gitlab.com/o/r/-/merge_requests/1",
    );
  });

  it("redacts every URL in a line, including a password that holds a / or an @", () => {
    expect(
      redactUrlCredentials(
        "fatal: unable to access 'https://x-access-token:ghp_secret@github.com/a/b.git/': 403",
      ),
    ).toBe("fatal: unable to access 'https://github.com/a/b.git/': 403");
    expect(redactUrlCredentials("from https://u:p@ss@github.com/a and ssh://me:pw@h/x")).toBe(
      "from https://github.com/a and ssh://h/x",
    );
    // A `/` in the password: over-redacted rather than leaked.
    expect(redactUrlCredentials("https://u:p/w@github.com/a/b")).toBe("https://github.com/a/b");
    expect(redactUrlCredentials("https://github.com:443/a/b@c")).toBe(
      "https://github.com:443/a/b@c",
    );
  });

  it("leaves a URL without userinfo, an @ in its path, and a non-URL alone", () => {
    for (const text of [
      "https://github.com/acme/widgets",
      "https://github.com/acme/widgets/blob/main/a@b.ts",
      "git@github.com:acme/widgets.git",
      "acme/widgets#42",
    ]) {
      expect(redactUrlCredentials(text), text).toBe(text);
    }
  });
});

describe("pullRequestRef", () => {
  it("namespaces the fetched head by owner and repository, lowercased", () => {
    // A fork's #12 and its upstream's #12 live in one checkout and must not share a ref.
    expect(pullRequestRef({ host: "github.com", owner: "Acme", repo: "Widget", number: 12 })).toBe(
      "refs/rvw/pr/acme/widget/12",
    );
    expect(pullRequestRef({ host: "github.com", owner: "me", repo: "widget", number: 12 })).toBe(
      "refs/rvw/pr/me/widget/12",
    );
  });

  it("encodes every dot, so names git refuses as ref components still make a ref", () => {
    // A leading dot, a `.lock` suffix and a double dot are each a `git check-ref-format`
    // refusal (`fatal: invalid refspec`) and each a valid GitHub repository name.
    const ref = (repo: string) =>
      pullRequestRef({ host: "github.com", owner: "acme", repo, number: 7 });
    expect(ref(".github")).toBe("refs/rvw/pr/acme/%2egithub/7");
    expect(ref("x.lock")).toBe("refs/rvw/pr/acme/x%2elock/7");
    expect(ref("a..b")).toBe("refs/rvw/pr/acme/a%2e%2eb/7");
    expect(
      placedWorktreeRef({ host: "github.com", owner: "Acme", repo: ".github", number: 7 }),
    ).toBe("refs/rvw/placed/acme/%2egithub/7");
  });
});
