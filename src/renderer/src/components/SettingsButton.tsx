import type { ReactElement } from "react";
import { SettingsIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ShortcutHint } from "@/components/ui/kbd";
import { TooltipHint } from "@/components/ui/tooltip";
import { useSettingsStore } from "@/stores/settings";

/** The title bar's way into the settings dialog — where the theme menu used to sit, since the
 * theme is now the first row in there. The hint carries the chord (⌘,) off the registry, so
 * the tooltip and the sheet cannot name two different keys for it. */
export function SettingsButton(): ReactElement {
  const openDialog = useSettingsStore((state) => state.openDialog);
  return (
    <TooltipHint side="bottom" align="end" content={<ShortcutHint id="settings.open" />}>
      <Button
        variant="chrome"
        size="icon"
        className="app-region-no-drag"
        aria-label="Settings"
        onClick={openDialog}
      >
        <SettingsIcon />
      </Button>
    </TooltipHint>
  );
}
