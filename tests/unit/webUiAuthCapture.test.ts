import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const cdp = vi.hoisted(() => ({
  requestHandler: undefined as ((params: Record<string, unknown>) => void) | undefined,
  killed: false,
  hifValue: '"local-storage-hif"' as string | null,
  emitRequest: true,
}));

vi.mock("../../src/cdp.js", () => {
  class MockCdpConnection {
    static async connect(): Promise<MockCdpConnection> {
      return new MockCdpConnection();
    }

    async send(method: string): Promise<Record<string, unknown>> {
      if (method === "Runtime.evaluate") {
        return { result: { value: cdp.hifValue } };
      }
      if (method === "Network.getCookies") {
        return { cookies: [{ name: "session", value: "captured-cookie" }] };
      }
      return {};
    }

    on(method: string, callback: (params: Record<string, unknown>) => void): void {
      if (method === "Fetch.requestPaused") {
        cdp.requestHandler = callback;
        if (cdp.emitRequest) {
          callback({
            requestId: "request-1",
            request: {
              url: "https://chat.deepseek.com/api/v0/chat/completion",
              headers: { authorization: "Bearer captured-token" },
            },
          });
        }
      }
    }

    close(): void {}
  }

  return {
    CdpConnection: MockCdpConnection,
    createPage: vi.fn(async () => "ws://test"),
    findChrome: vi.fn(() => "chrome.exe"),
    launchChrome: vi.fn(() => ({
      pid: undefined,
      kill: () => { cdp.killed = true; },
      on: vi.fn(),
    })),
    waitForDebugger: vi.fn(async () => {}),
  };
});

import { runAuthSSE, stopActiveAuthChrome } from "../../src/server/actions.js";

describe("Web UI auth credential capture", () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-web-auth-"));
    vi.stubEnv("DS_DATA_DIR", dataDir);
    vi.stubEnv("DS_AUTH_FILE", path.join(dataDir, "auth.json"));
    vi.stubEnv("DS_CHROME_PROFILE", path.join(dataDir, "chrome-profile"));
    cdp.requestHandler = undefined;
    cdp.killed = false;
    cdp.hifValue = '"local-storage-hif"';
    cdp.emitRequest = true;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it("completes from Bearer plus localStorage HIF when requests have no HIF header", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(
      JSON.stringify({ code: 0, data: { biz_code: 0 } }),
      { status: 200, headers: { "content-type": "application/json" } },
    ));
    const events: Array<{ message?: string }> = [];

    const auth = await runAuthSSE(event => events.push(event));

    expect(auth).toEqual({
      token: "captured-token",
      cookie: "session=captured-cookie",
      hifDliq: undefined,
      hifLeim: "local-storage-hif",
    });
    expect(events).toContainEqual(expect.objectContaining({ message: "Credentials captured, finalizing..." }));
    expect(fs.existsSync(path.join(dataDir, "auth.json"))).toBe(true);
    expect(cdp.killed).toBe(true);
  });

  it("accepts verified Bearer and cookie when current DeepSeek provides no HIF", async () => {
    cdp.hifValue = null;
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(
      JSON.stringify({ code: 0, data: { biz_code: 0 } }),
      { status: 200, headers: { "content-type": "application/json" } },
    ));

    const auth = await runAuthSSE(() => {});

    expect(auth).toEqual({
      token: "captured-token",
      cookie: "session=captured-cookie",
      hifDliq: undefined,
      hifLeim: undefined,
    });
    expect(fs.existsSync(path.join(dataDir, "auth.json"))).toBe(true);
    expect(cdp.killed).toBe(true);
  });

  it("cancels an active AUTH when auth Chrome is stopped for SHUTDOWN", async () => {
    cdp.emitRequest = false;
    const authPromise = runAuthSSE(() => {});
    await vi.waitFor(() => expect(cdp.requestHandler).toBeTypeOf("function"));

    await stopActiveAuthChrome();

    await expect(authPromise).resolves.toBeNull();
    expect(cdp.killed).toBe(true);
  });
});
