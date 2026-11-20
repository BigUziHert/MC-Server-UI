import test from "node:test";
import assert from "node:assert/strict";
import { createPufferfishProvider } from "./versions-pufferfish.mjs";

test("Pufferfish lists only exact Minecraft releases with pinned official archives", async () => {
  const pufferfish = createPufferfishProvider();
  const versions = await pufferfish.versions();
  assert.equal(versions[0].id, "1.21.10");
  assert.equal(new Set(versions.map(({ id }) => id)).size, versions.length);

  for (const version of versions) {
    const [build] = await pufferfish.builds(version.id);
    assert.equal(build.url, version.url);
    assert.equal(pufferfish.page(version.id, build.id), build.url);
    assert.match(
      build.artifact.url,
      /^https:\/\/ci\.pufferfish\.host\/job\/Pufferfish-1\.\d+\/\d+\/artifact\/.+\.jar$/,
    );
    assert.match(
      build.artifact.url,
      new RegExp(`-${version.id.replaceAll(".", "\\.")}-R0\\.1-SNAPSHOT`),
    );
    assert.match(build.artifact.checksums.sha256, /^[a-f0-9]{64}$/);
    assert.ok(Number.isInteger(build.javaVersion));
  }

  const [release] = await pufferfish.builds("1.21.1");
  assert.equal(release.id, "21");
  assert.equal(release.javaVersion, 21);
  assert.equal(
    release.url,
    "https://ci.pufferfish.host/job/Pufferfish-1.21/21/",
  );
  assert.equal(pufferfish.page("1.21.1", "39"), undefined);
  assert.deepEqual(await pufferfish.builds("1.21.2"), []);
  assert.deepEqual(await pufferfish.builds("../lastSuccessfulBuild"), []);
});
