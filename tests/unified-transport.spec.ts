import { test, expect, type Page } from "@playwright/test";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { Resvg } from "@resvg/resvg-js";

// Exercise the actual transport hooks independently of the workspace layout.
// Vite's bundled esbuild dependency compiles this isolated React harness only.
const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve("vite"))("esbuild");
let harness: Promise<string> | undefined;
function script() {
  harness ??= build({
    stdin: {
      contents: `
        import React, { useMemo, useState } from 'react';
        import { createRoot } from 'react-dom/client';
        import { PanelScope, ServerScope, SessionActiveContext, SessionExpiredContext, usePanelApi, useServerApi } from './src/api';
        import DownloadButton from './src/DownloadButton';
        import PanelSettings from './src/PanelSettings';
        import { ServerIconImage } from './src/ServerIcon';
        const leases = new Map([['A','epoch-A'], ['C','epoch-C']]);
        function Controls({ identity, expire }) {
          const client = useServerApi();
          const panel = usePanelApi();
          const [message, setMessage] = useState('Ready');
          async function flow() {
            try {
              await client.post('/files', { type:'file', name:'first-' + identity });
              await client.post('/files', { type:'file', name:'second-' + identity });
              setMessage(identity + ' completed');
            } catch (error) { setMessage(error.message); }
          }
          return <>
            <button onClick={flow}>Start two-step write</button>
            <button onClick={() => void client.post('/files', { type:'file', name:'current-' + identity }).then(() => setMessage(identity + ' current completed'))}>Write current</button>
            <button onClick={() => { const form = new FormData(); form.append('files', new File(['payload bytes'], 'payload.txt', {type:'text/plain'})); form.append('paths', '["folder/payload.txt"]'); form.append('directories', '["empty"]'); void client.api('/files/upload?path=target', {method:'POST',body:form}).then(() => setMessage('Uploaded')); }}>Upload</button>
            <button onClick={() => void panel.api('/server-setup/directories?directory=C%3A%5Cservers').then(() => setMessage('Host browsed'))}>Browse host</button>
            <button onClick={() => void panel.post('/servers', {requestId:'setup-id', name:'Host server'}).then(() => setMessage('Host created'))}>Create host server</button>
            <button onClick={expire}>Replace A account</button>
            <DownloadButton href={client.downloadUrl('/files/download?path=one.txt&path=two.txt')} onError={setMessage}>Download</DownloadButton>
            <ServerIconImage version="same-icon-version" name={identity}/>
            <PanelSettings notify={setMessage}/>
            <output>{message}</output>
          </>;
        }
        function Harness() {
          const [identity, setIdentity] = useState('A');
          const [epochs, setEpochs] = useState({A:'epoch-A',C:'epoch-C'});
          const [expired, setExpired] = useState('none');
          const target = useMemo(() => ({panelId:identity,sessionEpoch:epochs[identity],label:identity,origin:'https://' + identity.toLowerCase() + '.example.test'}), [identity, epochs]);
          const lease = useMemo(() => () => leases.get(identity) === target.sessionEpoch, [identity,target]);
          const expiry = useMemo(() => () => setExpired(identity), [identity]);
          return <>
            <button onClick={() => setIdentity('A')}>Select A</button>
            <button onClick={() => setIdentity('C')}>Select C</button>
            <div data-testid="expired">{expired}</div>
            <PanelScope.Provider value={target}><SessionActiveContext.Provider value={lease}><SessionExpiredContext.Provider value={expiry}><ServerScope.Provider value="same-server-id">
              <Controls identity={identity} expire={() => {leases.set('A','replacement-A');setEpochs(current=>({...current,A:'replacement-A'}));}}/>
            </ServerScope.Provider></SessionExpiredContext.Provider></SessionActiveContext.Provider></PanelScope.Provider>
          </>;
        }
        createRoot(document.getElementById('root')).render(<Harness/>);
      `,
      resolveDir: process.cwd(),
      sourcefile: "unified-transport-harness.tsx",
      loader: "tsx",
    },
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    jsx: "automatic",
    loader: { ".css": "empty" },
    define: { "process.env.NODE_ENV": '"test"' },
  }).then(
    (result: { outputFiles: { text: string }[] }) => result.outputFiles[0].text,
  );
  return harness!;
}
const pixel = new Resvg(
  '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="green"/></svg>',
)
  .render()
  .asPng();
async function openHarness(page: Page, origin = "http://127.0.0.1:3111") {
  await page.addInitScript(() =>
    localStorage.setItem("mc-panel.session.v1", "a".repeat(43)),
  );
  await page
    .context()
    .addCookies([{ name: "owner-fixture", value: "local", url: origin }]);
  await page.route("**/transport-harness", async (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><div id="root"></div><script>${(await script()).replace(/<\/script/gi, "<\\/script")}</script>`,
    }),
  );
  await page.goto(`${origin}/transport-harness`);
}

test("captured clients keep chained writes on their original panel despite identical server IDs and navigation", async ({
  page,
}) => {
  const calls: {
    panel: string;
    epoch: string | null;
    server: string | null;
    name: string;
  }[] = [];
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/desktop/panels/**/proxy/api/**", async (route) => {
    const url = new URL(route.request().url());
    expect(route.request().headers().authorization).toBeUndefined();
    expect(route.request().headers().cookie).toContain("owner-fixture=local");
    if (url.pathname.endsWith("/server/icon"))
      return route.fulfill({ contentType: "image/png", body: pixel });
    const name = route.request().postDataJSON().name;
    calls.push({
      panel: url.pathname.split("/")[4],
      epoch: url.searchParams.get("desktopEpoch"),
      server: url.searchParams.get("serverId"),
      name,
    });
    if (name === "first-A") await blocked;
    await route.fulfill({ json: { ok: true } });
  });
  await openHarness(page);
  await page.getByRole("button", { name: "Start two-step write" }).click();
  await expect.poll(() => calls.length).toBe(1);
  await page.getByRole("button", { name: "Select C" }).click();
  await page.getByRole("button", { name: "Write current" }).click();
  await expect.poll(() => calls.length).toBe(2);
  release();
  await expect.poll(() => calls.length).toBe(3);
  expect(calls).toEqual([
    { panel: "A", epoch: "epoch-A", server: "same-server-id", name: "first-A" },
    {
      panel: "C",
      epoch: "epoch-C",
      server: "same-server-id",
      name: "current-C",
    },
    {
      panel: "A",
      epoch: "epoch-A",
      server: "same-server-id",
      name: "second-A",
    },
  ]);
});

test("Panel Settings keeps all tabs on this computer when opened under a remote workspace", async ({
  page,
}) => {
  const calls: string[] = [];
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/server/icon"))
      return route.fulfill({ contentType: "image/png", body: pixel });
    calls.push(path);
    if (path === "/api/desktop/settings")
      return route.fulfill({
        json: {
          desktop: true,
          startAtLogin: false,
          autoStartServerIds: [],
          keepInTray: false,
          startupSupported: true,
        },
      });
    if (path === "/api/servers")
      return route.fulfill({ json: { servers: [] } });
    if (path === "/api/panel-users")
      return route.fulfill({ json: { users: [] } });
    if (path === "/api/access/settings")
      return route.fulfill({
        json: {
          enabled: false,
          publicUrl: "",
          transport: "direct",
          port: 3002,
          ready: false,
        },
      });
    return route.fulfill({
      status: 403,
      json: { error: "Unexpected destination" },
    });
  });
  await openHarness(page);
  await page
    .getByRole("button", { name: "Panel Settings", exact: true })
    .click();
  await page.getByRole("tab", { name: "Remote Access", exact: true }).click();
  await expect.poll(() => calls.includes("/api/access/settings")).toBe(true);
  await expect.poll(() => calls.includes("/api/panel-users")).toBe(true);
  expect(calls.every((path) => !path.includes("/proxy/"))).toBe(true);
});

test("replacing one panel account invalidates its pending chain without signing out the newly active panel", async ({
  page,
}) => {
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const writes: string[] = [];
  await page.route("**/api/desktop/panels/**/proxy/api/**", async (route) => {
    if (new URL(route.request().url()).pathname.endsWith("/server/icon"))
      return route.fulfill({ contentType: "image/png", body: pixel });
    writes.push(route.request().postDataJSON().name);
    await blocked;
    await route.fulfill({ json: { ok: true } });
  });
  await openHarness(page);
  await page.getByRole("button", { name: "Start two-step write" }).click();
  await expect.poll(() => writes.length).toBe(1);
  await page.getByRole("button", { name: "Replace A account" }).click();
  await page.getByRole("button", { name: "Select C" }).click();
  release();
  await expect(page.locator("output")).toContainText("session ended");
  expect(writes).toEqual(["first-A"]);
  await expect(page.getByTestId("expired")).toHaveText("none");
});

test("proxy transport preserves multipart uploads, scoped host setup, images and native downloads", async ({
  page,
}) => {
  const requests: {
    route: string;
    server: string | null;
    contentType?: string;
    body?: string | null;
  }[] = [];
  // Chromium's native anchor download can bypass page.route. Use a real,
  // disposable loopback response to exercise download headers and streaming.
  const downloads: { url: URL; authorization?: string; cookie?: string }[] = [];
  const listener = createServer((request, response) => {
    const url = new URL(request.url!, "http://fixture.invalid");
    if (url.pathname === "/api/desktop/panels/A/proxy/api/files/download") {
      downloads.push({
        url,
        authorization: request.headers.authorization,
        cookie: request.headers.cookie,
      });
      response.writeHead(200, {
        "Content-Type": "application/zip",
        "Content-Disposition": 'attachment; filename="panel-A.zip"',
      });
      response.end("streamed archive fixture");
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise<void>((resolve) =>
    listener.listen(0, "127.0.0.1", resolve),
  );
  const address = listener.address();
  if (!address || typeof address === "string")
    throw new Error("Missing fixture port");
  try {
    await page.route("**/api/desktop/panels/**/proxy/api/**", async (route) => {
      const url = new URL(route.request().url());
      expect(url.pathname).toContain("/panels/A/proxy/api/");
      expect(url.searchParams.get("desktopEpoch")).toBe("epoch-A");
      expect(route.request().headers().authorization).toBeUndefined();
      const endpoint = url.pathname.split("/proxy/api")[1];
      requests.push({
        route: endpoint,
        server: url.searchParams.get("serverId"),
        contentType: route.request().headers()["content-type"],
        body: route.request().postData(),
      });
      if (endpoint === "/server/icon")
        return route.fulfill({ contentType: "image/png", body: pixel });
      if (endpoint === "/files/download") return route.continue();
      return route.fulfill({ json: { ok: true } });
    });
    await openHarness(page, `http://127.0.0.1:${address.port}`);
    await page.getByRole("button", { name: "Upload", exact: true }).click();
    await expect(page.locator("output")).toHaveText("Uploaded");
    const upload = requests.find((item) => item.route === "/files/upload")!;
    expect(upload.server).toBe("same-server-id");
    expect(upload.contentType).toMatch(/^multipart\/form-data; boundary=/);
    expect(upload.body).toContain("payload bytes");
    expect(upload.body).toContain("folder/payload.txt");
    await page.getByRole("button", { name: "Browse host" }).click();
    await expect(page.locator("output")).toHaveText("Host browsed");
    await page.getByRole("button", { name: "Create host server" }).click();
    await expect(page.locator("output")).toHaveText("Host created");
    expect(
      requests.find((item) => item.route === "/server-setup/directories")
        ?.server,
    ).toBeNull();
    expect(
      requests.find((item) => item.route === "/servers")?.server,
    ).toBeNull();
    await expect(
      page.getByRole("img", { name: "A server icon" }),
    ).toBeVisible();
    const pendingDownload = page.waitForEvent("download");
    await page.getByRole("button", { name: "Download", exact: true }).click();
    const download = await pendingDownload;
    expect(download.suggestedFilename()).toBe("panel-A.zip");
    expect(await readFile((await download.path())!, "utf8")).toBe(
      "streamed archive fixture",
    );
    expect(downloads).toHaveLength(1);
    expect(downloads[0].url.searchParams.get("serverId")).toBe(
      "same-server-id",
    );
    expect(downloads[0].url.searchParams.get("desktopEpoch")).toBe("epoch-A");
    expect(downloads[0].url.searchParams.getAll("path")).toEqual([
      "one.txt",
      "two.txt",
    ]);
    expect(downloads[0].authorization).toBeUndefined();
    expect(downloads[0].cookie).toContain("owner-fixture=local");
  } finally {
    listener.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      listener.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
