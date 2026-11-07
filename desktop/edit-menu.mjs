// Electron does not supply a context menu when the application menu is hidden.
// Use native edit commands so selection, undo history and paste events behave
// exactly like the corresponding keyboard shortcuts.
export function installEditContextMenu(contents, Menu) {
  const show = (_event, params) => {
    if (!params.isEditable && !params.selectionText) return;
    const flags = params.editFlags || {};
    const command = (label, action, enabled, accelerator) => ({
      label,
      enabled: Boolean(enabled),
      accelerator,
      click: () => {
        if (!contents.isDestroyed()) {
          contents.focus();
          contents[action]();
        }
      },
    });
    const items = params.isEditable
      ? [
          command("Undo", "undo", flags.canUndo, "CmdOrCtrl+Z"),
          command("Redo", "redo", flags.canRedo, "CmdOrCtrl+Shift+Z"),
          { type: "separator" },
          command("Cut", "cut", flags.canCut, "CmdOrCtrl+X"),
          command("Copy", "copy", flags.canCopy, "CmdOrCtrl+C"),
          command("Paste", "paste", flags.canPaste, "CmdOrCtrl+V"),
          { type: "separator" },
          command("Select all", "selectAll", flags.canSelectAll, "CmdOrCtrl+A"),
        ]
      : [command("Copy", "copy", flags.canCopy, "CmdOrCtrl+C")];
    Menu.buildFromTemplate(items).popup();
  };
  contents.on("context-menu", show);
  return () => contents.removeListener("context-menu", show);
}
