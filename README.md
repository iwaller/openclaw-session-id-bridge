# OpenClaw Session ID Bridge

A lightweight OpenClaw extension that ensures upstream requests receive a real `session_id`.

## What changed (better than legacy marker approach)

- Uses provider `wrapStreamFn` to read OpenClaw `options.sessionId` directly.
- Injects request headers on every model call:
  - `session_id`
  - `x-openclaw-session-id` (source header for strict verification)
- Optional local proxy can still do route fan-out (`/crs` -> real upstream).
- Strict mode can reject requests that do not carry `x-openclaw-session-id`.
- Adds explicit diagnostics so you can confirm session ID resolution path.

## Why this is better

- No prompt pollution (no marker text added to system prompt by default).
- No brittle payload parsing to discover session context.
- Session ID comes from OpenClaw runtime stream options first-class path.

## Files

- `index.ts`: provider header bridge + optional proxy service
- `proxy.mjs`: routing proxy with strict source-header checks and logging
- `config.json`: runtime settings
- `openclaw.plugin.json`: manifest

## Config

Config file location:

- `~/.openclaw/extensions/openclaw-session-id-bridge/config.json`

```json
{
  "proxy": {
    "enabled": true,
    "port": 19090
  },
  "bridge": {
    "enabled": true,
    "providers": ["crs"],
    "sessionHeaderName": "session_id",
    "sourceSessionHeaderName": "x-openclaw-session-id",
    "setSourceHeader": true,
    "requireSourceHeader": true,
    "legacyPromptMarker": false
  },
  "log": {
    "enabled": true,
    "includeSessionId": false,
    "file": "proxy.log"
  },
  "routes": {
    "/crs": "https://crs.plenty126.xyz/openai"
  }
}
```

Key options:

- `bridge.providers`: provider IDs that should inject session headers (default `crs`)
- `bridge.requireSourceHeader`: when `true`, proxy rejects requests missing `x-openclaw-session-id`
- `bridge.legacyPromptMarker`: disabled by default; keep `false` on modern OpenClaw
- `log.enabled`: keep `true` to verify runtime behavior during rollout

## Install

From local source:

1. Copy this repo to `~/.openclaw/extensions/openclaw-session-id-bridge`.
2. Enable plugin id `openclaw-session-id-bridge` in `~/.openclaw/openclaw.json`.
3. Keep provider `baseUrl` pointed at proxy route (example: `http://127.0.0.1:19090/crs`) if you use route fan-out.
4. Restart gateway: `systemctl --user restart openclaw-gateway`.

## Verification

1. Check health:

```bash
curl -sS http://127.0.0.1:19090/_health
```

2. Confirm strict mode is active:

- `requireSourceSessionHeader: true`
- `sourceSessionHeaderName: "x-openclaw-session-id"`

3. Tail logs:

```bash
tail -f ~/.openclaw/extensions/openclaw-session-id-bridge/proxy.log
```

Look for:

- `event: "proxy_request"` with `sessionSource: "x-openclaw-session-id"`
- No `missing_source_session_header`
- No `session_id_fallback_source`

## Notes

- The bridge still supports fallback extraction (`system-marker`, `prompt_cache_key`) for compatibility, but strict mode is intended to enforce real source-header usage.
- If OpenClaw runtime ever stops providing `options.sessionId`, `index.ts` prints a warning and the proxy logs `missing_source_session_header` in strict mode.
