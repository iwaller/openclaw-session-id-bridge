# OpenClaw Session ID Bridge

A lightweight OpenClaw extension that maps per-session IDs to upstream `session_id` headers via a local proxy.

## What it does

- Injects a session marker in `before_prompt_build`
- Extracts marker in local proxy and writes upstream header `session_id`
- Strips marker from payload before forwarding upstream
- Supports prefix-based multi-provider routing from `config.json`
- Supports optional file logging (off by default)

## Files

- `index.ts`: plugin hook + proxy service lifecycle
- `proxy.mjs`: local HTTP proxy with header injection and routing
- `openclaw.plugin.json`: plugin manifest
- `config.json`: routes and logging config

## Config

```json
{
  "log": {
    "enabled": false,
    "includeSessionId": false,
    "file": "proxy.log"
  },
  "routes": {
    "/provider": "https://api.openai.com/v1"
  }
}
```

- `log.enabled`: enable/disable proxy logs
- `log.includeSessionId`: include resolved `session_id` in logs (debug only)
- `log.file`: log file path; relative paths are resolved under extension directory
- `routes`: prefix-to-upstream base URL map

## Install

From npm (recommended after publish):

```bash
openclaw plugins install openclaw-session-id-bridge
openclaw plugins enable openclaw-session-id-bridge
systemctl --user restart openclaw-gateway
```

From local source:

1. Copy this repo contents to `~/.openclaw/extensions/openclaw-session-id-bridge`.
2. Enable plugin id `openclaw-session-id-bridge` in `~/.openclaw/openclaw.json`.
3. Point provider `baseUrl` to local proxy prefix (example: `http://127.0.0.1:19090/provider`).
4. Restart gateway: `systemctl --user restart openclaw-gateway`.

## Health check

```bash
curl -sS http://127.0.0.1:19090/_health
```

## Notes

- Source priority for session extraction: `x-openclaw-session-id` > system marker > `prompt_cache_key`.
- Default logging is off for safety.
