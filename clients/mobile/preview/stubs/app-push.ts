export type PushSetup = "on" | "denied" | "unsupported" | "failed" | "unknown";
export const phonePush = (_: unknown) => ({ register: async (): Promise<PushSetup> => "on", tokenChanged: (_t: string) => undefined as Promise<PushSetup> | undefined });
export const clearDelivered = () => {};
export const onTokenChange = (_: unknown) => ({ remove() {} });
