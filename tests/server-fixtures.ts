import { expect, type APIRequestContext } from "@playwright/test";

// Use only with server IDs created by fixtures in the isolated E2E runtime.
export async function stopTestServer(request: APIRequestContext, id: string) {
  const headers = { "X-Server-Id": id };
  const current = await request.get("/api/server", { headers });
  expect(current.ok()).toBe(true);
  if ((await current.json()).status !== "offline") {
    const stopped = await request.post("/api/server/power", {
      headers,
      data: { action: "stop" },
    });
    expect(stopped.ok()).toBe(true);
    await expect
      .poll(
        async () =>
          (await (await request.get("/api/server", { headers })).json()).status,
      )
      .toBe("offline");
  }
}

export async function removeTestServer(request: APIRequestContext, id: string) {
  await stopTestServer(request, id);
  expect(
    (await request.delete(`/api/servers/${encodeURIComponent(id)}`)).ok(),
  ).toBe(true);
}
