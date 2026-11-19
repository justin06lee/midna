import { useEffect, useRef, useState } from "react";
import { accountChoices, modelGroups, providersInUse, thinkingWith, type Account, type BrainInfo, type BrainModel, type MidnaClient, type ModelChoice, type Status } from "@midna/protocol";
import { Icon, Spinner } from "./ui";

/**
 * What the host can think with: its installed brains, and each one's own list
 * of models. The brains the host is set to (the model, a stand-in, the
 * fallbacks) are asked at once, so what is thinking is called by the name
 * its brain gives it; the rest once `wanted`. `unlisted` are the brains that
 * gave no list: a host before 0.13.7 has no way to ask, and then only what
 * the host itself names is offered.
 */
export function useModels(client: MidnaClient, status: Status | null, wanted: boolean) {
  const [brains, setBrains] = useState<BrainInfo[]>([]);
  const [catalogues, setCatalogues] = useState<Record<string, BrainModel[]>>({});
  const [unlisted, setUnlisted] = useState<Record<string, boolean>>({});
  useEffect(() => {
    void client.brains().then(setBrains, () => {});
  }, [client]);
  const account = status?.account;
  const inUse = status ? providersInUse(status, brains).join(",") : "";
  useEffect(() => {
    const abort = new AbortController();
    for (const b of brains) {
      if (!b.installed || b.id === "hermes" || !(wanted || inUse.split(",").includes(b.id))) continue;
      void client.brainModels(b.id, b.id === "claude" ? account : undefined, abort.signal).then(
        (m) => {
          setCatalogues((c) => ({ ...c, [b.id]: m }));
          setUnlisted((u) => ({ ...u, [b.id]: false }));
        },
        () => abort.signal.aborted || setUnlisted((u) => ({ ...u, [b.id]: true })),
      );
    }
    return () => abort.abort();
  }, [client, brains, account, inUse, wanted]);
  return { brains, catalogues, unlisted };
}

/**
 * The model midna thinks with, as a pop-up button: it says what is thinking
 * now, and its menu switches the model and the Claude account. A change is
 * the host's setting, so every device sees it, and it holds from midna's
 * next turn.
 */
export function ModelMenu({ client, status, onStatus, look = "quiet", drop = "up" }: { client: MidnaClient; status: Status | null; onStatus: (s: Status) => void; look?: "quiet" | "button"; drop?: "up" | "down" }) {
  const [open, setOpen] = useState(false);
  const [asked, setAsked] = useState(false);
  const { brains, catalogues, unlisted } = useModels(client, status, asked);
  const [more, setMore] = useState<Record<string, boolean>>({});
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);

  // Opened: what is set may have changed on another device since this window last asked.
  useEffect(() => {
    if (open) void client.status().then(onStatus, () => {});
    // Only when it opens: onStatus is a new function every render.
  }, [open, client]);

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => !root.current?.contains(e.target as Node) && setOpen(false);
    const key = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", key);
    };
  }, [open]);

  if (!status) return null;
  const now = thinkingWith(status, brains, catalogues);
  const groups = modelGroups(status, brains, catalogues);
  const accounts = accountChoices(status);

  const save = async (what: string, patch: { model?: string; account?: Account }) => {
    setSaving(what);
    setError(null);
    try {
      onStatus(await client.updateSettings(patch));
      setOpen(false);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(null);
    }
  };

  const row = "group/item flex w-full items-center gap-1.5 rounded-[6px] pr-2.5 pl-1.5 text-left text-[13px] hover:bg-accent hover:text-white";
  const mark = (key: string, selected: boolean) => <span className="flex w-4 shrink-0 justify-center">{saving === key ? <Spinner className="size-3" /> : selected && <Icon name="check" className="size-3.5" />}</span>;
  // A model: its name as its brain gives it; in the tooltip, what the brain says of it and the model an alias stands for.
  const model = (c: ModelChoice) => (
    <button key={c.ref} type="button" role="menuitemradio" aria-checked={c.selected} title={c.detail} disabled={saving !== null} onClick={() => (c.selected ? setOpen(false) : void save(c.ref, { model: c.ref }))} className={`${row} h-7`}>
      {mark(c.ref, c.selected)}
      <span className="min-w-0 flex-1 truncate">{c.name}</span>
      {c.note && <span className="shrink-0 text-[11.5px] text-dim group-hover/item:text-white/80">{c.note}</span>}
    </button>
  );

  return (
    <div ref={root} className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        title={now.standIn ? `${now.standIn}; thinking with ${now.name} meanwhile` : "The model midna thinks with"}
        onClick={() => {
          setAsked(true);
          setError(null);
          setOpen((v) => !v);
        }}
        className={
          look === "button"
            ? "flex h-7 max-w-[260px] items-center gap-1.5 rounded-[7px] bg-control pr-1.5 pl-2.5 text-[13px] hover:bg-control-hover"
            : `flex h-7 max-w-[240px] items-center gap-1 rounded-[7px] pr-1 pl-2 text-[12.5px] text-dim hover:bg-hover hover:text-ink ${open ? "bg-hover text-ink" : ""}`
        }
      >
        <span className="truncate">{now.name}</span>
        {look === "quiet" && now.account && <span className="shrink-0 text-dimmer capitalize">{now.account}</span>}
        <Icon name="updown" className="size-3.5 shrink-0 opacity-70" />
      </button>

      {open && (
        <div role="menu" className={`material absolute right-0 z-50 max-h-[min(70vh,520px)] w-[272px] overflow-y-auto rounded-[12px] p-1.5 ${drop === "up" ? "bottom-full mb-1.5" : "top-full mt-1.5"}`}>
          {(now.standIn || error) && <p className="selectable px-2.5 pt-1 pb-1.5 text-[11.5px] leading-[1.4] text-ink-2">{error ?? `${now.standIn}. ${now.name} is thinking meanwhile.`}</p>}
          {groups.map((g) => (
            <div key={g.provider}>
              <div className="px-2.5 pt-1.5 pb-1 text-[11px] font-semibold text-dim">{g.label}</div>
              {g.choices.map(model)}
              {g.more.length > 0 &&
                (more[g.provider] ? (
                  g.more.map(model)
                ) : (
                  <button type="button" onClick={() => setMore((m) => ({ ...m, [g.provider]: true }))} className={`${row} h-7 text-dim`}>
                    <span className="w-4 shrink-0" />
                    <span className="flex-1">{g.more.length} more</span>
                    <Icon name="chevron" className="size-3 rotate-90" />
                  </button>
                ))}
              {/* No list from this brain: say so rather than offer names of our own. */}
              {!g.listed && (
                <p className="py-1 pr-2.5 pl-[30px] text-[11.5px] leading-[1.4] text-dim">{unlisted[g.provider] ? `midna on ${status.host.name} can't list ${g.label}'s models. Update it, or name one in Settings.` : "Asking for its models…"}</p>
              )}
            </div>
          ))}
          {accounts.length > 0 && (
            <>
              <div className="mx-2.5 my-1.5 h-px bg-line" />
              <div className="px-2.5 pt-0.5 pb-1 text-[11px] font-semibold text-dim">Claude account</div>
              {accounts.map((a) => (
                <button
                  key={a.account}
                  type="button"
                  role="menuitemradio"
                  aria-checked={a.selected}
                  disabled={saving !== null}
                  onClick={() => (a.selected ? setOpen(false) : void save(`account:${a.account}`, { account: a.account }))}
                  className={`${row} py-1`}
                >
                  {mark(`account:${a.account}`, a.selected)}
                  {/* The name leads; who it is signed in as, or when its usage is back, sits under it, smaller and grey. */}
                  <span className="min-w-0 flex-1">
                    <span className="block">{a.name}</span>
                    <span className="block truncate text-[11px] leading-[1.3] text-dim group-hover/item:text-white/75">{a.note}</span>
                  </span>
                </button>
              ))}
            </>
          )}
          <p className="px-2.5 pt-2 pb-1 text-[11px] text-dimmer">Holds from midna's next turn, on every device.</p>
        </div>
      )}
    </div>
  );
}
