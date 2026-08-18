import { describe, expect, it } from "vitest";
import { Redactor, collectAuthSecrets, isSensitiveKey } from "../../src/utils/redaction.js";

describe("Redactor", () => {
  it("redacts known secrets from text", () => {
    const redactor = new Redactor({ secrets: ["super-secret-token"] });
    expect(redactor.redactText("prefix super-secret-token suffix")).toBe("prefix [REDACTED] suffix");
  });

  it("redacts authorization headers", () => {
    const redactor = new Redactor();
    expect(redactor.redactText("authorization: Bearer abc123xyz")).toBe("authorization: Bearer [REDACTED]");
  });

  it("redacts cookie header", () => {
    const redactor = new Redactor();
    expect(redactor.redactText("cookie: sessionId=abc123; foo=bar")).toBe("cookie: [REDACTED]");
  });

  it("redacts sensitive keys recursively", () => {
    const redactor = new Redactor();
    const out = redactor.redactValue("body", {
      token: "abc",
      messages: [{ content: "hi" }],
      nested: { api_key: "123", text: "ok" },
    });
    expect(out).toEqual({
      token: "[REDACTED]",
      messages: [{ content: "hi" }],
      nested: { api_key: "[REDACTED]", text: "ok" },
    });
  });

  it("collectAuthSecrets returns token/cookie values", () => {
    const secrets = collectAuthSecrets({ token: "t12345", cookie: "c67890", hif_dliq: "", hif_leim: "" });
    expect(secrets).toEqual(["t12345", "c67890"]);
  });

  it("isSensitiveKey matches common names", () => {
    expect(isSensitiveKey("authorization")).toBe(true);
    expect(isSensitiveKey("x-api-key")).toBe(true);
    expect(isSensitiveKey("message_content")).toBe(false);
  });
});
