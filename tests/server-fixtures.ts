import { expect, type APIRequestContext, type Page } from "@playwright/test";
import { processStartup } from "./fixtures/process-options.mjs";

export async function createProcessServer(
  request: APIRequestContext,
  options: { data: Record<string, unknown> },
) {
  const response = await request.post("/api/servers", {
    ...options,
    data: { ...options.data, ...processStartup },
  });
  expect(response.status(), await response.text()).toBe(201);
  const { server } = await response.json();
  const headers = { "X-Server-Id": server.id };
  const eula = await request.put("/api/files/content", {
    headers,
    data: { path: "eula.txt", content: "eula=true\n" },
  });
  expect(eula.status(), await eula.text()).toBe(200);
  const started = await request.post("/api/server/power", {
    headers,
    data: { action: "start" },
  });
  expect(started.ok(), await started.text()).toBe(true);
  await expect
    .poll(
      async () =>
        (await (await request.get("/api/server", { headers })).json()).status,
    )
    .toBe("running");
  return response;
}

export function serverButton(page: Page, id: string) {
  return page.locator(`button[data-server-id="${id}"]`);
}

export async function selectServer(page: Page, id: string) {
  const open = page.getByRole("button", {
    name: "Open navigation",
    exact: true,
  });
  if (
    (await open.isVisible()) &&
    !(await page
      .locator(".sidebar")
      .evaluate((element) => element.classList.contains("is-open")))
  )
    await open.click();
  const servers = page
    .getByRole("navigation", { name: "Main navigation" })
    .getByRole("button", { name: "SERVER SELECTOR", exact: true });
  if ((await servers.getAttribute("aria-expanded")) === "false")
    await servers.click();
  await serverButton(page, id).click();
  await expect(serverButton(page, id)).toHaveAttribute("aria-pressed", "true");
}

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
