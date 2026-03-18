#!/usr/bin/env node
import crypto from "node:crypto";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { dirname, join } from "node:path";
import { fileURLToPath, URL } from "node:url";

const LISTEN_HOST = process.env.CRS_PROXY_HOST || "127.0.0.1";
const LISTEN_PORT = Number(process.env.CRS_PROXY_PORT || 19090);
const TARGET_BASE_URL = process.env.CRS_PROXY_TARGET_BASE_URL || "https://crs.plenty126.xyz/openai";
const PROXY_DIR = dirname(fileURLToPath(import.meta.url));
const CONFIG_FILE = process.env.CRS_PROXY_CONFIG_FILE || join(PROXY_DIR, "config.json");
const SESSION_KEY_FIELD = process.env.CRS_PROXY_SESSION_KEY_FIELD || "prompt_cache_key";
const SESSION_HEADER_NAME = process.env.CRS_PROXY_SESSION_HEADER_NAME || "session_id";
const SOURCE_SESSION_HEADER = process.env.CRS_PROXY_SOURCE_SESSION_HEADER || "x-openclaw-session-id";
const MAX_BODY_BYTES = Number(process.env.CRS_PROXY_MAX_BODY_BYTES || 20 * 1024 * 1024);

const MARKER_RE = /\[\[OPENCLAW_SESSION_ID:([^\]]+)\]\]/g;

function trimTrailingSlash(pathname) {
  if (pathname.length > 1 && pathname.endsWith("/")) return pathname.slice(0, -1);
  return pathname;
}

function normalizePrefix(rawPrefix) {
  const value = String(rawPrefix || "").trim();
  if (!value || value === "/") return "/";
  const prefixed = value.startsWith("/") ? value : `/${value}`;
  return trimTrailingSlash(prefixed);
}

function parseRequestUrl(urlPath) {
  try {
    return new URL(urlPath || "/", "http://proxy.local");
  } catch {
    return new URL("/", "http://proxy.local");
  }
}

function normalizeSessionId(raw) {
  const value = String(raw || "").trim();
  if (!value) return "";
  if (value.length <= 128 && /^[\x20-\x7E]+$/.test(value)) return value;
  const digest = crypto.createHash("sha256").update(value).digest("hex");
  return `pk_${digest.slice(0, 32)}`;
}

function getHeaderValue(headers, name) {
  const value = headers?.[name.toLowerCase()];
  if (Array.isArray(value)) return value[0] || "";
  if (typeof value === "string") return value;
  return "";
}

function extractSessionKey(payload) {
  if (!payload || typeof payload !== "object") return "";
  const direct = payload?.[SESSION_KEY_FIELD];
  if (typeof direct === "string") return direct;
  if (typeof direct === "number") return String(direct);
  return "";
}

function stripMarkerFromText(text) {
  if (typeof text !== "string") return { text, marker: "" };
  let marker = "";
  const cleaned = text.replace(MARKER_RE, (_all, capture) => {
    if (!marker && typeof capture === "string" && capture.trim()) marker = capture.trim();
    return "";
  });
  return { text: cleaned, marker };
}

function extractMarkerAndSanitizePayload(payload) {
  let marker = "";
  if (!payload || typeof payload !== "object") return { payload, marker };

  const input = payload.input;
  if (!Array.isArray(input)) return { payload, marker };

  const sanitizedInput = input.map((message) => {
    if (!message || typeof message !== "object") return message;

    if (typeof message.content === "string") {
      const stripped = stripMarkerFromText(message.content);
      if (!marker && stripped.marker) marker = stripped.marker;
      return { ...message, content: stripped.text };
    }

    if (Array.isArray(message.content)) {
      const sanitizedContent = message.content.map((part) => {
        if (!part || typeof part !== "object") return part;
        if (typeof part.text !== "string") return part;
        const stripped = stripMarkerFromText(part.text);
        if (!marker && stripped.marker) marker = stripped.marker;
        return { ...part, text: stripped.text };
      });
      return { ...message, content: sanitizedContent };
    }

    return message;
  });

  return {
    payload: { ...payload, input: sanitizedInput },
    marker,
  };
}

function parseAndMaybeSanitizeBody(bodyBuffer, contentType) {
  const contentTypeValue = String(contentType || "").toLowerCase();
  if (!contentTypeValue.includes("application/json") || bodyBuffer.length === 0) {
    return { bodyBuffer, marker: "", promptCacheKey: "" };
  }

  try {
    const parsed = JSON.parse(bodyBuffer.toString("utf8"));
    const promptCacheKey = extractSessionKey(parsed);
    const result = extractMarkerAndSanitizePayload(parsed);
    const sanitizedBuffer = Buffer.from(JSON.stringify(result.payload));
    return { bodyBuffer: sanitizedBuffer, marker: result.marker, promptCacheKey };
  } catch {
    return { bodyBuffer, marker: "", promptCacheKey: "" };
  }
}

function isHopByHopHeader(name) {
  const lower = String(name || "").toLowerCase();
  return lower === "connection" ||
    lower === "keep-alive" ||
    lower === "proxy-authenticate" ||
    lower === "proxy-authorization" ||
    lower === "te" ||
    lower === "trailer" ||
    lower === "transfer-encoding" ||
    lower === "upgrade";
}

function buildOutgoingHeaders(incomingHeaders, bodyBuffer, sessionId) {
  const headers = {};
  for (const [key, value] of Object.entries(incomingHeaders || {})) {
    if (typeof value === "undefined") continue;
    if (isHopByHopHeader(key)) continue;
    if (key.toLowerCase() === "host") continue;
    if (key.toLowerCase() === "content-length") continue;
    headers[key] = value;
  }
  headers["content-length"] = String(bodyBuffer.length);
  if (sessionId) headers[SESSION_HEADER_NAME] = sessionId;
  return headers;
}

function resolveSessionId(req, marker, promptCacheKey) {
  const fromHeader = getHeaderValue(req.headers, SOURCE_SESSION_HEADER);
  const source = fromHeader ? SOURCE_SESSION_HEADER : (marker ? "system-marker" : (promptCacheKey ? SESSION_KEY_FIELD : "none"));
  const raw = fromHeader || marker || promptCacheKey;
  return { source, value: normalizeSessionId(raw) };
}

function joinPath(basePath, incomingPath) {
  const safeBase = trimTrailingSlash(basePath || "/");
  const safeIncoming = incomingPath.startsWith("/") ? incomingPath : `/${incomingPath}`;
  if (safeBase === "/") return safeIncoming;
  if (safeIncoming === safeBase || safeIncoming.startsWith(`${safeBase}/`)) return safeIncoming;
  return `${safeBase}${safeIncoming}`;
}

function parseBoolEnv(name) {
  if (!(name in process.env)) return undefined;
  return /^(1|true|yes)$/i.test(String(process.env[name] || ""));
}

function loadProxyConfigFile() {
  if (!existsSync(CONFIG_FILE)) return { source: "default", config: {} };
  try {
    const raw = readFileSync(CONFIG_FILE, "utf8").trim();
    if (!raw) return { source: `file:${CONFIG_FILE}`, config: {} };
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { source: `file:${CONFIG_FILE}`, config: {} };
    }
    return { source: `file:${CONFIG_FILE}`, config: parsed };
  } catch {
    return { source: `file:${CONFIG_FILE}`, config: {} };
  }
}

const FILE_CONFIG = loadProxyConfigFile();
const ENV_ROUTES_RAW = (process.env.CRS_PROXY_ROUTES_JSON || "").trim();
const ROUTES_SOURCE = ENV_ROUTES_RAW ? "env:CRS_PROXY_ROUTES_JSON" : FILE_CONFIG.source;
const DEFAULT_LOG_FILE = join(PROXY_DIR, "proxy.log");

function parseRoutesObject() {
  if (ENV_ROUTES_RAW) {
    try {
      const parsed = JSON.parse(ENV_ROUTES_RAW);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    } catch {
      // Fall through to file/default.
    }
  }
  if (FILE_CONFIG.config.routes && typeof FILE_CONFIG.config.routes === "object" && !Array.isArray(FILE_CONFIG.config.routes)) {
    return FILE_CONFIG.config.routes;
  }
  return null;
}

const ROUTES_OBJECT = parseRoutesObject();
const LOG_ENABLED = parseBoolEnv("CRS_PROXY_LOG_ENABLED") ?? (FILE_CONFIG.config.log?.enabled === true);
const LOG_INCLUDE_SESSION_ID = parseBoolEnv("CRS_PROXY_LOG_INCLUDE_SESSION_ID") ?? (FILE_CONFIG.config.log?.includeSessionId === true);

function resolveLogFilePath() {
  if (typeof process.env.CRS_PROXY_LOG_FILE === "string" && process.env.CRS_PROXY_LOG_FILE.trim()) {
    return process.env.CRS_PROXY_LOG_FILE.trim();
  }

  const configured = typeof FILE_CONFIG.config.log?.file === "string" ? FILE_CONFIG.config.log.file.trim() : "";
  if (!configured) return DEFAULT_LOG_FILE;
  if (configured.startsWith("/")) return configured;
  return join(PROXY_DIR, configured);
}

const LOG_FILE = resolveLogFilePath();
const STRICT_ROUTES = parseBoolEnv("CRS_PROXY_STRICT_ROUTES") ??
  (typeof FILE_CONFIG.config.strictRoutes === "boolean" ? FILE_CONFIG.config.strictRoutes : Boolean(ROUTES_OBJECT));

function logInfo(event, details) {
  if (!LOG_ENABLED) return;
  try {
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      level: "info",
      event,
      ...(details ? { details } : {}),
    });
    appendFileSync(LOG_FILE, `${line}\n`, "utf8");
  } catch {
    // Keep proxy running even if logging fails.
  }
}

function parseRouteEntries() {
  const entries = [];

  function addRoute(prefixRaw, targetRaw) {
    if (!targetRaw) return;
    let target;
    try {
      target = new URL(String(targetRaw));
    } catch {
      return;
    }
    entries.push({
      prefix: normalizePrefix(prefixRaw),
      target,
      targetBasePath: trimTrailingSlash(target.pathname || "/"),
    });
  }

  if (ROUTES_OBJECT) {
    for (const [prefix, target] of Object.entries(ROUTES_OBJECT)) {
      addRoute(prefix, target);
    }
  }

  if (entries.length === 0) {
    addRoute("/", TARGET_BASE_URL);
  }

  entries.sort((a, b) => b.prefix.length - a.prefix.length);
  return entries;
}

const ROUTE_ENTRIES = parseRouteEntries();
const DEFAULT_ROUTE = ROUTE_ENTRIES.find((route) => route.prefix === "/") || null;

function isNonRootRouteMatch(pathname) {
  return ROUTE_ENTRIES.some((route) => route.prefix !== "/" && (pathname === route.prefix || pathname.startsWith(`${route.prefix}/`)));
}

function selectRoute(pathname) {
  for (const route of ROUTE_ENTRIES) {
    if (route.prefix === "/") continue;
    if (pathname === route.prefix || pathname.startsWith(`${route.prefix}/`)) return route;
  }
  return DEFAULT_ROUTE;
}

function buildTargetPath(route, incomingPathname) {
  let suffix = incomingPathname;
  if (route.prefix !== "/") suffix = incomingPathname.slice(route.prefix.length) || "/";
  if (!suffix.startsWith("/")) suffix = `/${suffix}`;
  return joinPath(route.targetBasePath, suffix);
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  res.end(body);
}

function createUpstreamRequestOptions(route, req, targetPathWithQuery, headers) {
  return {
    protocol: route.target.protocol,
    hostname: route.target.hostname,
    port: route.target.port || (route.target.protocol === "https:" ? 443 : 80),
    method: req.method,
    path: targetPathWithQuery,
    headers,
  };
}

function handleProxyRequest(req, res, originalBodyBuffer) {
  const parsedUrl = parseRequestUrl(req.url || "/");
  const pathname = parsedUrl.pathname || "/";
  const route = selectRoute(pathname);

  if (!route) {
    sendJson(res, 404, { error: "route_not_found", path: pathname });
    return;
  }

  if (STRICT_ROUTES && route.prefix === "/" && ROUTE_ENTRIES.some((entry) => entry.prefix !== "/") && !isNonRootRouteMatch(pathname)) {
    sendJson(res, 404, { error: "route_not_found", path: pathname });
    return;
  }

  const bodyResult = parseAndMaybeSanitizeBody(originalBodyBuffer, req.headers["content-type"]);
  const resolved = resolveSessionId(req, bodyResult.marker, bodyResult.promptCacheKey);
  const headers = buildOutgoingHeaders(req.headers, bodyResult.bodyBuffer, resolved.value);

  const targetPath = buildTargetPath(route, pathname);
  const targetPathWithQuery = `${targetPath}${parsedUrl.search || ""}`;
  const options = createUpstreamRequestOptions(route, req, targetPathWithQuery, headers);
  const client = route.target.protocol === "https:" ? https : http;

  logInfo("proxy_request", {
    method: req.method,
    path: pathname,
    routePrefix: route.prefix,
    upstreamHost: route.target.host,
    sessionSource: resolved.source,
    hasSessionId: Boolean(resolved.value),
    ...(LOG_INCLUDE_SESSION_ID ? { sessionId: resolved.value || null } : {}),
  });

  const upstreamReq = client.request(options, (upstreamRes) => {
    const responseHeaders = {};
    for (const [key, value] of Object.entries(upstreamRes.headers || {})) {
      if (typeof value === "undefined") continue;
      if (isHopByHopHeader(key)) continue;
      responseHeaders[key] = value;
    }
    res.writeHead(upstreamRes.statusCode || 502, responseHeaders);
    upstreamRes.pipe(res);
  });

  upstreamReq.on("error", (error) => {
    if (res.headersSent) {
      res.destroy(error);
      return;
    }
    sendJson(res, 502, {
      error: "upstream_request_failed",
      message: error.message,
    });
  });

  upstreamReq.setTimeout(120_000, () => {
    upstreamReq.destroy(new Error("upstream timeout"));
  });

  upstreamReq.end(bodyResult.bodyBuffer);
}

const server = http.createServer((req, res) => {
  const parsedUrl = parseRequestUrl(req.url || "/");

  if (req.method === "GET" && parsedUrl.pathname === "/_health") {
    sendJson(res, 200, {
      ok: true,
      listen: `${LISTEN_HOST}:${LISTEN_PORT}`,
      strictRoutes: STRICT_ROUTES,
      logEnabled: LOG_ENABLED,
      logIncludeSessionId: LOG_INCLUDE_SESSION_ID,
      logFile: LOG_FILE,
      configFile: CONFIG_FILE,
      routesSource: ROUTES_SOURCE,
      routes: ROUTE_ENTRIES.map((entry) => ({
        prefix: entry.prefix,
        targetBaseUrl: entry.target.toString(),
      })),
      sourcePriority: [SOURCE_SESSION_HEADER, "system-marker", SESSION_KEY_FIELD],
      sessionHeaderName: SESSION_HEADER_NAME,
    });
    return;
  }

  const chunks = [];
  let total = 0;

  req.on("data", (chunk) => {
    total += chunk.length;
    if (total > MAX_BODY_BYTES) {
      sendJson(res, 413, {
        error: "payload_too_large",
        maxBodyBytes: MAX_BODY_BYTES,
      });
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });

  req.on("end", () => {
    if (res.writableEnded) return;
    const bodyBuffer = Buffer.concat(chunks);
    handleProxyRequest(req, res, bodyBuffer);
  });

  req.on("error", (error) => {
    if (res.headersSent) {
      res.destroy(error);
      return;
    }
    sendJson(res, 400, {
      error: "bad_request_stream",
      message: error.message,
    });
  });
});

server.listen(LISTEN_PORT, LISTEN_HOST, () => {
  logInfo("startup", {
    listen: `${LISTEN_HOST}:${LISTEN_PORT}`,
    strictRoutes: STRICT_ROUTES,
    logEnabled: LOG_ENABLED,
    logIncludeSessionId: LOG_INCLUDE_SESSION_ID,
    logFile: LOG_FILE,
    configFile: CONFIG_FILE,
    routesSource: ROUTES_SOURCE,
    routes: ROUTE_ENTRIES.map((entry) => ({ prefix: entry.prefix, target: entry.target.toString() })),
    sourcePriority: [SOURCE_SESSION_HEADER, "system-marker", SESSION_KEY_FIELD, SESSION_HEADER_NAME],
  });
});
