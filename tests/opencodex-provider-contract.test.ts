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
import { ensureOpencodexProviderTokenFile } from "../src/opencodex-provider-auth";
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
  // The legacy canonical compact endpoint is a separate path, never the OpenCodex
  // provider compaction route (which uses ordinary /v1/responses). URL construction
  // must not duplicate /v1 there either.
  expect(providerUrl("http://127.0.0.1:17841/v1", "/responses/compact")).toBe("http://127.0.0.1:17841/v1/responses/compact");
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
  const appHome = mkdtempSync(join(tmpdir(), "s4b-prov-"));
  tempRoots.push(appHome);
  const prevHome = process.env.CODEX_CHATGPT_WEB_HOME;
  process.env.CODEX_CHATGPT_WEB_HOME = appHome;
  const config = defaultConfig("browser-only");
  config.integrationMode = "external-provider";
  const { token } = ensureOpencodexProviderTokenFile(config.providerTokenFile, config.controlToken);
  const headers = new Headers({ "content-type": "application/json" });
  headers.set("authorization", "Bearer " + token);
  let adapterStarted = false;
  const response = await responseRequest(new Request("http://127.0.0.1:17841/v1/responses", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  }), config, () => {
    adapterStarted = true;
    throw new Error("adapter must not start without native OpenCodex turn metadata");
  });
  expect(adapterStarted).toBe(false);
  expect(response.status).toBe(400);
  const payload = await response.json() as { error?: { message?: string } };
  expect(payload.error?.message).toBe("OpenCodex ChatGPT Web requests require native Codex turn metadata in client_metadata");
  if (prevHome === undefined) delete process.env.CODEX_CHATGPT_WEB_HOME; else process.env.CODEX_CHATGPT_WEB_HOME = prevHome;
});

test("OpenCodex-shaped HTTP requests keep compact metadata and reject unknown models", async () => {
  const appHome = mkdtempSync(join(tmpdir(), "s4b-shaped-"));
  tempRoots.push(appHome);
  const prevHome = process.env.CODEX_CHATGPT_WEB_HOME;
  process.env.CODEX_CHATGPT_WEB_HOME = appHome;
  const config = defaultConfig("browser-only");
  config.integrationMode = "external-provider";
  const { token } = ensureOpencodexProviderTokenFile(config.providerTokenFile, config.controlToken);
  const authHeaders = () => { const h = new Headers({ "content-type": "application/json" }); h.set("authorization", "Bearer " + token); return h; };
  let nativeCalls = 0;
  const models = await modelsRequest(
    new Request("http://127.0.0.1:17841/v1/models", { headers: authHeaders() }),
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
    headers: authHeaders(),
    body: JSON.stringify({ model: "gpt-5.6-sol", input: [] }),
  }), config);
  expect(unknown.status).toBe(400);
  const unknownBody = await unknown.json() as { error?: { message?: string; code?: string } };
  expect(unknownBody.error?.code).toBe("unsupported_model");
  expect(unknownBody.error?.message).toBe("Model gpt-5.6-sol is not provided by codex-chatgpt-web");
  // S4B: OpenCodex compaction uses ordinary /v1/responses, never /responses/compact.
  // The legacy compact endpoint answers 501 for provider-authenticated callers.
  const compact = await compactRequest(new Request("http://127.0.0.1:17841/v1/responses/compact", {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ model: "chatgpt-web/gpt-5.6-sol", input: [] }),
  }), config, () => ({ name: "no", async runTurn() { throw new Error("must not run"); } }));
  expect(compact.status).toBe(501);
  const compactBody = await compact.json() as { error?: { message?: string; code?: string } };
  expect(compactBody.error?.code).toBe("unsupported_operation");
  if (prevHome === undefined) delete process.env.CODEX_CHATGPT_WEB_HOME; else process.env.CODEX_CHATGPT_WEB_HOME = prevHome;
});
