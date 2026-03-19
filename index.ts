import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { OpenClawPluginApi, OpenClawPluginModule } from "openclaw/plugin-sdk";

const MARKER_PREFIX = "[[OPENCLAW_SESSION_ID:";
const MARKER_SUFFIX = "]]";
const DEFAULT_PROXY_HOST = "127.0.0.1";
const DEFAULT_PROXY_PORT = 19090;

type Logger = {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
};

let proxyProcess: ChildProcess | null = null;

function buildMarker(sessionId: string): string {
  return `${MARKER_PREFIX}${sessionId}${MARKER_SUFFIX}`;
}

function parsePort(value: unknown): number | null {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) return null;
  return parsed;
}

function readProxyPortFromConfig(configPath: string): number | null {
  if (!existsSync(configPath)) return null;
  try {
    const raw = readFileSync(configPath, "utf8").trim();
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { proxy?: { port?: unknown } };
    return parsePort(parsed?.proxy?.port);
  } catch {
    return null;
  }
}

function resolveProxyTarget(api: OpenClawPluginApi): { host: string; port: number } {
  const envPort = parsePort(process.env.CRS_PROXY_PORT);
  const configPath = join(dirname(api.source), "config.json");
  const configPort = readProxyPortFromConfig(configPath);

  return {
    host: process.env.CRS_PROXY_HOST || DEFAULT_PROXY_HOST,
    port: envPort ?? configPort ?? DEFAULT_PROXY_PORT,
  };
}

function normalizeHostCandidates(configuredHost: string): Set<string> {
  const normalized = (configuredHost || "").trim().toLowerCase();
  const hostCandidates = new Set<string>();

  if (normalized) hostCandidates.add(normalized);

  // Client-side provider URLs usually target loopback addresses.
  if (!normalized || normalized === "0.0.0.0" || normalized === "::" || normalized === "::0") {
    hostCandidates.add("127.0.0.1");
    hostCandidates.add("localhost");
    hostCandidates.add("::1");
    return hostCandidates;
  }

  if (normalized === "127.0.0.1" || normalized === "localhost" || normalized === "::1") {
    hostCandidates.add("127.0.0.1");
    hostCandidates.add("localhost");
    hostCandidates.add("::1");
  }

  return hostCandidates;
}

function collectUrlLikeValues(value: unknown, depth = 0, out: string[] = []): string[] {
  if (value == null || depth > 5) return out;

  if (typeof value === "string") {
    if (value.includes("://")) out.push(value);
    return out;
  }

  if (Array.isArray(value)) {
    for (const item of value) collectUrlLikeValues(item, depth + 1, out);
    return out;
  }

  if (typeof value !== "object") return out;

  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const lowerKey = key.toLowerCase();
    if (lowerKey === "input" || lowerKey === "messages" || lowerKey === "content" || lowerKey === "prompt") continue;

    if (typeof child === "string") {
      if (
        lowerKey.includes("url") ||
        lowerKey.includes("endpoint") ||
        lowerKey.includes("base") ||
        lowerKey.includes("host")
      ) {
        out.push(child);
      }
      continue;
    }

    collectUrlLikeValues(child, depth + 1, out);
  }

  return out;
}

function isProxyUrl(raw: string, hostCandidates: Set<string>, port: number): boolean {
  try {
    const url = new URL(raw);
    const hostname = url.hostname.toLowerCase();
    const urlPort = Number(url.port || (url.protocol === "https:" ? 443 : 80));
    return hostCandidates.has(hostname) && urlPort === port;
  } catch {
    return false;
  }
}

function shouldInjectForRequest(event: unknown, ctx: unknown, proxyTarget: { host: string; port: number }): boolean {
  const hostCandidates = normalizeHostCandidates(proxyTarget.host);
  const candidates = collectUrlLikeValues({ event, ctx });
  if (candidates.length === 0) return false;
  return candidates.some((value) => isProxyUrl(value, hostCandidates, proxyTarget.port));
}

function startProxy(api: OpenClawPluginApi, logger: Logger): void {
  if (proxyProcess && !proxyProcess.killed) return;
  const proxyPath = join(dirname(api.source), "proxy.mjs");
  const child = spawn(process.execPath, [proxyPath], {
    env: {
      ...process.env,
      CRS_PROXY_HOST: process.env.CRS_PROXY_HOST || "127.0.0.1",

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

function stopProxy(logger: Logger): void {
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
    const proxyTarget = resolveProxyTarget(api);

    api.on("before_prompt_build", async (event, ctx) => {
      if (!ctx.sessionId) return;
      if (!shouldInjectForRequest(event, ctx, proxyTarget)) return;

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
