import { useEffect, useState, type ReactElement } from "react";
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Kbd } from "@/components/ui/kbd";
import { isEditable } from "@/lib/shortcut-guard";
import { SHORTCUT_SHEET } from "@/lib/shortcuts";

// Every shortcut the app answers to, in one place, on the key everyone already tries.
//
// The app had accumulated a real keyboard vocabulary — j/k through the files, n/p through
// the comments, r to mark one read, o for the doc, ⌘F to find — and no way at all to learn
// it. Three of those keys ride a tooltip on the one control that performs the same action,
// which teaches a reader who was already reaching for that control with a mouse; it cannot
// teach the reader who never finds the control, and j/k had no control to ride at all.
//
// So the sheet is not a duplicate of those hints. It is the only surface that answers "what
// can I do without the mouse" as a question in its own right, and the tooltips stay because
// they answer a different one ("what is this button, and is there a faster way").
//
// It is glass and it floats above centre, which is the recents picker's treatment rather than
// the dialog's default opaque slab — and for the recents picker's reason. This is a lens held
// up over the work to check something, not a thing to fill in and dismiss: the reader opened it
// mid-file to remember one key, and the diff staying visible behind it is what says they never
// left. The slab is still right for everything that asks a question.
//
// What it does not do any more is decide what is on it. The rows are `lib/shortcuts`, which
// the tooltips read too — this file used to hold a literal of its own, and a sheet authored
// separately from the hints is a sheet that goes quietly out of date.

/** `?` opens the sheet from anywhere, and closes it again. Guarded like every other
 * single-key shortcut in the app: never inside a text field, never with a modifier — except
 * the shift the key itself is typed with, which is why this one takes `isEditable` directly
 * rather than the shared `shortcutBlocked`. It must also fire from *under* an open sheet,
 * since that sheet is the one this key takes down.
 *
 * `event.key` is already the shifted character, so this matches `?` on whatever layout the
 * reader has rather than a US-keyboard scancode. */
function useShortcutsShortcut(toggle: () => void): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.metaKey || event.ctrlKey || event.altKey || isEditable(event.target)) {
        return;
      }
      if (event.key === "?") {
        event.preventDefault();
        toggle();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [toggle]);
}

/** The keyboard reference, on `?`. Mounted at the app level so it opens over whichever
 * surface the reader is on — the diff, the doc, or the start screen before any of them. */
export function ShortcutsDialog(): ReactElement {
  const [open, setOpen] = useState(false);
  useShortcutsShortcut(() => setOpen((value) => !value));

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {/* The recents picker's shell, for its reason — and held above centre rather than in
          it, so the sheet lands where the picker lands and the two read as one kind of
          surface. Its own dismissal is Esc, spelled out in the footer, so no close glyph. */}
      <DialogContent
        variant="glass"
        showCloseButton={false}
        className="top-[12vh] w-[min(40rem,calc(100%-4rem))]"
      >
        <header className="flex flex-col gap-1 border-b border-foreground/10 px-5 py-4">
          <DialogPrimitive.Title className="text-base leading-none font-medium text-foreground">
            Keyboard shortcuts
          </DialogPrimitive.Title>
          <DialogPrimitive.Description className="text-sm text-text-muted">
            Single keys work anywhere except inside a text field.
          </DialogPrimitive.Description>
        </header>

        {/* Two columns on anything but the narrowest window: the list is short enough to
            read whole, and one tall column would push the last group under the fold for no
            reason. `break-inside-avoid` keeps a group from being split across the gap. */}
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-4 sm:columns-2 sm:gap-8">
          {SHORTCUT_SHEET.map((group) => (
            <section key={group.id} className="mb-5 break-inside-avoid last:mb-0">
              <h3 className="text-xs font-medium tracking-wide text-text-muted uppercase">
                {group.title}
              </h3>
              {group.note !== undefined && (
                <p className="mt-0.5 text-xs text-text-faint">{group.note}</p>
              )}
              {/* Keys first, because the sheet is scanned down its left edge by someone who
                  half-remembers a chord, not read as sentences. */}
              <dl className="mt-2 flex flex-col gap-1.5">
                {group.shortcuts.map((shortcut) => (
                  <div key={shortcut.id} className="flex items-baseline gap-3">
                    {/* A fixed key column, so the actions line up into a readable edge
                        instead of ragging with every chord's width. */}
                    <dt className="flex w-[4.5rem] shrink-0 items-center gap-1">
                      {shortcut.keys.map((key, index) => (
                        <span key={key} className="flex items-center gap-1">
                          {index > 0 && shortcut.range === true && (
                            <span className="text-text-faint">…</span>
                          )}
                          <Kbd className="h-5.5 min-w-5.5 px-1.5 text-xs">{key}</Kbd>
                        </span>
                      ))}
                    </dt>
                    <dd className="min-w-0 text-sm leading-snug text-foreground">
                      {shortcut.label}
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>

        {/* No `?` hint here — the reader pressed it to arrive, and a sheet that opens to
            tell you the key you just used is the one row on it nobody needs.
            Esc is spelled out rather than registered: it is the kit dialog's own dismissal,
            which every sheet in the app answers to for free, and a registry entry would put
            "close this sheet" on the sheet. Capitalised to match the rows above it and the
            recents picker's footer, which now takes its chip from the registry. */}
        <footer className="flex items-center justify-end border-t border-foreground/10 px-5 py-2 text-xs text-text-faint">
          <span className="flex items-center gap-1">
            <Kbd>Esc</Kbd>
            close
          </span>
        </footer>
      </DialogContent>
    </Dialog>
  );
}
