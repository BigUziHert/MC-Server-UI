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
const byId = new Map(allModCategories.map((row) => [row.id, row]));
const normalized = (value) =>
  String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");

export function categoryIds(value) {
  if (value === undefined || value === "") return [];
  const values = typeof value === "string" ? value.split(",") : value;
  if (
    !Array.isArray(values) ||
    values.length > 10 ||
    values.some((entry) => typeof entry !== "string" || !byId.has(entry))
  )
    throw new Error("Choose up to 10 valid mod categories.");
  return [...new Set(values)].sort();
}

export function supportsCategory(id, platform) {
  const row = byId.get(id);
  return Boolean(
    row &&
    (platform === "curseforge" ||
      (platform === "modrinth" && row.modrinth?.length)),
  );
}

export function matchesCategories(categories, selected) {
  if (!selected.length) return true;
  const known = new Set(categories ?? []);
  return selected.some(
    (id) =>
      known.has(id) ||
      byId.get(id)?.children?.some((child) => known.has(child.id)),
  );
}

export function modrinthCategoryFacets(selected) {
  return [
    ...new Set(selected.flatMap((id) => byId.get(id)?.modrinth ?? [])),
  ].map((name) => `categories:${name}`);
}

export function normalizeModrinthCategories(values) {
  if (!Array.isArray(values)) return [];
  return allModCategories
    .filter((row) => row.modrinth?.some((name) => values.includes(name)))
    .map((row) => row.id);
}

export function curseforgeCategoryId(value) {
  const name = normalized(value?.name);
  const slug = normalized(value?.slug);
  return allModCategories.find(
    (row) =>
      normalized(row.label) === name ||
      normalized(row.id) === slug ||
      normalized(row.label) === slug,
  )?.id;
}

export function normalizeCurseforgeCategories(values) {
  return Array.isArray(values)
    ? [...new Set(values.map(curseforgeCategoryId).filter(Boolean))]
    : [];
}
