import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  writeJsonAtomic,
  readJsonIfExists,
  readJsonStrictIfExists,
  fileMode,
  isOwnerOnlyMode,
} from "../../src/utils/atomicFile.js";

let tmpDir: string;
const actualPlatform = process.platform;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "atomic-test-"));
});

afterEach(() => {
  Object.defineProperty(process, "platform", { value: actualPlatform });
  vi.restoreAllMocks();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("writeJsonAtomic", () => {
  it("writes and reads back JSON data", async () => {
    const file = path.join(tmpDir, "test.json");
    await writeJsonAtomic(file, { hello: "world" });
    const data = await readJsonIfExists(file);
    expect(data).toEqual({ hello: "world" });
  });

  it("overwrites existing file via atomic rename", async () => {
    const file = path.join(tmpDir, "test.json");
    await writeJsonAtomic(file, { v: 1 });
    await writeJsonAtomic(file, { v: 2 });
    const data = await readJsonIfExists(file);
    expect(data).toEqual({ v: 2 });
  });

  it("creates intermediate directories", async () => {
    const file = path.join(tmpDir, "sub", "dir", "test.json");
    await writeJsonAtomic(file, { ok: true });
    const data = await readJsonIfExists(file);
    expect(data).toEqual({ ok: true });
  });

  it("leaves no .tmp files after successful write", async () => {
    const file = path.join(tmpDir, "test.json");
    await writeJsonAtomic(file, { clean: true });
    const entries = fs.readdirSync(tmpDir);
    expect(entries).toEqual(["test.json"]);
  });

  it("uses unique temp names even when Date.now is unchanged", async () => {
    const file = path.join(tmpDir, "test.json");
    const originalWriteFile = fs.promises.writeFile.bind(fs.promises);
    const tempPaths: string[] = [];
    vi.spyOn(Date, "now").mockReturnValue(12345);
    vi.spyOn(fs.promises, "writeFile").mockImplementation(async (target, data, options) => {
      if (String(target).endsWith(".tmp")) tempPaths.push(String(target));
      await originalWriteFile(target, data, options);
    });

    await writeJsonAtomic(file, { step: 1 });
    await writeJsonAtomic(file, { step: 2 });

    expect(tempPaths).toHaveLength(2);
    expect(new Set(tempPaths).size).toBe(2);
    expect(fs.readdirSync(tmpDir)).toEqual(["test.json"]);
  });
});

describe("writeJsonAtomic — platform-specific behavior", () => {
  const originalPlatform = process.platform;

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform });
  });

  it("win32: does NOT call chmod", async () => {
    Object.defineProperty(process, "platform", { value: "win32" });
    const chmodSpy = vi.spyOn(fs.promises, "chmod");

    const file = path.join(tmpDir, "test.json");
    await writeJsonAtomic(file, { win: true }, 0o600);

    expect(chmodSpy).not.toHaveBeenCalled();
    chmodSpy.mockRestore();
  });

  it("win32: writes file without mode option", async () => {
    Object.defineProperty(process, "platform", { value: "win32" });

    const file = path.join(tmpDir, "test.json");
    await writeJsonAtomic(file, { data: 123 }, 0o600);
    const raw = await readJsonIfExists(file);
    expect(raw).toEqual({ data: 123 });
  });

  it("win32: re-write works without EPERM", async () => {
    Object.defineProperty(process, "platform", { value: "win32" });

    const file = path.join(tmpDir, "auth.json");
    await writeJsonAtomic(file, { step: 1 }, 0o600);
    await writeJsonAtomic(file, { step: 2 }, 0o600);
    await writeJsonAtomic(file, { step: 3 }, 0o600);
    const data = await readJsonIfExists(file);
    expect(data).toEqual({ step: 3 });
  });

  it("non-win32: calls chmod with specified mode", async () => {
    Object.defineProperty(process, "platform", { value: "linux" });
    const chmodSpy = vi.spyOn(fs.promises, "chmod");

    const file = path.join(tmpDir, "test.json");
    await writeJsonAtomic(file, { unix: true }, 0o600);

    expect(chmodSpy).toHaveBeenCalledWith(file, 0o600);
    chmodSpy.mockRestore();
  });

  it("non-win32: chmod is skipped when mode is undefined", async () => {
    Object.defineProperty(process, "platform", { value: "linux" });
    const chmodSpy = vi.spyOn(fs.promises, "chmod");

    const file = path.join(tmpDir, "test.json");
    await writeJsonAtomic(file, { no_mode: true });

    expect(chmodSpy).not.toHaveBeenCalled();
    chmodSpy.mockRestore();
  });
});

describe("writeJsonAtomic — atomic rename fallback", () => {
  it.each(["EPERM", "EEXIST"])("replaces through a recoverable backup on %s", async code => {
    const file = path.join(tmpDir, "target.json");
    fs.writeFileSync(file, JSON.stringify({ old: true }));
    const originalRename = fs.promises.rename;
    let callCount = 0;

    vi.spyOn(fs.promises, "rename").mockImplementation(async (src, dst) => {
      callCount++;
      if (callCount === 1 && String(dst).includes("target.json")) {
        const err = new Error(code) as NodeJS.ErrnoException;
        err.code = code;
        throw err;
      }
      return originalRename(src, dst);
    });

    await writeJsonAtomic(file, { new: true });
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(data).toEqual({ new: true });
    expect(fs.readdirSync(tmpDir)).toEqual(["target.json"]);
  });

  it("T6/T10: restores the old target when the second-stage rename fails", async () => {
    Object.defineProperty(process, "platform", { value: "win32" });
    const file = path.join(tmpDir, "target.json");
    fs.writeFileSync(file, JSON.stringify({ old: true }));
    const originalRename = fs.promises.rename;
    let callCount = 0;

    vi.spyOn(fs.promises, "rename").mockImplementation(async (src, dst) => {
      callCount++;
      if (callCount === 1) {
        const error = new Error("synthetic EPERM") as NodeJS.ErrnoException;
        error.code = "EPERM";
        throw error;
      }
      if (callCount === 3) {
        const error = new Error("synthetic EIO") as NodeJS.ErrnoException;
        error.code = "EIO";
        throw error;
      }
      return originalRename(src, dst);
    });

    await expect(writeJsonAtomic(file, { new: true })).rejects.toMatchObject({ code: "EIO" });
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({ old: true });
    expect(fs.readdirSync(tmpDir)).toEqual(["target.json"]);
  });

  it("T10: recovers a valid backup on a Unicode path after restart", async () => {
    const unicodeDir = path.join(tmpDir, "Тестовая папка ёжик");
    fs.mkdirSync(unicodeDir, { recursive: true });
    const file = path.join(unicodeDir, "sessions.json");
    fs.writeFileSync(`${file}.bak`, JSON.stringify({ old: true }));

    const result = await readJsonStrictIfExists(file);

    expect(result).toEqual({ exists: true, value: { old: true } });
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({ old: true });
    expect(fs.readdirSync(unicodeDir)).toEqual(["sessions.json"]);
  });
});

describe("fileMode and isOwnerOnlyMode", () => {
  it("fileMode returns permissions bits on unix, stat on windows", () => {
    const file = path.join(tmpDir, "perms.json");
    fs.writeFileSync(file, "{}");
    const mode = fileMode(file);
    if (process.platform === "win32") {
      expect(mode).not.toBeNull();
    } else {
      fs.chmodSync(file, 0o600);
      expect(fileMode(file)).toBe(0o600);
    }
  });

  it("fileMode returns null for nonexistent file", () => {
    expect(fileMode(path.join(tmpDir, "nope.json"))).toBeNull();
  });

  it("isOwnerOnlyMode returns true for 0600", () => {
    expect(isOwnerOnlyMode(0o600)).toBe(true);
  });

  it("isOwnerOnlyMode returns false for 0644", () => {
    expect(isOwnerOnlyMode(0o644)).toBe(false);
  });

  it("isOwnerOnlyMode returns false for null", () => {
    expect(isOwnerOnlyMode(null)).toBe(false);
  });
});
