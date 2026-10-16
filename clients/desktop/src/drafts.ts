import { useCallback, useState } from "react";
import type { Connection } from "@midna/protocol";

/**
 * Nothing typed is lost: a draft outlives a view switch, a quit or a crash,
 * and goes only once what it was for has worked — a send, a save. Kept in
 * localStorage, one set per connection. Secrets are kept in memory only.
 */

/** Where one connection's drafts are kept; the chat's is this key itself, a field's adds its name. */
export const draftKey = (c: Connection) => `midna.draft:${c.url}#${c.device ?? ""}`;

/** A draft of several fields at once, as JSON. */
export function loadDraft<T>(key: string): T | null {
  const s = localStorage.getItem(key);
  if (s === null) return null;
  try {
    return JSON.parse(s) as T;
  } catch {
    return null;
  }
}

export const saveDraft = (key: string, value: unknown) => localStorage.setItem(key, JSON.stringify(value));
export const dropDraft = (key: string) => localStorage.removeItem(key);

/**
 * A field over a saved value: what the user typed while there is a draft,
 * the saved value otherwise. A saved value arriving later never replaces
 * the draft; typing the saved value back drops it.
 */
export function useDraft(key: string, saved: string) {
  const [draft, setDraft] = useState(() => localStorage.getItem(key));
  const set = useCallback(
    (v: string) => {
      const next = v === saved ? null : v;
      if (next === null) dropDraft(key);
      else localStorage.setItem(key, next);
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
