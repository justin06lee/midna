import { Store, type Settings } from "@midna/core";
import { ensureHome, midnaHome } from "./config.ts";

/**
 * Settings read and written on the host directly, for setup before the
 * daemon has ever run. Once it runs, clients go through the API instead.
 */
export function hostSettings(home = midnaHome()): Settings {
  const store = Store.open(ensureHome(home).db);
  try {
    return store.settings();
  } finally {
    store.close();
  }
}

export function updateHostSettings(patch: Partial<Settings>, home = midnaHome()): Settings {
  const store = Store.open(ensureHome(home).db);
  try {
    return store.updateSettings(patch);
  } finally {
    store.close();
  }
}
