import { readJsonIfExists, writeJsonAtomic } from "../utils/atomicFile.js";
import { isRecord } from "../utils/json.js";
import type { AuthSession, SessionMap } from "./session.js";

export interface SessionStorage {
  load(): Promise<SessionMap>;
  save(map: SessionMap): Promise<void>;
}

const SESSION_FILE_VERSION = 1;

interface SessionFileShape {
  version: number;
  sessions: AuthSession[];
}

function isAuthSession(value: unknown): value is AuthSession {
  return (
    isRecord(value) &&
    typeof value.sessionId === "string" &&
    typeof value.sidCookie === "string" &&
    typeof value.createdAt === "number" &&
    typeof value.updatedAt === "number"
  );
}

function normalizeFile(value: unknown): SessionMap {
  if (!isRecord(value)) return {};
  if (!Array.isArray(value.sessions)) return {};
  const map: SessionMap = {};
  for (const raw of value.sessions) {
    if (!isAuthSession(raw)) continue;
    map[raw.sessionId] = raw;
  }
  return map;
}

export class FileSessionStorage implements SessionStorage {
  constructor(private readonly file: string) {}

  async load(): Promise<SessionMap> {
    const raw = await readJsonIfExists(this.file);
    return normalizeFile(raw);
  }

  async save(map: SessionMap): Promise<void> {
    const payload: SessionFileShape = {
      version: SESSION_FILE_VERSION,
      sessions: Object.values(map),
    };
    await writeJsonAtomic(this.file, payload, 0o600);
  }
}
