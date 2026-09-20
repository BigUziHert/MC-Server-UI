import test from "node:test";
import assert from "node:assert/strict";
import { installPanelPermissionHandlers } from "./permissions.mjs";

function harness(origin = "https://panel.example:3002") {
  let check;
  let request;
  const contents = {
    url: `${origin}/#console`,
    destroyed: false,
    getURL() {
      return this.url;
    },
    isDestroyed() {
      return this.destroyed;
    },
  };
  let current = contents;
  installPanelPermissionHandlers(
    {
      setPermissionCheckHandler: (handler) => (check = handler),
      setPermissionRequestHandler: (handler) => (request = handler),
    },
    origin,
    () => current,
  );
  return {
    contents,
    detach: () => (current = undefined),
    check,
    request(...args) {
      let result;
      let calls = 0;
      request(
        args[0],
        args[1],
        (value) => {
          result = value;
          calls += 1;
        },
        args[2],
      );
      assert.equal(calls, 1);
      return result;
    },
  };
}

const write = "clipboard-sanitized-write";
const origin = "https://panel.example:3002";
const details = { isMainFrame: true, requestingUrl: `${origin}/` };

test("local and remote main documents can write sanitized clipboard content", () => {
  for (const panelOrigin of [origin, "http://127.0.0.1:31337"]) {
    const h = harness(panelOrigin);
    const requesting = {
      isMainFrame: true,
      requestingUrl: `${panelOrigin}/#invite=example`,
    };
    assert.equal(h.check(h.contents, write, panelOrigin, requesting), true);
    assert.equal(h.request(h.contents, write, requesting), true);
  }
});

test("clipboard reads and unrelated permissions remain denied", () => {
  const h = harness();
  for (const permission of [
    "clipboard-read",
    "deprecated-sync-clipboard-read",
    "clipboard-write",
    "media",
    "notifications",
    "openExternal",
    "fileSystem",
    "unknown",
    undefined,
  ]) {
    assert.equal(h.check(h.contents, permission, origin, details), false);
    assert.equal(h.request(h.contents, permission, details), false);
  }
});

test("clipboard writes reject missing frame metadata, subframes and workers", () => {
  const h = harness();
  for (const requesting of [
    undefined,
    {},
    { requestingUrl: origin },
    { ...details, isMainFrame: false },
    { ...details, isMainFrame: 1 },
    { isMainFrame: true },
  ]) {
    assert.equal(h.check(h.contents, write, origin, requesting), false);
    assert.equal(h.request(h.contents, write, requesting), false);
  }
  for (const contents of [null, undefined, { ...h.contents }]) {
    assert.equal(h.check(contents, write, origin, details), false);
    assert.equal(h.request(contents, write, details), false);
  }
});

test("clipboard writes require matching top-level, requesting URL and origin", () => {
  const h = harness();
  for (const url of [
    "https://other.example:3002/",
    "https://panel.example:3003/",
    "http://panel.example:3002/",
    `blob:${origin}/document`,
    "about:blank",
    "data:text/html,hello",
    "file:///panel.html",
    "https://name:password@panel.example:3002/",
    "malformed",
    "",
    undefined,
  ]) {
    const requesting = { ...details, requestingUrl: url };
    assert.equal(h.check(h.contents, write, origin, requesting), false);
    assert.equal(h.request(h.contents, write, requesting), false);
    assert.equal(h.check(h.contents, write, url, details), false);
    h.contents.url = url;
    assert.equal(h.check(h.contents, write, origin, details), false);
    assert.equal(h.request(h.contents, write, details), false);
    h.contents.url = `${origin}/`;
  }
});

test("closed and replaced windows lose clipboard write permission", () => {
  const h = harness();
  h.contents.destroyed = true;
  assert.equal(h.check(h.contents, write, origin, details), false);
  assert.equal(h.request(h.contents, write, details), false);
  h.contents.destroyed = false;
  h.detach();
  assert.equal(h.check(h.contents, write, origin, details), false);
  assert.equal(h.request(h.contents, write, details), false);
});
