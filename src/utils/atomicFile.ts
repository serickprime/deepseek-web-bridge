import fs from "node:fs";
import path from "node:path";

function tempSiblingPath(file: string): string {
  return `${file}.${process.pid}.${Date.now()}.tmp`;
}

export async function writeJsonAtomic(file: string, data: unknown, mode?: number): Promise<void> {
  const dir = path.dirname(file);
  await fs.promises.mkdir(dir, { recursive: true });
  const temp = tempSiblingPath(file);
  const body = JSON.stringify(data, null, 2);
  await fs.promises.writeFile(temp, body, { encoding: "utf8", mode });
  try {
    await fs.promises.rename(temp, file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST" ||
        (error as NodeJS.ErrnoException).code === "EPERM") {
      await fs.promises.unlink(file).catch(() => undefined);
      await fs.promises.rename(temp, file);
    } else {
      throw error;
    }
  }
  if (mode !== undefined) {
    await fs.promises.chmod(file, mode).catch(() => undefined);
  }
}

export async function readJsonIfExists(file: string): Promise<unknown> {
  try {
    const raw = await fs.promises.readFile(file, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function fileMode(file: string): number | null {
  try {
    const stat = fs.statSync(file);
    return stat.mode & 0o777;
  } catch {
    return null;
  }
}

export function isOwnerOnlyMode(mode: number | null): boolean {
  return mode !== null && (mode & 0o077) === 0;
}
