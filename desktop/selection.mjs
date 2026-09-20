import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { safePath } from "../server/index.mjs";

export async function flushRendererSelection(
  webContents,
  { timeoutMs = 4000 } = {},
) {
  let timer;
  let timedOut = false;
  try {
    await Promise.race([
      webContents.executeJavaScript("window.__mcPanelFlushSelection?.()"),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          reject(new Error("The server selection save timed out."));
        }, timeoutMs);
      }),
    ]);
  } catch (cause) {
    throw Object.assign(
      new Error("The selected server could not be saved before closing.", {
        cause,
      }),
      {
        code: "PANEL_SELECTION_FLUSH_FAILED",
        reason: timedOut ? "timeout" : "save-rejected",
      },
    );
  } finally {
    clearTimeout(timer);
  }
}

// Desktop origins and browser sessions change on every launch. Keep this
// preference with the app data instead of tying it to an ephemeral origin.
export function createDesktopSelection({ dataDir, hasServer }) {
  let writes = Promise.resolve();
  let closed = false;
  const target = () => safePath(dataDir, "desktop-selection.json");
  const failure = (status, message) =>
    Object.assign(new Error(message), { status });
  return {
    async read() {
      await writes;
      let saved;
      try {
        saved = JSON.parse(await fs.readFile(await target(), "utf8"));
      } catch (cause) {
        if (cause.code !== "ENOENT" && !(cause instanceof SyntaxError))
          throw cause;
      }
      return {
        desktop: true,
        activeServerId:
          typeof saved?.activeServerId === "string" &&
          hasServer(saved.activeServerId)
            ? saved.activeServerId
            : null,
      };
    },
    save(activeServerId) {
      if (closed)
        return Promise.reject(failure(503, "The desktop panel is closing."));
      const write = writes
        .catch(() => {})
        .then(async () => {
          if (
            activeServerId !== null &&
            (typeof activeServerId !== "string" || !hasServer(activeServerId))
          )
            throw failure(400, "Select a server that is still in the panel.");
          const temporary = await safePath(
            dataDir,
            `desktop-selection-${randomUUID()}.tmp`,
          );
          try {
            await fs.writeFile(temporary, JSON.stringify({ activeServerId }), {
              flag: "wx",
            });
            await fs.rename(temporary, await target());
          } finally {
            await fs.rm(temporary, { force: true });
          }
          return { desktop: true, activeServerId };
        });
      writes = write.catch(() => {});
      return write;
    },
    async close() {
      closed = true;
      await writes;
    },
  };
}

export async function readSelectionBody(req) {
  const body = await new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size <= 512) chunks.push(chunk);
    });
    req.once("error", reject);
    req.once("end", () => {
      if (size > 512)
        reject(
          Object.assign(new Error("The selection request is too large."), {
            status: 413,
          }),
        );
      else resolve(Buffer.concat(chunks).toString("utf8"));
    });
  });
  try {
    const parsed = JSON.parse(body);
    if (!parsed || typeof parsed !== "object" || !("activeServerId" in parsed))
      throw new Error();
    return parsed.activeServerId;
  } catch {
    throw Object.assign(new Error("Provide the selected server as JSON."), {
      status: 400,
    });
  }
}
