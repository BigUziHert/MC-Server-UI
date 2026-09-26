import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  createUpdatesOverlay,
  CLOSE_UPDATES_CHANNEL,
} from "./updates-overlay.mjs";

function fixture({
  load = async () => {},
  insert = async () => "blur-key",
} = {}) {
  const views = [];
  const ipcMain = new EventEmitter();
  const parent = new EventEmitter();
  parent.isDestroyed = () => parent.destroyed === true;
  parent.size = [1200, 800];
  parent.getContentSize = () => parent.size;
  parent.contentView = {
    children: [],
    addChildView(view) {
      this.children.push(view);
    },
    removeChildView(view) {
      this.children = this.children.filter((item) => item !== view);
    },
  };
  const background = new EventEmitter();
  background.isDestroyed = () => background.destroyed === true;
  background.insertCSS = insert;
  background.removed = [];
  background.removeInsertedCSS = async (key) => {
    background.removed.push(key);
  };
  background.focus = () => {
    background.focused = true;
  };
  parent.webContents = background;
  const session = {};
  class View {
    constructor(options) {
      this.options = options;
      const contents = new EventEmitter();
      this.webContents = contents;
      contents.isDestroyed = () => contents.destroyed === true;
      contents.focus = () => {
        contents.focused = true;
      };
      contents.close = () => {
        contents.destroyed = true;
        contents.emit("destroyed");
      };
      contents.setWindowOpenHandler = (handler) => {
        this.popup = handler;
      };
      contents.getURL = () => contents.url;
      contents.loadURL = async (url) => {
        contents.url = url;
        contents.mainFrame = { url, origin: new URL(url).origin };
        await load();
      };
      views.push(this);
    }
    setBackgroundColor(value) {
      this.backgroundColor = value;
    }
    setBounds(value) {
      this.bounds = value;
    }
  }
  const controller = createUpdatesOverlay({
    WebContentsView: View,
    ipcMain,
    parent,
    session,
    origin: "http://127.0.0.1:3001",
    preload: "/desktop/updates-preload.cjs",
  });
  const closeFrom = (sender, senderFrame = sender.mainFrame) =>
    ipcMain.emit(CLOSE_UPDATES_CHANNEL, { sender, senderFrame });
  return { controller, views, parent, background, session, ipcMain, closeFrom };
}

test("updates use one transparent local view with close-only authority and no native window", async () => {
  const h = fixture();
  await Promise.all([h.controller.open(), h.controller.open()]);
  assert.equal(h.views.length, 1);
  const view = h.views[0];
  assert.equal(view.options.webPreferences.session, h.session);
  assert.equal(
    view.options.webPreferences.preload,
    "/desktop/updates-preload.cjs",
  );
  assert.equal(view.options.webPreferences.nodeIntegration, false);
  assert.equal(view.options.webPreferences.sandbox, true);
  assert.equal(view.backgroundColor, "#00000000");
  assert.equal(view.webContents.url, "http://127.0.0.1:3001/?app-updates=1");
  assert.deepEqual(h.parent.contentView.children, [view]);
  assert.deepEqual(view.bounds, { x: 0, y: 0, width: 1200, height: 800 });
  h.parent.size = [1920, 1080];
  h.parent.emit("resize");
  assert.equal(view.bounds.width, 1920);
  assert.equal(view.bounds.height, 1080);
  assert.deepEqual(view.popup({ url: "https://evil.test" }), {
    action: "deny",
  });
  for (const type of ["will-navigate", "will-redirect"]) {
    for (const url of ["https://evil.test/", "http://127.0.0.1:3001/"]) {
      let prevented = false;
      view.webContents.emit(
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
  h.closeFrom(h.background);
  h.closeFrom(view.webContents, { ...view.webContents.mainFrame });
  assert.equal(view.webContents.destroyed, undefined);
  h.closeFrom(view.webContents);
  await Promise.resolve();
  assert.deepEqual(h.parent.contentView.children, []);
  assert.equal(h.background.focused, true);
  assert.deepEqual(h.background.removed, ["blur-key"]);
  await h.controller.open();
  assert.equal(h.views.length, 2);
  h.controller.close();
  assert.equal(h.views[1].webContents.destroyed, true);
  assert.equal(h.ipcMain.listenerCount(CLOSE_UPDATES_CHANNEL), 0);
  await assert.rejects(h.controller.open(), /shutting down/);
});

test("closing during load permits immediate reopen without a late view stealing focus", async () => {
  const pending = [];
  const h = fixture({
    load: () => new Promise((resolve) => pending.push(resolve)),
  });
  const first = h.controller.open();
  h.controller.dismiss();
  const second = h.controller.open();
  assert.equal(h.views.length, 2);
  pending[0]();
  await first;
  assert.deepEqual(h.parent.contentView.children, []);
  pending[1]();
  await second;
  assert.deepEqual(h.parent.contentView.children, [h.views[1]]);
  h.controller.close();
});

test("closing during CSS insertion removes late blur and never attaches stale overlay", async () => {
  let finish;
  const h = fixture({
    insert: () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  });
  const pending = h.controller.open();
  await new Promise(setImmediate);
  h.controller.dismiss();
  finish("late-key");
  await pending;
  assert.deepEqual(h.background.removed, ["late-key"]);
  assert.deepEqual(h.parent.contentView.children, []);
  h.controller.close();
});

test("load failure or parent/underlying view destruction clears overlay and its blur", async () => {
  let fail = true;
  const h = fixture({
    load: async () => {
      if (fail) throw new Error("load failed");
    },
  });
  await assert.rejects(h.controller.open(), /load failed/);
  assert.equal(h.views[0].webContents.destroyed, true);
  fail = false;
  await h.controller.open();
  h.background.destroyed = true;
  h.background.emit("destroyed");
  assert.equal(h.views[1].webContents.destroyed, true);
  await h.controller.open();
  h.parent.destroyed = true;
  h.parent.emit("closed");
  assert.equal(h.views[2].webContents.destroyed, true);
  assert.equal(h.ipcMain.listenerCount(CLOSE_UPDATES_CHANNEL), 0);
});

test("an updater renderer crash restores the underlying view instead of leaving a blocking layer", async () => {
  const h = fixture();
  await h.controller.open();
  h.views[0].webContents.emit("render-process-gone");
  await Promise.resolve();
  assert.equal(h.views[0].webContents.destroyed, true);
  assert.deepEqual(h.parent.contentView.children, []);
  assert.deepEqual(h.background.removed, ["blur-key"]);
  assert.equal(h.background.focused, true);
  h.controller.close();
});
