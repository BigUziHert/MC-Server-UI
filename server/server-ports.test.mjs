import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import {
  preflightServerPorts,
  probeServerPort,
  serverPorts,
} from "./server-ports.mjs";

test("startup preflight names a real occupied game port before launching Java", async (t) => {
  const listener = net.createServer();
  await new Promise((resolve) => listener.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => listener.close(resolve)));
  const port = listener.address().port;
  await assert.rejects(probeServerPort({ port, host: "127.0.0.1" }), {
    status: 409,
  });
  await assert.rejects(
    preflightServerPorts(new Map([["server-ip", "127.0.0.1"]]), port),
    new RegExp(`Port ${port}`),
  );
});

test("optional RCON/query conflicts warn without blocking a free game port and keep TCP separate from UDP", async () => {
  const settings = new Map([
    ["enable-rcon", "true"],
    ["enable-query", "true"],
  ]);
  const rows = serverPorts(settings, 25565);
  assert.deepEqual(
    rows.map(({ type, port }) => [type, port]),
    [
      ["tcp", 25565],
      ["tcp", 25575],
      ["udp", 25565],
    ],
  );
  const warnings = await preflightServerPorts(
    settings,
    25565,
    async ({ label }) => {
      if (label !== "game") throw new Error("occupied");
    },
  );
  assert.ok(warnings.some((value) => value.startsWith("RCON:")));
  assert.ok(warnings.some((value) => value.startsWith("query:")));
});
