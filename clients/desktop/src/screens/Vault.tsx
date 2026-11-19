import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { MidnaError, vaultMatches, vaultSite, type MidnaClient, type VaultItem } from "@midna/protocol";
import { useDraft, useSecretDraft } from "../drafts";
import { copySecret } from "../host";
import { Button, Icon, Loading, Spinner } from "../ui";

const NEW = "new";

/**
 * The vault: the logins midna keeps in ghostly, by title. One opens in place
 * to change; a password shows or copies only when asked. Hermes finds a
 * login here by its title, and asks before it uses a password. Every field
 * keeps what was typed until it is saved; a password being typed stays in
 * memory only.
 */
export function Vault({ client, draftKey }: { client: MidnaClient; draftKey: string }) {
  const [items, setItems] = useState<VaultItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [none, setNone] = useState<string | null>(null);
  const [tries, setTries] = useState(0);
  const query = useDraft(`${draftKey}:vault:query`, "");
  const open = useDraft(`${draftKey}:vault:open`, "");

  useEffect(() => {
    let live = true;
    setError(null);
    client.vault().then(
      (v) => live && setItems(v),
      (err: Error) => {
        if (!live) return;
        if (err instanceof MidnaError && err.status === 503) setNone(err.message);
        else setError(`Couldn't open the vault: ${err.message}`);
      },
    );
    return () => {
      live = false;
    };
  }, [client, tries]);

  const reload = useCallback(() => setTries((n) => n + 1), []);

  if (none)
    return (
      <Page>
        <div className="sheet rounded-[10px] px-5 py-8 text-center">
          <p className="text-[14px] font-medium">No vault on this midna</p>
          <p className="selectable mx-auto mt-1 max-w-[400px] text-[12.5px] text-dim">{none.replace(/^there's no vault here: /, "")}. ghostly keeps its vault on midna's host.</p>
        </div>
      </Page>
    );
  if (!items) return <Loading error={error} onRetry={reload} />;

  const q = query.value.trim();
  const shown = vaultMatches(items, q);
  const close = () => open.set("");

  return (
    <Page
      action={
        open.value !== NEW && (
          <Button onClick={() => open.set(NEW)} icon={<Icon name="plus" className="size-3.5" />}>
            Add Login
          </Button>
        )
      }
    >
      {items.length > 0 && (
        <input type="search" className="mb-3 h-7 w-full rounded-[7px] bg-control px-2.5 text-[13px] outline-none placeholder:text-dim focus:shadow-[0_0_0_3px_var(--focus)]" placeholder="Search" value={query.value} onChange={(e) => query.set(e.target.value)} spellCheck={false} />
      )}
      {open.value === NEW && (
        <div className="mb-3">
          <Editor client={client} item={null} draftKey={draftKey} onDone={() => (close(), reload())} onCancel={close} />
        </div>
      )}
      {items.length === 0 && open.value !== NEW ? (
        <div className="sheet rounded-[10px] px-5 py-8 text-center">
          <p className="text-[14px] font-medium">Nothing in the vault yet</p>
          <p className="mx-auto mt-1 max-w-[380px] text-[12.5px] text-dim">Add a login, and midna can find it by its title when you ask.</p>
        </div>
      ) : shown.length === 0 && q ? (
        <p className="px-1 py-2 text-[12.5px] text-dim">No login titled "{query.value.trim()}".</p>
      ) : (
        shown.length > 0 && (
          <div className="sheet divide-y divide-line overflow-hidden rounded-[10px]">
            {shown.map((i) =>
              open.value === i.id ? (
                <div key={i.id}>
                  <Editor client={client} item={i} draftKey={draftKey} onDone={() => (close(), reload())} onCancel={close} flat />
                </div>
              ) : (
                <button key={i.id} type="button" onClick={() => open.set(i.id)} className="flex w-full items-center gap-3 px-3 py-2 text-left transition-colors hover:bg-hover">
                  <span className="min-w-0 flex-1">
                    <span className="block text-[13px]">{i.title}</span>
                    {(i.username || i.url) && <span className="block text-[11.5px] text-dim">{[i.username, vaultSite(i.url)].filter(Boolean).join(" · ")}</span>}
                  </span>
                  <Icon name="chevron" className="size-3 shrink-0 text-dimmer" />
                </button>
              ),
            )}
          </div>
        )
      )}
    </Page>
  );
}

function Page({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="mx-auto w-full max-w-[760px] px-8 pt-2 pb-10">
      <header className="mb-6 flex items-end justify-between gap-4">
        <div>
          <h1 className="text-[20px] font-semibold">Vault</h1>
          <p className="mt-0.5 max-w-[460px] text-[13px] text-dim">Logins midna keeps in ghostly. Hermes finds one by its title, and asks you before it uses a password.</p>
        </div>
        {action}
      </header>
      {children}
    </div>
  );
}

/** One login, opened to change — or a new one. Saving sends only what changed. */
function Editor({ client, item, draftKey, onDone, onCancel, flat }: { client: MidnaClient; item: VaultItem | null; draftKey: string; onDone: () => void; onCancel: () => void; flat?: boolean }) {
  const key = `${draftKey}:vault:${item?.id ?? NEW}`;
  const title = useDraft(`${key}:title`, item?.title ?? "");
  const username = useDraft(`${key}:username`, item?.username ?? "");
  const url = useDraft(`${key}:url`, item?.url ?? "");
  const [password, setPassword] = useSecretDraft(`${key}:password`);
  /** The saved password, once asked for: memory only. */
  const [current, setCurrent] = useState<string | null>(null);
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState<"save" | "show" | "copy" | "trash" | null>(null);
  const [problem, setProblem] = useState("");
  const [copied, setCopied] = useState(false);
  const [sure, setSure] = useState(false);

  const saved = async () => {
    if (current !== null || !item) return current;
    const { password: p } = await client.vaultPassword(item.id);
    setCurrent(p);
    return p;
  };

  const run = async (what: NonNullable<typeof busy>, work: () => Promise<void>) => {
    setBusy(what);
    setProblem("");
    try {
      await work();
    } catch (err) {
      setProblem((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const show = () =>
    run("show", async () => {
      if (visible) return setVisible(false);
      if (!password && item) setPassword(await saved() ?? "");
      setVisible(true);
    });

  const copyIt = () =>
    run("copy", async () => {
      await copySecret(password || ((await saved()) ?? ""));
      setCopied(true);
      setTimeout(() => setCopied(false), 1_600);
    });

  const clear = () => {
    title.clear();
    username.clear();
    url.clear();
    setPassword("");
  };

  const save = (e: FormEvent) => {
    e.preventDefault();
    void run("save", async () => {
      if (!title.value.trim()) throw new Error("A login needs a title.");
      if (!item) {
        if (!password) throw new Error("A new login needs a password.");
        await client.addToVault({ title: title.value, username: username.value, url: url.value, password });
      } else {
        const patch = {
          ...(title.value !== item.title ? { title: title.value } : {}),
          ...(username.value !== (item.username ?? "") ? { username: username.value } : {}),
          ...(url.value !== (item.url ?? "") ? { url: url.value } : {}),
          ...(password && password !== current ? { password } : {}),
        };
        if (Object.keys(patch).length) await client.editVault(item.id, patch);
      }
      clear();
      onDone();
    });
  };

  const trash = () =>
    run("trash", async () => {
      if (!item) return;
      if (!sure) return setSure(true);
      await client.removeFromVault(item.id);
      clear();
      onDone();
    });

  const cancel = () => {
    clear();
    onCancel();
  };

  return (
    <form onSubmit={save} className={flat ? "px-3 py-3.5" : "sheet rounded-[10px] px-3 py-3.5"}>
      <div className="grid grid-cols-[80px_1fr] items-center gap-x-3 gap-y-2">
        <label className="text-right text-[13px]">Title</label>
        <input autoFocus={!item} className="field h-7 px-2 text-[13px]" value={title.value} onChange={(e) => title.set(e.target.value)} placeholder="GitHub" spellCheck={false} />
        <label className="text-right text-[13px]">Username</label>
        <input className="field h-7 px-2 text-[13px]" value={username.value} onChange={(e) => username.set(e.target.value)} autoComplete="off" spellCheck={false} />
        <label className="text-right text-[13px]">Website</label>
        <input className="field h-7 px-2 text-[13px]" value={url.value} onChange={(e) => url.set(e.target.value)} placeholder="https://" spellCheck={false} />
        <label className="text-right text-[13px]">Password</label>
        <div className="flex items-center gap-1.5">
          <input
            type={visible ? "text" : "password"}
            className="field h-7 min-w-0 flex-1 px-2 font-mono text-[12.5px]"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder={item ? "Unchanged" : ""}
            autoComplete="new-password"
            spellCheck={false}
          />
          {(item || password) && (
            <>
              <Button size="sm" variant="ghost" busy={busy === "show"} onClick={() => void show()}>
                {visible ? "Hide" : "Show"}
              </Button>
              <Button size="sm" variant="ghost" busy={busy === "copy"} onClick={() => void copyIt()} icon={copied ? <Icon name="check" className="size-3.5" /> : <Icon name="copy" className="size-3.5" />}>
                {copied ? "Copied" : "Copy"}
              </Button>
            </>
          )}
        </div>
      </div>
      {problem && <p className="selectable mt-3 text-[12.5px] text-ink-2">{problem}</p>}
      <div className="mt-4 flex items-center gap-2">
        {item && (
          <Button variant="ghost" className="-ml-3 text-[var(--bad)]" busy={busy === "trash"} onClick={() => void trash()}>
            {sure ? "Move to Trash?" : "Move to Trash"}
          </Button>
        )}
        <span className="flex-1" />
        {busy === "save" && <Spinner className="text-dim" />}
        <Button onClick={cancel}>Cancel</Button>
        <Button variant="primary" type="submit" disabled={busy !== null}>
          {item ? "Save" : "Add"}
        </Button>
      </div>
    </form>
  );
}
