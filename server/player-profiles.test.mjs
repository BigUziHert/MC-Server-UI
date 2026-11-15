import test from "node:test";
import assert from "node:assert/strict";
import { offlinePlayerUuid, lookupPlayerProfile } from "./player-profiles.mjs";

test("offline UUIDs follow Minecraft's case-sensitive Java UUID convention", () => {
  assert.equal(
    offlinePlayerUuid("Notch"),
    "b50ad385-829d-3141-a216-7e7d7539ba7f",
  );
  assert.notEqual(offlinePlayerUuid("Notch"), offlinePlayerUuid("notch"));
});

test("first-time online profiles are resolved without trusting mismatched or missing identities", async () => {
  const profile = await lookupPlayerProfile("Notch", async () =>
    Response.json({ id: "069a79f444e94726a5befca90e38aaf5", name: "Notch" }),
  );
  assert.equal(profile.uuid, "069a79f4-44e9-4726-a5be-fca90e38aaf5");
  await assert.rejects(
    lookupPlayerProfile("Notch", async () =>
      Response.json({ id: "069a79f444e94726a5befca90e38aaf5", name: "Other" }),
    ),
    /different/,
  );
  await assert.rejects(
    lookupPlayerProfile(
      "Missing",
      async () => new Response(null, { status: 204 }),
    ),
    /No Minecraft/,
  );
});
