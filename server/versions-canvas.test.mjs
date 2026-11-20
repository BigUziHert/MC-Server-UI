import assert from "node:assert/strict";
import test from "node:test";
import { createCanvasProvider } from "./versions-canvas.mjs";

test("Canvas lists only pinned releases and opens the exact official CI build", async () => {
  const provider = createCanvasProvider();
  assert.deepEqual(
    (await provider.versions()).map(({ id }) => id),
    ["26.3", "26.2", "26.1.2", "1.21.11", "1.21.8"],
  );
  const [current] = await provider.builds("26.3");
  assert.equal(current.id, "1038");
  assert.equal(current.javaVersion, 25);
  assert.equal(current.stable, true);
  assert.deepEqual(current.artifact, {
    url: "https://jenkins.canvasmc.io/job/Canvas/1038/artifact/canvas-server/build/libs/canvas-build.1038.jar",
    checksums: {
      sha256:
        "77485bd48c80a6dd0d798816c3385efc5a1d1a98861e5058604e656e76d760ef",
    },
  });
  assert.equal(current.url, "https://jenkins.canvasmc.io/job/Canvas/1038/");
  assert.equal(provider.page("26.3", "1038"), current.url);

  const [legacy] = await provider.builds("1.21.11");
  assert.equal(legacy.id, "794");
  assert.equal(legacy.javaVersion, 21);
  assert.match(legacy.artifact.checksums.sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(await provider.builds("1.21.1"), []);
  assert.equal(
    provider.page("26.3", "794"),
    "https://canvasmc.io/downloads/canvas",
  );
  assert.equal(
    provider.page("26.3", "https://example.com/"),
    "https://canvasmc.io/downloads/canvas",
  );
});
