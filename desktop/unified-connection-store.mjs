import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { safePath } from "../server/index.mjs";
import { createConnectionStore } from "./connection-store.mjs";
import { normalizePanelConnectionUrl } from "../shared/panel-connection.mjs";

const file = "desktop-workspace.json";
// 50 panels × 500 rows with every bounded string JSON-escaped still fits.
// Keep every legitimate offline row, while refusing unbounded damaged files.
const maximumBytes = 128 * 1024 * 1024;
const maximumCredentialBytes = 16 * 1024;
const validId = (value) =>
  typeof value === "string" && /^[a-f0-9-]{36}$/.test(value);
const validToken = (value) =>
  typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
const validRequestId = (value) =>
  typeof value === "string" &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
const object = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value, limit) =>
  typeof value === "string" && value.length > 0 && value.length <= limit;
const fingerprint = (value) =>
  typeof value === "string" && /^(?:[0-9A-F]{2}:){31}[0-9A-F]{2}$/.test(value);
const warning =
  "Some saved connections could not be restored. You can reconnect; the damaged file is preserved when changes are saved.";

function identity(value) {
  if (
    !object(value) ||
    value.role !== "subuser" ||
    !text(value.email, 256) ||
    !text(value.userId, 128)
  )
    return null;
  // Offline identity is display-only. Permissions must come from a live host.
  return {
    role: "subuser",
    email: value.email,
    userId: value.userId,
    ...(text(value.accountId, 128) ? { accountId: value.accountId } : {}),
    serverId: text(value.serverId, 128) ? value.serverId : null,
  };
}

export function displayRoster(servers = []) {
  if (!Array.isArray(servers)) return [];
  const seen = new Set();
  return servers.slice(0, 500).flatMap((server) => {
    if (
      !text(server?.id, 128) ||
      typeof server.name !== "string" ||
      seen.has(server.id)
    )
      return [];
    seen.add(server.id);
    return [
      {
        id: server.id,
        name: server.name.slice(0, 180),
        status: "unavailable",
        ...(typeof server.software === "string"
          ? { software: server.software.slice(0, 128) }
          : {}),
        ...(typeof server.minecraftVersion === "string"
          ? { minecraftVersion: server.minecraftVersion.slice(0, 128) }
          : {}),
      },
    ];
  });
}

function selection(value, panels) {
  if (!object(value) || !text(value.serverId, 128)) return null;
  if (
    value.panelId !== "local" &&
    !panels.some(
      (panel) =>
        panel.id === value.panelId &&
        panel.token &&
        panel.session &&
        panel.servers.some((server) => server.id === value.serverId),
    )
  )
    return null;
  return { panelId: value.panelId, serverId: value.serverId };
}

function boundedSnapshot(panels, selectedServer) {
  return { panels, selectedServer: selection(selectedServer, panels) };
}

// The separate file allows upgrading without modifying legacy credentials.
// Only bounded display metadata and OS-encrypted account identity are saved.
export function createUnifiedConnectionStore({ dataDir, safeStorage }) {
  let writes = Promise.resolve(),
    legacyWrites = Promise.resolve(),
    lastSemantic,
    recoveredSemantic,
    needsBackup = false;
  const legacy = createConnectionStore({ dataDir });
  const recover = (result, message = warning) => {
    needsBackup = true;
    lastSemantic = undefined;
    recoveredSemantic = JSON.stringify(result);
    return { ...result, warning: message };
  };
  return {
    async read() {
      await writes.catch(() => {});
      let saved;
      let handle;
      try {
        handle = await fs.open(await safePath(dataDir, file), "r");
        const stat = await handle.stat();
        if (!stat.isFile())
          throw new Error("Saved connections require an ordinary file.");
        if (stat.size > maximumBytes)
          return recover({ panels: [], selectedServer: null });
        const chunks = [];
        let length = 0;
        while (length <= maximumBytes) {
          const buffer = Buffer.alloc(
            Math.min(64 * 1024, maximumBytes + 1 - length),
          );
          const { bytesRead } = await handle.read(
            buffer,
            0,
            buffer.length,
            length,
          );
          if (!bytesRead) break;
          length += bytesRead;
          chunks.push(buffer.subarray(0, bytesRead));
        }
        if (length > maximumBytes)
          return recover({ panels: [], selectedServer: null });
        saved = JSON.parse(Buffer.concat(chunks, length).toString("utf8"));
      } catch (cause) {
        if (cause instanceof SyntaxError)
          return recover({ panels: [], selectedServer: null });
        if (cause.code !== "ENOENT") throw cause;
        const prior = await legacy.read();
        return {
          selectedServer: null,
          panels: prior.panels.map(({ id, origin, trustedFingerprint }) => ({
            id,
            origin,
            trustedFingerprint,
            servers: [],
          })),
          migrated: prior.panels.length > 0,
        };
      } finally {
        await handle?.close();
      }
      if (!object(saved) || saved.version !== 1 || !Array.isArray(saved.panels))
        return recover({ panels: [], selectedServer: null });
      let damaged = saved.panels.length > 50;
      let renewSignIn = false;
      const panels = [],
        origins = new Set(),
        ids = new Set();
      for (const entry of saved.panels.slice(0, 50)) {
        let origin;
        try {
          if (!object(entry) || !validId(entry.id) || ids.has(entry.id))
            throw new Error();
          origin = new URL(normalizePanelConnectionUrl(entry.origin)).origin;
          if (origin !== entry.origin || origins.has(origin)) throw new Error();
        } catch {
          damaged = true;
          continue;
        }
        ids.add(entry.id);
        origins.add(origin);
        let credential, session;
        if (
          typeof entry.credential === "string" &&
          entry.credential.length <= maximumCredentialBytes * 2 &&
          safeStorage.isEncryptionAvailable()
        ) {
          try {
            const bytes = Buffer.from(entry.credential, "base64");
            if (bytes.length > maximumCredentialBytes) throw new Error();
            credential = JSON.parse(safeStorage.decryptString(bytes));
            session = identity(credential?.session);
          } catch {
            /* Other OS accounts cannot restore this sign-in. */
          }
        }
        const signedIn = validToken(credential?.token) && session;
        if (
          credential?.pendingLeave !== undefined &&
          !validRequestId(credential.pendingLeave?.requestId)
        )
          damaged = true;
        if (entry.credential !== undefined && !signedIn) renewSignIn = true;
        if (
          !Array.isArray(entry.servers) ||
          entry.servers.length > 500 ||
          (entry.trustedFingerprint !== undefined &&
            !fingerprint(entry.trustedFingerprint))
        )
          damaged = true;
        panels.push({
          id: entry.id,
          origin,
          ...(fingerprint(entry.trustedFingerprint)
            ? { trustedFingerprint: entry.trustedFingerprint }
            : {}),
          servers: signedIn ? displayRoster(entry.servers) : [],
          ...(signedIn ? { token: credential.token, session } : {}),
          ...(signedIn && validRequestId(credential?.pendingLeave?.requestId)
            ? { pendingLeave: { requestId: credential.pendingLeave.requestId } }
            : {}),
        });
      }
      const result = boundedSnapshot(panels, saved.selectedServer);
      if (damaged) return recover(result);
      if (renewSignIn)
        return recover(
          result,
          "Some saved sign-ins could not be decrypted on this computer. Sign in again to those panels; other connections remain available.",
        );
      needsBackup = false;
      recoveredSemantic = undefined;
      lastSemantic = JSON.stringify(result);
      return result;
    },
    save({ panels, selectedServer, requireCredentialFor }) {
      if (!Array.isArray(panels) || panels.length > 50)
        return Promise.reject(
          new Error("Provide at most 50 saved panel connections."),
        );
      let normalized;
      try {
        if (
          requireCredentialFor !== undefined &&
          (!validId(requireCredentialFor) ||
            !panels.some((panel) => panel?.id === requireCredentialFor))
        )
          throw new Error("The sign-in to save is no longer available.");
        const ids = new Set(),
          origins = new Set();
        normalized = panels.map((panel) => {
          const origin = new URL(normalizePanelConnectionUrl(panel.origin))
            .origin;
          if (
            !validId(panel.id) ||
            origin !== panel.origin ||
            ids.has(panel.id) ||
            origins.has(origin)
          )
            throw new Error("Provide valid, distinct saved panel connections.");
          ids.add(panel.id);
          origins.add(origin);
          const session = identity(panel.session);
          const signedIn =
            validToken(panel.token) &&
            session &&
            safeStorage.isEncryptionAvailable();
          if (panel.id === requireCredentialFor && !signedIn)
            throw new Error(
              "This sign-in could not be encrypted and saved. Restore this computer's secure storage and try again; the new connection was not saved.",
            );
          if (
            panel.pendingLeave &&
            (!signedIn || !validRequestId(panel.pendingLeave.requestId))
          )
            throw new Error(
              "The access removal retry proof could not be encrypted and saved. Restore this computer's secure storage before trying Forget again.",
            );
          return {
            id: panel.id,
            origin,
            ...(fingerprint(panel.trustedFingerprint)
              ? { trustedFingerprint: panel.trustedFingerprint }
              : {}),
            servers: signedIn ? displayRoster(panel.servers) : [],
            ...(signedIn ? { token: panel.token, session } : {}),
            ...(panel.pendingLeave
              ? { pendingLeave: { requestId: panel.pendingLeave.requestId } }
              : {}),
          };
        });
      } catch (cause) {
        return Promise.reject(cause);
      }
      const snapshot = boundedSnapshot(normalized, selectedServer);
      const semantic = JSON.stringify(snapshot);
      const write = writes
        .catch(() => {})
        .then(async () => {
          if (
            requireCredentialFor !== undefined &&
            !safeStorage.isEncryptionAvailable()
          )
            throw new Error(
              "This sign-in could not be encrypted and saved. Restore this computer's secure storage and try again; the new connection was not saved.",
            );
          // Closing or refreshing an unchanged recovered workspace must not
          // replace the original damaged file. Normal unchanged polls also skip IO.
          if (semantic === lastSemantic || semantic === recoveredSemantic)
            return;
          const body = JSON.stringify({
            version: 1,
            selectedServer: snapshot.selectedServer,
            panels: snapshot.panels.map(
              ({ token, session, pendingLeave, ...panel }) => {
                if (!token) return panel;
                const encrypted = safeStorage.encryptString(
                  JSON.stringify({
                    token,
                    session,
                    ...(pendingLeave ? { pendingLeave } : {}),
                  }),
                );
                if (encrypted.length > maximumCredentialBytes)
                  throw new Error(
                    "The encrypted sign-in is too large to save.",
                  );
                return { ...panel, credential: encrypted.toString("base64") };
              },
            ),
          });
          if (Buffer.byteLength(body) > maximumBytes)
            throw new Error("The saved workspace is too large.");
          await fs.mkdir(dataDir, { recursive: true });
          const target = await safePath(dataDir, file);
          const temporary = await safePath(
            dataDir,
            "desktop-workspace-" + randomUUID() + ".tmp",
          );
          let backup;
          try {
            await fs.writeFile(temporary, body, { flag: "wx", mode: 0o600 });
            if (needsBackup) {
              backup = await safePath(
                dataDir,
                "desktop-workspace-recovered-" + randomUUID() + ".json",
              );
              try {
                await fs.rename(target, backup);
              } catch (cause) {
                if (cause.code !== "ENOENT") throw cause;
                backup = undefined;
              }
            }
            try {
              await fs.rename(temporary, target);
            } catch (cause) {
              if (backup) await fs.rename(backup, target).catch(() => {});
              throw cause;
            }
            needsBackup = false;
            recoveredSemantic = undefined;
            lastSemantic = semantic;
          } finally {
            await fs.rm(temporary, { force: true });
          }
        });
      writes = write;
      return write;
    },
    forgetLegacy(id) {
      const operation = legacyWrites
        .catch(() => {})
        .then(async () => {
          const prior = await legacy.read();
          if (!prior.panels.some((panel) => panel.id === id)) return;
          await legacy.save({
            activeId: prior.activeId === id ? "local" : prior.activeId,
            panels: prior.panels.filter((panel) => panel.id !== id),
          });
        });
      legacyWrites = operation;
      return operation;
    },
    async close() {
      await writes;
      await legacyWrites;
      await legacy.close();
    },
  };
}
