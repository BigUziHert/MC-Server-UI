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

const versionLinks = [
  "https://ci.pufferfish.host/job/Pufferfish-1.21/39/",
  "https://jenkins.canvasmc.io/job/Canvas/1038/",
  "https://fill-ui.papermc.io/projects/paper/version/1.21.1",
  "https://fill-ui.papermc.io/projects/velocity/version/4.3.1?build=45",
  "https://fill-ui.papermc.io/projects/folia/version/26.1.2?build=8",
  "https://fill-ui.papermc.io/projects/waterfall/version/1.21?build=609",
  "https://maven.neoforged.net/releases/net/neoforged/neoforge/21.1.267/",
  "https://maven.neoforged.net/releases/net/neoforged/neoforge/21.1.267/neoforge-21.1.267-changelog.txt",
  "https://maven.minecraftforge.net/net/minecraftforge/forge/1.21.1-52.0.20/forge-1.21.1-52.0.20-changelog.txt",
  "https://github.com/FabricMC/fabric-loader/releases",
  "https://github.com/FabricMC/fabric-loader/releases/tag/0.16.14",
  "https://maven.fabricmc.net/net/fabricmc/fabric-loader/0.7.0%2Bbuild.171/",
  "https://maven.quiltmc.org/repository/release/org/quiltmc/quilt-loader/0.29.0/",
  "https://launchercontent.mojang.com/v2/javaPatchNotes/1234-abcd.json",
  "https://feedback.minecraft.net/hc/en-us/articles/29100721259021-Minecraft-Java-Edition-1-21-1",
  "https://piston-meta.mojang.com/v1/packages/75bf72d8e4b38cf5f729637efc116697edec4334/1.14.2%20Pre-Release%204.json",
  "https://launchermeta.mojang.com/v1/packages/75bf72d8e4b38cf5f729637efc116697edec4334/1.14.2%20Pre-Release%204.json",
  "https://api.leavesmc.org/v2/projects/leaves/versions/1.21.11/builds",
  "https://api.leavesmc.org/v2/projects/leaves/versions/1.21.11/builds/157",
  "https://repo.magmafoundation.org/releases/org/magmafoundation/magma/21.1.70-beta/magma-21.1.70-beta-changelog.txt",
  "https://hub.spigotmc.org/versions/",
  "https://hub.spigotmc.org/versions/26.3.json",
  "https://hub.spigotmc.org/versions/1.13-pre7.json",
];

test("desktop permits all catalog project pages and every Versions official source", () => {
  for (const url of [
    ...catalogLinks,
    ...versionLinks,
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
    "https://ci.pufferfish.host/job/Pufferfish-1.21/39/artifact/build.jar",
    "https://jenkins.canvasmc.io/job/Canvas/1038/artifact/build.jar",
    "https://github.com/FabricMC/fabric-loader/releases/download/0.16.14/fabric-loader.jar",
    "https://github.com/FabricMC/fabric-loader/releases/tag/0.16.14?dummy=1",
    "https://github.com/FabricMC/another-project/releases/tag/0.16.14",
    "https://fill-ui.papermc.io/login?redirect=https://evil.example",
    "https://fill-ui.papermc.io/projects/another/version/1.21.1",
    "https://fill-ui.papermc.io/projects/paper/version/1.21.1?build=132&next=elsewhere",
    "https://maven.neoforged.net/releases/net/neoforged/neoforge/21.1.267/neoforge-21.1.266-changelog.txt",
    "https://maven.neoforged.net/releases/net/neoforged/neoforge/21.1.267/neoforge-21.1.267-installer.jar",
    "https://maven.minecraftforge.net/net/minecraftforge/forge/1.21.1-52.0.20/forge-1.21.1-52.0.20-installer.jar",
    "https://maven.fabricmc.net/net/fabricmc/fabric-loader/0.16.14/fabric-loader-0.16.14.jar",
    "https://maven.quiltmc.org/repository/release/org/quiltmc/quilt-loader/0.29.0/quilt-loader-0.29.0.jar",
    "https://launchercontent.mojang.com/v2/javaPatchNotes/anything.exe",
    "https://feedback.minecraft.net/hc/en-us/articles/123?next=https://example.test",
    "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json",
    "https://piston-meta.mojang.com/v1/packages/invalid/1.14.2.json",
    "https://api.leavesmc.org/v2/projects/other/versions/1.21.11/builds/157",
    "https://api.leavesmc.org/v2/projects/leaves/versions/1.21.11/builds/latest",
    "https://api.leavesmc.org/v2/projects/leaves/versions/1.21.11/builds/157/downloads/application",
    "https://repo.magmafoundation.org/releases/org/magmafoundation/magma/21.1.70-beta/magma-21.1.69-beta-changelog.txt",
    "https://repo.magmafoundation.org/releases/org/magmafoundation/magma/21.1.70-beta/magma-21.1.70-beta-launcher.jar",
    "https://hub.spigotmc.org/jenkins/job/BuildTools/201/artifact/target/BuildTools.jar",
    "https://hub.spigotmc.org/versions/26.3.json?next=elsewhere",
    "https://hub.spigotmc.org/versions/latest.json",
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
  const openedPages = [...catalogLinks, ...versionLinks];
  for (const url of openedPages)
    assert.deepEqual(windowHandler({ url }), { action: "deny" });
  assert.deepEqual(opened, openedPages);
  let blocked = 0;
  const event = { preventDefault: () => blocked++ };
  contents.emit("will-navigate", event, "http://127.0.0.1:45678/#files");
  assert.equal(blocked, 0);
  contents.emit("will-navigate", event, catalogLinks[0]);
  contents.emit("will-navigate", event, "https://evil.example/");
  contents.emit("will-navigate", event, "invalid");
  assert.equal(blocked, 3);
  assert.deepEqual(opened, [...openedPages, catalogLinks[0]]);
  assert.deepEqual(windowHandler({ url: "file:///C:/Windows/notepad.exe" }), {
    action: "deny",
  });
  assert.deepEqual(opened, [...openedPages, catalogLinks[0]]);
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

test("desktop opens only the saved public panel address in the browser", async () => {
  for (const publicPanelUrl of [
    "https://203.0.113.20",
    "https://panel.example.com",
    "https://[2001:db8::20]",
    "https://panel.example.com:3004",
  ]) {
    const opened = [];
    const contents = new EventEmitter();
    let windowHandler;
    contents.setWindowOpenHandler = (handler) => {
      windowHandler = handler;
    };
    let savedAddress = publicPanelUrl;
    installExternalLinkHandlers(contents, "http://127.0.0.1:45678", (url) =>
      openExternalWebsite(url, {
        publicPanelUrl: savedAddress,
        openExternal: async (target) => opened.push(target),
        logError: assert.fail,
      }),
    );
    const expected = new URL(publicPanelUrl).href;
    assert.deepEqual(windowHandler({ url: expected }), { action: "deny" });
    assert.deepEqual(opened, [expected]);
    let blocked = false;
    contents.emit(
      "will-navigate",
      { preventDefault: () => (blocked = true) },
      expected,
    );
    assert.equal(blocked, true);
    assert.deepEqual(opened, [expected, expected]);
    for (const url of [
      `${publicPanelUrl}/redirect?url=https://elsewhere.example`,
      `${publicPanelUrl}/?next=https://elsewhere.example`,
      `${publicPanelUrl}/#redirect`,
      publicPanelUrl.replace("https:", "http:"),
      publicPanelUrl.replace("https://", "https://user:password@"),
      "https://unconfigured.example/",
      "https://203.0.113.21/",
      "file:///C:/Windows/notepad.exe",
    ]) {
      assert.deepEqual(windowHandler({ url }), { action: "deny" });
    }
    assert.deepEqual(opened, [expected, expected]);
    savedAddress = "https://changed.example";
    windowHandler({ url: expected });
    windowHandler({ url: `${savedAddress}/` });
    assert.deepEqual(opened, [expected, expected, `${savedAddress}/`]);
  }
});

test("malformed public panel settings do not allow unsafe destinations or disable catalog links", () => {
  for (const publicPanelUrl of [
    "",
    "invalid",
    "file:///C:/Windows/notepad.exe",
    "http://panel.example.com",
    "https://user:password@panel.example.com/",
  ]) {
    assert.equal(externalWebsite(publicPanelUrl, { publicPanelUrl }), null);
    assert.equal(
      externalWebsite(catalogLinks[0], { publicPanelUrl }),
      catalogLinks[0],
    );
  }
});
