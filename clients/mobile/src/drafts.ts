import { useCallback, useState } from "react";
import Storage from "expo-sqlite/kv-store";

/**
 * Nothing typed is lost: a draft outlives switching tabs, the app being
 * closed or killed, and a send that failed, and goes only once what it was
 * for has worked — a send, a pairing. Kept in SQLite, written as each key
 * is typed (synchronously, so a kill can't lose the last one), one set per
 * connection, under the same keys as the desktop's. Secrets — a pairing
 * code — are kept in memory only.
 */

export interface Drafted {
  url: string;
  device: string;
}

/** Where one connection's drafts are kept; the chat's is this key itself, a field's adds its name. */
export const draftKey = (c: Drafted) => `midna.draft:${c.url}#${c.device}`;

/** A draft of several fields at once, as JSON. */
export function loadDraft<T>(key: string): T | null {
  const s = Storage.getItemSync(key);
  if (s === null) return null;
  try {
    return JSON.parse(s) as T;
  } catch {
    return null;
  }
}

export const saveDraft = (key: string, value: unknown) => Storage.setItemSync(key, JSON.stringify(value));
export const dropDraft = (key: string) => void Storage.removeItemSync(key);

/**
 * A field over a saved value: what the user typed while there is a draft,
 * the saved value otherwise. Typing the saved value back drops the draft.
 */
export function useDraft(key: string, saved = "") {
  const [draft, setDraft] = useState(() => Storage.getItemSync(key));
  const set = useCallback(
    (v: string) => {
      const next = v === saved ? null : v;
      if (next === null) dropDraft(key);
      else Storage.setItemSync(key, next);
      setDraft(next);
    },
    [key, saved],
  );
  const clear = useCallback(() => {
    dropDraft(key);
    setDraft(null);
  }, [key]);
  return { value: draft ?? saved, set, clear };
}

const secrets = new Map<string, string>();

/** A secret being typed: survives the screen going away, never touches the disk. */
export function useSecretDraft(key: string) {
  const [value, setValue] = useState(() => secrets.get(key) ?? "");
  const set = useCallback(
    (v: string) => {
      if (v) secrets.set(key, v);
      else secrets.delete(key);
      setValue(v);
    },
    [key],
  );
  return [value, set] as const;
}
