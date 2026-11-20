const LEAVES = "https://api.leavesmc.org/v2/projects/leaves";
const MAGMA = "https://magmafoundation.org/api/versions?limit=0";
const MAGMA_DOWNLOADS = "https://magmafoundation.org/downloads";
const MAGMA_REPOSITORY =
  "https://repo.magmafoundation.org/releases/org/magmafoundation/magma";
const MAGMA_MINECRAFT = "1.21.1";

const providerError = (message) =>
  Object.assign(new Error(message), { status: 502 });
const sha256 = (value) =>
  typeof value === "string" && /^[a-f0-9]{64}$/i.test(value);
const newest = (a, b) => b.localeCompare(a, "en", { numeric: true });
const dated = (value) =>
  typeof value === "string" && Number.isFinite(Date.parse(value))
    ? { publishedAt: value }
    : {};
const leavesPage = (version, build) =>
  `${LEAVES}/versions/${encodeURIComponent(version)}/builds${build ? `/${encodeURIComponent(build)}` : ""}`;
const magmaChangelog = (build) =>
  `${MAGMA_REPOSITORY}/${encodeURIComponent(build)}/magma-${encodeURIComponent(build)}-changelog.txt`;

export function createForkProviders({ json, text, cached }) {
  const magmaCatalog = () =>
    cached("magma", async () => {
      const data = await json(MAGMA);
      if (!Array.isArray(data?.versions))
        throw providerError("Magma returned invalid version metadata.");

      return data.versions
        .flatMap((entry) => {
          const id = entry?.version;
          // The website groups releases as 1.21.x. The 21.1 launcher series
          // specifically targets Minecraft 1.21.1. Older builds may provide an
          // installer only or use a different Java version.
          if (
            typeof id !== "string" ||
            id.length > 101 ||
            !/^21\.1\.\d+(?:[-+][a-z0-9][a-z0-9.+-]*)?$/i.test(id) ||
            !["1.21.x", MAGMA_MINECRAFT].includes(entry.minecraftVersion) ||
            entry.hasLauncher !== true
          )
            return [];

          const base = `${MAGMA_REPOSITORY}/${encodeURIComponent(id)}/magma-${encodeURIComponent(id)}`;
          const launcher = `${base}-launcher.jar`;
          const changelog = magmaChangelog(id);
          if (entry.launcherUrl !== launcher) return [];
          return [
            {
              id,
              label: id,
              stable: entry.isStable === true,
              javaVersion: 21,
              ...dated(entry.releaseDate),
              url:
                entry.changelogUrl === changelog ? changelog : MAGMA_DOWNLOADS,
              artifact: { url: launcher },
            },
          ];
        })
        .sort((a, b) => newest(a.id, b.id));
    });

  return {
    leaves: {
      page: leavesPage,
      async versions() {
        const project = await json(LEAVES);
        if (!Array.isArray(project?.versions))
          throw providerError("Leaves returned invalid version metadata.");

        return project.versions
          .filter(
            (version) =>
              typeof version === "string" && /^\d[\w.+-]{0,100}$/.test(version),
          )
          .sort(newest)
          .map((id) => ({
            id,
            label: id,
            stable: !/alpha|beta|snapshot|pre|rc/i.test(id),
            url: leavesPage(id),
          }));
      },
      async builds(version) {
        const root = `${LEAVES}/versions/${encodeURIComponent(version)}/builds`;
        const catalog = await json(root);
        if (!Array.isArray(catalog?.builds))
          throw providerError("Leaves returned invalid build metadata.");

        return catalog.builds
          .flatMap((build) => {
            const checksum = build?.downloads?.application?.sha256;
            if (
              !Number.isSafeInteger(build?.build) ||
              build.build < 1 ||
              !sha256(checksum)
            )
              return [];

            const id = String(build.build);
            const url = leavesPage(version, id);
            return [
              {
                id,
                label: `Build ${id}`,
                stable: build.channel === "default",
                javaVersion: 21,
                ...dated(build.time),
                url,
                artifact: {
                  url: `${url}/downloads/application`,
                  checksums: { sha256: checksum },
                },
              },
            ];
          })
          .sort((a, b) => newest(a.id, b.id));
      },
    },
    magma: {
      page: (_version, build) => magmaChangelog(build),
      async versions() {
        return (await magmaCatalog()).length
          ? [
              {
                id: MAGMA_MINECRAFT,
                label: MAGMA_MINECRAFT,
                stable: true,
                url: MAGMA_DOWNLOADS,
              },
            ]
          : [];
      },
      async builds(version) {
        return version === MAGMA_MINECRAFT ? magmaCatalog() : [];
      },
      async artifact(_version, { artifact: { url } }) {
        let checksum;
        try {
          checksum = (await text(`${url}.sha256`)).trim();
        } catch (cause) {
          throw Object.assign(
            providerError(
              "The official Magma launcher checksum is unavailable.",
            ),
            { cause },
          );
        }
        if (!sha256(checksum))
          throw providerError("Magma returned an invalid launcher checksum.");
        return { url, checksums: { sha256: checksum } };
      },
    },
  };
}
