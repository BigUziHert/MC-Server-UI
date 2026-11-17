import { launchpadError as error } from "./launchpad-network.mjs";

const autoFolders = {
  mod: "mods",
  resourcepack: "resourcepacks",
  shader: "shaderpacks",
};

export function contentTarget(input = {}) {
  const target = input.target ?? "server";
  if (!["server", "automodpack"].includes(target))
    throw error(400, "Choose a valid Launchpad content target.");
  if (target === "automodpack" && !Object.hasOwn(autoFolders, input.type))
    throw error(
      400,
      "AutoModpack supports mods, resource packs, and shader packs.",
    );
  if (target === "server" && ["resourcepack", "shader"].includes(input.type))
    throw error(
      400,
      "Use AutoModpack to stage resource packs and shader packs.",
    );
  return target;
}

export function autoModpackFolder(input) {
  return contentTarget(input) === "automodpack"
    ? `automodpack/host-modpack/main/${autoFolders[input.type]}`
    : null;
}

export const canActivateContent = (input) =>
  input.type === "mod" || input.target === "automodpack";

export function contentFilePattern(input) {
  // AutoModpack excludes *.disabled when generating its pack, so the regular
  // Mods activation convention also works for staged ZIP packs.
  // https://github.com/Skidamek/AutoModpack/blob/main/docs/pack-content.mdx
  if (["datapack", "resourcepack", "shader"].includes(input.type))
    return input.target === "automodpack"
      ? /\.zip(?:\.disabled)?$/i
      : /\.zip$/i;
  return input.type === "mod" ? /\.jar(?:\.disabled)?$/i : /\.jar$/i;
}

export function isContentPath(relative, folder, input) {
  return (
    typeof relative === "string" &&
    relative.startsWith(`${folder}/`) &&
    !relative.slice(folder.length + 1).includes("/") &&
    !relative.includes("\\") &&
    contentFilePattern(input).test(relative)
  );
}
