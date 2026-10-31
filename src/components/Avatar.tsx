import { useEffect, useMemo, useState } from "react";
import type { AvatarRef } from "../db/repo";
import { loadProfilePhoto } from "../db/repo";

const palette = [
  "bg-[#C13B3A]",
  "bg-[#A36422]",
  "bg-[#218752]",
  "bg-[#336BA3]",
  "bg-[#6C5FC7]",
  "bg-[#A95B89]",
  "bg-[#527D66]",
  "bg-[#B16131]",
];

const getInitials = (name: string) => {
  const trimmed = name.trim();

  if (!trimmed) return "NK";
  const parts = trimmed.split(/\s+/);

  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();

  return (parts[0][0] + parts[1][0]).toUpperCase();
};

const pickColor = (name: string) => {
  let hash = 0;

  for (let i = 0; i < name.length; i += 1) {
    hash = (hash + name.charCodeAt(i) * 17) % palette.length;
  }

  return palette[hash];
};

type AvatarProps = {
  name: string;
  colorKey?: string;
  avatarRef?: AvatarRef;
  size?: number;
  className?: string;
};

export default function Avatar({ name, colorKey, avatarRef, size = 40, className }: AvatarProps) {
  const [url, setUrl] = useState<string | null>(null);
  const initials = useMemo(() => getInitials(name), [name]);
  const bgClass = useMemo(() => pickColor(colorKey || name), [colorKey, name]);
  const avatarOwnerType = avatarRef?.ownerType;
  const avatarOwnerId = avatarRef?.ownerId;
  const avatarMime = avatarRef?.mime;
  const avatarTotal = avatarRef?.total;
  const avatarChunkSize = avatarRef?.chunkSize;
  const avatarRevision = avatarRef?.revision;

  useEffect(() => {
    let active = true;
    let objectUrl = "";

    const load = async () => {
      setUrl(null);

      if (
        !avatarOwnerType ||
        !avatarOwnerId ||
        !avatarMime ||
        avatarTotal === undefined ||
        avatarChunkSize === undefined
      ) {
        return;
      }

      const blob = await loadProfilePhoto({
        ownerType: avatarOwnerType,
        ownerId: avatarOwnerId,
        mime: avatarMime,
        total: avatarTotal,
        chunkSize: avatarChunkSize,
      });

      if (!blob) return;
      const nextUrl = URL.createObjectURL(blob);

      if (!active) {
        URL.revokeObjectURL(nextUrl);

        return;
      }

      objectUrl = nextUrl;
      setUrl(nextUrl);
    };

    load();

    return () => {
      active = false;

      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [avatarChunkSize, avatarMime, avatarOwnerId, avatarOwnerType, avatarTotal, avatarRevision]);

  return (
    <div
      className={`relative flex items-center justify-center overflow-hidden rounded-full text-xs font-semibold text-white ${bgClass} ${className || ""}`}
      style={{ width: size, height: size }}
    >
      {url ? (
        <img src={url} alt={name} className="h-full w-full object-cover" />
      ) : (
        <span>{initials}</span>
      )}
    </div>
  );
}
