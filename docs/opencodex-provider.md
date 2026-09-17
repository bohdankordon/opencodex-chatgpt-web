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

Verified against OpenCodex `2.57.0` / `main@44de45dfdc33d30af22502d2bed98014fe16d83b`.
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

Custom providers use live model discovery unless it is explicitly disabled, so once this bridge is
running OpenCodex can read its `/v1/models` catalog. The bridge itself does not require an API key;
ChatGPT authentication stays in the browser session owned by this process.

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
      "liveModels": true
    }
  }
}
```

Merge that provider entry into the existing config rather than replacing the whole file.

Keep Codex pointed at OpenCodex. Do not point Codex `openai_base_url` at this bridge, and do not
point this bridge at OpenCodex. Unknown models return an explicit error instead of falling back to
official Codex or another OpenCodex route.

## Wire compatibility contract

For a non-canonical `openai-responses` destination, current OpenCodex intentionally removes
`internal_chat_message_metadata_passthrough` from input items. When the request has `store: false`,
it also removes every `input[*].id`, because those IDs would otherwise be interpreted as references
to stored upstream items.

Current Codex also places its turn metadata in
`client_metadata["x-codex-turn-metadata"]`. OpenCodex preserves that body metadata when routing to
a custom Responses provider. External-provider mode therefore requires that native turn authority
before accepting a stripped OpenCodex request, and recovers the current instruction/environment
only when the remaining request structure is consistent with it. Arbitrary user-authored
environment XML is never sufficient authority on its own.

This contract is covered by compatibility tests so changes in either OpenCodex's request
sanitization or Codex's turn metadata shape fail visibly during an upstream sync.

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
