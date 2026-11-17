// Stable UI IDs are independent of the numeric IDs returned by CurseForge.
// Category names/hierarchy: https://www.curseforge.com/minecraft/search?class=mc-mods
// Modrinth mappings use its public /v2/tag/category taxonomy. Missing mappings
// are deliberately unavailable instead of silently broadening a user's filter.
export const modCategories = [
  { id: "addons", label: "Addons" },
  { id: "adventure-rpg", label: "Adventure and RPG", modrinth: ["adventure"] },
  { id: "api-library", label: "API and Library", modrinth: ["library"] },
  {
    id: "armor-tools-weapons",
    label: "Armor, Tools, and Weapons",
    modrinth: ["equipment"],
  },
  { id: "bug-fixes", label: "Bug Fixes" },
  { id: "cosmetic", label: "Cosmetic", modrinth: ["decoration"] },
  { id: "creative-mode", label: "CreativeMode" },
  { id: "education", label: "Education" },
  { id: "food", label: "Food", modrinth: ["food"] },
  { id: "horror", label: "Horror" },
  { id: "magic", label: "Magic", modrinth: ["magic"] },
  { id: "map-information", label: "Map and Information" },
  { id: "mcreator", label: "MCreator" },
  { id: "miscellaneous", label: "Miscellaneous" },
  { id: "modjam-2025", label: "ModJam 2025" },
  { id: "performance", label: "Performance", modrinth: ["optimization"] },
  { id: "redstone", label: "Redstone" },
  { id: "server-utility", label: "Server Utility", modrinth: ["management"] },
  { id: "storage", label: "Storage", modrinth: ["storage"] },
  {
    id: "technology",
    label: "Technology",
    modrinth: ["technology"],
    children: [
      { id: "automation", label: "Automation" },
      { id: "energy", label: "Energy" },
      {
        id: "energy-fluid-item-transport",
        label: "Energy, Fluid, and Item Transport",
      },
      { id: "farming", label: "Farming" },
      { id: "genetics", label: "Genetics" },
      {
        id: "player-transport",
        label: "Player Transport",
        modrinth: ["transportation"],
      },
      { id: "processing", label: "Processing" },
    ],
  },
  { id: "twitch-integration", label: "Twitch Integration" },
  { id: "utility-qol", label: "Utility & QoL", modrinth: ["utility"] },
  {
    id: "world-gen",
    label: "World Gen",
    modrinth: ["worldgen"],
    children: [
      { id: "biomes", label: "Biomes" },
      { id: "dimensions", label: "Dimensions" },
      { id: "mobs", label: "Mobs", modrinth: ["mobs"] },
      { id: "ores-resources", label: "Ores and Resources" },
      { id: "structures", label: "Structures" },
    ],
  },
];

export const allModCategories = modCategories.flatMap((row) => [
  row,
  ...(row.children ?? []),
]);
// Pack taxonomies come from Modrinth's /v2/tag/category and CurseForge's
// texture-packs/shaders catalog. Explicit aliases preserve each provider's
// terminology; unsupported mappings never silently broaden a filter.
export const resourcePackCategories = [
  ...["16x", "32x", "64x", "128x", "256x"].map((id) => ({
    id,
    label: id,
    modrinth: [id],
    curseforge: [id],
  })),
  {
    id: "512x-plus",
    label: "512x and Higher",
    modrinth: ["512x+"],
    curseforge: ["512x and Higher"],
  },
  { id: "8x-minus", label: "8x and Lower", modrinth: ["8x-"], curseforge: [] },
  { id: "48x", label: "48x", modrinth: ["48x"], curseforge: [] },
  { id: "animated", label: "Animated", curseforge: ["Animated"] },
  {
    id: "fonts",
    label: "Fonts",
    modrinth: ["fonts"],
    curseforge: ["Font Packs"],
  },
  {
    id: "modded",
    label: "Mod Support",
    modrinth: ["modded"],
    curseforge: ["Mod Support"],
  },
  {
    id: "realistic",
    label: "Realistic",
    modrinth: ["realistic"],
    curseforge: ["Photo Realistic"],
  },
  {
    id: "vanilla-like",
    label: "Vanilla-like",
    modrinth: ["vanilla-like"],
    curseforge: ["Traditional"],
  },
  ...["Medieval", "Miscellaneous", "Modern", "ModJam 2025", "Steampunk"].map(
    (label) => ({
      id: label.toLowerCase().replaceAll(" ", "-"),
      label,
      curseforge: [label],
    }),
  ),
  ...[
    ["audio", "Audio"],
    ["blocks", "Blocks"],
    ["combat", "Combat"],
    ["core-shaders", "Core Shaders"],
    ["cursed", "Cursed"],
    ["decoration", "Decoration"],
    ["entities", "Entities"],
    ["environment", "Environment"],
    ["equipment", "Equipment"],
    ["gui", "GUI"],
    ["items", "Items"],
    ["locale", "Translations"],
    ["models", "Models"],
    ["simplistic", "Simplistic"],
    ["themed", "Themed"],
    ["tweaks", "Tweaks"],
    ["utility", "Utility"],
  ].map(([id, label]) => ({ id, label, modrinth: [id], curseforge: [] })),
];
export const shaderCategories = [
  {
    id: "fantasy",
    label: "Fantasy",
    modrinth: ["fantasy"],
    curseforge: ["Fantasy"],
  },
  {
    id: "realistic",
    label: "Realistic",
    modrinth: ["realistic"],
    curseforge: ["Realistic"],
  },
  {
    id: "vanilla-like",
    label: "Vanilla-like",
    modrinth: ["vanilla-like"],
    curseforge: ["Vanilla"],
  },
  ...[
    ["cartoon", "Cartoon"],
    ["cursed", "Cursed"],
    ["semi-realistic", "Semi-realistic"],
    ["atmosphere", "Atmosphere"],
    ["bloom", "Bloom"],
    ["colored-lighting", "Colored Lighting"],
    ["foliage", "Foliage"],
    ["path-tracing", "Path Tracing"],
    ["pbr", "PBR"],
    ["reflections", "Reflections"],
    ["shadows", "Shadows"],
    ["potato", "Minimal Performance Impact"],
    ["low", "Low Performance Impact"],
    ["medium", "Medium Performance Impact"],
    ["high", "High Performance Impact"],
    ["screenshot", "Screenshot Quality"],
  ].map(([id, label]) => ({ id, label, modrinth: [id], curseforge: [] })),
];
export function categoriesFor(type = "mod") {
  return type === "resourcepack"
    ? resourcePackCategories
    : type === "shader"
      ? shaderCategories
      : type === "mod"
        ? modCategories
        : [];
}
export function allCategoriesFor(type = "mod") {
  return categoriesFor(type).flatMap((row) => [row, ...(row.children ?? [])]);
}
const categoryMaps = new Map(
  ["mod", "resourcepack", "shader"].map((type) => [
    type,
    new Map(allCategoriesFor(type).map((row) => [row.id, row])),
  ]),
);
const categoryMap = (type) => categoryMaps.get(type) ?? new Map();
const normalized = (value) =>
  String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");

export function categoryIds(value, type = "mod") {
  if (value === undefined || value === "") return [];
  const values = typeof value === "string" ? value.split(",") : value;
  if (
    !Array.isArray(values) ||
    values.length > 10 ||
    values.some(
      (entry) => typeof entry !== "string" || !categoryMap(type).has(entry),
    )
  )
    throw new Error(`Choose up to 10 valid ${type} categories.`);
  return [...new Set(values)].sort();
}

export function supportsCategory(id, platform, type = "mod") {
  const row = categoryMap(type).get(id);
  return Boolean(
    row &&
    ((platform === "curseforge" &&
      (row.curseforge === undefined || row.curseforge.length)) ||
      (platform === "modrinth" && row.modrinth?.length)),
  );
}

export function matchesCategories(categories, selected, type = "mod") {
  if (!selected.length) return true;
  const known = new Set(categories ?? []);
  return selected.some(
    (id) =>
      known.has(id) ||
      categoryMap(type)
        .get(id)
        ?.children?.some((child) => known.has(child.id)),
  );
}

export function modrinthCategoryFacets(selected, type = "mod") {
  return [
    ...new Set(
      selected.flatMap((id) => categoryMap(type).get(id)?.modrinth ?? []),
    ),
  ].map((name) => `categories:${name}`);
}

export function normalizeModrinthCategories(values, type = "mod") {
  if (!Array.isArray(values)) return [];
  return allCategoriesFor(type)
    .filter((row) => row.modrinth?.some((name) => values.includes(name)))
    .map((row) => row.id);
}

export function curseforgeCategoryId(value, type = "mod") {
  const name = normalized(value?.name);
  const slug = normalized(value?.slug);
  return allCategoriesFor(type).find(
    (row) =>
      row.curseforge?.some(
        (alias) => normalized(alias) === name || normalized(alias) === slug,
      ) ||
      (row.curseforge === undefined &&
        (normalized(row.label) === name ||
          normalized(row.id) === slug ||
          normalized(row.label) === slug)),
  )?.id;
}

export function normalizeCurseforgeCategories(values, type = "mod") {
  return Array.isArray(values)
    ? [
        ...new Set(
          values
            .map((value) => curseforgeCategoryId(value, type))
            .filter(Boolean),
        ),
      ]
    : [];
}
