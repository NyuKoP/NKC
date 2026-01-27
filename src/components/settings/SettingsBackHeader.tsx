import { ChevronLeft } from "lucide-react";

type SettingsBackHeaderProps = {
  title: string;
  backLabel: string;
  onBack: () => void;
};

export default function SettingsBackHeader({
  title,
  backLabel,
  onBack,
}: SettingsBackHeaderProps) {
  return (
    <div className="flex items-center justify-between">
      <button
        type="button"
        onClick={onBack}
        className="flex items-center gap-2 rounded-nkc border border-nkc-border px-3 py-2 text-xs text-nkc-text hover:bg-nkc-panel"
      >
        <ChevronLeft size={14} />
        {backLabel}
      </button>
      <span className="text-sm font-semibold text-nkc-text">{title}</span>
      <div className="w-12" />
    </div>
  );
}

