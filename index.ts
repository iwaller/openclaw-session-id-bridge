import { spawn, type ChildProcess } from "node:child_process";
import { dirname, join } from "node:path";
import type { OpenClawPluginApi, OpenClawPluginModule } from "openclaw/plugin-sdk";

const MARKER_PREFIX = "[[OPENCLAW_SESSION_ID:";
const MARKER_SUFFIX = "]]";

let proxyProcess: ChildProcess | null = null;

function buildMarker(sessionId: string): string {
  return `${MARKER_PREFIX}${sessionId}${MARKER_SUFFIX}`;
}

function startProxy(api: OpenClawPluginApi, logger: { info: (...args: unknown[]) => void; warn: (...args: unknown[]) => void }): void {
  if (proxyProcess && !proxyProcess.killed) return;

  const proxyPath = join(dirname(api.source), "proxy.mjs");
  const child = spawn(process.execPath, [proxyPath], {
    env: {
      ...process.env,
      CRS_PROXY_HOST: process.env.CRS_PROXY_HOST || "127.0.0.1",
      CRS_PROXY_PORT: process.env.CRS_PROXY_PORT || "19090",
      CRS_PROXY_TARGET_BASE_URL: process.env.CRS_PROXY_TARGET_BASE_URL || "https://crs.plenty126.xyz/openai",
      CRS_PROXY_SESSION_KEY_FIELD: process.env.CRS_PROXY_SESSION_KEY_FIELD || "prompt_cache_key",
      CRS_PROXY_SESSION_HEADER_NAME: process.env.CRS_PROXY_SESSION_HEADER_NAME || "session_id",
      CRS_PROXY_SOURCE_SESSION_HEADER: process.env.CRS_PROXY_SOURCE_SESSION_HEADER || "x-openclaw-session-id",
      CRS_PROXY_MAX_BODY_BYTES: process.env.CRS_PROXY_MAX_BODY_BYTES || "20971520",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  child.stdout?.on("data", (buf) => {
    logger.info(`[openclaw-session-id-bridge] ${String(buf).trimEnd()}`);
  });
  child.stderr?.on("data", (buf) => {
    logger.warn(`[openclaw-session-id-bridge] ${String(buf).trimEnd()}`);
  });

  child.on("exit", (code, signal) => {
    logger.warn(`[openclaw-session-id-bridge] proxy exited (code=${code ?? "null"}, signal=${signal ?? "null"})`);
    if (proxyProcess === child) proxyProcess = null;
  });

  proxyProcess = child;
}

function stopProxy(logger: { info: (...args: unknown[]) => void }): void {
  if (!proxyProcess || proxyProcess.killed) return;
  proxyProcess.kill("SIGTERM");
  logger.info("[openclaw-session-id-bridge] proxy stop requested");
  proxyProcess = null;
}

const plugin: OpenClawPluginModule = {
  id: "openclaw-session-id-bridge",
  name: "OpenClaw Session ID Bridge",
  description: "Injects per-session marker and runs a local proxy to map OpenClaw session ID to upstream session_id header.",
  register(api: OpenClawPluginApi): void {
    api.on("before_prompt_build", async (_event, ctx) => {
      if (!ctx.sessionId) return;
      return {
        // The proxy strips this marker before forwarding upstream.
        prependSystemContext: buildMarker(ctx.sessionId),
      };
    });

    api.registerService({
      id: "openclaw-session-id-bridge-proxy",
      start: async (ctx) => {
        startProxy(api, ctx.logger);
      },
      stop: async (ctx) => {
        stopProxy(ctx.logger);
      },
    });
  },
};

export default plugin;
