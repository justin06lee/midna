import type { ReactNode } from "react";

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
  const variants = {
    primary: "bg-primary text-primary-ink border-transparent hover:opacity-90 active:opacity-80",
    default: "bg-panel text-ink border-line-2 hover:bg-sunken active:bg-active shadow-[0_1px_1px_rgba(0,0,0,0.03)]",
    ghost: "bg-transparent text-dim border-transparent hover:bg-hover hover:text-ink active:bg-active",
  }[variant];
  const sizes = {
    sm: "h-7 px-2.5 text-[12.5px] gap-1.5 rounded-[7px]",
    md: "h-8 px-3 text-[13px] gap-1.5 rounded-lg",
    lg: "h-10 px-4 text-[14px] gap-2 rounded-[10px]",
  }[size];
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled || busy}
      title={title}
      className={`no-drag inline-flex shrink-0 items-center justify-center border font-medium whitespace-nowrap transition-[background-color,opacity,color,border-color] duration-150 disabled:opacity-40 ${variants} ${sizes} ${className}`}
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

/** midna's crescent. */
export function Mark({ className = "size-5" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 44 44" aria-hidden="true">
      <mask id="mark-bite">
        <rect width="44" height="44" fill="white" />
        <circle cx="27.3" cy="18.5" r="12.9" fill="black" />
      </mask>
      <circle cx="21" cy="23" r="15" fill="currentColor" mask="url(#mark-bite)" />
      <circle cx="33" cy="11" r="2.4" fill="currentColor" />
    </svg>
  );
}

/**
 * State by shape, not colour: a solid dot is running, a ring is reachable,
 * a cross is unreachable, a spinner is working on it.
 */
export function StateMark({ state }: { state: "running" | "online" | "offline" | "working" }) {
  if (state === "working") return <Spinner className="size-3" />;
  return (
    <svg className="size-3 shrink-0" viewBox="0 0 12 12" aria-hidden="true">
      {state === "running" && <circle cx="6" cy="6" r="4" fill="currentColor" />}
      {state === "online" && <circle cx="6" cy="6" r="3.5" fill="none" stroke="currentColor" strokeWidth="1.3" />}
      {state === "offline" && <path d="M3.5 3.5l5 5M8.5 3.5l-5 5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />}
    </svg>
  );
}

export function Segmented<T extends string>({ value, options, onChange, disabled }: { value: T; options: Array<{ value: T; label: string }>; onChange: (v: T) => void; disabled?: boolean }) {
  return (
    <div className="inline-flex rounded-lg border border-line-2 bg-sunken p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          disabled={disabled}
          onClick={() => onChange(o.value)}
          className={`h-7 rounded-md px-3 text-[12.5px] font-medium transition-colors ${o.value === value ? "bg-panel text-ink shadow-[0_0_0_1px_var(--line-2)]" : "text-dim hover:text-ink"}`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Section({ title, aside, children, className = "" }: { title: string; aside?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={className}>
      <div className="mb-2 flex items-baseline justify-between gap-3 px-1">
        <h2 className="text-[11.5px] font-medium tracking-wide text-dim uppercase">{title}</h2>
        {aside}
      </div>
      {children}
    </section>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="px-1 py-2 text-[12.5px] text-dimmer">{children}</p>;
}

export function Icon({ name, className = "size-4" }: { name: "chat" | "today" | "goals" | "settings" | "send" | "back" | "refresh" | "copy" | "external" | "terminal" | "check" | "cross"; className?: string }) {
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
  };
  return (
    <svg className={className} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {paths[name]}
    </svg>
  );
}
