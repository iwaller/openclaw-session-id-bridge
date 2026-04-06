# OpenClaw Session ID Bridge

A lightweight OpenClaw extension that ensures upstream requests receive a real `session_id`.

## What changed (better than legacy marker approach)

- Uses provider `wrapStreamFn` to read OpenClaw `options.sessionId` directly.
- Injects request headers on every model call:
  - `session_id`
  - `x-openclaw-session-id` (optional source header for diagnostics)
- Optional local proxy can still do route fan-out (`/crs` -> real upstream).
- Missing source header is logged but no longer blocks requests.
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
    "requireSourceHeader": false,
    "sessionPlaceholder": "{{session_id}}",
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
- `bridge.requireSourceHeader`: when `true`, proxy logs missing source header but still forwards requests
- `bridge.sessionPlaceholder`: placeholder token to replace in model headers (default `{{session_id}}`)
- `bridge.legacyPromptMarker`: disabled by default; keep `false` on modern OpenClaw
- `log.enabled`: keep `true` to verify runtime behavior during rollout

Example model header placeholder in `~/.openclaw/openclaw.json`:

```json
{
  "models": {
    "providers": {
      "crs": {
        "headers": {
          "x-openclaw-session-id": "{{session_id}}"
        }
      }
    }
  }
}
```

At runtime, the plugin replaces `{{session_id}}` with `options.sessionId` before the HTTP request is sent.

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

2. Confirm source-header diagnostics are active (optional):

- `requireSourceSessionHeader: true`
- `sourceSessionHeaderName: "x-openclaw-session-id"`

3. Tail logs:

```bash
tail -f ~/.openclaw/extensions/openclaw-session-id-bridge/proxy.log
```

Look for:

- `event: "proxy_request"`
- Optional `missing_source_session_header` diagnostics when source header is absent
- Optional `session_id_fallback_source` diagnostics when fallback source is used

## Notes

- The bridge supports fallback extraction (`system-marker`, `prompt_cache_key`) for compatibility.
- If OpenClaw runtime ever stops providing `options.sessionId`, `index.ts` prints a warning and the proxy logs fallback diagnostics.
