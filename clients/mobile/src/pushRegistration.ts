/**
 * When to give midna this phone's push token — kept free of Expo so it can be
 * tested under bun. Asking iOS for the token hands it to every token listener
 * too, so a listener that registered on each one registered forever (build 3
 * sent it thousands of times a minute and starved every other request).
 */

/** Where push notifications stand on this phone. */
export type PushSetup = "unknown" | "on" | "denied" | "unsupported" | "failed";

export type PushEnvironment = "production" | "development";

/** The same token that went through is given again at most this often (midna may have been set up again since). */
export const RESEND_SAME_TOKEN_MS = 60 * 60_000;

/** What registering needs from the phone and from midna. */
export interface PushSide {
  /** Asks the first time; whether notifications may be shown. */
  permitted(): Promise<boolean>;
  /** This phone's Apple push token. Asking may hand it to every token listener as well. */
  token(): Promise<string>;
  /** Which of Apple's push services the build talks to. */
  environment(): Promise<PushEnvironment>;
  /** Give the token to midna: "on", or why not ("unsupported" for a host without push, "failed"). */
  send(token: string, environment: PushEnvironment): Promise<PushSetup>;
}

export function pushRegistration(side: PushSide, now: () => number = Date.now) {
  /** The last token offered to midna, however that went: the same one again is no news. */
  let last: { token: string; at: number; setup: PushSetup } | null = null;
  let running: Promise<PushSetup> | null = null;

  /** One at a time: a call while one runs gets that one's outcome. */
  const once = (go: () => Promise<PushSetup>) =>
    running ??
    (running = go()
      .catch((): PushSetup => "failed")
      .finally(() => (running = null)));

  async function offer(token: string): Promise<PushSetup> {
    const setup = await side.send(token, await side.environment());
    last = { token, at: now(), setup };
    return setup;
  }

  return {
    /**
     * On launch and each return to the foreground. The same token that went
     * through less than an hour ago isn't sent again; after a failure it is
     * (returns to the foreground are the user's pace, not a loop).
     */
    register: (): Promise<PushSetup> =>
      once(async () => {
        if (!(await side.permitted())) return "denied";
        const token = await side.token();
        if (last && last.token === token && last.setup === "on" && now() - last.at < RESEND_SAME_TOKEN_MS) return "on";
        return offer(token);
      }),
    /** iOS handed the app a token: only one other than the last offered is sent. Null when there's nothing to do. */
    tokenChanged: (token: string): Promise<PushSetup> | null => (running || (last && last.token === token) ? null : once(() => offer(token))),
  };
}
