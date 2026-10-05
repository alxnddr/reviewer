import { app, BrowserWindow, Menu, type MenuItemConstructorOptions } from "electron";
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

/** ⌘, — where a macOS reader looks for an app's settings, and the reason the app menu below
 * is spelled out rather than `role: "appMenu"`: the stock role carries no Settings… item and
 * offers no way to add one. Through `requestMenuCommand` so that with no window open the chord
 * still gets one, the way ⌘T does. */
const SETTINGS_ITEM: MenuItemConstructorOptions = {
  label: "Settings…",
  accelerator: "CmdOrCtrl+,",
  click: () => requestMenuCommand(IpcEvent.menuOpenSettings),
};

/** The stock `appMenu` role, item for item, with Settings… in the slot macOS puts it in —
 * between About and Services, where every native app keeps it. */
function appMenu(): MenuItemConstructorOptions {
  return {
    label: app.name,
    submenu: [
      { role: "about" },
      { type: "separator" },
      SETTINGS_ITEM,
      { type: "separator" },
      { role: "services" },
      { type: "separator" },
      { role: "hide" },
      { role: "hideOthers" },
      { role: "unhide" },
      { type: "separator" },
      { role: "quit" },
    ],
  };
}

/** Explicit application menu: native roles plus the custom commands. */
export function installApplicationMenu(): void {
  const template: MenuItemConstructorOptions[] = [
    ...(process.platform === "darwin" ? [appMenu()] : []),
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
        // The third way to a review, and the only door to this one: a pull request someone
        // else wrote. Here and in the `?` sheet, and deliberately not on the start screen,
        // which names two things and stays at two (`StartScreen.tsx`). ⇧⌘P beside ⇧⌘O and ⇧⌘R
        // — P for pull request, and free: no stock role, no other item and no window handler
        // binds it. The ellipsis because it asks for something (the pull request) before it
        // does anything. Through `requestMenuCommand`, so with no window open it makes one.
        {
          label: "Review Pull Request…",
          accelerator: "CmdOrCtrl+Shift+P",
          click: () => requestMenuCommand(IpcEvent.menuReviewPullRequest),
        },
        // The ways out of the app and into the work. They sit in File rather than Edit
        // because in this app File *is* the review-artifact menu — open one, list them,
        // export one — and a prompt is that same family of projection, one step shorter
        // than an export. Edit is the more orthodox home for a Copy variant, but it is a
        // stock role here, and claiming it would mean spelling out and then owning the
        // whole macOS template for the sake of these two lines.
        //
        // All three go through the tab command (focused window only): unlike Open Repository
        // there is nothing to copy — and no checkout to hand over — in a window that does not
        // exist, so nothing is created to receive them.
        { type: "separator" },
        // The repo-level door, above the comment-level ones: same journey out, widest scope
        // first. No accelerator — every chord in this app is advertised through
        // `lib/shortcuts.ts`, and this one has no surface that would want to name a key for
        // it that the title bar's button does not already say in words. Not disabled on a
        // frozen review either, which the *button* is: a menu item can only be greyed by
        // rebuilding the whole template whenever the active tab changes, and the app already
        // answers an impossible open with a sentence that says how to fix it
        // (`lib/editor-open-failure-message.ts`) rather than with a control that has gone
        // quiet. One of those two explains itself; the other does not.
        {
          label: "Open Repository in Editor",
          click: () => requestTabCommand(IpcEvent.menuOpenRepoInEditor),
        },
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
          : // Off macOS there is no app menu to hold it, and File is where those platforms
            // keep it.
            [{ type: "separator" } as const, SETTINGS_ITEM]),
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
    // Spelled out rather than `role: "viewMenu"`, originally for one item: the stock View menu
    // binds Force Reload to ⇧⌘R, which is Recent Reviews above. Two items on one accelerator is
    // resolved by menu order — File comes first, so the picker did win — but that is a
    // coincidence of template order holding up an advertised shortcut, and the View menu
    // sat there naming ⇧⌘R as something else. Force Reload is a devtools affordance nobody
    // reviewing a diff reaches for; plain Reload keeps ⌘R and the collision goes away. The
    // sidebar toggle then needed somewhere to live, and this is already that menu.
    {
      label: "View",
      submenu: [
        // First, above the stock roles, where macOS keeps an app's own view toggles. Through
        // the tab command (focused window only): with no window there is no rail to put away,
        // and unlike ⌘T nothing should be created to receive this.
        {
          label: "Toggle Sidebar",
          accelerator: "CmdOrCtrl+B",
          click: () => requestTabCommand(IpcEvent.menuToggleSidebar),
        },
        { type: "separator" },
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
