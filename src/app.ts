import fs from "node:fs";
import { buildConfig, isLoopbackHostAddress } from "./config/env.js";
import { FileSessionStorage } from "./auth/storage.js";
import { SessionManager } from "./auth/sessionManager.js";
import { PowSolver } from "./deepseek/pow.js";
import { DeepSeekClient } from "./deepseek/client.js";
import type { AuthCredentials } from "./deepseek/client.js";
import { CompletionHandler } from "./api/handler.js";
import { SessionStore } from "./sessions/sessionStore.js";
import { LineageStore } from "./sessions/lineage.js";
import { PersistentSessionDocument } from "./sessions/persistentSessionDocument.js";
import { Redactor } from "./utils/redaction.js";
import { collectAuthSecrets } from "./utils/redaction.js";
import { Logger } from "./utils/logger.js";
import { isRecord } from "./utils/json.js";
import { BridgeServer } from "./server/server.js";
import type { RouteContext } from "./server/routes.js";
import { bridgeModelList } from "./config/modelCapabilities.js";

export interface AppHandle {
  server: BridgeServer;
  sessionManager: SessionManager;
  init: () => Promise<void>;
  stop: () => Promise<void>;
}

interface AuthFileShape {
  token?: unknown;
  cookie?: unknown;
  hifDliq?: unknown;
  hifLeim?: unknown;
  hif_dliq?: unknown;
  hif_leim?: unknown;
}

function loadAuthFile(file: string): AuthFileShape {
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    return isRecord(raw) ? (raw as AuthFileShape) : {};
  } catch {
    return {};
  }
}

export async function resetUpstreamAccountState(
  sessionStore: SessionStore,
  lineage: LineageStore,
): Promise<void> {
  sessionStore.clear();
  await lineage.clear();
}

export function buildApp(): AppHandle {
  const config = buildConfig();
  const redactor = new Redactor();
  const logger = new Logger({ level: config.debug ? "debug" : "info", redactor });

  const authData = loadAuthFile(config.authFile);
  const token = typeof authData.token === "string" ? authData.token : "";
  const cookie = typeof authData.cookie === "string" ? authData.cookie : "";
  const hifDliq = typeof authData.hifDliq === "string" ? authData.hifDliq
    : typeof authData.hif_dliq === "string" ? authData.hif_dliq : undefined;
  const hifLeim = typeof authData.hifLeim === "string" ? authData.hifLeim
    : typeof authData.hif_leim === "string" ? authData.hif_leim : undefined;

  for (const secret of collectAuthSecrets({ token, cookie, hif_dliq: hifDliq ?? "", hif_leim: hifLeim ?? "" })) {
    redactor.addSecret(secret);
  }

  const persistentSessions = new PersistentSessionDocument(config.sessionsFile);
  const sessionStorage = new FileSessionStorage(persistentSessions);
  const sessionManager = new SessionManager(sessionStorage, { logger });
  const sessionStore = new SessionStore();
  const lineage = new LineageStore(persistentSessions);
  let initialized = false;
  let initPromise: Promise<void> | null = null;
  const init = (): Promise<void> => {
    if (initPromise) return initPromise;
    initPromise = (async () => {
      await persistentSessions.init();
      await sessionManager.init();
      await lineage.init();
      initialized = true;
    })();
    return initPromise;
  };

  const solver = new PowSolver({
    wasmCacheDir: config.dataDir,
    logger,
  });

  const deepseek = new DeepSeekClient({
    baseUrl: config.baseUrl,
    auth: token || cookie ? { token, cookie, hifDliq, hifLeim } : null,
    sessionManager,
    solver,
    logger,
    redactor,
    timeoutMs: config.timeoutMs,
    maxRetries: config.proxyApiKey ? 2 : 0,
  });

  const handler = new CompletionHandler({ deepseek, sessionStore, lineage, logger });

  const routeContext: RouteContext = {
    security: {
      proxyApiKey: config.proxyApiKey,
      corsOrigins: config.corsOrigins,
      maxBytes: config.maxBytes,
      loopback: isLoopbackHostAddress(config.host),
    },
    handler,
    sessions: sessionManager,
    logger,
    redactor,
    models: bridgeModelList(),
    ready: () => initialized,
    setRuntimeAuth: async (auth: AuthCredentials) => {
      await resetUpstreamAccountState(sessionStore, lineage);
      deepseek.setAuth(auth);
    },
    clearRuntimeAuth: async () => {
      deepseek.clearAuth();
      await resetUpstreamAccountState(sessionStore, lineage);
    },
  };

  const server = new BridgeServer({
    host: config.host,
    port: config.port,
    logger,
    routeContext,
    beforeStart: init,
  });

  routeContext.gracefulStop = () => server.stop();

  return {
    server,
    sessionManager,
    init,
    stop: async () => {
      await server.stop();
    },
  };
}
