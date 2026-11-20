const ci = "https://ci.pufferfish.host/job";

// Pufferfish's Jenkins archives have no publisher checksum. Pin selected builds
// after matching the raw JAR to its copy in the same numbered Jenkins build's
// artifact ZIP and checking the Minecraft release in the build's source commit.
// Keep the exact artifact paths because they changed between upstream builds.
const verifiedBuilds = [
  {
    version: "1.21.10",
    build: "39",
    javaVersion: 21,
    publishedAt: "2025-12-21T17:30:13.765Z",
    artifactPath:
      "pufferfish-server/build/libs/pufferfish-paperclip-1.21.10-R0.1-SNAPSHOT-mojmap.jar",
    sha256: "2e5d8a27f62086948590dd8d7e36761f0c80a0dfb85820e34714d795ca3f99aa",
  },
  {
    version: "1.21.8",
    build: "33",
    javaVersion: 21,
    publishedAt: "2025-09-14T20:50:11.767Z",
    artifactPath:
      "pufferfish-server/build/libs/pufferfish-paperclip-1.21.8-R0.1-SNAPSHOT-mojmap.jar",
    sha256: "4dd5cc297217cc91aa85ee52a240f6df5a7b78eebc1f91d64652cabea3141f47",
  },
  {
    version: "1.21.7",
    build: "30",
    javaVersion: 21,
    publishedAt: "2025-07-12T01:57:10.428Z",
    artifactPath:
      "pufferfish-server/build/libs/pufferfish-paperclip-1.21.7-R0.1-SNAPSHOT-mojmap.jar",
    sha256: "61485966598cd21ce3dbd5996d90db6a8c7a148168b86d1c38b86314b2e49323",
  },
  {
    version: "1.21.3",
    build: "27",
    javaVersion: 21,
    publishedAt: "2024-12-04T01:50:29.673Z",
    artifactPath:
      "build/libs/pufferfish-paperclip-1.21.3-R0.1-SNAPSHOT-mojmap.jar",
    sha256: "7cb6662883690ffa97dff1d4ea179e32e4f821d0818a5101d9142f29dab0bb73",
  },
  {
    version: "1.21.1",
    build: "21",
    javaVersion: 21,
    publishedAt: "2024-10-22T23:07:39.114Z",
    artifactPath:
      "build/libs/pufferfish-paperclip-1.21.1-R0.1-SNAPSHOT-mojmap.jar",
    sha256: "c5db4e8d12bdedfee3bd7a1bd2530af989dd32d4c39026da5875f7cf88dcdec9",
  },
  {
    version: "1.21",
    build: "7",
    javaVersion: 21,
    publishedAt: "2024-08-08T23:19:40.761Z",
    artifactPath:
      "build/libs/pufferfish-paperclip-1.21-R0.1-SNAPSHOT-mojmap.jar",
    sha256: "15c5b98af903b54fb3ee1a4c93e630f8a0cab26f6eb6cde3a8cb15f5621ef976",
  },
  {
    version: "1.20.4",
    build: "52",
    javaVersion: 17,
    publishedAt: "2024-07-06T05:37:00.329Z",
    artifactPath:
      "build/libs/pufferfish-paperclip-1.20.4-R0.1-SNAPSHOT-reobf.jar",
    sha256: "47dec87ea82c4ebc8b9c1308068862b8d5841e9c28479c1c78051b21b18144d2",
  },
  {
    version: "1.19.4",
    build: "73",
    javaVersion: 17,
    publishedAt: "2023-06-06T17:40:20.016Z",
    artifactPath:
      "build/libs/pufferfish-paperclip-1.19.4-R0.1-SNAPSHOT-reobf.jar",
    sha256: "ef0758ada81d4a4a026dd8acc9392e5d383977bb5a8df22b43ab1130d60d8625",
  },
  {
    version: "1.18.2",
    build: "72",
    javaVersion: 17,
    publishedAt: "2022-06-18T02:55:07.429Z",
    artifactPath:
      "build/libs/pufferfish-paperclip-1.18.2-R0.1-SNAPSHOT-reobf.jar",
    sha256: "5be9750592b1c2ea7a60b0c72da1be8ee2a364cb29503065cb092720142d9550",
  },
  {
    version: "1.17.1",
    build: "22",
    javaVersion: 16,
    publishedAt: "2022-04-04T03:20:03.232Z",
    artifactPath: "build/libs/Pufferfish-1.17.1-R0.1-SNAPSHOT.jar",
    sha256: "d245f1fb71a1a68930967dd3f95dbf1d0b1ecec4f267d1300af8e15a07f17a13",
  },
];

function buildPage({ version, build }) {
  const series = version.split(".").slice(0, 2).join(".");
  return `${ci}/Pufferfish-${series}/${build}/`;
}

export function createPufferfishProvider() {
  return {
    async versions() {
      return verifiedBuilds.map((entry) => ({
        id: entry.version,
        label: entry.version,
        stable: true,
        url: buildPage(entry),
      }));
    },

    async builds(version) {
      return verifiedBuilds
        .filter((entry) => entry.version === version)
        .map((entry) => {
          const url = buildPage(entry);
          return {
            id: entry.build,
            label: `Build ${entry.build}`,
            stable: true,
            publishedAt: entry.publishedAt,
            javaVersion: entry.javaVersion,
            url,
            artifact: {
              url: `${url}artifact/${entry.artifactPath}`,
              checksums: { sha256: entry.sha256 },
            },
          };
        });
    },

    page(version, build) {
      const entry = verifiedBuilds.find(
        (entry) =>
          entry.version === version &&
          (build === undefined || entry.build === build),
      );
      return entry ? buildPage(entry) : undefined;
    },
  };
}
