import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createRemoteFrontend,
  configureRemoteCertificateVerification,
  PANEL_CONTENT_SECURITY_POLICY,
} from "./remote-frontend.mjs";

const origin = "https://panel.example:3002";

test("certificate verdict cache configuration preserves other disabled features", () => {
  let value = "ExistingFeature,AnotherFeature";
  const commandLine = {
    getSwitchValue: (name) => {
      assert.equal(name, "disable-features");
      return value;
    },
    appendSwitch: (name, next) => {
      assert.equal(name, "disable-features");
      value = next;
    },
  };
  configureRemoteCertificateVerification(commandLine);
  configureRemoteCertificateVerification(commandLine);
  assert.equal(value, "ExistingFeature,AnotherFeature,CacheCertVerification");
});

async function fixture(t, fetch = async () => new Response("remote response")) {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "mc-frontend-test-"),
  );
  t.after(async () => {
    assert.equal((await fs.lstat(directory)).isSymbolicLink(), false);
    const resolved = await fs.realpath(directory);
    const temporaryRoot = await fs.realpath(os.tmpdir());
    assert.equal(
      path.dirname(resolved).toLowerCase(),
      temporaryRoot.toLowerCase(),
    );
    assert.ok(path.basename(resolved).startsWith("mc-frontend-test-"));
    await fs.rm(resolved, { recursive: true, force: true });
  });
  await fs.mkdir(path.join(directory, "assets"));
  await fs.mkdir(path.join(directory, "api"));
  await fs.writeFile(
    path.join(directory, "index.html"),
    "<h1>Installed UI</h1>",
  );
  await fs.writeFile(
    path.join(directory, "assets", "current.js"),
    "installedCode()",
  );
  await fs.writeFile(
    path.join(directory, "assets", "current.css"),
    "body{color:white}",
  );
  await fs.writeFile(
    path.join(directory, "api", "private.json"),
    "local-secret",
  );
  const calls = [];
  let handler;
  const session = {
    fetch(request, options) {
      calls.push({ request, options });
      return fetch(request, options);
    },
    protocol: {
      handle(scheme, listener) {
        assert.equal(scheme, "https");
        handler = listener;
      },
      unhandle(scheme) {
        assert.equal(scheme, "https");
        handler = undefined;
      },
    },
  };
  const frontend = await createRemoteFrontend({ directory });
  const dispose = frontend.install(session, origin);
  return {
    calls,
    frontend,
    session,
    dispose,
    request: (pathname, init) => handler(new Request(origin + pathname, init)),
    invoke: (request) => handler(request),
  };
}

test("remote documents verify the host before showing the installed frontend", async (t) => {
  const f = await fixture(t);
  const document = await f.request("/?invite=1");
  assert.equal(await document.text(), "<h1>Installed UI</h1>");
  assert.equal(
    document.headers.get("content-security-policy"),
    PANEL_CONTENT_SECURITY_POLICY,
  );
  assert.equal(document.headers.get("cache-control"), "no-store");
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].request.url, origin + "/?invite=1");
  assert.equal(f.calls[0].options.bypassCustomProtocolHandlers, true);
  assert.equal(f.calls[0].options.credentials, "include");
  assert.equal(f.calls[0].options.redirect, "error");
  assert.equal(f.calls[0].options.signal.aborted, false);
  const asset = await f.request("/assets/current.js?v=old");
  assert.equal(await asset.text(), "installedCode()");
  assert.equal(
    asset.headers.get("content-type"),
    "text/javascript; charset=utf-8",
  );
  assert.equal(
    f.calls.length,
    1,
    "Bundled assets do not use the host's older build.",
  );
  const head = await f.request("/index.html", { method: "HEAD" });
  assert.equal(await head.text(), "");
  assert.equal(f.calls.length, 2);
});

test("offline, rejected TLS and unsuccessful hosts cannot become connected local shells", async (t) => {
  const offline = await fixture(t, async () => {
    throw new Error("certificate rejected");
  });
  await assert.rejects(offline.request("/"), /certificate rejected/);
  const disabled = await fixture(
    t,
    async () => new Response("disabled", { status: 503 }),
  );
  await assert.rejects(disabled.request("/"), /could not load/);
});

test("API requests preserve the remote body, session and CSRF origin", async (t) => {
  const f = await fixture(
    t,
    async () => new Response('{"ok":true}', { status: 403 }),
  );
  const response = await f.request("/api/console", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Server-Id": "remote-server",
    },
    body: '{"command":"list"}',
  });
  assert.equal(
    response.status,
    403,
    "Host permission denials pass through unchanged.",
  );
  const { request, options } = f.calls[0];
  assert.equal(request.method, "POST");
  assert.equal(await request.text(), '{"command":"list"}');
  assert.equal(options.headers.get("origin"), origin);
  assert.equal(options.headers.get("x-server-id"), "remote-server");
  assert.equal(options.credentials, "include");
  assert.equal(options.redirect, "error");
  assert.equal(options.bypassCustomProtocolHandlers, true);
});

test("only exact public build paths can use local bytes", async (t) => {
  const f = await fixture(t);
  for (const pathname of [
    "/api/private.json",
    "/api/desktop/preferences",
    "/assets/missing.js",
    "/assets/%2e%2e%2fprivate.json",
    "/assets/..%5c..%5csecret.txt",
    "/C:/Users/secret.txt",
    "/private.json",
    "/assets/current.js/extra",
  ])
    assert.equal(
      await (await f.request(pathname)).text(),
      "remote response",
      pathname,
    );
  assert.equal(
    await (
      await f.request("/assets/current.js", { method: "POST", body: "data" })
    ).text(),
    "remote response",
  );
  assert.equal(f.calls.length, 9);
});

test("external resources never receive panel cookies, credentials or write access", async (t) => {
  const f = await fixture(t);
  await f.invoke(
    new Request("https://cdn.example/icon.png", {
      headers: { Cookie: "secret=1", Authorization: "secret" },
    }),
  );
  const { options } = f.calls[0];
  assert.equal(options.credentials, "omit");
  assert.equal(options.redirect, "manual");
  assert.equal(options.headers.has("cookie"), false);
  assert.equal(options.headers.has("authorization"), false);
  await assert.rejects(
    f.invoke(
      new Request("https://cdn.example/api", { method: "POST", body: "x" }),
    ),
    /selected host/,
  );
  await assert.rejects(
    f.invoke(new Request("https://panel.example:3999/api")),
    /port/,
  );
  assert.equal(f.calls.length, 1);
});

test("disposing the adapter removes its session handler and rejects invalid origins", async (t) => {
  const f = await fixture(t);
  assert.throws(
    () => f.frontend.install(f.session, "http://panel.example"),
    /HTTPS origin/,
  );
  assert.throws(
    () => f.frontend.install(f.session, origin + "/path"),
    /HTTPS origin/,
  );
  await f.request("/api/state");
  const signal = f.calls[0].options.signal;
  assert.equal(signal.aborted, false);
  f.dispose();
  assert.equal(
    signal.aborted,
    true,
    "Disposal cancels remote requests and streams.",
  );
  f.dispose();
  assert.throws(() => f.request("/"), /handler/);
});

test("external redirects preserve streaming and omit credentials throughout the chain", async (t) => {
  let release;
  let canceled = 0;
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("image-"));
      release = () => {
        controller.enqueue(new TextEncoder().encode("bytes"));
        controller.close();
      };
    },
  });
  const streamed = new Response(stream, {
    headers: { "Content-Type": "image/png" },
  });
  const f = await fixture(t, async (request) => {
    if (request.url === origin + "/image.png") return streamed;
    return new Response(
      new ReadableStream({
        cancel() {
          canceled += 1;
        },
      }),
      {
        status: 302,
        headers: {
          Location: request.url.endsWith("/start.png")
            ? "/next.png"
            : origin + "/image.png",
        },
      },
    );
  });
  const result = await f.invoke(
    new Request("https://cdn.example/start.png", {
      headers: { Cookie: "secret=1", Authorization: "Bearer secret" },
    }),
  );
  assert.equal(
    result,
    streamed,
    "The final response stays streamed without buffering.",
  );
  assert.equal(canceled, 2);
  assert.deepEqual(
    f.calls.map(({ request }) => request.url),
    [
      "https://cdn.example/start.png",
      "https://cdn.example/next.png",
      origin + "/image.png",
    ],
  );
  for (const { request, options } of f.calls) {
    assert.equal(request.method, "GET");
    assert.equal(options.credentials, "omit");
    assert.equal(options.redirect, "manual");
    assert.equal(options.headers.has("cookie"), false);
    assert.equal(options.headers.has("authorization"), false);
  }
  const reader = result.body.getReader();
  assert.equal(new TextDecoder().decode((await reader.read()).value), "image-");
  release();
  assert.equal(new TextDecoder().decode((await reader.read()).value), "bytes");
  assert.equal((await reader.read()).done, true);
});

test("external redirects reject unsafe destinations before issuing another request", async (t) => {
  for (const location of [
    "http://cdn.example/image.png",
    "https://user:password@cdn.example/image.png",
    "https://panel.example:3999/image.png",
    "file:///private/image.png",
  ]) {
    const f = await fixture(
      t,
      async () =>
        new Response(null, { status: 302, headers: { Location: location } }),
    );
    await assert.rejects(
      f.invoke(new Request("https://cdn.example/image.png")),
      /allowed HTTPS/,
    );
    assert.equal(f.calls.length, 1, location);
  }
  const loop = await fixture(
    t,
    async () =>
      new Response(null, { status: 302, headers: { Location: "/loop.png" } }),
  );
  await assert.rejects(
    loop.invoke(new Request("https://cdn.example/loop.png")),
    /too many times/,
  );
  assert.equal(
    loop.calls.length,
    6,
    "At most five redirect hops are followed.",
  );
});

test("external HEAD redirects retain the request method", async (t) => {
  const f = await fixture(t, async (request) =>
    request.url.endsWith("/final.png")
      ? new Response(null, { headers: { "Content-Type": "image/png" } })
      : new Response(null, {
          status: 303,
          headers: { Location: "/final.png" },
        }),
  );
  await f.invoke(
    new Request("https://cdn.example/image.png", { method: "HEAD" }),
  );
  assert.deepEqual(
    f.calls.map(({ request }) => request.method),
    ["HEAD", "HEAD"],
  );
});
