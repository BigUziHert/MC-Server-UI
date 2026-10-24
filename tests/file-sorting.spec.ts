import { expect, test, type Page } from "@playwright/test";

type Entry = {
  name: string;
  path: string;
  type: "directory" | "file";
  size: number;
  modified: string;
};

const fixtures: Entry[] = [
  { name: "file10.txt", type: "file", size: 9, modified: "2026-10-03" },
  { name: "Settings.JSON", type: "file", size: 30, modified: "2026-01-03" },
  { name: "world", type: "directory", size: 0, modified: "2026-10-01" },
  { name: "file2.txt", type: "file", size: 12_000, modified: "2026-09-30" },
  { name: "README", type: "file", size: 4, modified: "2026-09-01" },
  { name: "archive.tar.gz", type: "file", size: 100, modified: "2026-01-20" },
].map((entry) => ({
  ...entry,
  type: entry.type as Entry["type"],
  path: `sorting/${entry.name}`,
  modified: `${entry.modified}T12:00:00.000Z`,
}));

const names = (page: Page) =>
  page.locator(".file-table tbody .file-selection-name .file-name");
const sortButton = (page: Page, name: string) =>
  page.locator(".file-table thead").getByRole("button", { name, exact: true });
const column = (page: Page, name: string) =>
  page.locator(".file-table th").filter({
    has: page.getByRole("button", { name, exact: true }),
  });

async function openFiles(page: Page, entries = fixtures) {
  // Control metadata so comparisons cannot accidentally pass by sorting the
  // formatted size or relative date strings. All other APIs use the isolated
  // E2E runtime; this route never writes to the real filesystem.
  await page.route("**/api/files?**", async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    const url = new URL(route.request().url());
    const path = url.searchParams.get("path") || "";
    await route.fulfill({
      json: {
        path,
        entries: path
          ? entries
          : [
              {
                name: "sorting",
                path: "sorting",
                type: "directory",
                size: 0,
                modified: "2026-10-01T12:00:00.000Z",
              },
            ],
      },
    });
  });
  await page.goto("/#files");
  await page.getByRole("button", { name: "sorting", exact: true }).click();
  await expect(names(page)).toHaveCount(Math.min(25, entries.length));
}

test("file name headers toggle natural ordering with keyboard support and preserve selection", async ({
  page,
}) => {
  await openFiles(page);
  const ascending = [
    "world",
    "archive.tar.gz",
    "file2.txt",
    "file10.txt",
    "README",
    "Settings.JSON",
  ];
  await expect(names(page)).toHaveText(ascending);
  await expect(column(page, "Name")).toHaveAttribute("aria-sort", "ascending");
  await page
    .getByRole("checkbox", { name: "Select file10.txt", exact: true })
    .check();

  await sortButton(page, "Name").click();
  await expect(column(page, "Name")).toHaveAttribute("aria-sort", "descending");
  await expect(names(page)).toHaveText([
    "world",
    ...ascending.slice(1).reverse(),
  ]);
  await expect(page.locator(".file-table tbody tr").first()).toHaveClass(
    "parent-directory",
  );
  await expect(
    page.getByRole("checkbox", { name: "Select file10.txt", exact: true }),
  ).toBeChecked();
  await expect(page.locator(".file-row-selected .file-name")).toHaveText(
    "file10.txt",
  );

  await sortButton(page, "Name").focus();
  await page.keyboard.press("Enter");
  await expect(names(page)).toHaveText(ascending);
  await expect(column(page, "Name")).toHaveAttribute("aria-sort", "ascending");
  await page
    .getByRole("checkbox", {
      name: "Select all visible files and folders",
      exact: true,
    })
    .check();
  await expect(column(page, "Name")).toHaveAttribute("aria-sort", "ascending");
  await expect(page.locator(".file-row-selected")).toHaveCount(fixtures.length);
});

test("size, date modified and type headers sort file metadata and keep folders first", async ({
  page,
}) => {
  await openFiles(page);
  await expect(
    page.getByRole("columnheader", { name: "Last modified", exact: true }),
  ).toHaveCount(0);
  for (const [name, label] of [
    ["world", "File folder"],
    ["README", "File"],
    ["Settings.JSON", "JSON file"],
    ["archive.tar.gz", "GZ file"],
    ["file2.txt", "TXT file"],
  ]) {
    const row = page.locator(".file-table tbody tr").filter({
      has: page.getByRole("checkbox", { name: `Select ${name}`, exact: true }),
    });
    await expect(
      row.getByRole("cell", { name: label, exact: true }),
    ).toBeVisible();
  }

  for (const [name, ascending] of [
    [
      "Size",
      ["README", "file10.txt", "Settings.JSON", "archive.tar.gz", "file2.txt"],
    ],
    [
      "Date modified",
      ["Settings.JSON", "archive.tar.gz", "README", "file2.txt", "file10.txt"],
    ],
  ] as const) {
    await sortButton(page, name).click();
    await expect(column(page, name)).toHaveAttribute("aria-sort", "ascending");
    await expect(names(page)).toHaveText(["world", ...ascending]);
    await sortButton(page, name).click();
    await expect(column(page, name)).toHaveAttribute("aria-sort", "descending");
    await expect(names(page)).toHaveText(["world", ...ascending.toReversed()]);
    await expect(
      page.locator(".file-table th[aria-sort='descending']"),
    ).toHaveCount(1);
  }

  await sortButton(page, "Type").click();
  await expect(column(page, "Type")).toHaveAttribute("aria-sort", "ascending");
  await expect(names(page)).toHaveText([
    "world",
    "README",
    "archive.tar.gz",
    "Settings.JSON",
    "file2.txt",
    "file10.txt",
  ]);
  await sortButton(page, "Type").click();
  await expect(column(page, "Type")).toHaveAttribute("aria-sort", "descending");
  // Files sharing a type can use either stable or direction-aware name ties.
  await expect(names(page).first()).toHaveText("world");
  await expect(names(page).nth(3)).toHaveText("Settings.JSON");
  await expect(names(page).nth(4)).toHaveText("archive.tar.gz");
  await expect(names(page).nth(5)).toHaveText("README");
  await expect(page.locator(".file-table tbody tr").first()).toHaveClass(
    "parent-directory",
  );
});

test("sorting applies to the full directory before pagination and preserves selected paths", async ({
  page,
}) => {
  const entries = Array.from({ length: 30 }, (_, index): Entry => ({
    name: `file${index + 1}.txt`,
    path: `sorting/file${index + 1}.txt`,
    type: "file",
    size: 30 - index,
    modified: "2026-10-01T12:00:00.000Z",
  }));
  await openFiles(page, entries);
  await page
    .getByRole("button", { name: "Next files page", exact: true })
    .click();
  await expect(names(page)).toHaveText(
    entries.slice(25).map((entry) => entry.name),
  );
  await page
    .getByRole("checkbox", { name: "Select file30.txt", exact: true })
    .check();
  await sortButton(page, "Size").click();
  await expect(
    page.getByRole("status", { name: "files page", exact: true }),
  ).toHaveText("Page 1 of 2");
  await expect(names(page)).toHaveText(
    entries
      .toReversed()
      .slice(0, 25)
      .map((entry) => entry.name),
  );
  await expect(
    page.getByRole("checkbox", { name: "Select file30.txt", exact: true }),
  ).toBeChecked();
});

test("recursive search results use the same sortable columns across result batches", async ({
  page,
}) => {
  await openFiles(page);
  const first: Entry = {
    name: "match10.txt",
    path: "sorting/a/match10.txt",
    type: "file",
    size: 10,
    modified: "2026-10-02T12:00:00.000Z",
  };
  const second: Entry = {
    name: "match2.JSON",
    path: "sorting/b/match2.JSON",
    type: "file",
    size: 2000,
    modified: "2026-10-01T12:00:00.000Z",
  };
  await page.route("**/api/files?**", async (route) => {
    const url = new URL(route.request().url());
    if (!url.searchParams.has("search")) return route.fallback();
    const continuation = url.searchParams.has("cursor");
    await route.fulfill({
      json: {
        path: "sorting",
        search: url.searchParams.get("search"),
        entries: [continuation ? second : first],
        nextCursor: continuation ? null : "second-batch",
      },
    });
  });
  await page
    .getByRole("textbox", { name: "Search files and folders", exact: true })
    .fill("match");
  const paths = page.locator(".file-search-path");
  await expect(paths).toHaveText([`/${second.path}`, `/${first.path}`]);
  await expect(page.locator(".parent-directory")).toHaveCount(0);
  await sortButton(page, "Size").click();
  await expect(paths).toHaveText([`/${first.path}`, `/${second.path}`]);
  await sortButton(page, "Date modified").click();
  await expect(paths).toHaveText([`/${second.path}`, `/${first.path}`]);
  await sortButton(page, "Type").click();
  await expect(paths).toHaveText([`/${second.path}`, `/${first.path}`]);
});

test("all file sort columns remain reachable on narrow screens without page overflow", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 960 });
  await openFiles(page);
  await page.screenshot({
    path: testInfo.outputPath("file-sorting-desktop.png"),
    fullPage: true,
  });

  await page.setViewportSize({ width: 390, height: 844 });
  for (const name of ["Date modified", "Type", "Size", "Name"]) {
    const button = sortButton(page, name);
    await button.scrollIntoViewIfNeeded();
    await expect(button).toBeInViewport();
    await button.click();
    await expect(column(page, name)).toHaveAttribute("aria-sort", "ascending");
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(390);
  }
  await sortButton(page, "Date modified").scrollIntoViewIfNeeded();
  await sortButton(page, "Date modified").click();
  await expect(names(page)).toHaveText([
    "world",
    "Settings.JSON",
    "archive.tar.gz",
    "README",
    "file2.txt",
    "file10.txt",
  ]);
  await page.screenshot({
    path: testInfo.outputPath("file-sorting-mobile.png"),
    fullPage: true,
  });
});
