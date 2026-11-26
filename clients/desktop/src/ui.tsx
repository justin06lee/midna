import type { ReactNode } from "react";
import { HELMET, HELMET_STROKE } from "./helmet";

// The few pieces every screen is built from, kept together so the app has
// one button rather than nine that are almost the same.

export function Button({
  children,
  onClick,
  variant = "default",
  size = "md",
  busy,
  disabled,
  title,
  icon,
  className = "",
  type = "button",
}: {
  children?: ReactNode;
  onClick?: () => void;
  variant?: "primary" | "default" | "ghost";
  size?: "sm" | "md" | "lg";
  busy?: boolean;
  disabled?: boolean;
  title?: string;
  icon?: ReactNode;
  className?: string;
  type?: "button" | "submit";
}) {
  // Capsules: the one to press in solid ink, the others on a wash of it.
  const variants = {
    primary: "bg-primary text-primary-ink hover:opacity-85 active:opacity-75",
    default: "bg-control text-ink hover:bg-control-hover active:bg-active",
    ghost: "bg-transparent text-ink-2 hover:bg-hover active:bg-active",
  }[variant];
  const sizes = {
    sm: "h-6 px-3 text-[12px] gap-1 rounded-full",
    md: "h-7 px-3.5 text-[13px] gap-1.5 rounded-full",
    lg: "h-9 px-5 text-[14px] gap-2 rounded-full",
  }[size];
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled || busy}
      title={title}
      className={`inline-flex shrink-0 items-center justify-center whitespace-nowrap transition-[background-color,filter,opacity] duration-150 disabled:opacity-40 ${variant === "primary" ? "font-medium" : ""} ${variants} ${sizes} ${className}`}
    >
      {busy ? <Spinner /> : icon}
      {children}
    </button>
  );
}

export function Spinner({ className = "" }: { className?: string }) {
  return (
    <svg className={`spin size-3.5 ${className}`} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.2" strokeWidth="2.5" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
    </svg>
  );
}

/** midna's mark: the helmet. */
export function Mark({ className = "size-5" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 100 100" aria-hidden="true">
      <path d={HELMET} transform="translate(0 1.75)" fill="currentColor" stroke="currentColor" strokeWidth={HELMET_STROKE} strokeLinejoin="round" />
    </svg>
  );
}

/**
 * State by shape first: a solid dot is running (green, as the system marks
 * what is on), a ring is reachable, a cross is unreachable, a spinner is
 * working on it.
 */
export function StateMark({ state }: { state: "running" | "online" | "offline" | "working" }) {
  if (state === "working") return <Spinner className="size-3" />;
  return (
    <svg className="size-3 shrink-0" viewBox="0 0 12 12" aria-hidden="true">
      {state === "running" && <circle cx="6" cy="6" r="4" fill="var(--ok)" />}
      {state === "online" && <circle cx="6" cy="6" r="3.5" fill="none" stroke="currentColor" strokeWidth="1.3" />}
      {state === "offline" && <path d="M3.5 3.5l5 5M8.5 3.5l-5 5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />}
    </svg>
  );
}

export function Segmented<T extends string>({ value, options, onChange, disabled }: { value: T; options: Array<{ value: T; label: string }>; onChange: (v: T) => void; disabled?: boolean }) {
  return (
    <div role="radiogroup" className={`inline-flex rounded-full bg-control p-0.5 ${disabled ? "opacity-50" : ""}`}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          disabled={disabled}
          onClick={() => onChange(o.value)}
          className={`h-6 rounded-full px-3 text-[12.5px] transition-[background-color,box-shadow] duration-150 ${o.value === value ? "bg-knob font-medium text-ink shadow-[0_0_0_0.5px_rgba(0,0,0,0.06),0_1px_2px_rgba(0,0,0,0.14)]" : "text-ink-2"}`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** On or off, as a switch: for a setting that takes effect at once. */
export function Switch({ on, onChange, disabled, label }: { on: boolean; onChange: (on: boolean) => void; disabled?: boolean; label?: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!on)}
      className={`relative h-[20px] w-[34px] shrink-0 rounded-full transition-colors duration-200 disabled:opacity-40 ${on ? "bg-accent" : "bg-active"}`}
    >
      <span className={`absolute top-[2px] left-[2px] size-4 rounded-full bg-white shadow-[0_1px_2px_rgba(0,0,0,0.25)] transition-transform duration-200 ${on ? "translate-x-[14px]" : ""}`} />
    </button>
  );
}

export function Section({ title, aside, footer, children, className = "" }: { title?: string; aside?: ReactNode; footer?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={className}>
      {(title || aside) && (
        <div className="mb-2 flex items-baseline justify-between gap-3 px-1.5">
          {title && <h2 className="text-[12px] font-medium text-dim">{title}</h2>}
          {aside}
        </div>
      )}
      {children}
      {footer && <p className="mt-1.5 px-3 text-[11.5px] leading-[1.4] text-dim">{footer}</p>}
    </section>
  );
}

/** A group of rows on one toned surface, a hairline between them and no line round it. */
export function Group({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`sheet divide-y divide-line overflow-hidden rounded-[14px] ${className}`}>{children}</div>;
}

/** One row of a Group: what it is on the left (with a line under it, if it needs one), its control on the right. */
export function Row({ label, note, children, top }: { label: ReactNode; note?: ReactNode; children?: ReactNode; top?: boolean }) {
  return (
    <div className={`flex min-h-[44px] gap-3 px-3.5 py-2.5 ${top ? "items-start" : "items-center"}`}>
      <div className="min-w-0 flex-1">
        <div className="text-[13px]">{label}</div>
        {note && <div className="mt-0.5 text-[11.5px] leading-[1.4] text-dim">{note}</div>}
      </div>
      {children && <div className="flex shrink-0 items-center gap-2">{children}</div>}
    </div>
  );
}

/** A line across the top of a screen that says something is up, with what to do about it. */
export function Banner({ children, actions, busy }: { children: ReactNode; actions?: ReactNode; busy?: boolean }) {
  return (
    <div role="status" className="rise mx-6 mb-2 flex items-center gap-3 rounded-[14px] bg-fill py-2 pr-2 pl-3.5 text-[12.5px]">
      {busy && <Spinner className="shrink-0 text-dim" />}
      <span className="min-w-0 flex-1">{children}</span>
      {actions}
    </div>
  );
}

/** Waiting on midna — or, if it didn't answer, saying so with a way to try again. */
export function Loading({ error, onRetry }: { error?: string | null; onRetry?: () => void }) {
  if (error)
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
        <p className="selectable max-w-[380px] text-[13px] text-dim">{error}</p>
        {onRetry && (
          <Button size="sm" onClick={onRetry} icon={<Icon name="refresh" className="size-3.5" />}>
            Try again
          </Button>
        )}
      </div>
    );
  return (
    <div className="flex h-full items-center justify-center gap-2 text-dim">
      <Spinner /> Loading…
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="px-3 py-2.5 text-[12.5px] text-dim">{children}</p>;
}

export function Icon({ name, className = "size-4" }: { name: "chat" | "today" | "goals" | "settings" | "send" | "back" | "refresh" | "copy" | "external" | "terminal" | "check" | "cross" | "file" | "image" | "paperclip" | "download" | "folder" | "computer" | "pause" | "key" | "money" | "plus" | "chevron" | "updown" | "stop"; className?: string }) {
  const paths: Record<typeof name, ReactNode> = {
    chat: <path d="M4 5.5A2.5 2.5 0 0 1 6.5 3h7A2.5 2.5 0 0 1 16 5.5v5a2.5 2.5 0 0 1-2.5 2.5H9l-3.5 3v-3h0A1.5 1.5 0 0 1 4 11.5z" />,
    today: (
      <>
        <rect x="3.5" y="4.5" width="13" height="12" rx="2.5" />
        <path d="M3.5 8.5h13M7 3v3M13 3v3" />
      </>
    ),
    goals: (
      <>
        <circle cx="10" cy="10" r="6.5" />
        <circle cx="10" cy="10" r="3.5" />
        <circle cx="10" cy="10" r="0.6" fill="currentColor" />
      </>
    ),
    settings: (
      <>
        <path d="M4 6h7M14 6h2M4 14h2M9 14h7" />
        <circle cx="12.5" cy="6" r="1.5" />
        <circle cx="7.5" cy="14" r="1.5" />
      </>
    ),
    send: <path d="M10 15.5v-11M5.5 9 10 4.5 14.5 9" />,
    computer: (
      <>
        <rect x="3.5" y="4" width="13" height="9" rx="1.8" />
        <path d="M7.5 16.5h5M10 13v3.5" />
      </>
    ),
    pause: <path d="M7.5 5v10M12.5 5v10" />,
    key: (
      <>
        <circle cx="7" cy="12.5" r="3.25" />
        <path d="m9.4 10.2 6.1-6.1M13.5 6.1l1.9 1.9M11.6 8l1.4 1.4" />
      </>
    ),
    money: (
      <>
        <rect x="2.75" y="5.5" width="14.5" height="9" rx="2" />
        <circle cx="10" cy="10" r="2" />
        <path d="M5.5 10h.01M14.5 10h.01" />
      </>
    ),
    plus: <path d="M10 4.5v11M4.5 10h11" />,
    chevron: <path d="m7.5 5 5 5-5 5" />,
    updown: <path d="m6.5 8 3.5-3.5L13.5 8M6.5 12l3.5 3.5 3.5-3.5" />,
    stop: <rect x="6" y="6" width="8" height="8" rx="1.5" fill="currentColor" stroke="none" />,
    back: <path d="M11.5 5 6.5 10l5 5" />,
    refresh: <path d="M15.5 10a5.5 5.5 0 1 1-1.6-3.9M15.5 4v3h-3" />,
    copy: (
      <>
        <rect x="7" y="7" width="9" height="9" rx="2" />
        <path d="M13 7V5.5A1.5 1.5 0 0 0 11.5 4h-6A1.5 1.5 0 0 0 4 5.5v6A1.5 1.5 0 0 0 5.5 13H7" />
      </>
    ),
    external: <path d="M8 4.5H5.5a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1V12M11 4.5h4.5V9M15.5 4.5 9 11" />,
    terminal: (
      <>
        <rect x="3" y="4" width="14" height="12" rx="2.5" />
        <path d="m6.5 8 2 2-2 2M10.5 12.5h3" />
      </>
    ),
    check: <path d="m5 10.5 3 3 7-7" />,
    cross: <path d="m6 6 8 8M14 6l-8 8" />,
    file: <path d="M6 3.5h5L15 7.5v8a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-11a1 1 0 0 1 1-1zM10.5 3.5v4.5H15" />,
    image: (
      <>
        <rect x="3.5" y="4.5" width="13" height="11" rx="2" />
        <circle cx="7.5" cy="8.5" r="1.25" />
        <path d="m4 14 4-3.5 3 2.5 2-1.5 3.5 2.5" />
      </>
    ),
    paperclip: <path d="m15.5 9.5-5.6 5.6a3.4 3.4 0 0 1-4.8-4.8l6-6a2.25 2.25 0 0 1 3.2 3.2l-5.9 5.9a1.1 1.1 0 0 1-1.6-1.6l5.3-5.3" />,
    download: <path d="M10 3.5v9M6 8.5l4 4 4-4M4.5 16h11" />,
    folder: <path d="M3.5 6A1.5 1.5 0 0 1 5 4.5h3.2l1.6 1.8H15A1.5 1.5 0 0 1 16.5 7.8v6.7A1.5 1.5 0 0 1 15 16H5a1.5 1.5 0 0 1-1.5-1.5z" />,
  };
  return (
    <svg className={className} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {paths[name]}
    </svg>
  );
}
