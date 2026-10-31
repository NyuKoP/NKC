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
    <div className="settings-back-header">
      <button
        type="button"
        data-testid="settings-back-button"
        onClick={onBack}
        className="flex items-center gap-2 rounded-nkc border border-nkc-border px-3 py-2 text-xs text-nkc-text hover:bg-nkc-panel"
      >
        <ChevronLeft size={14} />
        {backLabel}
      </button>
      <h2 className="text-base font-semibold text-nkc-text">{title}</h2>

    </div>
  );
}
