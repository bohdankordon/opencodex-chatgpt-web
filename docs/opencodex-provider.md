# OpenCodex provider

This project can run as an independent Responses provider behind OpenCodex. Codex keeps talking
to OpenCodex. OpenCodex routes only the selected ChatGPT Web models to this loopback server.

Use `--integration-mode external-provider` explicitly. The default remains `direct`, which still
owns Codex `openai_base_url`.

## Current scope

The external-provider integration in this release is a **CLI/runtime contract**. It keeps the core
setup, serve, doctor, route-mutation guards, Responses endpoints, and uninstall behavior from
silently taking ownership of Codex routing.

The desktop Launcher supports the external-provider lifecycle in an ownership-aware way. A
genuinely new Launcher installation can choose Direct (default) or External provider/router on
the Setup surface; that choice is first-install intent only, and Direct-to-External migration in
either direction stays CLI-only (there is no Settings routing picker or migration button).

Ownership split: the external router owns Codex routing, while the Launcher owns only the
ChatGPT Web bridge and browser runtime. Registering the provider with the router (for example
the `ocx provider add` flow below) remains manual work: the Launcher never installs, registers,
or configures the external router, and External setup fails unless Codex routing is already
owned by (released to) that router. Launcher startup, repair, reinstall, and update validate
bridge ownership-health without taking Direct route ownership, and External Remove leaves
external router/provider configuration untouched (a Direct Codex route owned by the
installation is still restored).

## What this process owns

- Loopback Responses listener on `127.0.0.1`
- ChatGPT browser login and account capability detection
- Optional Full-mode broker and MCP tunnel for Web tool intent capture

In Full mode, the OpenCodex provider projects the current Codex request's tool names,
descriptions, and schemas into the Web connector. A Web tool call commits one intent;
the provider returns a completed Responses `function_call` or `tool_search_call` with
its stable `call_id`. Codex alone executes the tool under its sandbox and approval
policy. The result or denial arrives through full replay on the next provider request.
Each provider request starts a fresh Temporary Chat, including after a tool result.
Direct mode retains its existing synchronous broker flow.

## Provider authentication (S4B)

The OpenCodex provider path uses a dedicated high-entropy Bearer secret, distinct
from the launcher/control token and from legacy `externalClients` credentials.

- Secret file: `<app-home>/opencodex-provider-token` (referenced by
  `providerTokenFile` in `config.json`). Generated once when absent with atomic
  `0600` creation; never overwritten when valid; never logged or exposed via
  `/healthz`; fails closed when unreadable. Rotate explicitly with
  `codex-chatgpt-web provider-token rotate --yes`, then update OpenCodex.
- Endpoints: `GET /healthz` needs no secret and reveals none; `GET /v1/models`
  and `POST /v1/responses` require `Authorization: Bearer <provider-secret>` with
  constant-time comparison. Missing/malformed/wrong share one `401` class and are
  rejected before model discovery, browser work, or request parsing.
- OpenCodex owns its provider configuration. This fork never writes
  `$OPENCODEX_HOME/config.json`; it only shows/generates registration info.
  Configure the provider with the secret as `apiKey` (see below) and restart
  OpenCodex so the running process picks it up.

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

That still requires the existing tunnel and connector. Codex owns local tool approval after
the provider hands back an intent. It does not force Browser-only or rewrite Codex routing.

## Migrating an existing Direct installation

Do not switch an active Direct installation to `external-provider` in one setup command. Changing
the ownership flag is not permission for this project to restore, replace, or otherwise rewrite
the current Codex route.

If codex-chatgpt-web currently owns the Direct route, release it first while the saved configuration
is still in Direct mode:

```bash
codex-chatgpt-web route disconnect
```

Disconnect restores every Codex setting owned by the Direct integration and leaves the route free
for another router to take over.

Then configure Codex/OpenCodex so Codex points at OpenCodex, not directly at this bridge. After
OpenCodex owns the Codex route, run setup with the explicit external-provider mode:

```bash
codex-chatgpt-web setup --browser-only --integration-mode external-provider --acknowledge-unofficial
```

Use `--full` instead of `--browser-only` when the ChatGPT Web route should expose the current
Codex request's MCP tools for intent capture.

For native Codex deferred MCP discovery, configure the OpenCodex provider with
`codexToolMode: "shell"`, then refresh the Codex model catalog with `ocx sync`.
The routed Codex catalog row must have `supports_search_tool: true` and leave
`tool_mode` unset. Codex then initially declares `tool_search` while deferring MCP
tool definitions until its search result is replayed. Without that catalog row,
Codex falls back to unknown-model metadata; MCP tools may be declared eagerly.
This setting belongs to OpenCodex's provider configuration, not to the Web bridge.

Setup deliberately refuses the ownership switch while the previous managed Direct route is still
active, while its non-route managed state is inconsistent, or while `openai_base_url` still points
directly at this bridge. After a clean handoff, setup retires the obsolete Direct ownership record
without modifying the route now owned by OpenCodex. Those checks make migration errors explicit
rather than permitting an automatic route takeover.

## OpenCodex registration

Minimum supported OpenCodex version: `2.57.0` (`main@44de45dfdc33d30af22502d2bed98014fe16d83b`).
Latest end-to-end verified version: OpenCodex `2.67.0` with Codex CLI
`0.158.0-alpha.2.1` (including native `tool_search` and deferred MCP replay).
The `openai-responses` adapter posts to `{baseUrl}/v1/responses` unless `responsesPath` is set, so
`baseUrl` may be either `http://127.0.0.1:17841` or `http://127.0.0.1:17841/v1`; OpenCodex
normalizes both to the same Responses endpoint.

Register the provider with:

```bash
codex-chatgpt-web provider-token status
# Copy the printed file path, read the secret privately, and configure OpenCodex with it as apiKey.
# Example (do not paste the secret into shell history where unnecessary):
# ocx provider add chatgpt-web --adapter openai-responses --base-url http://127.0.0.1:17841/v1 --allow-private-network --api-key "$(cat <app-home>/opencodex-provider-token)"
```

On `provider add`, `--allow-private-network` is a bare boolean flag (there is no
`--allow-private-network on` spelling), and there is no `--live-models` flag: absent
`liveModels` already means live model discovery is enabled, so once this bridge is running
OpenCodex can read its `/v1/models` catalog when it presents the provider secret.
The `on|off` spellings (`--allow-private-network <on|off>`, `--live-models <on|off>`)
belong to `ocx provider edit`. Flag spellings are version-sensitive and describe
OpenCodex 2.67; recheck them when moving to a newer OpenCodex. The provider secret
is the loopback Bearer for `/v1/*`; ChatGPT authentication itself stays in the
browser session owned by this process.

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
      "allowPrivateNetwork": true,
      "codexToolMode": "shell",
      "apiKey": "<contents of <app-home>/opencodex-provider-token>"
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

Contract frozen for OpenCodex `2.67.0` with Codex `0.158.0` (see
`tests/fixtures/opencodex-2.67/`): Codex sends JSON bodies with `content-encoding: zstd`;
compaction turn metadata carries
`compaction: {trigger, reason, implementation, phase, strategy}` with `strategy: "memento"`
and `implementation` of `responses` (native text form) or `responses_compaction_v2`
(routed remote-v2 form). A routed summarizer turn reaches a non-canonical provider with the
v2 marker intact but the `compaction_trigger` item and the tool surface removed and the
checkpoint prompt appended; the bridge answers with assistant text that OpenCodex wraps back
into the compaction item Codex replays.

The OpenCodex-routed catalog may project a gateway ingestion capability (`supports_tool_use`) on
these rows even though the bridge catalog itself reports `supports_tools: false`. That projection
describes OpenCodex-side ingestion. Full-mode provider turns expose only tools declared in the
current Codex request; browser-only turns have no access to the local Codex computer.

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
