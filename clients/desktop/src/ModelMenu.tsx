import { useEffect, useRef, useState } from "react";
import { accountChoices, modelGroups, parseModel, thinkingWith, type Account, type BrainInfo, type BrainModel, type MidnaClient, type ModelChoice, type Status } from "@midna/protocol";
import { Icon, Spinner } from "./ui";

/**
 * What the host can think with: its installed brains, and each one's own list
 * of models once asked for (`wanted`; a host before 0.13.7 has none to give,
 * and the picker falls back to the short list it can work out itself). The
 * brain that is set is asked at once, so its model is called by its real name.
 */
export function useModels(client: MidnaClient, status: Status | null, wanted: boolean) {
  const [brains, setBrains] = useState<BrainInfo[]>([]);
  const [catalogues, setCatalogues] = useState<Record<string, BrainModel[]>>({});
  useEffect(() => {
    void client.brains().then(setBrains, () => {});
  }, [client]);
  const account = status?.account;
  const set = status ? parseModel(status.model, brains.map((b) => b.id)).provider : null;
  useEffect(() => {
    const abort = new AbortController();
    for (const b of brains) {
      if (!b.installed || b.id === "hermes" || !(wanted || b.id === set)) continue;
      void client.brainModels(b.id, b.id === "claude" ? account : undefined, abort.signal).then(
        (m) => setCatalogues((c) => ({ ...c, [b.id]: m })),
        () => {},
      );
    }
    return () => abort.abort();
  }, [client, brains, account, set, wanted]);
  return { brains, catalogues };
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
  const { brains, catalogues } = useModels(client, status, asked);
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

  const item = (key: string, selected: boolean, name: string, note: string | undefined, title: string | undefined, onPick: () => void) => (
    <button
      key={key}
      type="button"
      role="menuitemradio"
      aria-checked={selected}
      title={title}
      disabled={saving !== null}
      onClick={onPick}
      className="group/item flex h-7 w-full items-center gap-1.5 rounded-[6px] pr-2.5 pl-1.5 text-left text-[13px] hover:bg-accent hover:text-white"
    >
      <span className="flex w-4 shrink-0 justify-center">{saving === key ? <Spinner className="size-3" /> : selected && <Icon name="check" className="size-3.5" />}</span>
      <span className="min-w-0 flex-1 truncate">{name}</span>
      {note && <span className="max-w-[55%] shrink-0 truncate text-[11.5px] text-dim group-hover/item:text-white/80">{note}</span>}
    </button>
  );
  const model = (c: ModelChoice) => item(c.ref, c.selected, c.name, c.note && c.note.length <= 14 ? c.note : undefined, c.note && c.note.length > 14 ? c.note : undefined, () => (c.selected ? setOpen(false) : void save(c.ref, { model: c.ref })));

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
                  <button type="button" onClick={() => setMore((m) => ({ ...m, [g.provider]: true }))} className="flex h-7 w-full items-center gap-1.5 rounded-[6px] pr-2 pl-1.5 text-left text-[13px] text-dim hover:bg-accent hover:text-white">
                    <span className="w-4 shrink-0" />
                    <span className="flex-1">{g.more.length} more</span>
                    <Icon name="chevron" className="size-3 rotate-90" />
                  </button>
                ))}
            </div>
          ))}
          {accounts.length > 0 && (
            <>
              <div className="mx-2.5 my-1.5 h-px bg-line" />
              <div className="px-2.5 pt-0.5 pb-1 text-[11px] font-semibold text-dim">Claude account</div>
              {accounts.map((a) => item(`account:${a.account}`, a.selected, a.name, a.note, a.note, () => (a.selected ? setOpen(false) : void save(`account:${a.account}`, { account: a.account }))))}
            </>
          )}
          <p className="px-2.5 pt-2 pb-1 text-[11px] text-dimmer">Holds from midna's next turn, on every device.</p>
        </div>
      )}
    </div>
  );
}
