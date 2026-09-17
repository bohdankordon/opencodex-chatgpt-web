import { expect, test } from "bun:test";
import { resolve } from "node:path";
import {
  extractChatGptTurnEnvironment,
  extractChatGptTurnUserRevision,
} from "../src/adapters/chatgpt-web/environment";
import { defaultConfig } from "../src/config";
import { parseRequest } from "../src/responses/parser";
import { compactRequest, modelsRequest, responseRequest } from "../src/server";

const TRAILING_SLASHES = /\/+$/;
const TRAILING_RESPONSES = /\/responses\/?$/;
const TRAILING_V1 = /\/v1\/?$/;

/** Mirror OpenCodex src/adapters/openai-responses-url.ts without importing that repository. */
function openaiResponsesUrl(baseUrl: string): string {
  const url = new URL(baseUrl.trim());
  const trimmedPath = url.pathname.replace(TRAILING_SLASHES, "");
  const withoutEndpoint = trimmedPath.replace(TRAILING_RESPONSES, "");
  const withoutV1 = withoutEndpoint.replace(TRAILING_V1, "");
  url.pathname = `${withoutV1}/v1/responses`;
  return url.toString();
}

function providerUrl(baseUrl: string, responsesPath?: string): string {
  if (responsesPath === undefined) return openaiResponsesUrl(baseUrl);
  return `${baseUrl.replace(/\/$/, "")}${responsesPath}`;
}

/**
 * Mirror the two OpenCodex request sanitizers this bridge depends on at the non-canonical
 * openai-responses boundary: private ChatGPT item metadata is removed, and store:false removes
 * all item ids. client_metadata is deliberately preserved and remains the native turn authority.
 */
function openCodexRoutedBody(body: Record<string, unknown>): Record<string, unknown> {
  const input = Array.isArray(body.input) ? body.input : [];
  return {
    ...body,
    input: input.map(value => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return value;
      const item = { ...(value as Record<string, unknown>) };
      delete item.internal_chat_message_metadata_passthrough;
      if (body.store === false) delete item.id;
      return item;
    }),
  };
}

test("OpenCodex openai-responses URL construction does not duplicate /v1", () => {
  expect(providerUrl("http://127.0.0.1:17841/v1")).toBe("http://127.0.0.1:17841/v1/responses");
  expect(providerUrl("http://127.0.0.1:17841/v1/")).toBe("http://127.0.0.1:17841/v1/responses");
  expect(providerUrl("http://127.0.0.1:17841")).toBe("http://127.0.0.1:17841/v1/responses");
  expect(providerUrl("http://127.0.0.1:17841/v1", "/responses")).toBe("http://127.0.0.1:17841/v1/responses");
  expect(providerUrl("http://127.0.0.1:17841/v1", "/responses/compact"))
    .toBe("http://127.0.0.1:17841/v1/responses/compact");
});

test("OpenCodex store:false sanitization preserves current-turn authority in client_metadata", () => {
  const root = resolve(process.cwd());
  const turnId = "turn_opencodex";
  const metadata = {
    request_kind: "turn",
    thread_id: "thread_opencodex",
    turn_id: turnId,
    sandbox: "none",
    workspaces: { [root]: {} },
  };
  const environment = `<environment_context>\n  <cwd>${root}</cwd>\n  <filesystem><workspace_roots><root>${root}</root></workspace_roots><permission_profile type="disabled"><file_system type="unrestricted" /></permission_profile></filesystem>\n</environment_context>`;
  const original = {
    model: "chatgpt-web/high",
    store: false,
    stream: true,
    client_metadata: {
      "x-codex-turn-metadata": JSON.stringify(metadata),
    },
    input: [
      {
        type: "message",
        id: "msg_environment",
        role: "user",
        content: [{ type: "input_text", text: environment }],
        internal_chat_message_metadata_passthrough: { turn_id: turnId },
      },
      {
        type: "message",
        id: "msg_prompt",
        role: "user",
        content: [{ type: "input_text", text: "Inspect the workspace read-only." }],
        internal_chat_message_metadata_passthrough: { turn_id: turnId },
      },
    ],
  } satisfies Record<string, unknown>;

  const routed = openCodexRoutedBody(original);
  const routedInput = routed.input as Array<Record<string, unknown>>;
  expect(routedInput.every(item => item.id === undefined)).toBe(true);
  expect(routedInput.every(item => item.internal_chat_message_metadata_passthrough === undefined)).toBe(true);
  expect(routed.client_metadata).toEqual(original.client_metadata);

  const parsed = parseRequest(routed);
  parsed._externalProviderTrusted = true;
  expect(extractChatGptTurnEnvironment(parsed).cwd).toBe(root);
  expect(extractChatGptTurnUserRevision(parsed)).toEqual([
    { type: "input_text", text: "Inspect the workspace read-only." },
  ]);
});

test("stripped environment recovery itself requires native client_metadata", () => {
  const root = resolve(process.cwd());
  const environment = `<environment_context>\n  <cwd>${root}</cwd>\n  <filesystem><workspace_roots><root>${root}</root></workspace_roots><permission_profile type="disabled"><file_system type="unrestricted" /></permission_profile></filesystem>\n</environment_context>`;
  const routed = openCodexRoutedBody({
    model: "chatgpt-web/high",
    store: false,
    stream: false,
    input: [
      {
        type: "message",
        id: "msg_environment",
        role: "user",
        content: [{ type: "input_text", text: environment }],
        internal_chat_message_metadata_passthrough: { turn_id: "turn_missing" },
      },
      {
        type: "message",
        id: "msg_prompt",
        role: "user",
        content: [{ type: "input_text", text: "Inspect the workspace read-only." }],
        internal_chat_message_metadata_passthrough: { turn_id: "turn_missing" },
      },
    ],
  });
  const parsed = parseRequest(routed);
  parsed._externalProviderTrusted = true;
  expect(() => extractChatGptTurnEnvironment(parsed)).toThrow("missing cwd in trusted Codex environment context");
  expect(() => extractChatGptTurnUserRevision(parsed)).toThrow("requires native Codex turn_id metadata");
});

test("external-provider refuses stripped turns when OpenCodex native metadata is missing", async () => {
  const root = resolve(process.cwd());
  const environment = `<environment_context>\n  <cwd>${root}</cwd>\n  <filesystem><workspace_roots><root>${root}</root></workspace_roots><permission_profile type="disabled"><file_system type="unrestricted" /></permission_profile></filesystem>\n</environment_context>`;
  const routed = openCodexRoutedBody({
    model: "chatgpt-web/high",
    store: false,
    stream: false,
    input: [
      {
        type: "message",
        id: "msg_environment",
        role: "user",
        content: [{ type: "input_text", text: environment }],
        internal_chat_message_metadata_passthrough: { turn_id: "turn_missing" },
      },
      {
        type: "message",
        id: "msg_prompt",
        role: "user",
        content: [{ type: "input_text", text: "Inspect the workspace read-only." }],
        internal_chat_message_metadata_passthrough: { turn_id: "turn_missing" },
      },
    ],
  });
  const config = defaultConfig("browser-only");
  config.integrationMode = "external-provider";
  let adapterStarted = false;
  const response = await responseRequest(new Request("http://127.0.0.1:17841/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(routed),
  }), config, () => {
    adapterStarted = true;
    throw new Error("adapter must not start without native OpenCodex turn metadata");
  });
  expect(adapterStarted).toBe(false);
  expect(response.status).toBe(400);
  const body = await response.json() as { error?: { message?: string } };
  expect(body.error?.message).toContain("native Codex turn metadata");
});

test("OpenCodex-shaped HTTP requests keep compact metadata and reject unknown models", async () => {
  const config = defaultConfig("browser-only");
  config.integrationMode = "external-provider";
  let nativeCalls = 0;
  const models = await modelsRequest(
    new Request("http://127.0.0.1:17841/v1/models"),
    config,
    async () => {
      nativeCalls += 1;
      throw new Error("native Codex must not be contacted");
    },
  );
  expect(nativeCalls).toBe(0);
  expect(models.status).toBe(200);
  const catalog = await models.json() as { data: Array<{ id: string }> };
  expect(catalog.data.every(model => model.id.startsWith("chatgpt-web/"))).toBe(true);

  const unknown = await responseRequest(new Request("http://127.0.0.1:17841/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "gpt-5.6-sol", input: [] }),
  }), config);
  expect(unknown.status).toBe(400);

  const compactMetadata = {
    request_kind: "compaction",
    thread_id: "thread_web",
    turn_id: "turn_web",
  };
  const compact = await compactRequest(new Request("http://127.0.0.1:17841/v1/responses/compact", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "chatgpt-web/high",
      client_metadata: {
        "x-codex-turn-metadata": JSON.stringify(compactMetadata),
      },
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Compact" }],
          internal_chat_message_metadata_passthrough: { turn_id: "turn_web" },
        },
      ],
    }),
  }), config, () => ({
    name: "test-web",
    async runTurn(parsed, _incoming, emit) {
      expect((parsed._rawBody as Record<string, unknown>).client_metadata).toEqual({
        "x-codex-turn-metadata": JSON.stringify(compactMetadata),
      });
      emit({ type: "text_delta", text: "ok", phase: "final_answer" });
      emit({
        type: "done",
        stopReason: "stop",
        endTurn: true,
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, estimated: true },
      });
    },
  }));
  expect(compact.status).toBe(200);
});
