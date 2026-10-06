import { describe, expect, test } from "bun:test";
import { ApiError, AuthRequiredError, ProviderNotInstalledError } from "@justin06lee/yagami";
import { brainProblem, howToSignIn } from "../src/check.ts";

describe("telling a signed-out brain from a failing one", () => {
  test("yagami's typed failure, carried as the cause of an ApiError", () => {
    const err = new ApiError(503, "api_error", "claude: not logged in", { cause: new AuthRequiredError("claude", "claude (then /login)") } as never);
    expect(brainProblem(err)).toEqual({ reason: "signed_out", loginCommand: "claude (then /login)" });
    const missing = new ApiError(503, "api_error", "codex: CLI not found", { cause: new ProviderNotInstalledError("codex", "npm i -g @openai/codex") } as never);
    expect(brainProblem(missing)).toEqual({ reason: "not_installed", installHint: "npm i -g @openai/codex" });
  });

  test("by code, when the error came from another copy of yagami", () => {
    const foreign = Object.assign(new Error("wrapped"), { cause: Object.assign(new Error("x"), { code: "auth_required", loginCommand: "gemini auth" }) });
    expect(brainProblem(foreign)).toEqual({ reason: "signed_out", loginCommand: "gemini auth" });
  });

  test("a Claude Code session's own result text", () => {
    expect(brainProblem(new Error("claude turn failed: Not logged in · Please run /login"))?.reason).toBe("signed_out");
  });

  test("anything else is just a failure", () => {
    expect(brainProblem(new Error("rate limited"))).toBeNull();
    expect(brainProblem(new ApiError(500, "api_error", "engine error: boom"))).toBeNull();
  });

  test("sign-in instructions", () => {
    expect(howToSignIn("claude (then /login)")).toBe("run `claude` there and type /login");
    expect(howToSignIn("codex login")).toBe("run `codex` there");
  });
});
