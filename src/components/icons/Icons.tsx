import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement> & {
  title?: string;
};

const createIcon =
  (path: string) =>
  ({ title, ...props }: IconProps) => (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={title ? undefined : true}
      role={title ? "img" : "presentation"}
      {...props}
    >
      {title ? <title>{title}</title> : null}
      <path d={path} />
    </svg>
  );

export const SearchIcon = createIcon(
  "M11 4a7 7 0 1 0 0 14a7 7 0 0 0 0-14Zm9 16-4.2-4.2"
);
export const SettingsIcon = createIcon(
  "M12 3v2M12 19v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M3 12h2M19 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4M12 8a4 4 0 1 0 0 8a4 4 0 0 0 0-8"
);
export const MessageIcon = createIcon(
  "M4 5h16v10H8l-4 4V5Z"
);
export const UsersIcon = createIcon(
  "M7 11a3 3 0 1 0-0.1 0ZM17 12a3 3 0 1 0-0.1 0ZM4 19c0-2.2 2-4 4.5-4S13 16.8 13 19M13 19c0-2 1.7-3.6 3.8-3.9"
);
export const PanelIcon = createIcon("M4 5h16M4 12h16M4 19h10");
export const CloseIcon = createIcon("M6 6l12 12M6 18L18 6");
export const EditIcon = createIcon("M4 20h4l10-10-4-4L4 16v4Z");
export const CopyIcon = createIcon(
  "M8 8h10v12H8zM6 4h10v2"
);
export const BackIcon = createIcon("M10 6 4 12l6 6M4 12h16");
export const MoreIcon = createIcon("M5 12h0.5M12 12h0.5M19 12h0.5");
