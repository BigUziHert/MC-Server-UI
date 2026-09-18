import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createPanel, createFleet } from "./index.mjs";
import { promoteVersion } from "./minecraft.mjs";
import { createRecycleBin } from "./recycle-bin.mjs";
import { containedSourcePath } from "./import.mjs";

const json = (method, body) => ({ method, body: JSON.stringify(body) });
const selection = {
  provider: "paper",
  version: "1.21.1",
  build: "12",
  confirmed: true,
  cleanInstall: true,
};
const gate = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
async function eventually(work) {
  const until = Date.now() + 5000;
  do {
    const value = await work();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 15));
  } while (Date.now() < until);
  assert.fail("The Minecraft operation did not reach its expected state.");
}
async function fixture(
  t,
  { fleet = false, mode = "live", stage, persistMinecraftConfiguration } = {},
) {
  const temporary = await fs.realpath(os.tmpdir());
  const root = await fs.mkdtemp(path.join(temporary, "mc-minecraft-test-"));
  const service = {
    listProviders: () => [{ id: "paper", name: "Paper", installable: true }],
    versions: async () => ({ versions: [{ id: "1.21.1", stable: true }] }),
    builds: async () => ({ builds: [{ id: "12", stable: true }] }),
    stage: async (input, ctx) => {
      if (stage) return stage(input, ctx);
      return makeStage(ctx);
    },
  };
  let panel, listener;
  const options = {
    dataDir: root,
    mode,
    jar: "server.jar",
    createDefaultServer: true,
    scheduler: false,
    useEnvironment: false,
    versionsService: service,
    extraProviders: [],
    publicAddress: { resolve: async () => null },
    telemetry: { reset() {}, sample: async () => null },
    persistMinecraftConfiguration,
  };
  const open = async () => {
    panel = await (fleet ? createFleet(options) : createPanel(options));
    listener = await new Promise((resolve) => {
      const server = panel.app.listen(0, "127.0.0.1", () => resolve(server));
    });
  };
  const close = async () => {
    await panel.close();
    listener.closeAllConnections();
    await new Promise((resolve) => listener.close(resolve));
  };
  await open();
  const serverDir = fleet
    ? [...panel.runtimes.values()][0].serverDir
    : panel.serverDir;
  await fs.mkdir(path.join(serverDir, "world"), { recursive: true });
  await fs.writeFile(path.join(serverDir, "server.jar"), "original JAR");
  await fs.writeFile(
    path.join(serverDir, "user_jvm_args.txt"),
    "-Xms6G -Xmx12G\n",
  );
  await fs.writeFile(
    path.join(serverDir, "world", "level.dat"),
    "precious world",
  );
  await fs.writeFile(
    path.join(serverDir, "server.properties"),
    "level-name=world\nserver-port=25565\nmotd=preserve me\n",
  );
  t.after(async () => {
    await close();
    assert.equal(path.dirname(root), temporary);
    assert.ok(path.basename(root).startsWith("mc-minecraft-test-"));
    await fs.rm(root, { recursive: true, force: true });
  });
  return {
    root,
    serverDir,
    service,
    close,
    restart: async () => {
      await close();
      await open();
    },
    request: async (route, init = {}, id) => {
      const response = await fetch(
        `http://127.0.0.1:${listener.address().port}${route}`,
        {
          ...init,
          headers: {
            "Content-Type": "application/json",
            ...(id ? { "X-Server-Id": id } : {}),
            ...init.headers,
          },
        },
      );
      return { status: response.status, body: await response.json() };
    },
  };
}
async function makeStage({ stageDir }) {
  const output = path.join(stageDir, "server");
  await fs.mkdir(output);
  await fs.writeFile(path.join(output, "server.jar"), "new verified JAR");
  await fs.writeFile(
    path.join(output, "user_jvm_args.txt"),
    "installer defaults",
  );
  return {
    stageDir: output,
    files: [
      { path: "server.jar" },
      { path: "user_jvm_args.txt", preserveExisting: true },
    ],
    configuration: {
      launchType: "jar",
      jar: "server.jar",
      launchArgs: [],
      launchScript: "",
      launchExecutable: "",
      software: "Paper",
      version: "1.21.1",
    },
    summary: { provider: "paper", version: "1.21.1", build: "12" },
  };
}
async function install(f, id) {
  const accepted = await f.request(
    "/api/versions/install",
    json("POST", selection),
    id,
  );
  assert.equal(accepted.status, 202, JSON.stringify(accepted.body));
  return eventually(async () => {
    const result = await f.request(
      `/api/versions/jobs/${accepted.body.id}`,
      {},
      id,
    );
    return ["complete", "failed"].includes(result.body.state)
      ? result.body
      : null;
  });
}

test("version jobs clean the entire selected server folder, retain recovery files, and persist fleet metadata", async (t) => {
  const f = await fixture(t, { fleet: true });
  const before = await fs.readFile(path.join(f.serverDir, "server.properties"));
  const result = await install(f);
  assert.equal(result.state, "complete", result.error);
  assert.equal(
    await fs.readFile(path.join(f.serverDir, "server.jar"), "utf8"),
    "new verified JAR",
  );
  assert.equal(
    await fs.readFile(path.join(f.serverDir, "user_jvm_args.txt"), "utf8"),
    "installer defaults",
  );
  await assert.rejects(fs.stat(path.join(f.serverDir, "world")), {
    code: "ENOENT",
  });
  assert.notDeepEqual(
    await fs.readFile(path.join(f.serverDir, "server.properties")),
    before,
  );
  const recycled = (await f.request("/api/files/recycle-bin")).body.items;
  for (const name of [
    "world",
    "server.jar",
    "server.properties",
    "user_jvm_args.txt",
  ])
    assert.ok(recycled.some((item) => item.originalPath === name));
  assert.match(result.backupPath, /recycle-bin$/);
  assert.equal((await f.request("/api/versions")).body.job.id, result.id);
  await f.restart();
  const current = (await f.request("/api/server")).body;
  assert.equal(current.software, "Paper");
  assert.equal(current.version, "1.21.1");
  assert.equal(current.status, "offline");
});

test("selecting a different JAR clears the installed Minecraft release in memory and the persisted registry", async (t) => {
  const f = await fixture(t, { fleet: true });
  assert.equal((await install(f)).state, "complete");
  const current = (await f.request("/api/versions")).body.current;
  assert.equal(current.gameVersion, "1.21.1");
  await fs.writeFile(
    path.join(f.serverDir, "replacement.jar"),
    "different server software",
  );
  const id = (await f.request("/api/servers")).body.servers[0].id;
  const changed = await f.request(
    `/api/servers/${id}`,
    json("PATCH", { jar: "replacement.jar" }),
  );
  assert.equal(changed.status, 200, JSON.stringify(changed.body));
  assert.equal(
    (await f.request("/api/versions")).body.current.gameVersion,
    null,
  );
  const registry = JSON.parse(
    await fs.readFile(path.join(f.root, "servers.json"), "utf8"),
  );
  assert.equal(
    registry.servers.find((entry) => entry.id === id).minecraftVersion,
    null,
  );
  await f.restart();
  const restored = (await f.request("/api/versions")).body.current;
  assert.equal(restored.gameVersion, null);
  assert.equal(restored.software, "Java");
  assert.equal(restored.version, "Configured JAR");
});

test("queued installations hold server power, file, settings and backup locks until the job ends", async (t) => {
  const started = gate(),
    release = gate(),
    cleanupStarted = gate(),
    finishCleanup = gate();
  let privateStage;
  t.after(() => {
    release.resolve();
    finishCleanup.resolve();
  });
  const f = await fixture(t, {
    fleet: true,
    stage: async (_input, ctx) => {
      privateStage = ctx.stageDir;
      started.resolve();
      await release.promise;
      return makeStage(ctx);
    },
  });
  const remove = fs.rm;
  t.mock.method(fs, "rm", async (target, ...args) => {
    if (target === privateStage) {
      cleanupStarted.resolve();
      await finishCleanup.promise;
    }
    return remove(target, ...args);
  });
  const serverId = (await f.request("/api/servers")).body.servers[0].id;
  const accepted = await f.request(
    "/api/versions/install",
    json("POST", selection),
  );
  assert.equal(accepted.status, 202);
  await started.promise;
  try {
    for (const [route, init] of [
      ["/api/server/power", json("POST", { action: "start" })],
      ["/api/files", json("DELETE", { path: "server.jar" })],
      ["/api/backups", json("POST", { name: "Concurrent backup" })],
      [
        `/api/servers/${serverId}`,
        json("PATCH", { name: "Concurrent rename" }),
      ],
      ["/api/versions/install", json("POST", selection)],
    ])
      assert.equal((await f.request(route, init)).status, 409, route);
    assert.equal(
      (await f.request("/api/versions")).body.job.id,
      accepted.body.id,
    );
    assert.equal(
      await fs.readFile(path.join(f.serverDir, "server.jar"), "utf8"),
      "original JAR",
    );
  } finally {
    release.resolve();
  }
  await cleanupStarted.promise;
  try {
    assert.equal(
      (await f.request(`/api/versions/jobs/${accepted.body.id}`)).body.state,
      "running",
      "A terminal job must not be published before private cleanup releases the mutation lock.",
    );
    assert.equal(
      (
        await f.request(
          `/api/servers/${serverId}`,
          json("PATCH", { name: "During cleanup" }),
        )
      ).status,
      409,
    );
  } finally {
    finishCleanup.resolve();
  }
  await eventually(
    async () =>
      (await f.request(`/api/versions/jobs/${accepted.body.id}`)).body.state ===
      "complete",
  );
  assert.equal(
    (
      await f.request(
        `/api/servers/${serverId}`,
        json("PATCH", { name: "Unlocked rename" }),
      )
    ).status,
    200,
  );
});

test("a failed registry application rolls replaced files back and retains the former startup configuration", async (t) => {
  let attempts = 0;
  const f = await fixture(t, {
    persistMinecraftConfiguration: async () => {
      if (++attempts === 1)
        throw Object.assign(new Error("fixture registry failure"), {
          status: 409,
        });
    },
  });
  const result = await install(f);
  assert.equal(result.state, "failed");
  assert.equal(
    attempts,
    2,
    "configuration rollback reaches registry persistence",
  );
  assert.match(
    result.error,
    /fixture registry failure.*Previous server files were restored/,
  );
  assert.equal(
    await fs.readFile(path.join(f.serverDir, "server.jar"), "utf8"),
    "original JAR",
  );
  assert.equal((await f.request("/api/server")).body.software, "Java");
  assert.equal((await f.request("/api/server")).body.status, "offline");
});

test("malformed or duplicate promotion paths fail before replacing any source file", async (t) => {
  const cases = [
    "../outside",
    "libraries/../../outside",
    "C:/outside",
    "libraries\\file.jar",
    "server.jar",
  ];
  for (const bad of cases) {
    const f = await fixture(t, {
      stage: async (_input, ctx) => {
        const result = await makeStage(ctx);
        result.files.push({ path: bad });
        return result;
      },
    });
    const result = await install(f);
    assert.equal(result.state, "failed", bad);
    assert.match(result.error, /invalid file path|conflicting file paths/);
    assert.equal(
      await fs.readFile(path.join(f.serverDir, "server.jar"), "utf8"),
      "original JAR",
    );
    assert.equal(
      (await f.request("/api/files/recycle-bin")).body.items.length,
      0,
    );
  }
});

test("version installation requires explicit confirmation and a stopped server", async (t) => {
  const f = await fixture(t, { mode: "demo" });
  assert.equal(
    (
      await f.request(
        "/api/versions/install",
        json("POST", { ...selection, cleanInstall: false }),
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await f.request(
        "/api/versions/install",
        json("POST", { ...selection, confirmed: false }),
      )
    ).status,
    400,
  );
  assert.equal(
    (await f.request("/api/versions/install", json("POST", selection))).status,
    409,
  );
  assert.equal(
    await fs.readFile(path.join(f.serverDir, "server.jar"), "utf8"),
    "original JAR",
  );
});

test("installation jobs and their source changes are selected-server scoped", async (t) => {
  const f = await fixture(t, { fleet: true });
  const initialId = (await f.request("/api/servers")).body.servers[0].id;
  const added = await f.request(
    "/api/servers",
    json("POST", {
      name: "Other server",
      mode: "live",
      port: 25566,
      jar: "server.jar",
    }),
  );
  assert.equal(added.status, 201);
  const result = await install(f, initialId);
  assert.equal(result.state, "complete");
  assert.equal(
    (
      await f.request(
        `/api/versions/jobs/${result.id}`,
        {},
        added.body.server.id,
      )
    ).status,
    404,
  );
  assert.equal(
    (await f.request("/api/versions", {}, added.body.server.id)).body.job,
    null,
  );
  assert.equal(
    (await f.request("/api/server", {}, added.body.server.id)).body.software,
    "Java",
  );
});

test("closing aborts a staged installer and waits without promoting its partial outputs", async (t) => {
  const started = gate();
  let aborted = false;
  const f = await fixture(t, {
    stage: async (_input, ctx) => {
      started.resolve();
      await new Promise((resolve, reject) =>
        ctx.signal.addEventListener(
          "abort",
          () => {
            aborted = true;
            reject(new Error("Fixture cancelled"));
          },
          { once: true },
        ),
      );
    },
  });
  assert.equal(
    (await f.request("/api/versions/install", json("POST", selection))).status,
    202,
  );
  await started.promise;
  await f.close();
  assert.equal(aborted, true);
  assert.equal(
    await fs.readFile(path.join(f.serverDir, "server.jar"), "utf8"),
    "original JAR",
  );
});

test("partial configuration failures roll back settings and receipts independently", async (t) => {
  const f = await fixture(t);
  const stage = path.join(f.root, "promotion-test");
  await fs.mkdir(stage);
  const result = await makeStage({ stageDir: stage });
  const safePath = (root, relative = "") =>
    relative ? containedSourcePath(root, relative) : fs.realpath(root);
  const bin = await createRecycleBin({
    dataDir: f.root,
    serverDir: f.serverDir,
    safePath,
  });
  let configuration = {
    software: "Previous",
    port: 25565,
    memoryLimitMB: 4096,
  };
  let applies = 0,
    restores = 0;
  await assert.rejects(
    promoteVersion(result, {
      serverDir: f.serverDir,
      dataDir: f.root,
      safePath,
      getConfiguration: () => configuration,
      applyConfiguration: async (value) => {
        configuration = value;
        if (++applies === 1)
          throw new Error("failed after configuration changed");
        throw new Error("restore persisted but refresh failed");
      },
      snapshotInstalled: () => [{ title: "Previous pack" }],
      restoreInstalled: async (value) => {
        assert.equal(value[0].title, "Previous pack");
        restores++;
      },
      recycle: (name) => bin.recycle(name),
      restore: (id) => bin.restore(id),
    }),
    /failed after configuration changed.*Recovery needs attention for server settings/,
  );
  assert.equal(applies, 2);
  assert.equal(configuration.software, "Previous");
  assert.equal(
    restores,
    1,
    "receipt rollback still runs when configuration rollback throws",
  );
  assert.equal(
    await fs.readFile(path.join(f.serverDir, "server.jar"), "utf8"),
    "original JAR",
  );
});

test("Versions terminal outcomes survive restart and persistent dismissal with normalized job wrappers", async (t) => {
  const f = await fixture(t);
  const job = await install(f);
  assert.equal(job.status, "completed");
  assert.equal(job.job.id, job.id);
  await f.restart();
  assert.equal((await f.request("/api/versions")).body.job.id, job.id);
  assert.equal(
    (await f.request(`/api/versions/jobs/${job.id}`)).body.job.status,
    "completed",
  );
  assert.equal(
    (await f.request(`/api/versions/jobs/${job.id}/dismiss`, json("POST", {})))
      .status,
    200,
  );
  await f.restart();
  assert.equal((await f.request("/api/versions")).body.job, null);
});

test("a terminal-history write failure cannot prevent Minecraft management shutdown", async (t) => {
  const f = await fixture(t);
  const rename = fs.rename.bind(fs),
    diagnostics = [];
  t.mock.method(console, "warn", (message) => diagnostics.push(message));
  t.mock.method(fs, "rename", async (source, destination) => {
    if (String(destination).endsWith("last-job.json"))
      throw Object.assign(new Error("Fixture history disk is full"), {
        code: "ENOSPC",
      });
    return rename(source, destination);
  });
  const completed = await install(f);
  assert.equal(completed.status, "completed");
  // restart calls the complete management close path before rebuilding it.
  // Previously rejected history.flush aborted that path before runtime stop.
  await f.restart();
  assert.ok(
    diagnostics.some((message) =>
      /Installation history.*disk is full/.test(message),
    ),
  );
  assert.equal((await f.request("/api/server")).body.status, "offline");
});
