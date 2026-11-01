export type ModCategory = {
  id: string;
  label: string;
  modrinth?: string[];
  children?: ModCategory[];
};
export const modCategories: ModCategory[];
export const allModCategories: ModCategory[];
export function categoryIds(value: unknown): string[];
export function supportsCategory(id: string, platform: string): boolean;
export function matchesCategories(
  categories: string[] | undefined,
  selected: string[],
): boolean;
export function modrinthCategoryFacets(selected: string[]): string[];
export function normalizeModrinthCategories(values: unknown): string[];
export function curseforgeCategoryId(
  value: { name?: string; slug?: string } | undefined,
): string | undefined;
export function normalizeCurseforgeCategories(values: unknown): string[];
