import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { installEditContextMenu } from "./edit-menu.mjs";

test("editable context menus use native commands and their real availability", () => {
  const contents = new EventEmitter();
  const calls = [];
  contents.isDestroyed = () => false;
  for (const action of [
    "focus",
    "undo",
    "redo",
    "cut",
    "copy",
    "paste",
    "selectAll",
  ])
    contents[action] = () => calls.push(action);
  let template;
  const remove = installEditContextMenu(contents, {
    buildFromTemplate(items) {
      template = items;
      return { popup: () => calls.push("popup") };
    },
  });
  contents.emit(
    "context-menu",
    {},
    {
      isEditable: true,
      editFlags: {
        canCut: true,
        canCopy: true,
        canPaste: true,
        canSelectAll: true,
        canUndo: true,
        canRedo: false,
      },
    },
  );
  assert.deepEqual(
    template.filter((item) => item.label).map((item) => item.label),
    ["Undo", "Redo", "Cut", "Copy", "Paste", "Select all"],
  );
  assert.equal(template.find((item) => item.label === "Redo").enabled, false);
  for (const label of ["Cut", "Copy", "Paste", "Select all"])
    template.find((item) => item.label === label).click();
  assert.deepEqual(calls, [
    "popup",
    "focus",
    "cut",
    "focus",
    "copy",
    "focus",
    "paste",
    "focus",
    "selectAll",
  ]);
  remove();
  assert.equal(contents.listenerCount("context-menu"), 0);
});

test("plain file-manager surfaces retain their renderer context menu", () => {
  const contents = new EventEmitter();
  const templates = [];
  installEditContextMenu(contents, {
    buildFromTemplate: (items) => ({ popup: () => templates.push(items) }),
  });
  contents.emit("context-menu", {}, { isEditable: false, selectionText: "" });
  assert.equal(templates.length, 0);
  contents.emit(
    "context-menu",
    {},
    {
      isEditable: false,
      selectionText: "Server log",
      editFlags: { canCopy: true },
    },
  );
  assert.deepEqual(
    templates[0].map((item) => item.label),
    ["Copy"],
  );
});
