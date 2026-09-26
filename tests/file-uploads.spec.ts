import { test, expect, type APIRequestContext } from "@playwright/test";
import {
  createProcessServer,
  selectServer,
  removeTestServer,
} from "./server-fixtures";
import {
  collectDroppedUpload,
  collectSelectedUpload,
  uploadInBatches,
  UPLOAD_FILE_SIZE_LIMIT,
  type UploadProgress,
} from "../src/file-uploads";

const fileEntry = (name: string, text = name) => ({
  name,
  isFile: true,
  isDirectory: false,
  file: (resolve: (file: File) => void) =>
    queueMicrotask(() =>
      resolve(new File([text], name, { lastModified: 1234567890000 })),
    ),
});
function directoryEntry(name: string, batches: unknown[][]) {
  let reads = 0;
  return {
    name,
    isFile: false,
    isDirectory: true,
    get reads() {
      return reads;
    },
    createReader: () => ({
      readEntries: (resolve: (entries: unknown[]) => void) =>
        queueMicrotask(() => resolve(batches[reads++] || [])),
    }),
  };
}
const transfer = (entries: unknown[]) =>
  ({
    items: entries.map((entry) => ({
      kind: "file",
      webkitGetAsEntry: () => entry,
      getAsFile: () => null,
    })),
    files: [],
  }) as unknown as DataTransfer;

test("folder collection exhausts every directory reader batch and keeps empty folders and relative names", async () => {
  const empty = directoryEntry("empty", [[]]);
  const nested = directoryEntry("nested", [
    [fileEntry("settings.json", "nested settings")],
    [],
  ]);
  const mods = directoryEntry("mods", [
    Array.from({ length: 100 }, (_, index) => fileEntry(`mod-${index}.jar`)),
    Array.from({ length: 105 }, (_, index) =>
      fileEntry(`mod-${index + 100}.jar`),
    ),
    [empty, nested],
    [],
  ]);
  const counts: { files: number; directories: number }[] = [];
  const result = await collectDroppedUpload(transfer([mods]), {
    onProgress: (value) => counts.push(value),
  });
  expect(mods.reads).toBe(4);
  expect(empty.reads).toBe(1);
  expect(result.files).toHaveLength(206);
  expect(result.directories).toEqual(["mods", "mods/empty", "mods/nested"]);
  const settings = result.files.find(
    (entry) => entry.path === "mods/nested/settings.json",
  )!;
  expect(await settings.file.text()).toBe("nested settings");
  expect(counts.at(-1)).toEqual({ files: 206, directories: 3 });
});

test("folder inputs retain webkitRelativePath and duplicate or unsafe targets fail before requests", async () => {
  const file = new File(["configuration"], "config.toml");
  Object.defineProperty(file, "webkitRelativePath", {
    value: "pack/config/config.toml",
  });
  const result = collectSelectedUpload([file]);
  expect(result.files[0].path).toBe("pack/config/config.toml");
  expect(result.directories).toEqual(["pack", "pack/config"]);
  let requests = 0;
  const request = async () => {
    requests++;
    return { uploaded: 1 };
  };
  const invalid = await uploadInBatches({
    source: { files: [{ file, path: "../outside" }], directories: [] },
    destination: "mods",
    request,
  });
  expect(invalid.phase).toBe("failed");
  expect(requests).toBe(0);
  expect(() => collectSelectedUpload([file, file])).toThrow("two files");
});

test("205 mods upload sequentially in batches of at most20 with metadata and confirmed progress", async () => {
  const source = collectSelectedUpload(
    Array.from(
      { length: 205 },
      (_, index) =>
        new File([`mod ${index}`], `mod-${index}.jar`, {
          lastModified: 1234567890000,
        }),
    ),
  );
  const sizes: number[] = [];
  const progress: UploadProgress[] = [];
  let active = 0;
  let maximum = 0;
  const result = await uploadInBatches({
    source,
    destination: "mods",
    onProgress: (value) => progress.push(value),
    request: async (url, options) => {
      expect(url).toBe("/files/upload?path=mods");
      expect(options.method).toBe("POST");
      active++;
      maximum = Math.max(maximum, active);
      await Promise.resolve();
      const body = options.body as FormData;
      const files = body.getAll("files") as File[];
      expect(JSON.parse(body.get("paths") as string)).toEqual(
        files.map((file) => file.name),
      );
      expect(JSON.parse(body.get("modified") as string)).toEqual(
        files.map(() => 1234567890000),
      );
      sizes.push(files.length);
      active--;
      return { uploaded: files.length };
    },
  });
  expect(maximum).toBe(1);
  expect(sizes).toEqual([...Array(10).fill(20), 5]);
  expect(result.phase).toBe("completed");
  expect(result.uploadedFiles).toBe(205);
  expect(progress.at(-1)?.uploadedBytes).toBe(
    source.files.reduce((sum, entry) => sum + entry.file.size, 0),
  );
  expect(
    progress.every(
      (value, index) =>
        !index || value.uploadedFiles >= progress[index - 1].uploadedFiles,
    ),
  ).toBe(true);
});

test("empty directory uploads are bounded separately and a too-large file prevents every mutation", async () => {
  const directories = Array.from(
    { length: 2100 },
    (_, index) => `empty-${index}`,
  );
  const counts: number[] = [];
  const result = await uploadInBatches({
    source: { files: [], directories },
    destination: "",
    request: async (_url, options) => {
      const body = options.body as FormData;
      expect(body.getAll("files")).toHaveLength(0);
      counts.push(JSON.parse(body.get("directories") as string).length);
      return { uploaded: 0, directories: counts.at(-1) };
    },
  });
  expect(counts).toEqual([1000, 1000, 100]);
  expect(result.completedDirectories).toBe(2100);
  const oversized = new File(["fixture"], "oversized.jar");
  Object.defineProperty(oversized, "size", {
    value: UPLOAD_FILE_SIZE_LIMIT + 1,
  });
  let requests = 0;
  const rejected = await uploadInBatches({
    source: {
      files: [{ file: oversized, path: oversized.name }],
      directories: ["must-not-create"],
    },
    destination: "",
    request: async () => {
      requests++;
      return { uploaded: 0 };
    },
  });
  expect(rejected.phase).toBe("failed");
  expect(rejected.message).toContain("256 MiB");
  expect(requests).toBe(0);
});

test("cancellation and transport failures stop batches without retrying uncertain files", async () => {
  const source = collectSelectedUpload(
    Array.from(
      { length: 45 },
      (_, index) => new File(["data"], `${index}.jar`),
    ),
  );
  const controller = new AbortController();
  let requests = 0;
  const cancelled = await uploadInBatches({
    source,
    destination: "mods",
    signal: controller.signal,
    request: async () => {
      requests++;
      controller.abort();
      return { uploaded: 20 };
    },
  });
  expect(cancelled.phase).toBe("cancelled");
  expect(cancelled.uploadedFiles).toBe(20);
  expect(cancelled.uncertainPaths).toEqual([]);
  expect(requests).toBe(1);
  requests = 0;
  const uncertain = await uploadInBatches({
    source,
    destination: "mods",
    request: async () => {
      requests++;
      if (requests === 1) return { uploaded: 20 };
      throw new TypeError("Connection interrupted");
    },
  });
  expect(uncertain.phase).toBe("uncertain");
  expect(uncertain.uploadedFiles).toBe(20);
  expect(uncertain.uncertainPaths).toHaveLength(20);
  expect(requests).toBe(2);
});

test("canceling enumeration rejects promptly without waiting for a stalled folder reader", async () => {
  const controller = new AbortController();
  const pending = collectDroppedUpload(
    transfer([
      {
        name: "unavailable",
        isDirectory: true,
        isFile: false,
        createReader: () => ({ readEntries: () => {} }),
      },
    ]),
    { signal: controller.signal },
  );
  controller.abort(new DOMException("Selection stopped.", "AbortError"));
  await expect(pending).rejects.toMatchObject({ name: "AbortError" });
});

test("server-reported partial writes are counted and stop every later batch", async () => {
  const source = collectSelectedUpload(
    Array.from(
      { length: 45 },
      (_, index) => new File(["data"], `${index}.jar`),
    ),
  );
  let requests = 0;
  const result = await uploadInBatches({
    source,
    destination: "mods",
    request: async () => {
      requests++;
      if (requests === 1) return { uploaded: 20 };
      throw Object.assign(new Error("A destination appeared during upload."), {
        status: 409,
        uploaded: 3,
        directories: 0,
      });
    },
  });
  expect(result.phase).toBe("failed");
  expect(result.uploadedFiles).toBe(23);
  expect(result.uploadedBytes).toBe(23 * 4);
  expect(result.message).toContain("Check the destination");
  expect(requests).toBe(2);
});

async function uploadServer(request: APIRequestContext) {
  const fleet = await (await request.get("/api/servers")).json();
  const occupied = new Set(
    fleet.servers.map((server: { port: number }) => server.port),
  );
  let port = 29700;
  while (occupied.has(port)) port++;
  const response = await createProcessServer(request, {
    data: { name: "Upload fixture", mode: "live", port, memoryLimitMB: 1024 },
  });
  expect(response.ok()).toBe(true);
  const { server } = await response.json();
  return {
    id: server.id as string,
    headers: { "X-Server-Id": server.id as string },
  };
}

test("File Manager uploads205 mods in bounded requests to the selected server", async ({
  page,
  request,
}) => {
  const fixture = await uploadServer(request);
  try {
    const created = await request.post("/api/files", {
      headers: fixture.headers,
      data: { path: "", name: "mods", type: "directory" },
    });
    expect(created.ok()).toBe(true);
    await page.goto("/#files");
    await selectServer(page, fixture.id);
    await page.getByRole("link", { name: "File Manager", exact: true }).click();
    await page.getByRole("button", { name: "mods", exact: true }).click();
    await page.evaluate(() => {
      const state = window as typeof window & { uploadBatchSizes: number[] };
      state.uploadBatchSizes = [];
      const original = window.fetch;
      window.fetch = (url, options) => {
        if (
          String(url).startsWith("/api/files/upload") &&
          options?.body instanceof FormData
        )
          state.uploadBatchSizes.push(options.body.getAll("files").length);
        return original(url, options);
      };
    });
    page.on("request", (request) => {
      if (new URL(request.url()).pathname !== "/api/files/upload") return;
      expect(request.headers()["x-server-id"]).toBe(fixture.id);
    });
    await page.getByLabel("Upload server files", { exact: true }).setInputFiles(
      Array.from({ length: 205 }, (_, index) => ({
        name: `mod-${index.toString().padStart(3, "0")}.jar`,
        mimeType: "application/java-archive",
        buffer: Buffer.from(`Exact mod bytes ${index}\n`),
      })),
    );
    await expect
      .poll(async () => {
        const response = await request.get("/api/files?path=mods", {
          headers: fixture.headers,
        });
        return (await response.json()).entries.length;
      })
      .toBe(205);
    await expect(
      page.getByRole("status", { name: "File transfer progress", exact: true }),
    ).toContainText("Transfer complete");
    const batches = await page.evaluate(
      () =>
        (window as typeof window & { uploadBatchSizes: number[] })
          .uploadBatchSizes,
    );
    expect(batches).toEqual([...Array(10).fill(20), 5]);
    for (const index of [0, 99, 204]) {
      const response = await request.get(
        `/api/files/download?path=mods/mod-${index.toString().padStart(3, "0")}.jar`,
        { headers: fixture.headers },
      );
      expect(response.ok()).toBe(true);
      expect(await response.body()).toEqual(
        Buffer.from(`Exact mod bytes ${index}\n`),
      );
    }
  } finally {
    await removeTestServer(request, fixture.id);
  }
});

test("dropping a folder in File Manager preserves nested contents and empty directories", async ({
  page,
  request,
}) => {
  const fixture = await uploadServer(request);
  try {
    const created = await request.post("/api/files", {
      headers: fixture.headers,
      data: { path: "", name: "mods", type: "directory" },
    });
    expect(created.ok()).toBe(true);
    await page.goto("/#files");
    await selectServer(page, fixture.id);
    await page.getByRole("link", { name: "File Manager", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "File Manager", exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "mods", exact: true }).click();
    await page
      .getByRole("region", { name: "Server files", exact: true })
      .evaluate((element) => {
        const file = {
          name: "config.toml",
          isFile: true,
          isDirectory: false,
          file: (resolve: (file: File) => void) =>
            resolve(new File(["enabled = true\n"], "config.toml")),
        };
        const directory = (name: string, batches: unknown[][]) => ({
          name,
          isFile: false,
          isDirectory: true,
          createReader: () => {
            let index = 0;
            return {
              readEntries: (resolve: (entries: unknown[]) => void) =>
                resolve(batches[index++] || []),
            };
          },
        });
        const nested = directory("config", [[file], []]);
        const empty = directory("empty", [[]]);
        const root = directory("dropped-pack", [[nested], [empty], []]);
        const dataTransfer = new DataTransfer();
        dataTransfer.items.add(new File([""], "placeholder"));
        Object.defineProperty(dataTransfer, "items", {
          value: [
            {
              kind: "file",
              webkitGetAsEntry: () => root,
              getAsFile: () => null,
            },
          ],
        });
        element.dispatchEvent(
          new DragEvent("drop", {
            bubbles: true,
            cancelable: true,
            dataTransfer,
          }),
        );
      });
    await expect
      .poll(async () => {
        const response = await request.get(
          "/api/files/content?path=mods/dropped-pack/config/config.toml",
          { headers: fixture.headers },
        );
        return response.ok() ? (await response.json()).content : null;
      })
      .toBe("enabled = true\n");
    const directories = await (
      await request.get("/api/files?path=mods/dropped-pack", {
        headers: fixture.headers,
      })
    ).json();
    expect(
      directories.entries.map((entry: { name: string }) => entry.name).sort(),
    ).toEqual(["config", "empty"]);
    const empty = await (
      await request.get("/api/files?path=mods/dropped-pack/empty", {
        headers: fixture.headers,
      })
    ).json();
    expect(empty.entries).toEqual([]);
  } finally {
    await removeTestServer(request, fixture.id);
  }
});
