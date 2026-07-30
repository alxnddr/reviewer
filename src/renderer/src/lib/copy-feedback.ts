import { useCallback, useEffect, useRef, useState } from "react";

// The copied check, in one place. Four controls in the app put something on the clipboard —
// a file's path on its diff header, the agent prompt on the start screen, a comment as a
// prompt, and every comment as a prompt — and each of them answers the same way: the copy
// glyph becomes a check for a moment and then goes back. That is the only feedback any of
// them gets, which is also what makes it load-bearing: a failed write shows nothing, so a
// check means it happened and its absence means it did not.
//
// It was two copies of the same effect and two definitions of the same duration before the
// prompt copies would have made it four.

/** How long a copied check stands in for the copy glyph. */
export const COPY_FEEDBACK_MS = 1500;

/** The flash, for a copy whose success the caller learns for itself — it has the promise, so
 * it calls `confirm` when the write resolves and never when it rejects.
 *
 * A ticket rather than a boolean, so a second copy during a flash restarts the timer instead
 * of riding out the first one's: at that point the reader has pressed twice and is owed two
 * acknowledgements, or at least one that lasts as long as the last press. */
export function useCopyFeedback(): { copied: boolean; confirm: () => void } {
  const [ticket, setTicket] = useState(0);
  const confirm = useCallback(() => setTicket((value) => value + 1), []);

  useEffect(() => {
    if (ticket === 0) {
      return;
    }
    const timer = window.setTimeout(() => setTicket(0), COPY_FEEDBACK_MS);
    return () => window.clearTimeout(timer);
  }, [ticket]);

  return { copied: ticket > 0, confirm };
}

/** The same flash, driven by a token that changes on every successful copy — the shape a
 * control needs when the copy it reports can also be performed from a menu accelerator,
 * where there is no click of its own to hang a promise off. The store records the copy and
 * bumps the token; the control that the copy was *about* watches it and flashes.
 *
 * Value-compared against a mount-seeded ref, the idiom `DiffView`'s scroll effects use: a
 * control that mounts with a token already set finds it unchanged and stays quiet. Without
 * that, a card scrolling back into a virtualized diff — or a tab switched away from and
 * back — would replay a check for a copy that happened minutes ago.
 *
 * `null` means nothing has been copied that this control speaks for. */
export function useCopiedFlash(token: number | null): boolean {
  const { copied, confirm } = useCopyFeedback();
  const seen = useRef(token);

  useEffect(() => {
    if (token === seen.current) {
      return;
    }
    seen.current = token;
    if (token !== null) {
      confirm();
    }
  }, [token, confirm]);

  return copied;
}
