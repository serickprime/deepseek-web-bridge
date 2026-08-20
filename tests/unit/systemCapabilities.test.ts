import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { routes } from "../../src/server/routes.js";
import { getSystemCapabilities, type CommandAvailability, type SystemCapabilities, type SupportedPlatform } from "../../src/server/system.js";
import { LANDING_PAGE_HTML } from "../../src/server/landingPage.js";

function mockResponse() {
  const res = new EventEmitter() as EventEmitter & {
    status?: number;
    headers?: Record<string, string>;
    body?: string;
    writeHead: (status: number, headers: Record<string, string>) => void;
    end: (body?: string) => void;
  };
  res.writeHead = (status, headers) => { res.status = status; res.headers = headers; };
  res.end = body => { res.body = body; };
  return res;
}

async function callSystemEndpoint(platform: SupportedPlatform, commandAvailable: CommandAvailability) {
  const originalPlatform = process.platform;
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
  const ctx = {
    security: { proxyApiKey: null, corsOrigins: [], maxBytes: 1024, loopback: true },
    handler: {} as never,
    sessions: {} as never,
    logger: {} as never,
    redactor: {} as never,
    models: [],
    ready: () => true,
    systemInfo: () => getSystemCapabilities(undefined, commandAvailable),
  };
  try {
    const handler = routes(ctx).find(route => route.method === "GET" && route.path === "/api/system")!.handler;
    const res = mockResponse();
    await handler(new EventEmitter() as never, res as never, "request-ref");
    return { status: res.status, body: JSON.parse(res.body ?? "null") as SystemCapabilities };
  } finally {
    Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
  }
}

describe("GET /api/system", () => {
  it.each([
    ["win32", { platform: "win32", folderPicker: true, claudeCodeLaunch: true, openCodeLaunch: true }],
    ["darwin", { platform: "darwin", folderPicker: true, claudeCodeLaunch: false, openCodeLaunch: false }],
    ["linux", { platform: "linux", folderPicker: true, claudeCodeLaunch: false, openCodeLaunch: false }],
  ] as const)("returns backend capabilities for %s", async (platform, expected) => {
    const commandAvailable = vi.fn(async (command: string) => platform === "linux" && command === "zenity");
    const result = await callSystemEndpoint(platform, commandAvailable);

    expect(result.status).toBe(200);
    expect(result.body).toEqual(expected);
  });

  it("reports folderPicker=false on Linux when neither picker is installed", async () => {
    const result = await callSystemEndpoint("linux", async () => false);
    expect(result.body).toEqual({
      platform: "linux",
      folderPicker: false,
      claudeCodeLaunch: false,
      openCodeLaunch: false,
    });
  });
});

describe("Web UI system capabilities", () => {
  it("keeps manual workDir input and disables picker when folderPicker=false", () => {
    expect(LANDING_PAGE_HTML).toContain('id="workdir"');
    expect(LANDING_PAGE_HTML).toContain('fetch("/api/system")');
    expect(LANDING_PAGE_HTML).toContain("picker.disabled=!d.folderPicker");
    expect(LANDING_PAGE_HTML).toContain("claude.disabled=!d.claudeCodeLaunch");
    expect(LANDING_PAGE_HTML).toContain("open.disabled=!d.openCodeLaunch");
    expect(LANDING_PAGE_HTML).toContain("Folder picker unavailable on ");
    expect(LANDING_PAGE_HTML).toContain('id="platform-label"');
  });
});
