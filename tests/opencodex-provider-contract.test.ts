import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { readFileSync } from "node:fs";
import {
  extractChatGptTurnEnvironment,
  extractChatGptTurnUserRevision,
} from "../src/adapters/chatgpt-web/environment";
import { defaultConfig } from "../src/config";
import { parseRequest } from "../src/responses/parser";
import { compactRequest, modelsRequest, responseRequest } from "../src/server";

const dir = new URL("./fixtures/opencodex-2.67/", import.meta.url);
const load = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(name, dir), "utf8"));

function withoutUnderscore(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutUnderscore);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([key]) => !key.startsWith("_"))
        .map(([key, entry]) => [key, withoutUnderscore(entry)]),
    );
  }
  return value;
}

/** Fixtures use a synthetic root; extraction needs a real absolute root on this platform. */
const tempRoots: string[] = [];
afterAll(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function withRealRoot(body: unknown): { body: Record<string, unknown>; root: string } {
  const root = mkdtempSync(join(tmpdir(), "s4a-267c-"));
  tempRoots.push(root);
  const portable = root.replace(/\\/g, "/");
  return { body: JSON.parse(JSON.stringify(body).replaceAll("/synthetic/work", portable)), root: portable };
}

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

test("OpenCodex openai-responses URL construction does not duplicate /v1", () => {
  expect(providerUrl("http://127.0.0.1:17841/v1")).toBe("http://127.0.0.1:17841/v1/responses");
  expect(providerUrl("http://127.0.0.1:17841/v1/")).toBe("http://127.0.0.1:17841/v1/responses");
  expect(providerUrl("http://127.0.0.1:17841")).toBe("http://127.0.0.1:17841/v1/responses");
  expect(providerUrl("http://127.0.0.1:17841/v1", "/responses")).toBe("http://127.0.0.1:17841/v1/responses");
});

test("OpenCodex 2.67 store:false sanitization preserves current-turn authority in client_metadata", () => {
  // provider-first-turn.json IS the post-sanitization shape: the obsolete inline 2.58
  // sanitizer simulation was deleted in favor of this captured fixture family.
  const raw = withoutUnderscore(load("provider-first-turn.json")) as Record<string, unknown>;
  expect(raw).not.toHaveProperty("access_programs");
  const routedInput = raw.input as Array<Record<string, unknown>>;
  expect(routedInput.every(item => item.id === undefined)).toBe(true);
  expect(routedInput.every(item => item.internal_chat_message_metadata_passthrough === undefined)).toBe(true);
  expect(raw.client_metadata).toBeDefined();
  const { body, root } = withRealRoot(raw);
  const parsed = parseRequest(body);
  parsed._externalProviderTrusted = true;
  expect(extractChatGptTurnEnvironment(parsed).cwd.replace(/\\/g, "/")).toBe(root);
  expect(extractChatGptTurnUserRevision(parsed)).toEqual([
    { type: "input_text", text: "Inspect the workspace read-only." },
  ]);
});

test("stripped environment recovery itself requires native client_metadata", () => {
  const raw = withoutUnderscore(load("provider-first-turn.json")) as Record<string, unknown>;
  const { body } = withRealRoot(raw);
  delete (body as Record<string, unknown>).client_metadata;
  const parsed = parseRequest(body);
  parsed._externalProviderTrusted = true;
  expect(() => extractChatGptTurnEnvironment(parsed)).toThrow();
  expect(() => extractChatGptTurnUserRevision(parsed)).toThrow();
});

test("external-provider refuses stripped turns when OpenCodex native metadata is missing", async () => {
  const raw = withoutUnderscore(load("provider-first-turn.json")) as Record<string, unknown>;
  const { body } = withRealRoot(raw);
  delete (body as Record<string, unknown>).client_metadata;
  const config = defaultConfig("browser-only");
  config.integrationMode = "external-provider";
  let adapterStarted = false;
  const response = await responseRequest(new Request("http://127.0.0.1:17841/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }), config, () => {
    adapterStarted = true;
    throw new Error("adapter must not start without native OpenCodex turn metadata");
  });
  expect(adapterStarted).toBe(false);
  expect(response.status).toBe(400);
  const payload = await response.json() as { error?: { message?: string } };
  expect(payload.error?.message).toContain("native Codex turn metadata");
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
  const metadata = (load("metadata.json") as Record<string, Record<string, unknown>>).continuation;
  const compactMetadata = {
    request_kind: "compaction",
    thread_id: metadata.thread_id,
    turn_id: metadata.turn_id,
  };
  const root = resolve(process.cwd());
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
        },
      ],
    }),
  }), config, () => ({
    name: "test-web",
    async runTurn(parsed, _incoming, emit) {
      expect((parsed._rawBody as Record<string, unknown>).client_metadata).toEqual({
        "x-codex-turn-metadata": JSON.stringify(compactMetadata),
      });
      expect(root.length).toBeGreaterThan(0);
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
