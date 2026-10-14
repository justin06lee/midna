import { describe, expect, test } from "bun:test";
import { ApiError, AuthRequiredError, ProviderNotInstalledError, toApiError } from "@justin06lee/yagami";
import { BrainError } from "../src/brain.ts";
import { brainProblem, howToSignIn } from "../src/check.ts";

describe("telling a signed-out brain from a failing one", () => {
  test("yagami's typed failure, thrown as is", () => {
    expect(brainProblem(new AuthRequiredError("codex", "codex login"))).toEqual({ reason: "signed_out", loginCommand: "codex login" });
    expect(brainProblem(new ProviderNotInstalledError("gemini", "npm i -g @google/gemini-cli"))).toEqual({ reason: "not_installed", installHint: "npm i -g @google/gemini-cli" });
  });

  test("yagami's API error, which keeps only the message", () => {
    const err = toApiError(new AuthRequiredError("claude", "claude (then /login)"));
    expect(err).toBeInstanceOf(ApiError);
    expect(brainProblem(err)).toEqual({ reason: "signed_out", loginCommand: "claude (then /login)" });
    const detailed = toApiError(new AuthRequiredError("codex", "codex login", "token expired (401). retry later"));
    expect(brainProblem(detailed)).toEqual({ reason: "signed_out", loginCommand: "codex login" });
    const missing = toApiError(new ProviderNotInstalledError("codex", "npm i -g @openai/codex"));
    expect(brainProblem(missing)).toEqual({ reason: "not_installed", installHint: "npm i -g @openai/codex" });
    const missingWhy = toApiError(new ProviderNotInstalledError("gemini", "npm i -g @google/gemini-cli", "not on PATH"));
    expect(brainProblem(missingWhy)).toEqual({ reason: "not_installed", installHint: "npm i -g @google/gemini-cli" });
  });

  test("a harness turn that failed, with yagami's failure as the BrainError's cause", () => {
    const failure = new AuthRequiredError("gemini", "gemini (then /auth)");
    const err = new BrainError(`gemini turn failed: ${failure.message}`, "s1", { cause: failure });
    expect(brainProblem(err)).toEqual({ reason: "signed_out", loginCommand: "gemini (then /auth)" });
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
