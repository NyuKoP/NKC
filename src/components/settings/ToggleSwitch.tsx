type ToggleSwitchProps = {
  label: string;
  checked: boolean;
  disabled?: boolean;
  testId?: string;
  onChange: (checked: boolean) => void;
};

export default function ToggleSwitch({
  label,
  checked,
  disabled = false,
  testId,
  onChange,
}: ToggleSwitchProps) {
  return (
    <label
      className={`inline-flex shrink-0 ${disabled ? "cursor-not-allowed" : "cursor-pointer"}`}
      data-testid={testId ? `${testId}-control` : undefined}
    >
      <input
        type="checkbox"
        className="peer sr-only"
        role="switch"
        aria-label={label}
        checked={checked}
        disabled={disabled}
        data-testid={testId}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span
        className="relative h-6 w-11 rounded-full bg-nkc-brandSoft transition-colors duration-200 after:absolute after:left-0.5 after:top-0.5 after:h-5 after:w-5 after:rounded-full after:bg-white after:shadow-sm after:transition-transform after:duration-200 after:content-[''] peer-checked:bg-nkc-brandAccent peer-checked:after:translate-x-5 peer-focus-visible:ring-2 peer-focus-visible:ring-nkc-brandDeep peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-nkc-panelMuted peer-disabled:opacity-45"
        data-testid={testId ? `${testId}-track` : undefined}
      />
    </label>
  );
}
