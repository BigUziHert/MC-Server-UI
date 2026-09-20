import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export default async function cleanup() {
  const directory = process.env.PANEL_E2E_DATA_DIR;
  if (!directory) return;
  const target = path.resolve(directory);
  const parent = path.resolve(tmpdir());
  // Refuse recursive cleanup outside a direct, explicitly prefixed temp folder.
  if (
    path.dirname(target).toLowerCase() !== parent.toLowerCase() ||
    !path.basename(target).startsWith("mc-panel-e2e-")
  ) {
    throw new Error(
      `Refusing to remove unexpected test data directory: ${target}`,
    );
  }
  // Playwright runs global teardown before shutting down its web server. Stop
  // this run's subprocesses first so Windows can remove their working folders.
  const registry = await readFile(path.join(target, "servers.json"), "utf8")
    .then((contents) => JSON.parse(contents) as { servers: { id: string }[] })
    .catch((cause) => {
      if (cause.code === "ENOENT") return { servers: [] };
      throw cause;
    });
  for (const server of registry.servers) {
    const headers = {
      "X-Server-Id": server.id,
      "Content-Type": "application/json",
    };
    const status = async () => {
      // Fleet descriptors report lifecycle without the per-process telemetry
      // collector, whose 5-second budget can exceed teardown's request timeout.
      const response = await fetch("http://127.0.0.1:3111/api/servers", {
        headers,
        signal: AbortSignal.timeout(3_000),
      });
      if (response.status === 404) return "offline";
      if (!response.ok) throw new Error(await response.text());
      const fleet = await response.json();
      return (
        fleet.servers.find(
          (entry: { id: string; status: string }) => entry.id === server.id,
        )?.status ?? "offline"
      );
    };
    let current: string;
    try {
      current = await status();
    } catch (cause) {
      if (
        (cause as { cause?: { code?: string } }).cause?.code === "ECONNREFUSED"
      )
        break;
      throw cause;
    }
    if (current === "offline") continue;
    const stopped = await fetch("http://127.0.0.1:3111/api/server/power", {
      method: "POST",
      headers,
      body: JSON.stringify({ action: "stop" }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!stopped.ok) throw new Error(await stopped.text());
    const deadline = Date.now() + 10_000;
    while ((await status()) !== "offline") {
      if (Date.now() > deadline)
        throw new Error(
          `Test server ${server.id} did not stop before cleanup.`,
        );
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  await rm(target, {
    recursive: true,
    force: true,
    maxRetries: 4,
    retryDelay: 300,
  });
}
