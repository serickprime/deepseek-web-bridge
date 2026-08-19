import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeJsonAtomic, readJsonIfExists, fileMode, isOwnerOnlyMode } from "../../src/utils/atomicFile.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "atomic-test-"));
});

afterEach(() => {
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
  it("retries rename on EPERM by unlinking target first", async () => {
    const file = path.join(tmpDir, "target.json");
    fs.writeFileSync(file, JSON.stringify({ old: true }));
    const originalRename = fs.promises.rename;
    let callCount = 0;

    vi.spyOn(fs.promises, "rename").mockImplementation(async (src, dst) => {
      callCount++;
      if (callCount === 1 && String(dst).includes("target.json")) {
        const err = new Error("EPERM") as NodeJS.ErrnoException;
        err.code = "EPERM";
        throw err;
      }
      return originalRename(src, dst);
    });

    await writeJsonAtomic(file, { new: true });
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(data).toEqual({ new: true });
    vi.restoreAllMocks();
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
