import { useEffect, useMemo, useState } from "react";
import type { AvatarRef } from "../db/repo";
import { loadProfilePhoto } from "../db/repo";

const palette = [
  "bg-[#C13B3A]",
  "bg-[#C77C2E]",
  "bg-[#2DA564]",
  "bg-[#336BA3]",
  "bg-[#6C5FC7]",
  "bg-[#C76DA2]",
  "bg-[#5B8A72]",
  "bg-[#D1753B]",
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

  useEffect(() => {
    let active = true;
    let objectUrl = "";

    const load = async () => {
      if (!avatarRef) {
        setUrl(null);
        return;
      }
      const blob = await loadProfilePhoto(avatarRef);
      if (!blob) return;
      objectUrl = URL.createObjectURL(blob);
      if (active) setUrl(objectUrl);
    };

    load();

    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [avatarRef]);

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
