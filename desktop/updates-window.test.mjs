import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createUpdatesWindow } from "./updates-window.mjs";

function fixture(load = async () => {}) {
  const windows = [];
  const parent = { isDestroyed: () => false };
  const session = {};
  class Window extends EventEmitter {
    constructor(options) {
      super();
      this.options = options;
      this.webContents = new EventEmitter();
      this.webContents.setWindowOpenHandler = (handler) => {
        this.popup = handler;
      };
      windows.push(this);
    }
    isDestroyed() {
      return this.destroyed === true;
    }
    isMinimized() {
      return false;
    }
    show() {
      this.shown = true;
    }
    focus() {
      this.focused = true;
    }
    setMenu(menu) {
      this.menu = menu;
    }
    destroy() {
      this.destroyed = true;
      this.emit("closed");
    }
    async loadURL(url) {
      this.url = url;
      await load();
    }
  }
  const controller = createUpdatesWindow({
    BrowserWindow: Window,
    parent,
    session,
    origin: "http://127.0.0.1:3001",
  });
  return { controller, windows, parent, session };
}

test("updates open in one trusted window without a renderer bridge or parent navigation", async () => {
  let finish;
  const h = fixture(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const first = h.controller.open();
  const second = h.controller.open();
  assert.equal(h.windows.length, 1);
  const child = h.windows[0];
  assert.equal(child.options.parent, h.parent);
  assert.equal(child.options.webPreferences.session, h.session);
  assert.equal(child.options.webPreferences.preload, undefined);
  assert.equal(child.options.webPreferences.nodeIntegration, false);
  assert.equal(child.options.webPreferences.sandbox, true);
  assert.equal(child.url, "http://127.0.0.1:3001/?app-updates=1");
  assert.deepEqual(child.popup({ url: "https://evil.test" }), {
    action: "deny",
  });
  for (const type of ["will-navigate", "will-redirect"]) {
    for (const url of ["https://evil.test/", "http://127.0.0.1:3001/"]) {
      let prevented = false;
      child.webContents.emit(
        type,
        {
          preventDefault() {
            prevented = true;
          },
        },
        url,
      );
      assert.equal(prevented, true);
    }
  }
  finish();
  await Promise.all([first, second]);
  assert.equal(child.shown, true);
  await h.controller.open();
  assert.equal(h.windows.length, 1);
  child.destroy();
  const reopened = h.controller.open();
  assert.equal(h.windows.length, 2);
  finish();
  await reopened;
  h.controller.close();
  assert.equal(h.windows[1].destroyed, true);
  await assert.rejects(h.controller.open(), /shutting down/);
});

test("a failed updates window load is discarded and can be opened again", async () => {
  let fail = true;
  const h = fixture(async () => {
    if (fail) throw new Error("load failed");
  });
  await assert.rejects(h.controller.open(), /load failed/);
  assert.equal(h.windows[0].destroyed, true);
  fail = false;
  await h.controller.open();
  assert.equal(h.windows.length, 2);
  assert.equal(h.windows[1].shown, true);
  h.controller.close();
});
