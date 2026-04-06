import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { OpenClawPluginApi, OpenClawPluginModule } from "openclaw/plugin-sdk";

const MARKER_PREFIX = "[[OPENCLAW_SESSION_ID:";
const MARKER_SUFFIX = "]]";
const DEFAULT_PROXY_HOST = "127.0.0.1";
const DEFAULT_PROXY_PORT = 19090;
const DEFAULT_PROVIDER_IDS = ["crs"];
const DEFAULT_SESSION_HEADER_NAME = "session_id";
const DEFAULT_SOURCE_SESSION_HEADER = "x-openclaw-session-id";
const DEFAULT_SESSION_PLACEHOLDER = "{{session_id}}";

type Logger = {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
};

type BridgeLogFn = (level: "info" | "warn", event: string, details?: Record<string, unknown>) => void;

type BridgeConfigFile = {
  proxy?: {
    enabled?: boolean;
    host?: string;
    port?: unknown;
  };
  bridge?: {
    enabled?: boolean;
    providers?: unknown;
    sessionHeaderName?: unknown;
    sourceSessionHeaderName?: unknown;
    setSourceHeader?: unknown;
    requireSourceHeader?: unknown;
    sessionPlaceholder?: unknown;
    legacyPromptMarker?: unknown;
  };
};

type RuntimeConfig = {
  proxyEnabled: boolean;
  proxyHost: string;
  proxyPort: number;
  bridgeEnabled: boolean;
  providerIds: string[];
  sessionHeaderName: string;
  sourceSessionHeaderName: string;
  setSourceHeader: boolean;
  requireSourceHeader: boolean;
  sessionPlaceholder: string;
  legacyPromptMarker: boolean;
};

let proxyProcess: ChildProcess | null = null;
const missingSessionLogByProvider = new Set<string>();
const placeholderLogByProvider = new Set<string>();

function parsePort(value: unknown): number | null {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) return null;
  return parsed;
}

function parseBool(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return undefined;
  if (normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on") {
    return true;
  }
  if (normalized === "0" || normalized === "false" || normalized === "no" || normalized === "off") {
    return false;
  }
  return undefined;
}

function parseString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function parseStringList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map((entry) => parseString(entry))
      .filter((entry): entry is string => Boolean(entry));
  }

  if (typeof value === "string") {
    return value
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);
  }

  return [];
}

function dedupe(list: string[]): string[] {
  return [...new Set(list)];
}

function readConfig(configPath: string): BridgeConfigFile {
  if (!existsSync(configPath)) return {};
  try {
    const raw = readFileSync(configPath, "utf8").trim();
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as BridgeConfigFile;
  } catch {
    return {};
  }
}

function readEnvProviderIds(): string[] {
  const fromProviderIds = parseStringList(process.env.CRS_BRIDGE_PROVIDER_IDS);
  const fromProviderId = parseString(process.env.CRS_BRIDGE_PROVIDER_ID);
  return dedupe([...fromProviderIds, ...(fromProviderId ? [fromProviderId] : [])]);
}

function resolveRuntimeConfig(api: OpenClawPluginApi): RuntimeConfig {
  const configPath = join(dirname(api.source), "config.json");
  const fileConfig = readConfig(configPath);

  const envProxyEnabled = parseBool(process.env.CRS_PROXY_ENABLED);
  const fileProxyEnabled = parseBool(fileConfig.proxy?.enabled);

  const envProxyHost = parseString(process.env.CRS_PROXY_HOST);
  const fileProxyHost = parseString(fileConfig.proxy?.host);

  const envProxyPort = parsePort(process.env.CRS_PROXY_PORT);
  const fileProxyPort = parsePort(fileConfig.proxy?.port);

  const envBridgeEnabled = parseBool(process.env.CRS_BRIDGE_ENABLED);
  const fileBridgeEnabled = parseBool(fileConfig.bridge?.enabled);

  const envProviderIds = readEnvProviderIds();
  const fileProviderIds = parseStringList(fileConfig.bridge?.providers);

  const envSessionHeaderName = parseString(process.env.CRS_PROXY_SESSION_HEADER_NAME);
  const fileSessionHeaderName = parseString(fileConfig.bridge?.sessionHeaderName);

  const envSourceSessionHeaderName = parseString(process.env.CRS_PROXY_SOURCE_SESSION_HEADER);
  const fileSourceSessionHeaderName = parseString(fileConfig.bridge?.sourceSessionHeaderName);

  const envSetSourceHeader = parseBool(process.env.CRS_BRIDGE_SET_SOURCE_HEADER);
  const fileSetSourceHeader = parseBool(fileConfig.bridge?.setSourceHeader);

  const envRequireSourceHeader = parseBool(process.env.CRS_BRIDGE_REQUIRE_SOURCE_HEADER);
  const fileRequireSourceHeader = parseBool(fileConfig.bridge?.requireSourceHeader);

  const envSessionPlaceholder = parseString(process.env.CRS_BRIDGE_SESSION_PLACEHOLDER);
  const fileSessionPlaceholder = parseString(fileConfig.bridge?.sessionPlaceholder);

  const envLegacyPromptMarker = parseBool(process.env.CRS_BRIDGE_LEGACY_PROMPT_MARKER);
  const fileLegacyPromptMarker = parseBool(fileConfig.bridge?.legacyPromptMarker);

  const providerIds = dedupe(
    envProviderIds.length > 0
      ? envProviderIds
      : fileProviderIds.length > 0
        ? fileProviderIds
        : DEFAULT_PROVIDER_IDS,
  );

  const requireSourceHeader = envRequireSourceHeader ?? fileRequireSourceHeader ?? false;
  const setSourceHeader = requireSourceHeader
    ? true
    : (envSetSourceHeader ?? fileSetSourceHeader ?? true);

  return {
    proxyEnabled: envProxyEnabled ?? fileProxyEnabled ?? true,
    proxyHost: envProxyHost ?? fileProxyHost ?? DEFAULT_PROXY_HOST,
    proxyPort: envProxyPort ?? fileProxyPort ?? DEFAULT_PROXY_PORT,
    bridgeEnabled: envBridgeEnabled ?? fileBridgeEnabled ?? true,
    providerIds,
    sessionHeaderName: envSessionHeaderName ?? fileSessionHeaderName ?? DEFAULT_SESSION_HEADER_NAME,
    sourceSessionHeaderName:
      envSourceSessionHeaderName ?? fileSourceSessionHeaderName ?? DEFAULT_SOURCE_SESSION_HEADER,
    setSourceHeader,
    requireSourceHeader,
    sessionPlaceholder: envSessionPlaceholder ?? fileSessionPlaceholder ?? DEFAULT_SESSION_PLACEHOLDER,
    legacyPromptMarker: envLegacyPromptMarker ?? fileLegacyPromptMarker ?? false,
  };
}

function buildMarker(sessionId: string): string {
  return `${MARKER_PREFIX}${sessionId}${MARKER_SUFFIX}`;
}

function createBridgeLogger(api: OpenClawPluginApi): BridgeLogFn {
  const pluginDir = dirname(api.source);
  const envLogFile = parseString(process.env.CRS_BRIDGE_LOG_FILE);
  const logFile = envLogFile
    ? (envLogFile.startsWith("/") ? envLogFile : join(pluginDir, envLogFile))
    : join(pluginDir, "bridge.log");

  return (level, event, details) => {
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      level,
      event,
      ...(details ? { details } : {}),
    });

    try {
      appendFileSync(logFile, `${line}\n`, "utf8");
    } catch {
      // Do not break requests if local logging fails.
    }
  };
}

function setHeaderIfMissingCaseInsensitive(
  headers: Record<string, string>,
  headerName: string,
  headerValue: string,
): void {
  const lower = headerName.toLowerCase();
  const existing = Object.keys(headers).some((name) => name.toLowerCase() === lower);
  if (!existing) headers[headerName] = headerValue;
}

function headersContainPlaceholder(headers: Record<string, string>, placeholder: string): boolean {
  if (!placeholder) return false;
  return Object.values(headers).some((value) => typeof value === "string" && value.includes(placeholder));
}

function replacePlaceholderInHeaders(headers: Record<string, string>, placeholder: string, sessionId: string): number {
  if (!placeholder || !sessionId) return 0;

  let replaced = 0;
  for (const [name, value] of Object.entries(headers)) {
    if (typeof value !== "string" || !value.includes(placeholder)) continue;
    headers[name] = value.split(placeholder).join(sessionId);
    replaced += 1;
  }

  return replaced;
}

function registerProviderHeaderBridge(
  api: OpenClawPluginApi,
  runtimeConfig: RuntimeConfig,
  bridgeLog: BridgeLogFn,
): void {
  if (!runtimeConfig.bridgeEnabled) return;

  for (const providerId of runtimeConfig.providerIds) {
    api.registerProvider({
      id: providerId,
      label: `Session Header Bridge (${providerId})`,
      auth: [],
      wrapStreamFn: (ctx) => {
        const inner = ctx.streamFn;
        if (!inner) return undefined;

        return (model, context, options) => {
          const directSessionId = typeof options?.sessionId === "string" ? options.sessionId.trim() : "";
          const rawFallback = (options as Record<string, unknown> | undefined)?.["prompt_cache_key"];
          const fallbackSessionId =
            typeof rawFallback === "string"
              ? rawFallback.trim()
              : (typeof rawFallback === "number" ? String(rawFallback) : "");

          const sessionId = directSessionId || fallbackSessionId;

          const headers: Record<string, string> = {
            ...(options?.headers ?? {}),
          };

          if (!sessionId) {
            if (headersContainPlaceholder(headers, runtimeConfig.sessionPlaceholder)) {
              const message =
                `[openclaw-session-id-bridge] unresolved placeholder '${runtimeConfig.sessionPlaceholder}' for provider '${providerId}' because options.sessionId is empty`;
              console.warn(message);
              bridgeLog("warn", "unresolved_placeholder", {
                providerId,
                placeholder: runtimeConfig.sessionPlaceholder,
              });
            }

            if (!missingSessionLogByProvider.has(providerId)) {
              missingSessionLogByProvider.add(providerId);
              const message =
                `[openclaw-session-id-bridge] missing session id for provider '${providerId}' (options.sessionId and prompt_cache_key are empty)`;
              console.warn(message);
              bridgeLog("warn", "missing_session_id", {
                providerId,
                requireSourceHeader: runtimeConfig.requireSourceHeader,
              });
            }

            return inner(model, context, options);
          }

          if (!directSessionId && fallbackSessionId) {
            const message =
              `[openclaw-session-id-bridge] provider '${providerId}' fell back to prompt_cache_key because options.sessionId is empty`;
            console.warn(message);
            bridgeLog("warn", "fallback_prompt_cache_key", {
              providerId,
              sessionId,
            });
          }

          // Explicitly print session_id for debugging/tracing at runtime.
          console.info(`[openclaw-session-id-bridge] provider='${providerId}' session_id='${sessionId}'`);
          bridgeLog("info", "session_id_resolved", {
            providerId,
            sessionId,
            source: directSessionId ? "options.sessionId" : "prompt_cache_key",
          });

          const replacedCount = replacePlaceholderInHeaders(headers, runtimeConfig.sessionPlaceholder, sessionId);
          if (replacedCount > 0 && !placeholderLogByProvider.has(providerId)) {
            placeholderLogByProvider.add(providerId);
            console.info(
              `[openclaw-session-id-bridge] placeholder '${runtimeConfig.sessionPlaceholder}' replaced in ${replacedCount} header(s) for provider '${providerId}'`,
            );
          }

          if (replacedCount > 0) {
            bridgeLog("info", "placeholder_replaced", {
              providerId,
              placeholder: runtimeConfig.sessionPlaceholder,
              replacedCount,
              sessionId,
            });
          }

          setHeaderIfMissingCaseInsensitive(headers, runtimeConfig.sessionHeaderName, sessionId);
          if (runtimeConfig.setSourceHeader) {
            setHeaderIfMissingCaseInsensitive(headers, runtimeConfig.sourceSessionHeaderName, sessionId);
          }

          return inner(model, context, {
            ...options,
            headers,
          });
        };
      },
    });
  }
}

function startProxy(api: OpenClawPluginApi, logger: Logger, runtimeConfig: RuntimeConfig): void {
  if (!runtimeConfig.proxyEnabled) {
    logger.info("[openclaw-session-id-bridge] proxy disabled by config");
    return;
  }

  if (proxyProcess && !proxyProcess.killed) return;
  const proxyPath = join(dirname(api.source), "proxy.mjs");
  const child = spawn(process.execPath, [proxyPath], {
    env: {
      ...process.env,
      CRS_PROXY_HOST: runtimeConfig.proxyHost,
      CRS_PROXY_PORT: String(runtimeConfig.proxyPort),
      CRS_PROXY_SESSION_HEADER_NAME: runtimeConfig.sessionHeaderName,
      CRS_PROXY_SOURCE_SESSION_HEADER: runtimeConfig.sourceSessionHeaderName,
      CRS_PROXY_REQUIRE_SOURCE_SESSION_HEADER: runtimeConfig.requireSourceHeader ? "1" : "0",
      CRS_PROXY_SESSION_KEY_FIELD: process.env.CRS_PROXY_SESSION_KEY_FIELD || "prompt_cache_key",
      CRS_PROXY_MAX_BODY_BYTES: process.env.CRS_PROXY_MAX_BODY_BYTES || "20971520",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  logger.info(
    `[openclaw-session-id-bridge] proxy start host=${runtimeConfig.proxyHost} port=${runtimeConfig.proxyPort} sessionHeader=${runtimeConfig.sessionHeaderName} sourceHeader=${runtimeConfig.sourceSessionHeaderName} requireSourceHeader=${runtimeConfig.requireSourceHeader}`,
  );

  child.stdout?.on("data", (buf) => {
    logger.info(`[openclaw-session-id-bridge] ${String(buf).trimEnd()}`);
  });
  child.stderr?.on("data", (buf) => {
    logger.warn(`[openclaw-session-id-bridge] ${String(buf).trimEnd()}`);
  });

  child.on("exit", (code, signal) => {
    logger.warn(
      `[openclaw-session-id-bridge] proxy exited (code=${code ?? "null"}, signal=${signal ?? "null"})`,
    );
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
  description:
    "Injects per-request session_id headers from OpenClaw sessionId and optionally runs a local routing proxy.",
  register(api: OpenClawPluginApi): void {
    const runtimeConfig = resolveRuntimeConfig(api);

    const bridgeLog = createBridgeLogger(api);

    console.info(
      `[openclaw-session-id-bridge] init providers=${runtimeConfig.providerIds.join(",")} bridgeEnabled=${runtimeConfig.bridgeEnabled} proxyEnabled=${runtimeConfig.proxyEnabled} requireSourceHeader=${runtimeConfig.requireSourceHeader} sessionPlaceholder=${runtimeConfig.sessionPlaceholder}`,
    );
    bridgeLog("info", "init", {
      providers: runtimeConfig.providerIds,
      bridgeEnabled: runtimeConfig.bridgeEnabled,
      proxyEnabled: runtimeConfig.proxyEnabled,
      requireSourceHeader: runtimeConfig.requireSourceHeader,
      sessionPlaceholder: runtimeConfig.sessionPlaceholder,
    });

    registerProviderHeaderBridge(api, runtimeConfig, bridgeLog);

    if (runtimeConfig.legacyPromptMarker) {
      api.on("before_prompt_build", async (_event, ctx) => {
        if (!ctx.sessionId) return;
        return {
          prependSystemContext: buildMarker(ctx.sessionId),
        };
      });
    }

    api.registerService({
      id: "openclaw-session-id-bridge-proxy",
      start: async (ctx) => {
        startProxy(api, ctx.logger, runtimeConfig);
      },
      stop: async (ctx) => {
        stopProxy(ctx.logger);
      },
    });
  },
};

export default plugin;
