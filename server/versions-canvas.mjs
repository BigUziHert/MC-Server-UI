const jenkins = "https://jenkins.canvasmc.io/job/Canvas";
const downloads = "https://canvasmc.io/downloads/canvas";

// Canvas publishes version and CI metadata without artifact checksums. These
// pins were taken from byte-identical copies served by the exact Jenkins build's
// direct JAR and ZIP archive routes. The archived source revisions and each
// JAR's embedded Minecraft version were checked against the official catalog.
const builds = new Map([
  [
    "26.3",
    {
      id: "1038",
      publishedAt: "2026-11-19T21:27:26.462Z",
      javaVersion: 25,
      sha256:
        "77485bd48c80a6dd0d798816c3385efc5a1d1a98861e5058604e656e76d760ef",
    },
  ],
  [
    "26.2",
    {
      id: "994",
      publishedAt: "2026-10-28T08:18:17.560Z",
      javaVersion: 25,
      sha256:
        "8c4e36c0545a4e8d3332c6c0d6dce922001fd986ff47deec4b93fd26ba0de2b2",
    },
  ],
  [
    "26.1.2",
    {
      id: "876",
      publishedAt: "2026-07-25T21:42:33.175Z",
      javaVersion: 25,
      sha256:
        "f139a1f169f7177ced831ba92c688b9b249ff19e2310d7d68797fa8a4eaec279",
    },
  ],
  [
    "1.21.11",
    {
      id: "794",
      publishedAt: "2026-06-06T14:11:47.135Z",
      javaVersion: 21,
      sha256:
        "8b1443a57d55bb5b5aa85041acfaad67ecfdd3823c4869d478267bff5c5dff74",
    },
  ],
  [
    "1.21.8",
    {
      id: "603",
      publishedAt: "2025-12-29T18:22:42.939Z",
      javaVersion: 21,
      sha256:
        "6577181e4bc8ac40a7a48ff00e262f2ac7a798f48ada446a07eb06618dc36f1b",
    },
  ],
]);

export function createCanvasProvider() {
  return {
    async versions() {
      return [...builds.keys()].map((id) => ({
        id,
        label: id,
        stable: true,
        url: downloads,
      }));
    },
    async builds(version) {
      const build = builds.get(version);
      if (!build) return [];
      const { id, publishedAt, javaVersion, sha256 } = build;
      const url = `${jenkins}/${id}/`;
      return [
        {
          id,
          label: `Build ${id}`,
          stable: true,
          publishedAt,
          javaVersion,
          url,
          artifact: {
            url: `${url}artifact/canvas-server/build/libs/canvas-build.${id}.jar`,
            checksums: { sha256 },
          },
        },
      ];
    },
    page(version, build) {
      return build && builds.get(version)?.id === build
        ? `${jenkins}/${build}/`
        : downloads;
    },
  };
}
