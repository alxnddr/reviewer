import { BrowserWindow, Menu, type MenuItemConstructorOptions } from "electron";
import { IpcEvent, TAB_ORDINAL_EVENTS, type IpcEventName } from "../shared/ipc";
import { installCliCommand, uninstallCliCommand } from "./cli-install";
import { createMainWindow } from "./window";

/** Routes a payload-free menu command to a renderer, which owns the open
 * flow — the same store action the empty-state button triggers. With zero windows
 * (macOS keeps the app alive), recreate one and deliver once its page can receive. */
function requestMenuCommand(event: IpcEventName): void {
  const target = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  if (target !== undefined) {
    target.webContents.send(event);
    return;
  }
  const created = createMainWindow();
  created.webContents.once("did-finish-load", () => {
    created.webContents.send(event);
  });
}

/** Tab commands act on the focused window's tabs; with no window there are no
 * tabs, so unlike open-repo nothing is recreated. */
function requestTabCommand(event: IpcEventName): void {
  BrowserWindow.getFocusedWindow()?.webContents.send(event);
}

/** ⌘1…⌘9 jump items. Hidden on macOS per tabbed-app convention (Safari/Chrome
 * list no digit items) — hidden accelerators still fire there, but only there
 * (acceleratorWorksWhenHidden is macOS-only), so other platforms list them. */
function tabOrdinalItems(): MenuItemConstructorOptions[] {
  return TAB_ORDINAL_EVENTS.map(([ordinal, event]) => ({
    label: `Tab ${ordinal}`,
    accelerator: `CmdOrCtrl+${ordinal}`,
    visible: process.platform !== "darwin",
    acceleratorWorksWhenHidden: true,
    click: () => requestTabCommand(event),
  }));
}

/** Explicit application menu: native roles plus the custom commands. */
export function installApplicationMenu(): void {
  const template: MenuItemConstructorOptions[] = [
    ...(process.platform === "darwin" ? [{ role: "appMenu" } as const] : []),
    {
      label: "File",
      submenu: [
        {
          label: "Open Repository…",
          accelerator: "CmdOrCtrl+O",
          click: () => requestMenuCommand(IpcEvent.menuOpenRepo),
        },
        {
          label: "Open Review…",
          accelerator: "CmdOrCtrl+Shift+O",
          click: () => requestMenuCommand(IpcEvent.menuOpenReview),
        },
        { type: "separator" },
        {
          label: "Export Review as Markdown…",
          click: () => requestMenuCommand(IpcEvent.menuExportReviewMarkdown),
        },
        {
          label: "Export Review…",
          accelerator: "CmdOrCtrl+Shift+E",
          click: () => requestMenuCommand(IpcEvent.menuExportReviewJson),
        },
        ...(process.platform === "darwin"
          ? [
              { type: "separator" } as const,
              {
                label: "Install 'rvw' Command in PATH…",
                click: () => void installCliCommand(),
              },
              {
                label: "Uninstall 'rvw' Command",
                click: () => void uninstallCliCommand(),
              },
            ]
          : []),
        { type: "separator" },
        {
          label: "Close Tab",
          accelerator: "CmdOrCtrl+W",
          click: () => requestTabCommand(IpcEvent.menuCloseTab),
        },
        // ⌘W closes the tab (macOS tabbed-app convention), so window close
        // takes ⇧⌘W. A custom item rather than `role: "close"` because macOS
        // auto-decorates role-backed items with an SF Symbol icon.
        {
          label: "Close Window",
          accelerator: "Shift+CmdOrCtrl+W",
          click: () => BrowserWindow.getFocusedWindow()?.close(),
        },
      ],
    },
    { role: "editMenu" },
    { role: "viewMenu" },
    {
      label: "Window",
      submenu: [
        { role: "minimize" },
        { role: "zoom" },
        { type: "separator" },
        {
          label: "Show Next Tab",
          accelerator: "Control+Tab",
          click: () => requestTabCommand(IpcEvent.menuNextTab),
        },
        {
          label: "Show Previous Tab",
          accelerator: "Control+Shift+Tab",
          click: () => requestTabCommand(IpcEvent.menuPreviousTab),
        },
        ...tabOrdinalItems(),
        ...(process.platform === "darwin"
          ? [{ type: "separator" } as const, { role: "front" } as const]
          : []),
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
