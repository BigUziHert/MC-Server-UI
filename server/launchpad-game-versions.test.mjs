import test from "node:test";
import assert from "node:assert/strict";
import { createCoreProviders } from "./launchpad-providers.mjs";

test("Launchpad Minecraft version catalog keeps every release channel in newest-first date order", async () => {
  const tags = [
    { version: "b1.7.3", version_type: "beta", date: "2011-07-07T22:00:00Z" },
    {
      version: "1.21.1",
      version_type: "release",
      date: "2024-08-08T12:24:45Z",
    },
    {
      version: "rd-132211",
      version_type: "alpha",
      date: "2009-05-13T20:11:00Z",
    },
    {
      version: "26.3-rc-2",
      version_type: "snapshot",
      date: "2026-09-11T10:34:40Z",
    },
    {
      version: "25w01a",
      version_type: "snapshot",
      date: "2025-01-01T12:00:00Z",
    },
    {
      version: "26.3-rc-1",
      version_type: "snapshot",
      date: "2026-09-10T11:28:25Z",
    },
    { version: "26.2", version_type: "release", date: "2026-07-01T12:00:00Z" },
    { version: "a1.2.6", version_type: "alpha", date: "2010-12-03T12:00:00Z" },
  ];
  let requested;
  const [provider] = createCoreProviders({
    fetch: async (url) => {
      requested = url;
      return Response.json(tags);
    },
  });
  assert.deepEqual(await provider.gameVersions(), [
    "26.3-rc-2",
    "26.3-rc-1",
    "26.2",
    "25w01a",
    "1.21.1",
    "b1.7.3",
    "a1.2.6",
    "rd-132211",
  ]);
  assert.equal(requested, "https://api.modrinth.com/v2/tag/game_version");
});

test("Launchpad Minecraft version catalog deduplicates tags without inventing or losing undated versions", async () => {
  const [provider] = createCoreProviders({
    fetch: async () =>
      Response.json([
        { version: "same-tag", date: "2026-09-12T10:00:00Z" },
        { version: "older-offset", date: "2026-09-12T12:15:00+02:00" },
        { version: "newer-utc", date: "2026-09-12T10:30:00Z" },
        { version: "same-tag", date: "2026-09-11T10:00:00Z" },
        { version: "provider-tag-without-date" },
        { version: "provider-tag-with-invalid-date", date: "unknown" },
        { version: "" },
        { version: "   " },
        { version: null },
        null,
      ]),
  });
  assert.deepEqual(await provider.gameVersions(), [
    "newer-utc",
    "older-offset",
    "same-tag",
    "provider-tag-without-date",
    "provider-tag-with-invalid-date",
  ]);
});
