import fs from "node:fs/promises";
import path from "node:path";
import {
  jarTimestampIdentity,
  jarContentIdentity,
} from "./launchpad-jar-identity.mjs";
import { inspectInstalledMod } from "./launchpad-mod-metadata.mjs";
import { downloadVerified } from "./launchpad-network.mjs";

// Search names and filenames are discovery hints only. A downloaded release
// must pass its provider checksum, then match the installed archive's contents
// before it can supply an identity or update checks. Only packaging and known
// unsigned-manifest build timestamps can differ; names alone prove nothing.
export async function recoverJarIdentity(
  source,
  {
    name,
    loader,
    gameVersion,
    provider,
    request,
    temporaryDirectory,
    reserve,
    signal,
  },
) {
  let signature;
  try {
    signature = jarTimestampIdentity(source, { signal });
  } catch {
    signal?.throwIfAborted();
    return null;
  }
  let title;
  try {
    title = (await inspectInstalledMod(source, { loader, signal })).title;
  } catch {
    signal?.throwIfAborted();
    // Unsupported loader metadata can still use the filename as a search hint.
  }
  const candidates = await provider.installedCandidates({
    name,
    title,
    loader,
    gameVersion,
    signal,
  });
  let directory, contentSignature;
  try {
    for (const version of candidates) {
      for (const file of version.files) {
        signal?.throwIfAborted();
        if (!reserve(file.size)) return null;
        directory ??= await temporaryDirectory();
        const target = path.join(directory, `${file.hashes.sha512}.jar`);
        await downloadVerified(file, target, provider.downloadHosts, request, {
          signal,
        });
        const downloaded = await fs.readFile(target, { signal });
        let identityMethod;
        try {
          if (
            downloaded.length === source.length &&
            jarTimestampIdentity(downloaded, { signal }) === signature
          )
            identityMethod = "jar-timestamps";
          else {
            contentSignature ??= await jarContentIdentity(source, { signal });
            if (
              (await jarContentIdentity(downloaded, { signal })) ===
              contentSignature
            )
              identityMethod = "jar-contents";
          }
        } catch {
          signal?.throwIfAborted();
        }
        if (identityMethod)
          return {
            platform: "modrinth",
            projectId: version.project_id,
            versionId: version.id,
            versionName: version.name,
            title: version.name,
            identityMethod,
            canonicalSha512: file.hashes.sha512.toLowerCase(),
          };
        await fs.unlink(target);
      }
    }
    return null;
  } finally {
    if (directory) await fs.rm(directory, { recursive: true, force: true });
  }
}
