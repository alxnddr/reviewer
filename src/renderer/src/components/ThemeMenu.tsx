import type { ReactElement } from "react";
import { ContrastIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useThemeStore } from "@/stores/theme";
import { ThemeId } from "../../../shared/contracts";
import { THEMES } from "../../../shared/themes.generated";

export function ThemeMenu(): ReactElement {
  const selection = useThemeStore((state) => state.selection);
  const setSelection = useThemeStore((state) => state.setSelection);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="icon"
            // The ghost hover (bg-muted) is invisible on the bg-sidebar titlebar —
            // the wash must come from the border tone to register on chrome
            // surfaces, with dark: twins to outrank the variant's own dark arm.
            className="app-region-no-drag hover:bg-border/60 aria-expanded:bg-border/60 dark:hover:bg-border/60 dark:aria-expanded:bg-border/60"
            aria-label="Change theme"
          />
        }
      >
        <ContrastIcon />
      </DropdownMenuTrigger>
      {/* w-auto min-w-40 overrides the menu's default anchor-width sizing (the trigger is a 32px icon
          button, so the names would otherwise wrap) — size to the widest theme label instead. */}
      <DropdownMenuContent align="end" sideOffset={8} className="w-auto min-w-40">
        <DropdownMenuRadioGroup
          // Pre-hydration nothing is selected yet; the check settles once main answers with the pick.
          value={selection ?? ""}
          onValueChange={(value) => {
            void setSelection(ThemeId.parse(value));
          }}
        >
          {THEMES.map((theme) => (
            <DropdownMenuRadioItem key={theme.id} value={theme.id} className="min-h-7">
              {theme.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
