import type {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from "react";

export type BadgeTone =
  | "neutral"
  | "accent"
  | "caution"
  | "positive"
  | "danger";

export type ButtonVariant = "primary" | "secondary" | "quiet" | "danger";
export type ControlSize = "sm" | "md";

const VARIANTS: Record<ButtonVariant, string> = {
  primary:
    "bg-accent text-surface border border-accent hover:bg-accent-hover hover:border-accent-hover active:translate-y-px",
  secondary:
    "bg-surface text-ink border border-rule-strong hover:border-muted hover:bg-paper-sunk active:translate-y-px",
  quiet:
    "bg-transparent text-muted border border-transparent hover:text-ink hover:bg-paper-sunk active:translate-y-px",
  danger:
    "bg-transparent text-danger border border-danger-rule hover:bg-danger-soft active:translate-y-px",
};

// `sm` is the inspector density for the right-hand panels; `md` stays the
// default so full-page surfaces (unlock, recovery) keep their larger targets.
const BUTTON_SIZES: Record<ControlSize, string> = {
  sm: "min-h-8 gap-1.5 px-2.5",
  md: "min-h-11 gap-2 px-3.5",
};

export function Button({
  variant = "secondary",
  size = "md",
  icon,
  children,
  className = "",
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ControlSize;
  icon?: ReactNode;
}) {
  return (
    <button
      {...rest}
      className={`relative inline-flex items-center justify-center rounded-sm text-sm transition-[background-color,border-color,color,transform] duration-150 ease-out-quart after:absolute after:-inset-1 after:content-[''] disabled:cursor-not-allowed disabled:opacity-45 ${BUTTON_SIZES[size]} ${VARIANTS[variant]} ${className}`}
    >
      {icon}
      {children}
    </button>
  );
}

export function Field({
  label,
  error,
  children,
}: {
  label: string;
  error?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2">
      <span className="text-xs font-medium text-muted">{label}</span>
      {children}
      {error ? (
        <span role="alert" className="font-mono text-xs text-danger">
          {error}
        </span>
      ) : null}
    </div>
  );
}

const CONTROL_SIZES: Record<ControlSize, string> = {
  sm: "min-h-8 px-2 py-1 text-sm",
  md: "min-h-11 px-3 py-2 text-base",
};

const CONTROL =
  "w-full rounded-sm border border-rule-strong bg-surface transition-colors duration-150 ease-out-quart placeholder:text-faint hover:border-muted focus:border-accent disabled:cursor-not-allowed disabled:opacity-45";

export function Input({
  size = "md",
  className = "",
  ...rest
}: Omit<InputHTMLAttributes<HTMLInputElement>, "size"> & {
  size?: ControlSize;
}) {
  return (
    <input
      {...rest}
      className={`${CONTROL} ${CONTROL_SIZES[size]} ${className}`}
    />
  );
}

export function Textarea({
  size = "md",
  className = "",
  ...rest
}: TextareaHTMLAttributes<HTMLTextAreaElement> & { size?: ControlSize }) {
  return (
    <textarea
      {...rest}
      className={`${CONTROL} ${size === "sm" ? "min-h-20 px-2 py-1.5 text-sm" : "min-h-24 px-3 py-2 text-base"} ${className}`}
    />
  );
}

export function Select({
  size = "md",
  className = "",
  children,
  ...rest
}: Omit<SelectHTMLAttributes<HTMLSelectElement>, "size"> & {
  size?: ControlSize;
}) {
  return (
    <select
      {...rest}
      className={`${CONTROL} ${CONTROL_SIZES[size]} ${className}`}
    >
      {children}
    </select>
  );
}

/**
 * A compact ruled field. The inspector's structural unit: a micro label over a
 * full-width control, separated by hairlines. Stacks by design so it survives a
 * 280px panel without the two-column grid that broke the config tab.
 */
export function Row({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: string;
  error?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2 border-t border-rule py-2 first:border-t-0">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-xs font-medium text-ink">{label}</span>
        {hint ? (
          <span className="text-right text-xs leading-tight text-faint">
            {hint}
          </span>
        ) : null}
      </div>
      <div className="flex min-w-0 flex-col gap-2">
        {children}
        {error ? (
          <span role="alert" className="font-mono text-xs text-danger">
            {error}
          </span>
        ) : null}
      </div>
    </div>
  );
}

const BADGE_TONES: Record<BadgeTone, string> = {
  neutral: "border-rule text-faint",
  accent: "border-accent-rule text-accent",
  caution: "border-caution-rule text-caution",
  positive: "border-positive/40 text-positive",
  danger: "border-danger-rule text-danger",
};

const BADGE_SIZES: Record<ControlSize, string> = {
  sm: "px-1 py-px text-[10.5px]",
  md: "px-1.5 py-px text-xs tracking-[0.08em]",
};

export function Badge({
  tone = "neutral",
  title,
  children,
  size = "md",
}: {
  tone?: BadgeTone;
  title?: string;
  children: ReactNode;
  size?: ControlSize;
}) {
  return (
    <span
      title={title}
      className={`inline-flex shrink-0 items-center rounded-sm border ${BADGE_SIZES[size]} font-mono ${BADGE_TONES[tone]}`}
    >
      {children}
    </span>
  );
}

/**
 * A squared switch, not a pill: the app's one radius system is sharp, and a
 * rounded toggle would be the only soft shape on the page. The knob slides,
 * never the whole control.
 */
export function Toggle({
  checked,
  onCheckedChange,
  label,
  disabled,
}: {
  checked: boolean;
  onCheckedChange(checked: boolean): void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={() => onCheckedChange(!checked)}
      className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-sm border transition-colors duration-150 ease-out-quart after:absolute after:-inset-1.5 after:content-[''] disabled:cursor-not-allowed disabled:opacity-45 ${
        checked
          ? "border-accent bg-accent hover:border-accent-hover hover:bg-accent-hover"
          : "border-rule-strong bg-paper-sunk hover:border-muted"
      }`}
    >
      <span
        aria-hidden="true"
        className={`block size-3.5 rounded-sm border transition-transform duration-150 ease-out-quart ${
          checked
            ? "translate-x-[17px] border-accent-hover bg-surface"
            : "translate-x-[3px] border-rule bg-surface"
        }`}
      />
    </button>
  );
}

export function IconButton({
  label,
  onClick,
  tone = "default",
  disabled,
  children,
}: {
  label: string;
  onClick(): void;
  tone?: "default" | "danger";
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className={`relative inline-flex size-7 shrink-0 items-center justify-center rounded-sm text-muted transition-colors after:absolute after:-inset-1 after:content-[''] disabled:cursor-not-allowed disabled:opacity-45 ${
        tone === "danger"
          ? "hover:text-danger"
          : "hover:bg-paper-sunk hover:text-ink"
      }`}
    >
      {children}
    </button>
  );
}

/** A titled inspector section: micro label, optional count and header action. */
export function PanelSection({
  label,
  count,
  action,
  hint,
  children,
}: {
  label: string;
  count?: number;
  action?: ReactNode;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-2">
        <span className="flex min-w-0 items-baseline gap-1.5">
          <span className="label-micro">{label}</span>
          {count !== undefined ? (
            <span className="numeric font-mono text-xs text-faint">
              {count}
            </span>
          ) : null}
        </span>
        {action}
      </div>
      {hint ? (
        <p className="text-xs leading-relaxed text-faint">{hint}</p>
      ) : null}
      {children}
    </section>
  );
}

export function EmptyState({
  icon,
  title,
  hint,
  action,
}: {
  icon?: ReactNode;
  title: string;
  hint?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-sm border border-dashed border-rule px-3 py-5 text-center">
      {icon ? <span className="text-faint">{icon}</span> : null}
      <span className="text-xs text-muted">{title}</span>
      {hint ? (
        <span className="text-xs leading-relaxed text-faint">{hint}</span>
      ) : null}
      {action}
    </div>
  );
}
