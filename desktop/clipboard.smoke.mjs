// Real Electron/Windows clipboard smoke, isolated in a temporary app profile.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { _electron as electron, expect } from "@playwright/test";

const project = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
const root = await fs.mkdtemp(path.join(os.tmpdir(), "mc-clipboard-smoke-"));
let application;
try {
  const folder = path.join(root, "copied folder");
  const file = path.join(root, "copied file.txt");
  await fs.mkdir(path.join(folder, "empty"), { recursive: true });
  await fs.writeFile(
    path.join(folder, "nested.txt"),
    "nested clipboard contents",
  );
  await fs.writeFile(file, "clipboard contents");
  const environment = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;
  delete environment.NODE_OPTIONS;
  application = await electron.launch({
    executablePath: path.join(
      project,
      "node_modules",
      "electron",
      "dist",
      "electron.exe",
    ),
    args: [
      project,
      `--user-data-dir=${path.join(root, "profile")}`,
      "--smoke-test",
    ],
    cwd: project,
    env: environment,
    timeout: 30000,
  });
  const page = await application.firstWindow();
  await expect
    .poll(() => page.evaluate(() => Boolean(window.mcPanelClipboard)))
    .toBe(true);
  // Keep preexisting clipboard data in the main process, never in test output.
  // Snapshot the payloads now: native ClipboardItems otherwise read lazily.
  await application.evaluate(async ({ clipboard, ClipboardItem }) => {
    const supported = new Set([
      "text/plain",
      "text/html",
      "text/rtf",
      "text/uri-list",
      "image/png",
      "image/jpeg",
      "electron application/bookmark",
      "web application/x-mc-panel-files",
    ]);
    const saved = [];
    for (const item of await clipboard.read()) {
      const values = {};
      for (const type of item.types)
        if (supported.has(type)) values[type] = await item.getType(type);
      if (Object.keys(values).length) saved.push(new ClipboardItem(values));
    }
    globalThis.__clipboardSmokeRestore = () =>
      saved.length ? clipboard.write(saved) : clipboard.clear();
  });
  await application.evaluate(
    async ({ clipboard, ClipboardItem }, uris) => {
      await clipboard.write([new ClipboardItem({ "text/uri-list": uris })]);
    },
    [file, folder].map((value) => pathToFileURL(value).href).join("\r\n"),
  );
  const copied = await page.evaluate(async () => {
    const bridge = window.mcPanelClipboard;
    const selection = await bridge.readFiles();
    const contents = [];
    for (const file of selection.files) {
      const bytes = await bridge.readFile(selection.id, file.id, 0);
      contents.push([file.path, new TextDecoder().decode(bytes)]);
    }
    await bridge.releaseFiles(selection.id);
    await bridge.markInternalCopy();
    return {
      contents,
      directories: selection.directories,
      afterInternalCopy: await bridge.readFiles(),
    };
  });
  assert.deepEqual(copied.contents.sort(), [
    ["copied file.txt", "clipboard contents"],
    ["copied folder/nested.txt", "nested clipboard contents"],
  ]);
  assert.deepEqual(copied.directories.sort(), [
    "copied folder",
    "copied folder/empty",
  ]);
  assert.equal(copied.afterInternalCopy, null);

  await application.evaluate(({ Menu }) => {
    Menu.prototype.popup = function () {
      globalThis.__clipboardSmokeMenu = this;
    };
  });
  await page.evaluate(() => {
    const field = document.createElement("textarea");
    field.id = "clipboard-smoke";
    field.style.cssText =
      "position:fixed;inset:20px;width:500px;height:120px;z-index:99999";
    field.value = "Edit this text";
    document.body.append(field);
    field.focus();
    field.select();
  });
  const field = page.locator("#clipboard-smoke");
  await field.click({ button: "right" });
  const labels = await application.evaluate(() =>
    globalThis.__clipboardSmokeMenu.items
      .map((item) => item.label)
      .filter(Boolean),
  );
  assert.deepEqual(labels, [
    "Undo",
    "Redo",
    "Cut",
    "Copy",
    "Paste",
    "Select all",
  ]);
  const action = async (label) =>
    application.evaluate((_electron, label) => {
      const item = globalThis.__clipboardSmokeMenu.items.find(
        (item) => item.label === label,
      );
      if (!item.enabled) throw new Error(`${label} was disabled`);
      item.click();
    }, label);
  await action("Cut");
  await expect(field).toHaveValue("");
  assert.equal(
    await application.evaluate(({ clipboard }) => clipboard.readText()),
    "Edit this text",
  );
  await field.click({ button: "right" });
  await action("Paste");
  await expect(field).toHaveValue("Edit this text");
  await field.click({ button: "right" });
  await action("Select all");
  await expect
    .poll(() =>
      field.evaluate(
        (element) => element.selectionEnd - element.selectionStart,
      ),
    )
    .toBe(14);
  await page.keyboard.press("Control+C");
  await page.keyboard.press("Backspace");
  await page.keyboard.press("Control+V");
  await expect(field).toHaveValue("Edit this text");
  console.log(
    "PASS native copied files/folders, internal-copy precedence, context editing and keyboard clipboard shortcuts",
  );
} finally {
  try {
    await application?.evaluate(async () => {
      await globalThis.__clipboardSmokeRestore?.();
    });
  } finally {
    await application?.close();
    await fs.rm(root, { recursive: true, force: true });
  }
}
