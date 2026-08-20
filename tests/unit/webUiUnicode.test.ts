import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return { ...actual, spawn: vi.fn() };
});

import * as childProcess from "node:child_process";
import { launchClaudeCode, launchOpenCode, pickFolder } from "../../src/server/actions.js";

function fakeChild(): EventEmitter & {
  stdout: PassThrough;
  pid: number;
  kill: ReturnType<typeof vi.fn>;
  unref: ReturnType<typeof vi.fn>;
} {
  const child = new EventEmitter() as EventEmitter & {
    stdout: PassThrough;
    pid: number;
    kill: ReturnType<typeof vi.fn>;
    unref: ReturnType<typeof vi.fn>;
  };
  child.stdout = new PassThrough();
  child.pid = 43210;
  child.kill = vi.fn(() => true);
  child.unref = vi.fn();
  return child;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Windows folder picker UTF-8", () => {
  it("preserves a Cyrillic path even when a multibyte character is split across stdout chunks", async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    const child = fakeChild();
    vi.mocked(childProcess.spawn).mockReturnValue(child as never);
    const expected = "D:\\Проекты\\Тестовая папка\\ёжик";
    const encoded = Buffer.from(Buffer.from(expected, "utf8").toString("base64") + "\r\n", "ascii");
    const splitAt = Math.floor(encoded.length / 2);

    try {
      const resultPromise = pickFolder();
      child.stdout.write(encoded.subarray(0, splitAt));
      child.stdout.write(encoded.subarray(splitAt));
      child.stdout.end();
      child.emit("close", 0);
      const result = await resultPromise;

      expect(result).toEqual({ path: expected, cancelled: false, supported: true });
      const spawnArgs = vi.mocked(childProcess.spawn).mock.calls[0];
      expect(spawnArgs?.[1]).toContain("-STA");
      expect(String(spawnArgs?.[1])).toContain("[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)");
      expect(String(spawnArgs?.[1])).toContain("$OutputEncoding = [Console]::OutputEncoding");
      expect(String(spawnArgs?.[1])).toContain("ToBase64String");
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
    }
  });

  it("repairs a mojibake FolderBrowserDialog path only when the repaired directory exists", async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "bridge-picker-"));
    const expected = path.join(root, "Тестовая папка ёжик");
    await fs.promises.mkdir(expected);
    const mojibake = Buffer.from(expected, "utf8").toString("latin1");
    const child = fakeChild();
    vi.mocked(childProcess.spawn).mockReturnValue(child as never);

    try {
      const resultPromise = pickFolder();
      child.stdout.end(Buffer.from(Buffer.from(mojibake, "utf8").toString("base64") + "\r\n", "ascii"));
      child.emit("close", 0);

      await expect(resultPromise).resolves.toEqual({ path: expected, cancelled: false, supported: true });
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
      await fs.promises.rm(root, { recursive: true, force: true });
    }
  });
});

describe("launcher Unicode cwd", () => {
  it.each([
    ["Claude Code", launchClaudeCode],
    ["OpenCode", launchOpenCode],
  ])("passes the exact Unicode cwd to %s", (_name, launch) => {
    const cwd = "D:\\Проекты\\Тестовая папка\\ёжик";
    const child = fakeChild();
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    vi.mocked(childProcess.spawn).mockReturnValue(child as never);

    const launched = launch(cwd, "deepseek-reasoner", vi.fn(), { platform: "win32" });

    expect(launched).toBe(child);
    expect(vi.mocked(childProcess.spawn).mock.calls[0]?.[2]).toMatchObject({ cwd });
    child.emit("close", 0);
  });

  it("returns a clear Windows error when the CLI executable is missing", () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    const cwd = "D:\\Проекты\\Тестовая папка\\ёжик";
    vi.spyOn(fs, "existsSync").mockImplementation(target => String(target) === cwd);
    const send = vi.fn();

    try {
      expect(launchClaudeCode(cwd, "deepseek-chat", send)).toBeNull();
      expect(send).toHaveBeenCalledWith({
        type: "error",
        message: "claude executable was not found in the Bridge PATH. Install it or start it manually.",
      });
      expect(childProcess.spawn).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
    }
  });
});
