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
        // First, and above the two pickers, because it is the ordinary way in: a tab showing
        // the start screen, where a review is asked for and past ones are listed. Through
        // `requestMenuCommand` rather than the tab command — with no window open, ⌘T means
        // "give me one", and the window it creates opens on this very screen.
        {
          label: "New Tab",
          accelerator: "CmdOrCtrl+T",
          click: () => requestMenuCommand(IpcEvent.menuNewTab),
        },
        { type: "separator" },
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
        // Beside Open Review… because it answers the same question by the other route: that
        // one is "I know where the file is", this one is "I know I reviewed it". No ellipsis —
        // it opens an in-app panel, not a system picker, and the ellipsis is what tells a
        // macOS reader which of those to expect.
        {
          label: "Recent Reviews",
          accelerator: "CmdOrCtrl+Shift+R",
          click: () => requestMenuCommand(IpcEvent.menuOpenRecentReviews),
        },
        // The way out of the app and into the work. They sit in File rather than Edit
        // because in this app File *is* the review-artifact menu — open one, list them,
        // export one — and a prompt is that same family of projection, one step shorter
        // than an export. Edit is the more orthodox home for a Copy variant, but it is a
        // stock role here, and claiming it would mean spelling out and then owning the
        // whole macOS template for the sake of these two lines.
        //
        // Both go through the tab command (focused window only): unlike Open Repository
        // there is nothing to copy in a window that does not exist, so nothing is created
        // to receive them.
        { type: "separator" },
        {
          label: "Copy Comment as Prompt",
          accelerator: "Shift+CmdOrCtrl+C",
          click: () => requestTabCommand(IpcEvent.menuCopyCommentPrompt),
        },
        {
          // Option as the alternate/wider scope, on the same letter — the native idiom,
          // and what makes the pair self-teaching once either half is known.
          label: "Copy All Comments as Prompt",
          accelerator: "Alt+Shift+CmdOrCtrl+C",
          click: () => requestTabCommand(IpcEvent.menuCopyAllCommentsPrompt),
        },
        // Both exports are parked for now — the commands, IPC and store actions behind
        // them are all still wired, so restoring the feature is just uncommenting these
        // two items (and the separator above them).
        // { type: "separator" },
        // {
        //   label: "Export Review as Markdown…",
        //   click: () => requestMenuCommand(IpcEvent.menuExportReviewMarkdown),
        // },
        // {
        //   label: "Export Review…",
        //   accelerator: "CmdOrCtrl+Shift+E",
        //   click: () => requestMenuCommand(IpcEvent.menuExportReviewJson),
        // },
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
    // Spelled out rather than `role: "viewMenu"`, for one item: the stock View menu binds
    // Force Reload to ⇧⌘R, which is Recent Reviews above. Two items on one accelerator is
    // resolved by menu order — File comes first, so the picker did win — but that is a
    // coincidence of template order holding up an advertised shortcut, and the View menu
    // sat there naming ⇧⌘R as something else. Force Reload is a devtools affordance nobody
    // reviewing a diff reaches for; plain Reload keeps ⌘R and the collision goes away.
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
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
