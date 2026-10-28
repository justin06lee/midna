import { expect, test } from "bun:test";
import { pushRegistration, RESEND_SAME_TOKEN_MS, type PushSetup } from "../src/pushRegistration";

/**
 * A phone like expo-notifications: asking for the token hands it to the
 * token listener too, as the app's listener (tokenChanged) receives it.
 */
function phone(opts: { answer?: () => PushSetup } = {}) {
  let clock = 1_000_000;
  let token = "ab".repeat(32);
  const sent: string[] = [];
  const reg = pushRegistration(
    {
      permitted: async () => true,
      token: async () => {
        const t = token;
        // expo emits the token to listeners on every ask: during it, and once it's answered.
        void reg.tokenChanged(t);
        queueMicrotask(() => void reg.tokenChanged(t));
        setTimeout(() => void reg.tokenChanged(t), 0);
        return t;
      },
      environment: async () => "production",
      send: async (t) => {
        sent.push(t);
        await Bun.sleep(1);
        return opts.answer?.() ?? "on";
      },
    },
    () => clock,
  );
  return { reg, sent, later: (ms: number) => (clock += ms), newToken: (t: string) => (token = t) };
}

const settle = () => Bun.sleep(20);

test("asking for the token raises a token event, and that event doesn't register again", async () => {
  const p = phone();
  expect(await p.reg.register()).toBe("on");
  await settle();
  expect(p.sent.length).toBe(1);
});

test("a token event equal to the last one sent doesn't send; a different one does", async () => {
  const p = phone();
  await p.reg.register();
  await settle();
  expect(p.reg.tokenChanged("ab".repeat(32))).toBeNull();
  expect(p.sent.length).toBe(1);
  expect(await p.reg.tokenChanged("cd".repeat(32))).toBe("on");
  expect(p.sent).toEqual(["ab".repeat(32), "cd".repeat(32)]);
});

test("two registrations never run at once", async () => {
  const p = phone();
  const [a, b] = await Promise.all([p.reg.register(), p.reg.register()]);
  await settle();
  expect([a, b]).toEqual(["on", "on"]);
  expect(p.sent.length).toBe(1);
});

test("returns to the foreground send the same token at most once an hour", async () => {
  const p = phone();
  await p.reg.register();
  for (let i = 0; i < 5; i++) {
    p.later(60_000);
    expect(await p.reg.register()).toBe("on");
  }
  await settle();
  expect(p.sent.length).toBe(1);
  p.later(RESEND_SAME_TOKEN_MS);
  await p.reg.register();
  expect(p.sent.length).toBe(2);
  // A new token goes at once, an hour or not.
  p.newToken("ef".repeat(32));
  await p.reg.register();
  expect(p.sent.at(-1)).toBe("ef".repeat(32));
});

test("after a failure a return to the foreground tries again, but the token's own event doesn't", async () => {
  const p = phone({ answer: () => "unsupported" });
  expect(await p.reg.register()).toBe("unsupported");
  await settle();
  expect(p.sent.length).toBe(1);
  expect(p.reg.tokenChanged("ab".repeat(32))).toBeNull();
  await p.reg.register();
  await settle();
  expect(p.sent.length).toBe(2);
});
