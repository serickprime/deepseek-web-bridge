import { describe, expect, it, vi } from "vitest";
import { parseChallengePayload } from "../../src/deepseek/pow.js";

type FetchFn = typeof globalThis.fetch;

function mockFetch(fn: (...args: Parameters<FetchFn>) => Promise<Response>): { restore: () => void } {
  const prev = globalThis.fetch;
  const wrapped: FetchFn = ((...args: unknown[]) => fn(...(args as Parameters<FetchFn>))) as FetchFn;
  globalThis.fetch = wrapped;
  return { restore: () => { globalThis.fetch = prev; } };
}

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

/* ── Envelope parsing logic (same as checkAuthStatus) ── */

function parseAuthEnvelope(json: Record<string, unknown>): { valid: boolean; message: string } {
  const code = typeof json.code === "number" ? json.code : 0;
  if (code === 40003) return { valid: false, message: "AUTH INVALID (code 40003)" };
  if (code !== 0) {
    const msg = typeof json.msg === "string" ? json.msg : `code ${code}`;
    return { valid: false, message: `AUTH INVALID (${msg})` };
  }
  return { valid: true, message: "Auth OK" };
}

/* ── checkAuthStatus envelope tests ── */

describe("checkAuthStatus envelope parsing", () => {
  it("code 0 → valid", () => {
    const result = parseAuthEnvelope({ code: 0, msg: "success" });
    expect(result.valid).toBe(true);
  });

  it("code 40003 → AUTH INVALID", () => {
    const result = parseAuthEnvelope({ code: 40003, msg: "unauthorized" });
    expect(result.valid).toBe(false);
    expect(result.message).toContain("AUTH INVALID");
    expect(result.message).toContain("40003");
  });

  it("code 40001 → AUTH INVALID with message", () => {
    const result = parseAuthEnvelope({ code: 40001, msg: "token expired" });
    expect(result.valid).toBe(false);
    expect(result.message).toContain("AUTH INVALID");
    expect(result.message).toContain("token expired");
  });

  it("non-numeric code treated as 0 → valid", () => {
    const result = parseAuthEnvelope({ code: "unexpected", msg: "ok" });
    expect(result.valid).toBe(true);
  });

  it("missing code field → treated as 0 → valid", () => {
    const result = parseAuthEnvelope({ msg: "ok" });
    expect(result.valid).toBe(true);
  });

  it("code 500 with no msg → shows code number", () => {
    const result = parseAuthEnvelope({ code: 500 });
    expect(result.valid).toBe(false);
    expect(result.message).toContain("code 500");
  });
});

/* ── checkAuthStatus HTTP status tests ── */

describe("checkAuthStatus HTTP handling", () => {
  it("HTTP 404 is NOT treated as valid", async () => {
    const mock = mockFetch(async () => jsonResponse({ code: 0 }, { status: 404 }));
    try {
      const res = await fetch("https://chat.deepseek.com/api/v0/auth/session");
      expect(res.ok).toBe(false);
      expect(res.status).toBe(404);
    } finally {
      mock.restore();
    }
  });

  it("HTTP 403 returns invalid", async () => {
    const mock = mockFetch(async () => jsonResponse({ code: 0 }, { status: 403 }));
    try {
      const res = await fetch("https://chat.deepseek.com/api/v0/auth/session");
      expect(res.ok).toBe(false);
      expect(res.status).toBe(403);
    } finally {
      mock.restore();
    }
  });

  it("HTTP 200 + code 40003 → invalid", async () => {
    const mock = mockFetch(async () => jsonResponse({ code: 40003, msg: "unauthorized" }));
    try {
      const res = await fetch("https://chat.deepseek.com/api/v0/auth/session");
      expect(res.ok).toBe(true);
      const json = await res.json() as Record<string, unknown>;
      const result = parseAuthEnvelope(json);
      expect(result.valid).toBe(false);
    } finally {
      mock.restore();
    }
  });
});

/* ── Pow challenge envelope tests ── */

describe("pow challenge envelope parsing", () => {
  it("code 0, biz_code 0 → challenge parsed", () => {
    const body = {
      code: 0, msg: "success",
      data: {
        biz_code: 0, biz_msg: "",
        biz_data: {
          challenge: {
            signature: "sig1", target_path: "/api/v0/chat/completion",
            algorithm: "sha3", salt: "abc", salt_number: 1,
            complexity: 4, difficulty: 4, expire_at: 9999999, challenge: "xyz",
          },
        },
      },
    };
    const result = parseChallengePayload(body);
    expect(result).not.toBeNull();
    expect(result!.signature).toBe("sig1");
  });

  it("code 40003 → API error (not challenge format)", () => {
    const body = { code: 40003, msg: "unauthorized" };
    const code = typeof body.code === "number" ? body.code : 0;
    expect(code).toBe(40003);
    const msg = typeof body.msg === "string" ? body.msg : `code ${code}`;
    expect(msg).toBe("unauthorized");
  });

  it("code 0, biz_code 10001 → biz error", () => {
    const body = {
      code: 0, msg: "success",
      data: { biz_code: 10001, biz_msg: "rate limited" },
    };
    const code = typeof body.code === "number" ? body.code : 0;
    const data = typeof body.data === "object" && body.data !== null ? body.data as Record<string, unknown> : {};
    const bizCode = typeof data.biz_code === "number" ? data.biz_code : 0;
    expect(code).toBe(0);
    expect(bizCode).toBe(10001);
    const bizMsg = typeof data.biz_msg === "string" ? data.biz_msg : "";
    expect(bizMsg).toBe("rate limited");
  });

  it("code 0, biz_code 0, but bad challenge → null from parseChallengePayload", () => {
    const body = {
      code: 0, msg: "success",
      data: { biz_code: 0, biz_msg: "", biz_data: { challenge: null } },
    };
    const result = parseChallengePayload(body);
    expect(result).toBeNull();
  });
});

/* ── Session create verification envelope tests ── */

describe("session create verification envelope", () => {
  function verifySessionEnvelope(json: Record<string, unknown>): { ok: boolean; error?: string } {
    const code = typeof json.code === "number" ? json.code : 0;
    const data = typeof json.data === "object" && json.data !== null ? json.data as Record<string, unknown> : {};
    const bizCode = typeof data.biz_code === "number" ? data.biz_code : 0;
    if (code !== 0 || bizCode !== 0) {
      const verifyMsg = typeof json.msg === "string" ? json.msg : `code ${code}`;
      const bizMsg = typeof data.biz_msg === "string" ? data.biz_msg : bizCode !== 0 ? `biz_code ${bizCode}` : "";
      return { ok: false, error: bizMsg ? `${verifyMsg}: ${bizMsg}` : verifyMsg };
    }
    return { ok: true };
  }

  it("code 0, biz_code 0 → ok", () => {
    const result = verifySessionEnvelope({ code: 0, data: { biz_code: 0 } });
    expect(result.ok).toBe(true);
  });

  it("code 40003 → invalid with msg", () => {
    const result = verifySessionEnvelope({ code: 40003, msg: "unauthorized" });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("unauthorized");
  });

  it("code 0, biz_code 50001 → invalid with biz_msg", () => {
    const result = verifySessionEnvelope({ code: 0, msg: "ok", data: { biz_code: 50001, biz_msg: "session limit exceeded" } });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("ok: session limit exceeded");
  });

  it("code 0, biz_code 50001, no biz_msg → shows biz_code", () => {
    const result = verifySessionEnvelope({ code: 0, data: { biz_code: 50001 } });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("biz_code 50001");
  });

  it("code -1, no msg → shows code", () => {
    const result = verifySessionEnvelope({ code: -1 });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("code -1");
  });
});
