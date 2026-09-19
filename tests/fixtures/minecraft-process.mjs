import { readFile, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { createHash } from "node:crypto";

// A subprocess fixture, never imported by application code. Tests exercise
// actual stdin/stdout, process exit, and Minecraft-owned files through it.
const log = (message) => console.log(`[Server thread/INFO]: ${message}`);
async function records(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return [];
  }
}
async function writeRecords(file, values) {
  await writeFile(file, JSON.stringify(values, null, 2) + "\n");
}
async function identity(name) {
  for (const file of [
    "usercache.json",
    "ops.json",
    "whitelist.json",
    "banned-players.json",
  ]) {
    const known = (await records(file)).find(
      (item) => item.name.toLowerCase() === name.toLowerCase(),
    );
    if (known) return { name: known.name, uuid: known.uuid };
  }
  const hash = createHash("md5").update(`OfflinePlayer:${name}`).digest("hex");
  return {
    name,
    uuid: `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20)}`,
  };
}
async function changeMembership(file, name, add, extra = {}) {
  const values = (await records(file)).filter(
    (entry) => entry.name.toLowerCase() !== name.toLowerCase(),
  );
  if (add) values.push({ ...(await identity(name)), ...extra });
  await writeRecords(file, values);
}
for (const [file, contents] of Object.entries({
  "ops.json": "[]\n",
  "whitelist.json": "[]\n",
  "banned-players.json": "[]\n",
  "server.properties": "max-players=20\nwhite-list=false\n",
})) {
  try {
    await writeFile(file, contents, { flag: "wx" });
  } catch (cause) {
    if (cause.code !== "EEXIST") throw cause;
  }
}
log("Starting minecraft server version 1.21.4");
log("Loading properties");
log('Done (2.314s)! For help, type "help"');
const input = createInterface({ input: process.stdin });
let pending = Promise.resolve();
input.on("line", (line) => {
  pending = pending
    .then(async () => {
      const [command, name, ...rest] = line.trim().split(/\s+/);
      if (command === "stop") {
        log("Stopping server");
        log("Saved the game");
        input.close();
        process.exit(0);
      } else if (command === "save-all") log("Saved the game");
      else if (command === "save-off") log("Automatic saving is now disabled");
      else if (command === "save-on") log("Automatic saving is now enabled");
      else if (command === "say") log(`[Server] ${line.slice(4)}`);
      else if (command === "time") log("The time is 6000.");
      else if (command === "list")
        log("There are 0 of a max of 20 players online:");
      else if (command === "op" || command === "deop") {
        await changeMembership("ops.json", name, command === "op", {
          level: 4,
          bypassesPlayerLimit: false,
        });
        log(
          command === "op"
            ? `Made ${name} a server operator`
            : `Made ${name} no longer a server operator`,
        );
      } else if (command === "ban" || command === "pardon") {
        await changeMembership("banned-players.json", name, command === "ban", {
          created: "2026-01-01 00:00:00 +0000",
          source: "Server",
          expires: "forever",
          reason: rest.join(" ") || "Banned by an operator.",
        });
        log(command === "ban" ? `Banned ${name}` : `Unbanned ${name}`);
      } else if (command === "whitelist") {
        if (name === "on" || name === "off") {
          const properties = await readFile("server.properties", "utf8");
          const next = `white-list=${name === "on"}`;
          await writeFile(
            "server.properties",
            /^white-list=/m.test(properties)
              ? properties.replace(/^white-list=.*$/m, next)
              : `${properties}\n${next}\n`,
          );
          log(`Whitelist is now ${name === "on" ? "turned on" : "turned off"}`);
        } else if (name === "add" || name === "remove") {
          await changeMembership("whitelist.json", rest[0], name === "add");
          log(
            `${name === "add" ? "Added" : "Removed"} ${rest[0]} ${name === "add" ? "to" : "from"} the whitelist`,
          );
        }
      } else if (command === "kick") log(`${name} left the game`);
      else log(`Executed: ${line}`);
    })
    .catch((cause) => {
      console.error(cause);
      process.exitCode = 1;
      input.close();
    });
});
