const MOHIST = "https://api.mohistmc.com/project/mohist";
const ARCLIGHT = "https://files.hypoglycemia.icu/v1/files/arclight/minecraft";
const ARCLIGHT_REPO = "https://github.com/IzzelAliz/Arclight";
const SPONGE =
  "https://dl-api.spongepowered.org/v2/groups/org.spongepowered/artifacts/spongevanilla";
const softwareLoaders = new Map([
  ["fabric", "Fabric"],
  ["forge", "Forge"],
  ["neoforge", "NeoForge"],
]);
const identifier = (value) =>
  typeof value === "string" && /^[a-z0-9][a-z0-9._+-]{0,100}$/i.test(value);
const stable = (version) => !/alpha|beta|snapshot|pre|rc/i.test(version);
const newest = (a, b) => b.id.localeCompare(a.id, "en", { numeric: true });
const sha1 = (value) =>
  typeof value === "string" && /^[a-f0-9]{40}$/i.test(value);
const sha256 = (value) =>
  typeof value === "string" && /^[a-f0-9]{64}$/i.test(value);
const invalidMetadata = (provider) =>
  Object.assign(
    new Error(
      `The official ${provider} service returned invalid release metadata.`,
    ),
    { status: 502 },
  );
const release = (id, url) => ({ id, label: id, stable: stable(id), url });
const publishedAt = (value) =>
  typeof value === "string" && Number.isFinite(Date.parse(value))
    ? value
    : undefined;

function mohistPage(version, hash) {
  const url = new URL("https://www.mohistmc.com/downloadSoftware");
  url.searchParams.set("project", "mohist");
  url.searchParams.set("projectVersion", version);
  if (sha1(hash)) url.hash = `:~:text=${hash.slice(0, 8)}`;
  return url.href;
}

function spongePage(version, build) {
  const url = new URL("https://spongepowered.org/downloads/spongevanilla");
  url.searchParams.set("minecraft", version);
  if (build) url.hash = `:~:text=${encodeURIComponent(build)}`;
  return url.href;
}

function arclightPage(_version, build) {
  const commit = /-([a-f0-9]{7,40})$/i.exec(build)?.[1];
  return commit
    ? `${ARCLIGHT_REPO}/commit/${commit}`
    : `${ARCLIGHT_REPO}/releases`;
}

function arclightArtifact(value) {
  if (typeof value !== "string") return;
  const match =
    /^https:\/\/files\.(?:hypertention\.cn|hypoglycemia\.icu)\/v1\/objects\/([a-f0-9]{40})$/i.exec(
      value,
    );
  if (match)
    return {
      url: `https://files.hypoglycemia.icu/v1/objects/${match[1]}`,
      // These permalink IDs are the SHA-1 of the stored bytes.
      checksums: { sha1: match[1] },
    };
}

function spongeJar(assets, build) {
  const jars = new Map();
  for (const asset of assets) {
    const { classifier, extension, downloadUrl } = asset ?? {};
    if (extension !== "jar" || (classifier && classifier !== "universal"))
      continue;
    try {
      const url = new URL(downloadUrl);
      const suffix = classifier ? "-universal" : "";
      const filename = `/org/spongepowered/spongevanilla/${build}/spongevanilla-${build}${suffix}.jar`;
      const pathname = decodeURIComponent(url.pathname);
      if (
        url.protocol === "https:" &&
        url.hostname === "repo.spongepowered.org" &&
        !url.username &&
        !url.password &&
        !url.port &&
        !url.search &&
        !url.hash &&
        ["/repository/maven-releases", "/repository/legacy-transfer"].some(
          (base) => pathname === base + filename,
        )
      )
        jars.set(classifier || "", { url: url.href, sha1: asset.sha1 });
    } catch {
      // Only artifacts on Sponge's own repository are installable.
    }
  }
  return jars.get("universal") ?? jars.get("");
}

export function createHybridProviders({ json, text, cached }) {
  async function arclightFiles(url) {
    const data = await json(url);
    if (!Array.isArray(data?.files)) throw invalidMetadata("Arclight");
    return data.files;
  }
  return {
    mohist: {
      page: (version) => mohistPage(version),
      async versions() {
        const versions = await json(`${MOHIST}/versions`);
        if (!Array.isArray(versions)) throw invalidMetadata("Mohist");
        return versions
          .map((entry) => entry?.name)
          .filter(identifier)
          .map((id) => release(id, mohistPage(id)))
          .sort(newest);
      },
      async builds(version) {
        const catalog = `${MOHIST}/${encodeURIComponent(version)}/builds`;
        const builds = await json(catalog);
        if (!Array.isArray(builds)) throw invalidMetadata("Mohist");
        return builds
          .filter(
            (entry) =>
              Number.isSafeInteger(entry?.id) &&
              entry.id > 0 &&
              sha256(entry.file_sha256),
          )
          .map((entry) => ({
            id: String(entry.id),
            label: `Build ${entry.id}`,
            stable: stable(version),
            publishedAt: publishedAt(entry.build_date),
            url: mohistPage(version, entry.commit?.hash),
            artifact: {
              url: `${catalog}/${entry.id}/download`,
              checksums: { sha256: entry.file_sha256 },
            },
          }))
          .sort(
            (a, b) =>
              (b.publishedAt ?? "").localeCompare(a.publishedAt ?? "") ||
              newest(a, b),
          );
      },
    },
    arclight: {
      page: arclightPage,
      async versions() {
        const versions = await arclightFiles(ARCLIGHT);
        return versions
          .map((entry) => entry?.name)
          .filter(identifier)
          .map((id) => release(id, `${ARCLIGHT_REPO}/releases`))
          .sort(newest);
      },
      async builds(version) {
        const catalog = `${ARCLIGHT}/${encodeURIComponent(version)}/loaders`;
        const loaders = (await arclightFiles(catalog))
          .map((entry) => entry?.name)
          .filter((loader) => softwareLoaders.has(loader));
        const results = await Promise.all(
          loaders.map(async (loader) => {
            const channels = (await arclightFiles(`${catalog}/${loader}`))
              .map((entry) => entry?.name)
              .filter((name) =>
                ["versions-stable", "versions-snapshot"].includes(name),
              );
            const builds = await Promise.all(
              channels.map(async (channel) =>
                (
                  await arclightFiles(`${catalog}/${loader}/${channel}`)
                ).flatMap((entry) => {
                  if (entry?.type !== "object" || !identifier(entry.name))
                    return [];
                  const id = `${loader}-${entry.name}`;
                  const artifact = arclightArtifact(entry.permlink);
                  if (!identifier(id) || !artifact) return [];
                  return [
                    {
                      id,
                      label: `${entry.name} · ${softwareLoaders.get(loader)}`,
                      stable: channel === "versions-stable" && stable(version),
                      publishedAt: publishedAt(entry["last-modified"]),
                      url: arclightPage(version, id),
                      artifact,
                    },
                  ];
                }),
              ),
            );
            return builds.flat();
          }),
        );
        return results
          .flat()
          .sort(
            (a, b) =>
              Number(b.stable) - Number(a.stable) ||
              (b.publishedAt ?? "").localeCompare(a.publishedAt ?? "") ||
              newest(a, b),
          );
      },
    },
    sponge: {
      page: spongePage,
      async versions() {
        const data = await json(SPONGE);
        if (!Array.isArray(data?.tags?.minecraft))
          throw invalidMetadata("Sponge");
        return data.tags.minecraft
          .filter(identifier)
          .map((id) => release(id, spongePage(id)))
          .sort(newest);
      },
      async builds(version) {
        const query = new URLSearchParams({ tags: `minecraft:${version}` });
        const catalog = `${SPONGE}/versions?${query}`;
        // The official catalog limits an unqualified response to recent builds.
        // Keep recommended builds visible even when previews fill that response.
        const pages = await Promise.all([
          json(catalog),
          json(`${catalog}&recommended=true`),
        ]);
        const builds = new Map();
        for (const page of pages) {
          if (
            !page?.artifacts ||
            typeof page.artifacts !== "object" ||
            Array.isArray(page.artifacts)
          )
            throw invalidMetadata("Sponge");
          for (const [id, entry] of Object.entries(page.artifacts)) {
            if (!identifier(id) || entry?.tagValues?.minecraft !== version)
              continue;
            builds.set(id, {
              id,
              label: id,
              stable: stable(version) && entry.recommended === true,
              url: spongePage(version, id),
            });
          }
        }
        return [...builds.values()].sort(
          (a, b) => Number(b.stable) - Number(a.stable) || newest(a, b),
        );
      },
      async artifact(_version, { id }) {
        return cached(`sponge:artifact:${id}`, async () => {
          const data = await json(
            `${SPONGE}/versions/${encodeURIComponent(id)}`,
          );
          if (!Array.isArray(data?.assets)) throw invalidMetadata("Sponge");
          const asset = spongeJar(data.assets, id);
          if (!asset) throw invalidMetadata("Sponge");
          let checksum;
          try {
            checksum = (await text(`${asset.url}.sha256`)).trim();
          } catch (cause) {
            if (!sha1(asset.sha1)) throw cause;
          }
          if (sha256(checksum))
            return { url: asset.url, checksums: { sha256: checksum } };
          if (sha1(asset.sha1))
            return { url: asset.url, checksums: { sha1: asset.sha1 } };
          throw invalidMetadata("Sponge");
        });
      },
    },
  };
}
