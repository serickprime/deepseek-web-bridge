import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", async importOriginal => {
  const actual = await importOriginal() as Record<string, unknown>;
  return { ...actual, spawn: vi.fn() };
});

import * as childProcess from "node:child_process";
import { pickFolder } from "../../src/server/actions.js";

const originalPlatform = process.platform;

function fakeChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: PassThrough;
    stderr: PassThrough;
  };
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  return child;
}

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
}

afterEach(() => {
  Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
  vi.mocked(childProcess.spawn).mockReset();
});

describe("macOS folder picker", () => {
  it("preserves a Unicode path from osascript", async () => {
    setPlatform("darwin");
    const child = fakeChild();
    vi.mocked(childProcess.spawn).mockReturnValue(child as never);
    const resultPromise = pickFolder();
    child.stdout.end(Buffer.from("/Users/миша/Проекты/ёжик/\n", "utf8"));
    child.emit("close", 0);

    await expect(resultPromise).resolves.toEqual({
      path: "/Users/миша/Проекты/ёжик",
      cancelled: false,
      supported: true,
    });
    expect(vi.mocked(childProcess.spawn).mock.calls[0]?.[0]).toBe("osascript");
    expect(vi.mocked(childProcess.spawn).mock.calls[0]?.[1]).toEqual([
      "-e",
      'POSIX path of (choose folder with prompt "Select working directory")',
    ]);
    expect(vi.mocked(childProcess.spawn).mock.calls[0]?.[2]).toMatchObject({ shell: false });
  });

  it("returns cancelled=true for AppleScript user cancel", async () => {
    setPlatform("darwin");
    const child = fakeChild();
    vi.mocked(childProcess.spawn).mockReturnValue(child as never);
    const resultPromise = pickFolder();
    child.stderr.end("execution error: User canceled. (-128)\n");
    child.emit("close", 1);

    await expect(resultPromise).resolves.toEqual({ path: null, cancelled: true, supported: true });
  });
});

describe("Linux folder picker", () => {
  it("uses zenity first and preserves its Unicode path", async () => {
    setPlatform("linux");
    vi.mocked(childProcess.spawn).mockImplementation(() => {
      const child = fakeChild();
      process.nextTick(() => {
        child.stdout.end(Buffer.from("/home/миша/Проекты/ёжик\n", "utf8"));
        child.emit("close", 0);
      });
      return child as never;
    });

    await expect(pickFolder({ commandAvailable: async command => command === "zenity" })).resolves.toEqual({
      path: "/home/миша/Проекты/ёжик",
      cancelled: false,
      supported: true,
    });
    expect(vi.mocked(childProcess.spawn).mock.calls.map(call => call[0])).toEqual(["zenity"]);
    expect(vi.mocked(childProcess.spawn).mock.calls[0]?.[2]).toMatchObject({ shell: false });
  });

  it("falls back to kdialog when zenity is unavailable", async () => {
    setPlatform("linux");
    vi.mocked(childProcess.spawn).mockImplementation(() => {
      const child = fakeChild();
      process.nextTick(() => {
        child.stdout.end("/home/user/KDE folder\n");
        child.emit("close", 0);
      });
      return child as never;
    });

    await expect(pickFolder({ commandAvailable: async command => command === "kdialog" })).resolves.toEqual({
      path: "/home/user/KDE folder",
      cancelled: false,
      supported: true,
    });
    expect(vi.mocked(childProcess.spawn).mock.calls.map(call => call[0])).toEqual(["kdialog"]);
    expect(vi.mocked(childProcess.spawn).mock.calls[0]?.[2]).toMatchObject({ shell: false });
  });

  it("returns supported=false when neither zenity nor kdialog exists", async () => {
    setPlatform("linux");
    const checked: string[] = [];
    await expect(pickFolder({ commandAvailable: async command => {
      checked.push(command);
      return false;
    } })).resolves.toEqual({ path: null, cancelled: false, supported: false });
    expect(checked).toEqual(["zenity", "kdialog"]);
    expect(vi.mocked(childProcess.spawn)).not.toHaveBeenCalled();
  });
});
