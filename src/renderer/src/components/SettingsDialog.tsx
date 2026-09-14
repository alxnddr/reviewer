import { useEffect, useMemo, useState, type ReactElement } from "react";
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { SearchIcon } from "lucide-react";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { SettingRow } from "@/components/settings/SettingRow";
import { listMonospaceFonts } from "@/lib/local-fonts";
import {
  filterSettings,
  SETTING_ENTRIES,
  SETTING_GROUPS,
  settingSections,
  type SettingGroupId,
} from "@/lib/settings-catalog";
import { cn } from "@/lib/utils";
import { useSettingsStore } from "@/stores/settings";

// The app's settings, in one sheet: a search box, the sections as tabs down the left, and the
// chosen section's rows on the right. One section at a time, not one long page — a tab is a
// tab, and a reader who clicked Diff is looking at the diff's rows and nothing above or below
// them. Chosen now, with two sections and seven rows, because the shape is the part that has to
// be right before there are twenty.
//
// Search cuts across the tabs: it filters every section, a tab with nothing left greys out,
// and if the tab the reader was on empties the sheet moves to the first one that did not — so
// a query never lands on a blank pane while its matches sit behind another tab.
//
// The opaque slab rather than the glass lens (`ui/dialog.tsx`): this is a thing to fill in and
// dismiss, and the reader's work behind it is not what they are checking against — though the
// diff does repaint live behind the overlay as a font size is committed, which is the one
// reason the overlay is as light as it is.
//
// Every row is `lib/settings-catalog`; nothing about a setting is decided in here. The store
// is read directly (`useSettingsStore`), the way a rail section reads the review store: this
// dialog is mounted once and names its own state, and the rows take props.

export function SettingsDialog(): ReactElement {
  const open = useSettingsStore((state) => state.dialogOpen);
  const closeDialog = useSettingsStore((state) => state.closeDialog);
  const openDialog = useSettingsStore((state) => state.openDialog);
  const resolved = useSettingsStore((state) => state.resolved);
  const stored = useSettingsStore((state) => state.settings);
  const update = useSettingsStore((state) => state.update);

  const [query, setQuery] = useState("");
  const [active, setActive] = useState<SettingGroupId>(SETTING_GROUPS[0].id);
  const [fonts, setFonts] = useState<readonly string[]>([resolved.diffFontFamily]);

  const sections = useMemo(() => settingSections(filterSettings(SETTING_ENTRIES, query)), [query]);
  const current = sections.find((section) => section.id === active) ?? sections[0] ?? null;

  // A closed dialog forgets its search and its tab: reopening to the last filter would hide
  // rows the reader has no way of knowing were filtered.
  useEffect(() => {
    if (!open) {
      setQuery("");
      setActive(SETTING_GROUPS[0].id);
    }
  }, [open]);

  // The installed fonts are read on each opening, not once: a font installed while the app is
  // running is exactly the one the reader is opening this sheet to pick. The stale-answer
  // guard matters because the query is asynchronous and the sheet can close and reopen under it.
  useEffect(() => {
    if (!open) {
      return;
    }
    let stale = false;
    void listMonospaceFonts().then((families) => {
      if (!stale) {
        setFonts(families);
      }
    });
    return () => {
      stale = true;
    };
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? openDialog() : closeDialog())}>
      <DialogContent
        // The slab, resized: the default variant is a small centred card, and this is a page.
        // Held above centre like the sheets, so it lands where they land.
        className="top-[10vh] flex h-[min(38rem,80vh)] w-[min(52rem,calc(100%-4rem))] max-w-none translate-y-0 flex-col gap-0 overflow-hidden p-0 sm:max-w-none"
      >
        {/* pr-12 keeps the search box clear of the close button in the corner. */}
        <header className="flex shrink-0 items-center gap-4 border-b border-border px-5 py-3 pr-12">
          <div className="flex min-w-0 flex-col gap-0.5">
            <DialogPrimitive.Title className="text-base leading-none font-medium text-foreground">
              Settings
            </DialogPrimitive.Title>
            <DialogPrimitive.Description className="text-sm text-text-muted">
              Yours, not a review&apos;s: these follow you across tabs and relaunches.
            </DialogPrimitive.Description>
          </div>
          <div className="flex-1" />
          <InputGroup className="w-64">
            <InputGroupAddon>
              <SearchIcon />
            </InputGroupAddon>
            <InputGroupInput
              type="search"
              placeholder="Search settings"
              aria-label="Search settings"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
            />
          </InputGroup>
        </header>

        <div className="flex min-h-0 flex-1">
          <nav
            role="tablist"
            aria-label="Settings sections"
            aria-orientation="vertical"
            className="flex w-40 shrink-0 flex-col gap-0.5 border-r border-border p-2"
          >
            {SETTING_GROUPS.map((group) => {
              const present = sections.some((section) => section.id === group.id);
              const selected = current?.id === group.id;
              return (
                <button
                  key={group.id}
                  type="button"
                  role="tab"
                  disabled={!present}
                  aria-selected={selected}
                  className={cn(
                    "rounded-md px-2 py-1 text-left text-base transition-colors duration-(--duration-fast) outline-none focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-40",
                    selected
                      ? "bg-selected text-foreground"
                      : "text-text-muted hover:bg-border/30 hover:text-foreground",
                  )}
                  onClick={() => setActive(group.id)}
                >
                  {group.title}
                </button>
              );
            })}
          </nav>

          <div
            role="tabpanel"
            className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-6 py-2"
          >
            {current === null ? (
              <p className="py-8 text-center text-base text-text-muted">
                No settings match <span className="text-foreground">{query.trim()}</span>.
              </p>
            ) : (
              <section key={current.id} className="pt-2 pb-2">
                <h3 className="text-sm font-medium tracking-wide text-text-muted uppercase">
                  {current.title}
                </h3>
                <div className="mt-1 divide-y divide-border">
                  {current.entries.map((entry) => (
                    <SettingRow
                      key={entry.key}
                      entry={entry}
                      resolved={resolved}
                      stored={stored ?? {}}
                      fonts={fonts}
                      onChange={(patch) => void update(patch)}
                    />
                  ))}
                </div>
              </section>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
