# OpenCodex provider

This project can run as an independent Responses provider behind OpenCodex. Codex keeps talking
to OpenCodex. OpenCodex routes only the selected ChatGPT Web models to this loopback server.

Use `--integration-mode external-provider` explicitly. The default remains `direct`, which still
owns Codex `openai_base_url`.

## Current scope

The external-provider integration in this release is a **CLI/runtime contract**. It keeps the core
setup, serve, doctor, route-mutation guards, Responses endpoints, and uninstall behavior from
silently taking ownership of Codex routing.

The desktop Launcher has not yet been taught to persist or operate external-provider ownership.
Until that launcher work lands, do not use Launcher Repair, Update, Remove, or other setup-changing
Launcher actions on an external-provider installation. Start and manage this mode through the CLI
commands documented below. This avoids the stock Launcher re-running Direct-mode setup against a
Codex configuration owned by OpenCodex.

## What this process owns

- Loopback Responses listener on `127.0.0.1`
- ChatGPT browser login and account capability detection
- Optional Full-mode broker, MCP tunnel, and tool approvals

In external-provider mode, the core CLI/runtime does **not** create, modify, delete, or restore
Codex `openai_base_url`, `model_provider`, OpenCodex config, or OpenCodex model catalogs.

## Source setup

Use isolated homes so the live user profile is never rewritten while validating the integration:

```bash
export CODEX_CHATGPT_WEB_HOME="$PWD/.tmp-chatgpt-web"
export CODEX_HOME="$PWD/.tmp-codex-unused"
bun run src/cli.ts setup --browser-only --integration-mode external-provider --acknowledge-unofficial
bun run src/cli.ts serve
```

Sign in through the configured browser host, then confirm:

```bash
curl -sS http://127.0.0.1:17841/healthz
curl -sS http://127.0.0.1:17841/v1/models
```

`healthz` reports `integration_mode: "external-provider"` and a `provider_base_url`.
`/v1/models` lists only ChatGPT Web routes this account can use. It does not call official Codex
model discovery.

Full mode is independent of routing ownership:

```bash
bun run src/cli.ts setup --full --integration-mode external-provider --acknowledge-unofficial
```

That still requires the existing tunnel, connector, and tool-approval flow. It does not force
Browser-only, and it still must not rewrite Codex routing.

## Migrating an existing Direct installation

Do not switch an active Direct installation to `external-provider` in one setup command. Changing
the ownership flag is not permission for this project to restore, replace, or otherwise rewrite
the current Codex route.

If codex-chatgpt-web currently owns the Direct route, release it first while the saved configuration
is still in Direct mode:

```bash
codex-chatgpt-web route disconnect
```

Then configure Codex/OpenCodex so Codex points at OpenCodex, not directly at this bridge. After
OpenCodex owns the Codex route, run setup with the explicit external-provider mode:

```bash
codex-chatgpt-web setup --browser-only --integration-mode external-provider --acknowledge-unofficial
```

Use `--full` instead of `--browser-only` when the ChatGPT Web route should retain the existing MCP
tool flow.

Setup deliberately refuses the ownership switch while the previous managed Direct route is still
active, while that integration is inconsistent, or while `openai_base_url` still points directly at
this bridge. Those are migration errors to fix explicitly rather than conditions that permit an
automatic route takeover.

## OpenCodex registration

Minimum supported OpenCodex version: `2.57.0` (`main@44de45dfdc33d30af22502d2bed98014fe16d83b`).
Latest end-to-end verified version: OpenCodex `2.58.0`
(`6fe4cd0de85d63b8cdd0c3552e5e8883c0a029ee`).
The `openai-responses` adapter posts to `{baseUrl}/v1/responses` unless `responsesPath` is set, so
`baseUrl` may be either `http://127.0.0.1:17841` or `http://127.0.0.1:17841/v1`; OpenCodex
normalizes both to the same Responses endpoint.

Register the provider with:

```bash
ocx provider add chatgpt-web \
  --adapter openai-responses \
  --base-url http://127.0.0.1:17841/v1 \
  --allow-private-network
```

On `provider add`, `--allow-private-network` is a bare boolean flag (there is no
`--allow-private-network on` spelling), and there is no `--live-models` flag: absent
`liveModels` already means live model discovery is enabled, so once this bridge is running
OpenCodex can read its `/v1/models` catalog. The `on|off` spellings
(`--allow-private-network <on|off>`, `--live-models <on|off>`) belong to
`ocx provider edit`. Flag spellings are version-sensitive and describe OpenCodex 2.58; recheck
them when moving to a newer OpenCodex. The bridge itself does not require an API key;
ChatGPT authentication stays in the browser session owned by this process.

`ocx provider add` persists the provider to the OpenCodex configuration but does not adopt it
into an already-running OpenCodex process. After registering, restart OpenCodex (`ocx restart`)
so the running process picks up the new provider, then refresh the Codex model catalog
(`ocx sync`) and select a `chatgpt-web/...` model.

OpenCodex stores its persistent configuration in `$OPENCODEX_HOME/config.json` (normally
`~/.opencodex/config.json`, or `%USERPROFILE%\.opencodex\config.json` on Windows). An equivalent
provider object is:

```json
{
  "providers": {
    "chatgpt-web": {
      "adapter": "openai-responses",
      "baseUrl": "http://127.0.0.1:17841/v1",
      "allowPrivateNetwork": true
    }
  }
}
```

Merge that provider entry into the existing config rather than replacing the whole file. The same
restart-then-sync note above applies when editing the config file by hand: a hand-edited provider
is picked up on restart, not by the already-running process.

Keep Codex pointed at OpenCodex. Do not point Codex `openai_base_url` at this bridge, and do not
point this bridge at OpenCodex. Unknown models return an explicit error instead of falling back to
official Codex or another OpenCodex route.

## Wire compatibility contract

For a non-canonical `openai-responses` destination such as this bridge, OpenCodex 2.58 removes
top-level `access_programs` (destination-sensitive removal for non-OpenAI-operated destinations)
and `internal_chat_message_metadata_passthrough` from input items. When the request has
`store: false`, it also removes every `input[*].id`, because those IDs would otherwise be
interpreted as references to stored upstream items.

Current Codex also places its turn metadata in
`client_metadata["x-codex-turn-metadata"]`. OpenCodex preserves that body metadata when routing to
a custom Responses provider. External-provider mode therefore requires that native turn authority
before accepting a stripped OpenCodex request, and recovers the current instruction/environment
only when the remaining request structure is consistent with it. Arbitrary user-authored
environment XML is never sufficient authority on its own.

Compaction through this provider class is a routed summarizer over the normal `/v1/responses`
endpoint: OpenCodex converts the summary back to the compaction form Codex expects. The bridge
still exposes `/v1/responses/compact` as its own canonical endpoint contract (used by Direct
mode and the dev harness), but a normal `chatgpt-web` OpenCodex route does not send compaction
there.

The OpenCodex-routed catalog may project a gateway ingestion capability (`supports_tool_use`) on
these rows even though the bridge catalog itself reports `supports_tools: false`. That projection
describes OpenCodex-side ingestion, not local Codex tool execution: browser-only turns have no
access to the local Codex computer, and the bridge says so explicitly in its turn commentary
rather than executing anything locally.

This contract is covered by compatibility tests so changes in either OpenCodex's request
sanitization or Codex's turn metadata shape fail visibly during an upstream sync.

## Verified end-to-end status

- Phase A (bridge to real ChatGPT Web inference): PASS.
- Phase B (real OpenCodex 2.58 to bridge to ChatGPT Web): PASS.
- Phase C (real Codex CLI to OpenCodex 2.58 to bridge to ChatGPT Web High, with the response
  returned to real Codex): PASS. The real Codex to OpenCodex to ChatGPT Web core path is proven.

Verification ran on Windows with a headed browser. Windows headless authenticated composer parity
is not established and is outside the scope of this release; do not treat headless Windows as a
verified target.

## Recovery

To return to Direct mode, rerun setup explicitly with Direct ownership:

```bash
codex-chatgpt-web setup --browser-only --integration-mode direct --acknowledge-unofficial --replace-codex-route
```

That is an explicit Direct takeover. It is not a silent fallback. Do not restore an old Codex
`config.toml` backup over a file OpenCodex currently owns.

To leave routing with OpenCodex and stop only this provider, stop the CLI-managed provider/service
and keep the OpenCodex-owned Codex route unchanged. Launcher-managed removal is intentionally
outside the scope of this release.
