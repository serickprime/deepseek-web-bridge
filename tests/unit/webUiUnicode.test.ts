import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import fs from "node:fs";

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
    const encoded = Buffer.from(expected + "\r\n", "utf8");
    const splitAt = encoded.indexOf(Buffer.from("ё", "utf8")) + 1;

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
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
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

    const launched = launch(cwd, "deepseek-reasoner", vi.fn());

    expect(launched).toBe(child);
    expect(vi.mocked(childProcess.spawn).mock.calls[0]?.[2]).toMatchObject({ cwd });
    child.emit("close", 0);
  });
});
