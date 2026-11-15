const channels = ["release", "beta", "alpha"];

export const normalizeChannel = (value) =>
  channels.includes(value) ? value : undefined;

export const isUpdateChannel = (value) =>
  value === "installed" || channels.includes(value);

// Unknown installed metadata is conservative. A filename containing "alpha"
// is not evidence of the publisher's release channel.
export function allowedUpdateChannels(policy = "installed", installedChannel) {
  const ceiling =
    policy === "installed"
      ? (normalizeChannel(installedChannel) ?? "release")
      : (normalizeChannel(policy) ?? "release");
  return channels.slice(0, channels.indexOf(ceiling) + 1);
}
