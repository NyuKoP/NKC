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
export const SettingsIcon = ({ title, ...props }: IconProps) => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden={title ? undefined : true}
    role={title ? "img" : "presentation"}
    {...props}
  >
    {title ? <title>{title}</title> : null}
    <path d="M9.7 3.2h4.6l.5 2.1c.5.2 1 .4 1.4.8l2-.7 2.3 4-1.6 1.5a6 6 0 0 1 0 2.2l1.6 1.5-2.3 4-2-.7c-.4.4-.9.6-1.4.8l-.5 2.1H9.7l-.5-2.1c-.5-.2-1-.4-1.4-.8l-2 .7-2.3-4 1.6-1.5a6 6 0 0 1 0-2.2L3.5 9.4l2.3-4 2 .7c.4-.4.9-.6 1.4-.8l.5-2.1Z" />
    <circle cx="12" cy="12" r="3" />
  </svg>
);
export const MessageIcon = createIcon(
  "M4 5h16v10H8l-4 4V5Z"
);
export const UsersIcon = createIcon(
  "M7 11a3 3 0 1 0-0.1 0ZM17 12a3 3 0 1 0-0.1 0ZM4 19c0-2.2 2-4 4.5-4S13 16.8 13 19M13 19c0-2 1.7-3.6 3.8-3.9"
);
export const PanelIcon = createIcon("M4 5h16M4 12h16M4 19h10");
export const SunIcon = createIcon(
  "M12 3v2M12 19v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M3 12h2M19 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0"
);
export const MoonIcon = createIcon(
  "M19.5 15.2A8 8 0 0 1 8.8 4.5 8 8 0 1 0 19.5 15.2Z"
);
export const CloseIcon = createIcon("M6 6l12 12M6 18L18 6");
export const EditIcon = createIcon("M4 20h4l10-10-4-4L4 16v4Z");
export const CopyIcon = createIcon(
  "M8 8h10v12H8zM6 4h10v2"
);
export const BackIcon = createIcon("M10 6 4 12l6 6M4 12h16");
export const MoreIcon = createIcon("M5 12h0.5M12 12h0.5M19 12h0.5");
export const LockIcon = createIcon(
  "M7 11V8.5a5 5 0 0 1 10 0V11M6 11h12v9H6zM12 15v2"
);
export const KeyIcon = createIcon(
  "M14.5 9.5a4.5 4.5 0 1 1-1.3-3.2 4.5 4.5 0 0 1 1.3 3.2ZM13 13l7 7M17 17l2-2M15 15l-2 2"
);
export const AddFriendIcon = createIcon(
  "M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7ZM3.5 20c.3-3.6 2.3-5.5 5.5-5.5 1.5 0 2.7.4 3.6 1.2M17 12v8M13 16h8"
);
export const GroupIcon = createIcon(
  "M8 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM17 12a2.5 2.5 0 1 0 0-5M3 20c.3-3.6 2.2-5.5 5-5.5s4.7 1.9 5 5.5M14 15c3.5-.8 6.5 1 7 4.5"
);
