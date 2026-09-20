import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { versionProviders } from "../server/versions.mjs";
import {
  externalWebsite,
  installExternalLinkHandlers,
  openExternalWebsite,
} from "./external-links.mjs";

const catalogLinks = [
  "https://modrinth.com/mod/cloth-config",
  "https://www.curseforge.com/minecraft/mc-mods/cloth-config",
  "https://www.spigotmc.org/resources/123/",
  "https://www.feed-the-beast.com/modpacks/123",
  "https://atlauncher.com/pack/TestPack",
  "https://voidswrath.com/modpacks/test-pack/",
];

test("desktop permits all catalog project pages and every Versions official source", () => {
  for (const url of [
    ...catalogLinks,
    ...versionProviders.map((provider) => provider.website),
    "https://github.com/BigUziHert/MC-Server-UI/tree/dev#readme",
    "https://aka.ms/MinecraftEULA",
  ])
    assert.equal(externalWebsite(url), url, url);
});

test("desktop blocks arbitrary protocols, credentials, unlisted hosts, and deceptive URLs", async () => {
  const opened = [];
  for (const url of [
    "javascript:alert(1)",
    "file:///C:/Windows/notepad.exe",
    "ms-settings:privacy",
    "http://modrinth.com/mod/cloth-config",
    "https://modrinth.com:8443/mod/cloth-config",
    "https://modrinth.com.evil.example/mod/cloth-config",
    "https://evil-modrinth.com/",
    "https://modrinth.com@evil.example/",
    "https://user:password@modrinth.com/",
    "https://127.0.0.1/",
    "https://github.com/BigUziHert/MC-Server-UI-evil",
    "https://github.com/untrusted/project",
    "https://aka.ms/untrusted-link",
    "https://aka.ms/MinecraftEULA?redirect=elsewhere",
    "https://aka.ms/MinecraftEULA#fragment",
    "not a URL",
    "",
    null,
  ]) {
    assert.equal(externalWebsite(url), null, String(url));
    assert.equal(
      await openExternalWebsite(url, {
        openExternal: async (target) => opened.push(target),
        logError: assert.fail,
      }),
      false,
    );
  }
  assert.deepEqual(opened, []);
});

test("desktop new-window and navigation handlers route catalog links to browser without replacing panel", async () => {
  const contents = new EventEmitter();
  let windowHandler;
  contents.setWindowOpenHandler = (handler) => {
    windowHandler = handler;
  };
  const opened = [];
  const opener = (url) =>
    openExternalWebsite(url, {
      openExternal: async (target) => opened.push(target),
      logError: assert.fail,
    });
  installExternalLinkHandlers(contents, "http://127.0.0.1:45678", opener);
  for (const url of catalogLinks)
    assert.deepEqual(windowHandler({ url }), { action: "deny" });
  assert.deepEqual(opened, catalogLinks);
  let blocked = 0;
  const event = { preventDefault: () => blocked++ };
  contents.emit("will-navigate", event, "http://127.0.0.1:45678/#files");
  assert.equal(blocked, 0);
  contents.emit("will-navigate", event, catalogLinks[0]);
  contents.emit("will-navigate", event, "https://evil.example/");
  contents.emit("will-navigate", event, "invalid");
  assert.equal(blocked, 3);
  assert.deepEqual(opened, [...catalogLinks, catalogLinks[0]]);
  assert.deepEqual(windowHandler({ url: "file:///C:/Windows/notepad.exe" }), {
    action: "deny",
  });
  assert.deepEqual(opened, [...catalogLinks, catalogLinks[0]]);
});

test("desktop reports browser-opening errors without unhandled rejections", async () => {
  const failure = new Error("Browser could not start");
  const errors = [];
  assert.equal(
    await openExternalWebsite(catalogLinks[0], {
      openExternal: async () => {
        throw failure;
      },
      logError: async (error) => errors.push(error),
    }),
    false,
  );
  assert.deepEqual(errors, [failure]);
});
