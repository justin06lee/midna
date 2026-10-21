import * as SecureStore from "expo-secure-store";
import { fetch as streamingFetch } from "expo/fetch";
import { MidnaClient, type Fetch } from "@midna/protocol";

/** This phone's pairing with midna. Kept in the keychain, never in plain storage. */
export interface PhoneConnection {
  url: string;
  token: string;
  /** This phone's device id on the host. */
  device: string;
  /** midna's name, as the host reported it when pairing. */
  name: string;
}

const CURRENT = "midna.connection";
/**
 * The pairing this phone is replacing, kept from "Pair again" (or a revoked
 * token) until the new one works, so the new pairing can name it and the
 * host retires it.
 */
const PREVIOUS = "midna.connection.previous";

// The token never leaves this phone, and is readable only while it is unlocked.
const opts: SecureStore.SecureStoreOptions = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };

async function read(key: string): Promise<PhoneConnection | null> {
  const s = await SecureStore.getItemAsync(key, opts);
  if (!s) return null;
  try {
    return JSON.parse(s) as PhoneConnection;
  } catch {
    return null;
  }
}

export const loadConnection = () => read(CURRENT);
export const loadPrevious = () => read(PREVIOUS);

/** A new pairing works: it is the connection now, and the one it replaced is gone. */
export async function saveConnection(c: PhoneConnection): Promise<void> {
  await SecureStore.setItemAsync(CURRENT, JSON.stringify(c), opts);
  await SecureStore.deleteItemAsync(PREVIOUS, opts);
}

/** Pair again: the current pairing waits as the previous one until the new one works. */
export async function setAside(c: PhoneConnection): Promise<void> {
  await SecureStore.setItemAsync(PREVIOUS, JSON.stringify(c), opts);
  await SecureStore.deleteItemAsync(CURRENT, opts);
}

/** Unpaired for good: nothing of it is kept. */
export async function forget(): Promise<void> {
  await SecureStore.deleteItemAsync(CURRENT, opts);
  await SecureStore.deleteItemAsync(PREVIOUS, opts);
}

/**
 * A client whose requests go through expo/fetch: React Native's own fetch
 * can't stream a response body, and the event stream is one.
 */
export const clientFor = (url: string, token?: string) => new MidnaClient(url, token, { fetch: streamingFetch as unknown as Fetch });
