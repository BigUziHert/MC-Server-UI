import { useState } from "react";
import "./player-head.css";

type PlayerHeadProps = {
  name: string;
  uuid?: string;
  size?: number;
};

const defaultHead = "/player-head-fallback.svg";
const minecraftUuid =
  /^(?:[a-f0-9]{32}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/i;

export default function PlayerHead({ name, uuid, size = 32 }: PlayerHeadProps) {
  const identifier =
    uuid && minecraftUuid.test(uuid)
      ? uuid
      : /^[A-Za-z0-9_]{3,16}$/.test(name)
        ? name
        : null;
  const source = identifier
    ? `https://mc-heads.net/avatar/${encodeURIComponent(identifier)}/64`
    : defaultHead;
  // Remember which request failed so changing players immediately loads their skin.
  const [failedSource, setFailedSource] = useState<string | null>(null);
  const fallback = source === defaultHead || failedSource === source;

  return (
    <img
      key={source}
      className="player-head"
      src={fallback ? defaultHead : source}
      alt={`${name}'s Minecraft head${fallback ? " (default)" : ""}`}
      title={fallback ? `${name} · Default head` : name}
      width={size}
      height={size}
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
      draggable={false}
      onError={() => {
        if (!fallback) setFailedSource(source);
      }}
    />
  );
}
