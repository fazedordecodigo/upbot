import { describe, expect, test } from "bun:test";
import { mapAcpAuthError } from "../src/providers/acp";
import {
  classifyStartupError,
  DEFAULT_COMMANDS,
  isVmCredentialRejection,
  redactSecrets,
  vmCredentialRejectedMessage,
} from "../src/providers/process";

describe("microVM credential rejection messages", () => {
  const cases = [
    {
      provider: "claude" as const,
      name: "API key",
      credential: "sk-ant-api03-fake-claude",
      detail: "HTTP 401 invalid x-api-key sk-ant-api03-fake-claude",
    },
    {
      provider: "claude" as const,
      name: "OAuth token",
      credential: "sk-ant-oat01-fake-oauth",
      detail: "Authentication failed for token sk-ant-oat01-fake-oauth",
    },
    {
      provider: "codex" as const,
      name: "API key",
      credential: "sk-proj-fake-codex",
      detail: "Incorrect API key provided: sk-proj-fake-codex",
    },
    {
      provider: "gemini" as const,
      name: "API key",
      credential: "AIzaSyFake-fake-gemini",
      detail: "API key not valid. Please pass a valid API key: AIzaSyFake-fake-gemini",
    },
  ];

  for (const { provider, name, credential, detail } of cases) {
    test(`${provider} ${name} rejection does not expose the saved fake credential`, () => {
      expect(isVmCredentialRejection(detail)).toBe(true);
      const message = vmCredentialRejectedMessage(provider, detail, credential);
      expect(message).toContain(`${provider}: the saved microVM credential was rejected`);
      expect(message).toContain("Update it in Settings → Hosts.");
      expect(message).not.toContain(credential);
    });
  }

  test("does not classify unrelated provider failures as credential rejections", () => {
    expect(isVmCredentialRejection("network connection timed out")).toBe(false);
  });

  test("redacts provider-masked API keys with visible prefixes and suffixes", () => {
    const detail = "Incorrect API key provided: sk-proj-****************029f";
    expect(redactSecrets(detail)).not.toContain("sk-proj-");
  });

  test("redacts Gemini API keys in provider details", () => {
    expect(redactSecrets("invalid key AIzaSyAbcdefghijklmnopqrstuvwxyz0123456789")).not.toContain(
      "AIzaSy",
    );
  });
});

describe("classifyStartupError", () => {
  const credential = "sk-proj-fake-codex";

  test("maps a credential rejection in the error detail to the saved-credential message", () => {
    const error = classifyStartupError(
      "codex",
      `Incorrect API key provided: ${credential}`,
      "",
      credential,
    );
    expect(error.code).toBe("auth_required");
    expect(error.message).toContain("codex: the saved microVM credential was rejected");
    expect(error.message).not.toContain(credential);
  });

  test("maps a credential rejection that only appears in the stderr tail", () => {
    const error = classifyStartupError(
      "codex",
      "initialize timed out after 30000ms",
      `Incorrect API key provided: ${credential}`,
      credential,
    );
    expect(error.code).toBe("auth_required");
    expect(error.message).toContain("the saved microVM credential was rejected");
    expect(error.message).not.toContain(credential);
  });

  test("maps a sign-in hint that only appears in the stderr tail", () => {
    const error = classifyStartupError("codex", "process exited (code 1)", "not logged in", null);
    expect(error.code).toBe("auth_required");
    expect(error.message).toContain("codex requires sign-in. Run `codex login` in a terminal.");
  });

  test("falls back to the detail plus a truncated tail, credential redacted", () => {
    const tail = ["line1", "line2", "line3", "line4", "line5", "line6", `key ${credential}`].join(
      "\n",
    );
    const error = classifyStartupError("gemini", "boom", tail, credential);
    expect(error.code).toBe("provider_unavailable");
    expect(error.message).toContain("gemini failed to start: boom");
    expect(error.message).toContain("line6");
    expect(error.message).not.toContain("line1");
    expect(error.message).not.toContain(credential);
  });

  test("maps Gemini's failed cached Google sign-in (exit 41) to sign-in guidance", () => {
    const error = classifyStartupError(
      "gemini",
      "ACP connection closed",
      [
        "Error authenticating: FatalAuthenticationError: Failed to authenticate with user code.",
        "    at initOauthClient (file:///home/user/gemini/bundle/chunk.js:1:1)",
        "  exitCode: 41",
        "}",
      ].join("\n"),
      null,
    );
    expect(error.code).toBe("auth_required");
    expect(error.message).toBe(
      "gemini requires sign-in. Run `gemini` in a terminal and choose Sign in with Google, Use Gemini API Key or Vertex AI. (Error authenticating: FatalAuthenticationError: Failed to authenticate with user code.)",
    );
  });

  test("honors the internal fallback code for resume attempts", () => {
    const error = classifyStartupError("claude", "boom", "", null, "internal");
    expect(error.code).toBe("internal");
  });
});

describe("ACP microVM authentication errors", () => {
  test("maps rejected Gemini credentials to a redacted saved-credential error", () => {
    const credential = "AIzaSyFake-fake-gemini";
    const error = mapAcpAuthError(
      "gemini",
      new Error(`API key not valid: ${credential}`),
      credential,
    );
    expect(error?.code).toBe("auth_required");
    expect(error?.message).toContain("gemini: the saved microVM credential was rejected");
    expect(error?.message).not.toContain(credential);
  });

  test("maps rejected Cursor credentials to a redacted saved-credential error", () => {
    const credential = "sk-cursor-fake-cursor";
    const error = mapAcpAuthError(
      "cursor",
      new Error(`HTTP 401 invalid API key: ${credential}`),
      credential,
    );
    expect(error?.code).toBe("auth_required");
    expect(error?.message).toContain("cursor: the saved microVM credential was rejected");
    expect(error?.message).not.toContain(credential);
  });

  test("maps Cursor's generic credentialed ACP startup rejection", () => {
    const credential = "sk-cursor-fake-cursor";
    const error = mapAcpAuthError(
      "cursor",
      new Error("Internal error: Failed to initialize session services"),
      credential,
    );
    expect(error?.code).toBe("auth_required");
    expect(error?.message).toContain("Failed to initialize session services");
    expect(error?.message).not.toContain(credential);
  });

  test("keeps a signed-out ACP provider on its interactive sign-in guidance", () => {
    const error = mapAcpAuthError("cursor", new Error("Authentication required"), null);
    expect(error?.code).toBe("auth_required");
    expect(error?.message).toContain("Run `agent login` in a terminal.");
  });

  test("maps Gemini's signed-out session/new error to its sign-in picker", () => {
    const error = mapAcpAuthError(
      "gemini",
      Object.assign(new Error("Gemini API key is missing or not configured."), { code: -32000 }),
      null,
    );
    expect(error?.code).toBe("auth_required");
    expect(error?.message).toBe(
      "gemini requires sign-in. Run `gemini` in a terminal and choose Sign in with Google, Use Gemini API Key or Vertex AI. (Gemini API key is missing or not configured.)",
    );
  });

  test("launches Gemini with the non-deprecated ACP flag", () => {
    expect(DEFAULT_COMMANDS.gemini).toEqual(["gemini", "--acp"]);
  });

  test("maps OpenCode's unexpected ACP disconnect to sign-in guidance before progress", () => {
    const error = mapAcpAuthError("opencode", new Error("connection closed unexpectedly"), null);
    const beforeProgress = mapAcpAuthError(
      "opencode",
      new Error("connection closed unexpectedly"),
      null,
      true,
    );
    expect(error).toBeNull();
    expect(beforeProgress?.code).toBe("auth_required");
    expect(beforeProgress?.message).toBe(
      "opencode requires sign-in. Run `opencode auth login` in a terminal.",
    );
    expect(
      mapAcpAuthError("opencode", new Error("connection closed unexpectedly"), null, false),
    ).toBeNull();
  });
});
