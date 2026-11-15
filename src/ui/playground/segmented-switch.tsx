export function SegmentedSwitch<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: readonly { value: T; label: string }[];
  onChange(value: T): void;
}) {
  return (
    <div role="group" aria-label={label} className="flex overflow-hidden rounded-sm border border-rule">
      {options.map((option, index) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={value === option.value}
          onClick={() => onChange(option.value)}
          className={`relative px-2.5 py-1 font-mono text-xs transition-colors duration-150 ease-out-quart after:absolute after:-inset-1 after:content-[''] ${
            index > 0 ? "border-l border-rule" : ""
          } ${value === option.value ? "bg-accent-soft text-accent" : "text-muted hover:bg-paper-sunk hover:text-ink"}`}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
