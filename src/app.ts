import fs from "node:fs";
import { buildConfig, isLoopbackHostAddress } from "./config/env.js";
import { FileSessionStorage } from "./auth/storage.js";
import { SessionManager } from "./auth/sessionManager.js";
import { PowSolver } from "./deepseek/pow.js";
import { DeepSeekClient } from "./deepseek/client.js";
import { CompletionHandler } from "./api/handler.js";
import { SessionStore } from "./sessions/sessionStore.js";
import { LineageStore } from "./sessions/lineage.js";
import { Redactor } from "./utils/redaction.js";
import { collectAuthSecrets } from "./utils/redaction.js";
import { Logger } from "./utils/logger.js";
import { isRecord } from "./utils/json.js";
import { BridgeServer } from "./server/server.js";
import type { RouteContext } from "./server/routes.js";

export interface AppHandle {
  server: BridgeServer;
  sessionManager: SessionManager;
  stop: () => Promise<void>;
}

interface AuthFileShape {
  token?: unknown;
  cookie?: unknown;
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

export function buildApp(): AppHandle {
  const config = buildConfig();
  const redactor = new Redactor();
  const logger = new Logger({ level: config.debug ? "debug" : "info", redactor });

  const authData = loadAuthFile(config.authFile);
  const token = typeof authData.token === "string" ? authData.token : "";
  const cookie = typeof authData.cookie === "string" ? authData.cookie : "";
  const hifDliq = typeof authData.hif_dliq === "string" ? authData.hif_dliq : undefined;
  const hifLeim = typeof authData.hif_leim === "string" ? authData.hif_leim : undefined;

  if (!token && !cookie) {
    throw new Error(
      `No credentials found in ${config.authFile}. Run \`npm run auth\` first.`,
    );
  }

  for (const secret of collectAuthSecrets({ token, cookie, hif_dliq: hifDliq ?? "", hif_leim: hifLeim ?? "" })) {
    redactor.addSecret(secret);
  }

  const sessionStorage = new FileSessionStorage(config.sessionsFile);
  const sessionManager = new SessionManager(sessionStorage, { logger });
  const sessionStore = new SessionStore();
  const lineage = new LineageStore(config.sessionsFile);

  const solver = new PowSolver({
    wasmCacheDir: config.dataDir,
    logger,
  });

  const deepseek = new DeepSeekClient({
    baseUrl: config.baseUrl,
    auth: { token, cookie, hifDliq, hifLeim },
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
    models: [
      { id: "deepseek-chat", object: "model", owned_by: "deepseek" },
      { id: "deepseek-reasoner", object: "model", owned_by: "deepseek" },
    ],
    ready: () => sessionManager.listSessions().length >= 0,
  };

  const server = new BridgeServer({
    host: config.host,
    port: config.port,
    logger,
    routeContext,
  });

  return {
    server,
    sessionManager,
    stop: async () => {
      await server.stop();
    },
  };
}
