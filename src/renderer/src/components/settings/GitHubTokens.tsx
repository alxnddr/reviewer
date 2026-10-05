import { useState, type FormEvent, type ReactElement } from "react";
import { ExternalLink, KeyRound } from "lucide-react";
import type { GitHubTokenStatus } from "../../../../shared/github-posting";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { tokenRefusalMessage } from "@/lib/github-failure-message";
import {
  tokenCoverage,
  tokenExpiryLabel,
  tokenFormOffered,
  tokenKindLabel,
} from "@/lib/github-posting";
import { acceptGitHubLogin } from "@/lib/settings-catalog";
import { useGitHubStore } from "@/stores/github";
import { useReviewStore } from "@/stores/review";

// Settings ▸ GitHub's token block (Layer C): the tokens main holds, described; a field to paste
// one into; how to make a narrow one; and what the app can and cannot promise about it. Not a
// settings row — a token is not a setting (`shared/settings.ts` never sees one) and never sits in
// the settings store or on disk — so it is drawn here, under the section's rows, by the dialog.
//
// **A new token reaches the open reviews at once**: the ones of a pull request it covers ask
// GitHub again with it (`recheckWithToken`) — a private repository's diff check, and where their
// comments stand.
//
// **Write-only.** The field is a password field that empties itself the moment it is submitted,
// whatever main answers; the token goes straight to main (`stores/github.ts`), which answers with
// a description and keeps the token in memory until quit. Nothing on this screen ever shows a
// token again — a held one is its kind, login, owner and expiry, which GitHub tells anyone. Main
// also empties the clipboard when it still holds what was just pasted, accepted or not
// (`clipboardCleared`), and the message says so.
//
// **A run that can be read from outside says so here, and offers no field.** When the app was
// started with a debugging or network-logging switch (`main/github/exposure.ts`), main refuses
// tokens and posting for the run — and the field is not drawn at all, nor before main has said
// the run is clean, because a token typed into a page a debugger is attached to is read before
// main ever sees it. The block names the switch and what to do instead.
//
// **The copy says what to do, not everything that is true.** The first version listed every
// caveat from `next-features.md`'s threat model (C1) here: eight bullets and five numbered steps,
// which nobody read. What stays is what the reader acts on: what posting does, the owner field,
// a link that opens GitHub's token form pre-filled (`NEW_TOKEN_URL`), and the two facts that
// surprise people — memory-only, and an organization's approval. Every other caveat is said where
// it bites, by the failure that names it (`lib/github-failure-message.ts`: a classic token's
// scopes, an unapproved or too-narrow token, an expired one). Don't grow the list back here; put
// a new caveat in the failure message it explains.

/** GitHub's new fine-grained token form, pre-filled with a name, a description and the one
 * permission posting needs (`pull_requests=write`; GitHub adds Metadata read by itself). The
 * resource owner and the repositories stay the reader's to pick, which is the point of the
 * token being narrow. Query parameters per GitHub's "Managing your personal access tokens". */
const NEW_TOKEN_URL =
  "https://github.com/settings/personal-access-tokens/new?name=Reviewer&description=Post+pending+review+comments+from+Reviewer&pull_requests=write";

export function GitHubTokens(): ReactElement {
  const status = useGitHubStore((state) => state.status);
  const setToken = useGitHubStore((state) => state.setToken);
  const forget = useGitHubStore((state) => state.forget);
  const [token, setTokenText] = useState("");
  const [owner, setOwner] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "refused"; text: string } | null>(null);
  const ownerAccepted = owner.trim() === "" ? undefined : acceptGitHubLogin(owner);

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    const pasted = token.trim();
    // Out of the field before anything else happens, whatever the answer.
    setTokenText("");
    if (pasted === "" || ownerAccepted === null) {
      return;
    }
    setBusy(true);
    setMessage(null);
    void setToken(pasted, ownerAccepted).then((answer) => {
      setBusy(false);
      if (answer.ok) {
        setOwner("");
        // Open reviews of pull requests it covers ask GitHub again, with it.
        void useReviewStore.getState().recheckWithToken(answer.owner);
        setMessage({
          tone: "ok",
          text: `Token added: ${tokenCoverage(answer)}.${
            answer.clipboardCleared ? " Clipboard cleared." : ""
          }`,
        });
      } else {
        setMessage({
          tone: "refused",
          text: `${tokenRefusalMessage(answer.failure)}${
            answer.clipboardCleared ? " Clipboard cleared." : ""
          }`,
        });
      }
    });
  };

  const tokens = status?.tokens ?? [];
  const exposedBy = status?.exposedBy ?? [];
  const offered = tokenFormOffered(status);

  return (
    <section className="flex flex-col gap-3 py-3">
      <div>
        <span className="text-base font-medium text-foreground">Post to GitHub</span>
        <p className="mt-0.5 max-w-prose text-sm leading-snug text-text-muted">
          Post the comments you pick to a pull request as pending drafts. Only you see them until
          you submit the review on GitHub. Reviewer never submits.
        </p>
      </div>

      {exposedBy.length > 0 && (
        <p role="alert" className="max-w-prose text-sm leading-snug text-warning">
          Reviewer was started with{" "}
          {exposedBy.map((name, index) => (
            <span key={name}>
              {index > 0 && ", "}
              <code className="font-mono">{name.toUpperCase() === name ? name : `--${name}`}</code>
            </span>
          ))}
          , which lets other programs read this window. Tokens and posting are off. Quit Reviewer
          and open it again from the Dock or Finder.
        </p>
      )}

      {tokens.length === 0 ? (
        <p className="text-sm text-text-muted">No token yet.</p>
      ) : (
        <ul className="flex flex-col divide-y divide-border rounded-lg border border-border">
          {tokens.map((held) => (
            <TokenRow
              key={held.owner ?? "*"}
              token={held}
              onForget={() => void forget(held.owner)}
            />
          ))}
        </ul>
      )}

      {/* No field at all while the run is exposed, or before main has said it is not: a
          token typed into this window would pass through a page an attached debugger can read,
          before main could refuse it (`tokenFormOffered`). */}
      {offered && (
        <form className="flex flex-col gap-2" onSubmit={submit}>
          <div className="flex items-center gap-2">
            <Input
              className="w-44"
              value={owner}
              placeholder="Owner"
              aria-label="The account or organization the token is for"
              aria-invalid={ownerAccepted === null}
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              onChange={(event) => setOwner(event.target.value)}
            />
            <Input
              className="min-w-0 flex-1 font-mono"
              type="password"
              value={token}
              placeholder="github_pat_…"
              aria-label="GitHub token"
              autoComplete="off"
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              onChange={(event) => setTokenText(event.target.value)}
            />
            <Button
              type="submit"
              variant="outline"
              disabled={busy || token.trim() === "" || ownerAccepted === null}
            >
              {busy ? "Checking…" : "Add"}
            </Button>
          </div>
          <p className="text-xs text-text-muted">
            Owner is the account or organization the token is for. Leave it empty for your own.
          </p>
          {ownerAccepted === null && <p className="text-xs text-destructive">Not a GitHub name.</p>}
          {message !== null && (
            <p
              role="status"
              className={
                message.tone === "ok" ? "text-sm text-foreground" : "text-sm text-destructive"
              }
            >
              {message.text}
            </p>
          )}
        </form>
      )}

      <div className="flex max-w-prose flex-col items-start gap-1.5 text-sm leading-snug text-text-muted">
        <Button
          variant="outline"
          size="sm"
          // Through `window.open`, which main hands to `external-links.ts` (https only), like
          // every other link out of the app.
          onClick={() => window.open(NEW_TOKEN_URL, "_blank", "noopener")}
        >
          <ExternalLink />
          Create a token on GitHub
        </Button>
        <p>
          Pick the owner and only the repositories you review. Pull requests: Read and write is
          already set.
        </p>
        <p>
          Tokens stay in memory until you quit, never on disk. An organization may have to approve a
          token before it can post.
        </p>
      </div>
    </section>
  );
}

function TokenRow({
  token,
  onForget,
}: {
  token: GitHubTokenStatus;
  onForget: () => void;
}): ReactElement {
  return (
    <li className="flex items-center gap-3 px-3 py-2">
      <KeyRound aria-hidden="true" className="size-4 shrink-0 text-text-muted" />
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm text-foreground">{tokenCoverage(token)}</span>
        <span className="truncate text-xs text-text-muted">
          {tokenKindLabel(token.kind)} · {token.login} ·{" "}
          {tokenExpiryLabel(token.expiresAt, Date.now())}
        </span>
      </div>
      <Button variant="ghost" size="sm" onClick={onForget}>
        Forget
      </Button>
    </li>
  );
}
