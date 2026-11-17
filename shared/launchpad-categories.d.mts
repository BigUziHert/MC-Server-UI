export type ModCategory = {
  id: string;
  label: string;
  modrinth?: string[];
  curseforge?: string[];
  children?: ModCategory[];
};
export const modCategories: ModCategory[];
export const allModCategories: ModCategory[];
export const resourcePackCategories: ModCategory[];
export const shaderCategories: ModCategory[];
export function categoriesFor(type?: string): ModCategory[];
export function allCategoriesFor(type?: string): ModCategory[];
export function categoryIds(value: unknown, type?: string): string[];
export function supportsCategory(
  id: string,
  platform: string,
  type?: string,
): boolean;
export function matchesCategories(
  categories: string[] | undefined,
  selected: string[],
  type?: string,
): boolean;
export function modrinthCategoryFacets(
  selected: string[],
  type?: string,
): string[];
export function normalizeModrinthCategories(
  values: unknown,
  type?: string,
): string[];
export function curseforgeCategoryId(
  value: { name?: string; slug?: string } | undefined,
  type?: string,
): string | undefined;
export function normalizeCurseforgeCategories(
  values: unknown,
  type?: string,
): string[];
