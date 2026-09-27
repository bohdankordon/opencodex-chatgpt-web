import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { defaultConfig } from "../src/config";
import {
  OPENCODEX_PROVIDER_AUTH_FAILURE_MESSAGE,
  OPENCODEX_PROVIDER_COMPACT_ENDPOINT_MESSAGE,
  OPENCODEX_PROVIDER_PREVIOUS_RESPONSE_MESSAGE,
  ensureOpencodexProviderTokenFile,
  generateOpencodexProviderToken,
  readOpencodexProviderTokenFile,
  rotateOpencodexProviderTokenFile,
  validateOpencodexProviderToken,
} from "../src/opencodex-provider-auth";
import { COMPACT_PROMPT, encodeCompactionSummary } from "../src/responses/compaction";
import { parseRequest } from "../src/responses/parser";
import { compactRequest, modelsRequest, responseRequest, startServer } from "../src/server";
import type { AdapterEvent, CodexParsedRequest } from "../src/types";
import type { ProviderAdapter } from "../src/adapters/base";

const roots: string[] = [];
const prevHome = process.env.CODEX_CHATGPT_WEB_HOME;
const prevCodex = process.env.CODEX_HOME;
afterAll(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
  if (prevHome === undefined) delete process.env.CODEX_CHATGPT_WEB_HOME; else process.env.CODEX_CHATGPT_WEB_HOME = prevHome;
  if (prevCodex === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = prevCodex;
});

function isolatedProviderEnv(mode: "browser-only" | "full" = "browser-only") {
  const root = mkdtempSync(join(tmpdir(), "s4b-provider-"));
  roots.push(root);
  const appHome = join(root, "app");
  const codexHome = join(root, "codex");
  mkdirSync(appHome, { recursive: true });
  mkdirSync(codexHome, { recursive: true });
  process.env.CODEX_CHATGPT_WEB_HOME = appHome;
  process.env.CODEX_HOME = codexHome;
  const config = defaultConfig(mode);
  config.integrationMode = "external-provider";
  config.port = 0;
  const ensured = ensureOpencodexProviderTokenFile(config.providerTokenFile, config.controlToken);
  return { root, appHome, codexHome, config, token: ensured.token, tokenFile: ensured.path };
}

function bearer(token: string): Headers {
  const h = new Headers();
  h.set("content-type", "application/json");
  h.set("authorization", "Bearer " + token);
  return h;
}

function emittingAdapter(onRun?: (parsed: CodexParsedRequest) => void, textOut = "ok"): ProviderAdapter {
  return { name: "s4b-test", async runTurn(parsed, _incoming, emit) { onRun?.(parsed); emit({ type: "text_delta", text: textOut, phase: "final_answer" } as AdapterEvent); emit({ type: "done", stopReason: "stop", endTurn: true, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, estimated: true } } as AdapterEvent); } };
}

const dir = new URL("./fixtures/opencodex-2.67/", import.meta.url);
const load = (name: string): unknown => JSON.parse(readFileSync(new URL(name, dir), "utf8"));
function withoutUnderscore(v: unknown): unknown { if (Array.isArray(v)) return v.map(withoutUnderscore); if (v && typeof v === "object") return Object.fromEntries(Object.entries(v as Record<string, unknown>).filter(([k]) => !k.startsWith("_")).map(([k, e]) => [k, withoutUnderscore(e)])); return v; }
function withRealRoot(body: unknown): { body: Record<string, unknown>; root: string } { const r = mkdtempSync(join(tmpdir(), "s4b-root-")); roots.push(r); const p = r.replace(/\\/g, "/"); return { body: JSON.parse(JSON.stringify(body).replaceAll("/synthetic/work", p)), root: p }; }

const AUTH_FAILURE_BODY = JSON.stringify({ error: { message: OPENCODEX_PROVIDER_AUTH_FAILURE_MESSAGE, type: "authentication_error", code: "invalid_api_key" } });

test("provider models requires Bearer: no/malformed/wrong share one 401", async () => {
  const { config, token } = isolatedProviderEnv();
  const wrong = token.endsWith("A") ? token.slice(0, -1) + "B" : token.slice(0, -1) + "A";
  const cases: Array<[string, Headers]> = [
    ["missing", new Headers({ "content-type": "application/json" })],
    ["malformed-basic", (() => { const h = new Headers({ "content-type": "application/json" }); h.set("authorization", "Basic " + token); return h; })()],
    ["malformed-bare", (() => { const h = new Headers({ "content-type": "application/json" }); h.set("authorization", "Bearer"); return h; })()],
    ["wrong-same-length", bearer(wrong)],
    ["wrong-short", bearer(token.slice(1))],
  ];
  const bodies = new Set<string>();
  for (const [label, headers] of cases) {
    const res = await modelsRequest(new Request("http://127.0.0.1/v1/models", { headers }), config, async () => { throw new Error("native must not be contacted " + label); });
    expect([label, res.status]).toEqual([label, 401]);
    const text = await res.text();
    expect([label, text]).toEqual([label, AUTH_FAILURE_BODY]);
    expect(text.includes(token)).toBe(false);
    expect(text.includes(wrong)).toBe(false);
    bodies.add(text);
  }
  expect(bodies.size).toBe(1);
});

test("provider responses requires Bearer before parsing: same 401, no adapter", async () => {
  const { config, token } = isolatedProviderEnv();
  const body = { model: "chatgpt-web/gpt-5.6-sol", input: [] };
  let starts = 0;
  const factory = (): ProviderAdapter => ({ name: "no-start", async runTurn() { starts += 1; throw new Error("must not start"); } });
  const wrong = token.endsWith("A") ? token.slice(0, -1) + "B" : token.slice(0, -1) + "A";
  for (const headers of [new Headers({ "content-type": "application/json" }), bearer(wrong)]) {
    const res = await responseRequest(new Request("http://127.0.0.1/v1/responses", { method: "POST", headers, body: JSON.stringify(body) }), config, factory);
    expect(res.status).toBe(401);
    expect(await res.text()).toBe(AUTH_FAILURE_BODY);
  }
  expect(starts).toBe(0);
});

test("provider accepts captured normal 2.67 with tools present (no S4C)", async () => {
  const { config, token } = isolatedProviderEnv();
  const raw = withoutUnderscore(load("provider-first-turn.json")) as Record<string, unknown>;
  const { body } = withRealRoot(raw);
  (body as Record<string, unknown>).stream = false;
  let sawTools = false;
  const res = await responseRequest(new Request("http://127.0.0.1/v1/responses", { method: "POST", headers: bearer(token), body: JSON.stringify(body) }), config, () => emittingAdapter(p => { sawTools = (p.context.tools ?? []).length > 0; }));
  expect(res.status).toBe(200);
  expect(sawTools).toBe(true);
  const payload = await res.json() as { output?: unknown[]; error?: unknown };
  expect(payload.error).toBeUndefined();
  expect(Array.isArray(payload.output)).toBe(true);
});

test("provider accepts full replay second turn", async () => {
  const { config, token } = isolatedProviderEnv();
  const raw = withoutUnderscore(load("replay-continuation.json")) as Record<string, unknown>;
  const { body } = withRealRoot(raw);
  (body as Record<string, unknown>).stream = false;
  const res = await responseRequest(new Request("http://127.0.0.1/v1/responses", { method: "POST", headers: bearer(token), body: JSON.stringify(body) }), config, () => emittingAdapter(undefined, "continued"));
  expect(res.status).toBe(200);
  const payload = await res.json() as { output: Array<{ content?: Array<{ text?: string }> }> };
  expect(JSON.stringify(payload)).toContain("continued");
});

test("provider accepts replayed function and tool_search native rounds", async () => {
  const fixture = load("tools.json") as Record<string, Record<string, unknown>>;
  const parsedNative = parseRequest({ model: "chatgpt-web/high", tools: withoutUnderscore(fixture.declarations_provider_side), input: withoutUnderscore(fixture.tool_search_round) });
  expect((parsedNative.context.tools ?? []).map(t => t.namespace ? t.namespace + "__" + t.name : t.name)).toContain("tool_search");
  const { config, token } = isolatedProviderEnv();
  const body = { model: "chatgpt-web/gpt-5.6-sol", tools: withoutUnderscore(fixture.declarations_provider_side), input: [...(withoutUnderscore(fixture.tool_search_round) as unknown[]), { type: "message", role: "user", content: [{ type: "input_text", text: "Inspect read-only." }] }], client_metadata: { "x-codex-turn-metadata": JSON.stringify({ thread_id: "t1", turn_id: "u1", request_kind: "turn", sandbox: "none", sandbox_mode: "danger-full-access", model: "chatgpt-web/high", workspaces: { [process.cwd().replace(/\\/g, "/")]: {} } }) } };
  const res = await responseRequest(new Request("http://127.0.0.1/v1/responses", { method: "POST", headers: bearer(token), body: JSON.stringify(body) }), config, () => emittingAdapter());
  expect(res.status).toBe(200);
});

test("provider rejects non-empty previous_response_id with stable unsupported-request", async () => {
  const { config, token } = isolatedProviderEnv();
  let starts = 0;
  const factory = (): ProviderAdapter => ({ name: "no-start", async runTurn() { starts += 1; throw new Error("must not start"); } });
  for (const prev of ["resp_123", ["resp_123"]]) {
    const res = await responseRequest(new Request("http://127.0.0.1/v1/responses", { method: "POST", headers: bearer(token), body: JSON.stringify({ model: "chatgpt-web/gpt-5.6-sol", previous_response_id: prev, input: [] }) }), config, factory);
    expect(res.status).toBe(400);
    const payload = await res.json() as { error?: { type?: string; code?: string; message?: string } };
    expect(payload.error?.message).toBe(OPENCODEX_PROVIDER_PREVIOUS_RESPONSE_MESSAGE);
    expect(payload.error?.type).toBe("invalid_request_error");
    expect(payload.error?.code).toBe("unsupported_request");
  }
  expect(starts).toBe(0);
});

test("provider compaction v2 succeeds via ordinary responses, compact endpoint is unsupported", async () => {
  const { config, token } = isolatedProviderEnv();
  const fixture = load("compaction.json") as Record<string, Record<string, unknown>>;
  const body = withoutUnderscore(fixture.routed_summarizer) as Record<string, unknown>;
  (body as Record<string, unknown>).model = "chatgpt-web/gpt-5.6-sol";
  (body as Record<string, unknown>).stream = false;
  const summary = "Synthetic handoff summary.";
  const res = await responseRequest(new Request("http://127.0.0.1/v1/responses", { method: "POST", headers: bearer(token), body: JSON.stringify(body) }), config, () => ({ name: "compactor", async runTurn(_p, _i, emit) { emit({ type: "text_delta", text: summary, phase: "final_answer" } as AdapterEvent); emit({ type: "done", stopReason: "stop", endTurn: true } as AdapterEvent); } }));
  expect(res.status).toBe(200);
  const payload = await res.json() as { output: Array<{ type: string }> };
  expect(payload.output).toHaveLength(1);
  const compactRes = await compactRequest(new Request("http://127.0.0.1/v1/responses/compact", { method: "POST", headers: bearer(token), body: JSON.stringify({ model: "chatgpt-web/gpt-5.6-sol", input: [] }) }), config, () => ({ name: "no", async runTurn() { throw new Error("must not run"); } }));
  expect(compactRes.status).toBe(501);
  const compactBody = await compactRes.json() as { error?: { message?: string; code?: string } };
  expect(compactBody.error?.message).toBe(OPENCODEX_PROVIDER_COMPACT_ENDPOINT_MESSAGE);
  expect(compactBody.error?.code).toBe("unsupported_operation");
});

test("provider compaction invalid markers fail closed, no browser", async () => {
  const { config, token } = isolatedProviderEnv();
  let starts = 0;
  const factory = (): ProviderAdapter => ({ name: "no-start", async runTurn() { starts += 1; throw new Error("must not start"); } });
  const bad = { model: "chatgpt-web/gpt-5.6-sol", client_metadata: { "x-codex-turn-metadata": JSON.stringify({ request_kind: "compaction", thread_id: "t", turn_id: "u", compaction: { implementation: "responses_compaction_v2", strategy: "prefix_compaction" } }) }, input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Summarize." }] }] };
  const res = await responseRequest(new Request("http://127.0.0.1/v1/responses", { method: "POST", headers: bearer(token), body: JSON.stringify(bad) }), config, factory);
  expect(res.status).toBe(400);
  expect(starts).toBe(0);
});

test("provider web_search accepted with and without external_web_access (capability-gated)", async () => {
  const base = { model: "chatgpt-web/high", input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Hi" }] }] };
  const withFlag = parseRequest({ ...base, tools: [{ type: "web_search", external_web_access: true, search_content_types: ["text"] }] });
  const withoutFlag = parseRequest({ ...base, tools: [{ type: "web_search", search_content_types: ["text"] }] });
  expect(withFlag.context.tools).toBeUndefined();
  expect(withoutFlag.context.tools).toBeUndefined();
  const { config, token } = isolatedProviderEnv();
  for (const tools of [[{ type: "web_search", external_web_access: true }], [{ type: "web_search" }]]) {
    const { body } = withRealRoot({ model: "chatgpt-web/gpt-5.6-sol", tools, input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Hi" }] }], client_metadata: { "x-codex-turn-metadata": JSON.stringify({ thread_id: "tw", turn_id: "uw", request_kind: "turn", sandbox: "none", sandbox_mode: "danger-full-access", model: "chatgpt-web/high", workspaces: { [process.cwd().replace(/\\/g, "/")]: {} } }) } });
    const res = await responseRequest(new Request("http://127.0.0.1/v1/responses", { method: "POST", headers: bearer(token), body: JSON.stringify(body) }), config, () => emittingAdapter());
    expect(res.status).toBe(200);
  }
});

test("provider secret file create/read/no-overwrite/rotate/validate", async () => {
  const root = mkdtempSync(join(tmpdir(), "s4b-secret-")); roots.push(root);
  const file = join(root, "sub", "opencodex-provider-token");
  const first = ensureOpencodexProviderTokenFile(file);
  expect(first.created).toBe(true);
  expect(validateOpencodexProviderToken(first.token)).toBe(first.token);
  const second = ensureOpencodexProviderTokenFile(file);
  expect(second.created).toBe(false);
  expect(second.token).toBe(first.token);
  expect(readOpencodexProviderTokenFile(file)).toBe(first.token);
  if (process.platform !== "win32") {
    const st = statSync(file);
    expect((st.mode & 0o777) & 0o077).toBe(0);
  } else {
    expect(existsSync(file)).toBe(true);
  }
  const rotated = rotateOpencodexProviderTokenFile(file);
  expect(rotated.token).not.toBe(first.token);
  expect(readOpencodexProviderTokenFile(file)).toBe(rotated.token);
  expect(validateOpencodexProviderToken("short")).toBeUndefined();
  expect(generateOpencodexProviderToken().length).toBeGreaterThanOrEqual(43);
});

test("provider secret never appears in errors and differs from control token", async () => {
  const { config, token } = isolatedProviderEnv();
  expect(token).not.toBe(config.controlToken);
  expect(validateOpencodexProviderToken(config.controlToken)).toBe(config.controlToken);
  const bad = await modelsRequest(new Request("http://127.0.0.1/v1/models"), config);
  expect(bad.status).toBe(401);
  expect((await bad.text()).includes(token)).toBe(false);
  expect(() => readOpencodexProviderTokenFile(join(tmpdir(), "s4b-missing-" + Date.now().toString()))).toThrow("unreadable");
});

test("provider token resolution never escapes the isolated app home", async () => {
  const { getDefaultOpencodexProviderTokenFile } = await import("../src/opencodex-provider-auth");
  const root = mkdtempSync(join(tmpdir(), "s4b-isolation-")); roots.push(root);
  const appHome = join(root, "app"); mkdirSync(appHome, { recursive: true });
  process.env.CODEX_CHATGPT_WEB_HOME = appHome;
  const resolved = getDefaultOpencodexProviderTokenFile();
  expect(resolved.startsWith(resolve(appHome))).toBe(true);
  const ensured = ensureOpencodexProviderTokenFile(resolved);
  expect(existsSync(resolved)).toBe(true);
  expect(validateOpencodexProviderToken(ensured.token)).toBe(ensured.token);
});

test("existing config without providerTokenFile migrates with default, no overwrite", async () => {
  const root = mkdtempSync(join(tmpdir(), "s4b-migrate-")); roots.push(root);
  const appHome = join(root, "app"); mkdirSync(appHome, { recursive: true });
  process.env.CODEX_CHATGPT_WEB_HOME = appHome;
  process.env.CODEX_HOME = join(root, "codex"); mkdirSync(process.env.CODEX_HOME, { recursive: true });
  const fresh = defaultConfig("browser-only");
  expect(typeof fresh.providerTokenFile).toBe("string");
  expect(fresh.providerTokenFile.endsWith("opencodex-provider-token")).toBe(true);
  const { token } = ensureOpencodexProviderTokenFile(fresh.providerTokenFile, fresh.controlToken);
  const again = ensureOpencodexProviderTokenFile(fresh.providerTokenFile, fresh.controlToken);
  expect(again.token).toBe(token);
  expect(existsSync(join(appHome, "config.json"))).toBe(false);
});

test("provider lowered tool_search replay exposes deferred specs from JSON string", async () => {
  const fixture = load("lowered-replay.json") as Record<string, unknown>;
  const parsed = parseRequest({ model: "chatgpt-web/high", tools: fixture.declarations_provider_lowered, input: fixture.tool_search_lowered_round });
  const names = (parsed.context.tools ?? []).map(t => (t.namespace ? t.namespace + "__" + t.name : t.name) + (t.toolSearch ? "#search" : ""));
  expect(names.some(n => n.startsWith("tool_search"))).toBe(true);
  expect(names.some(n => n.startsWith("subagents__spawn_worker"))).toBe(true);
  const results = parsed.context.messages.filter(m => m.role === "toolResult");
  expect(results.some(m => m.toolCallId === "call_s4a_search_01" && typeof m.content === "string" && m.content.includes("subagents__spawn_worker"))).toBe(true);
  const calls = parsed.context.messages.filter(m => m.role === "assistant").flatMap(m => m.content).filter(p => p.type === "toolCall");
  expect(calls.some(c => c.id === "call_s4a_search_01" && c.name === "tool_search")).toBe(true);
  expect(calls.some(c => c.id === "call_s4a_spawn_01" && c.name === "subagents__spawn_worker")).toBe(true);
});

test("provider lowered custom call arrives as function_call with input", async () => {
  const fixture = load("lowered-replay.json") as Record<string, unknown>;
  const parsed = parseRequest({ model: "chatgpt-web/high", tools: fixture.declarations_provider_lowered, input: fixture.custom_lowered_round });
  const calls = parsed.context.messages.filter(m => m.role === "assistant").flatMap(m => m.content).filter(p => p.type === "toolCall");
  const patch = calls.find(c => c.id === "call_s4a_patch_01");
  expect(patch).toMatchObject({ name: "apply_patch" });
  expect(JSON.stringify((patch as { arguments?: unknown }).arguments)).toContain("Begin Patch");
  const results = parsed.context.messages.filter(m => m.role === "toolResult");
  expect(results.find(m => m.toolCallId === "call_s4a_patch_01")).toMatchObject({ toolName: "apply_patch" });
});

test("provider accepts lowered replay over HTTP (no rejection for tools)", async () => {
  const { config, token } = isolatedProviderEnv();
  const fixture = load("lowered-replay.json") as Record<string, unknown>;
  const root = process.cwd().replace(/\\/g, "/");
  const body = { model: "chatgpt-web/gpt-5.6-sol", tools: fixture.declarations_provider_lowered, input: [...(fixture.tool_search_lowered_round as unknown[]), { type: "message", role: "user", content: [{ type: "input_text", text: "Proceed read-only." }] }], client_metadata: { "x-codex-turn-metadata": JSON.stringify({ thread_id: "t2", turn_id: "u2", request_kind: "turn", sandbox: "none", sandbox_mode: "danger-full-access", model: "chatgpt-web/high", workspaces: { [root]: {} } }) } };
  const res = await responseRequest(new Request("http://127.0.0.1/v1/responses", { method: "POST", headers: bearer(token), body: JSON.stringify(body) }), config, () => emittingAdapter());
  expect(res.status).toBe(200);
});

test("provider health needs no secret and reveals none", async () => {
  const { config, token } = isolatedProviderEnv();
  const server = startServer(config, { adapterFactory: () => { throw new Error("no adapter"); }, fetchUpstream: async () => { throw new Error("no upstream"); } });
  try {
    await Bun.sleep(10);
    const res = await fetch("http://127.0.0.1:" + server.port + "/healthz");
    expect(res.status).toBe(200);
    const data = await res.json() as Record<string, unknown>;
    const text = JSON.stringify(data);
    expect(text.includes(token)).toBe(false);
    expect(text.includes(config.controlToken)).toBe(false);
    expect(text.includes("opencodex-provider-token")).toBe(false);
    expect(data.status).toBe("ok");
  } finally { await server.stop(true); }
});

test("provider models catalog is Web-only, no native fallback", async () => {
  const { config, token } = isolatedProviderEnv();
  let nativeCalls = 0;
  const res = await modelsRequest(new Request("http://127.0.0.1/v1/models", { headers: bearer(token) }), config, async () => { nativeCalls += 1; throw new Error("native"); });
  expect(res.status).toBe(200);
  expect(nativeCalls).toBe(0);
  const catalog = await res.json() as { data: Array<{ id: string }> };
  expect(catalog.data.length).toBeGreaterThan(0);
  expect(catalog.data.every(m => m.id.startsWith("chatgpt-web/"))).toBe(true);
  expect(catalog.data.some(m => !m.id.startsWith("chatgpt-web/"))).toBe(false);
});

test("provider rejects unknown model before browser, no fallback", async () => {
  const { config, token } = isolatedProviderEnv();
  let starts = 0;
  const factory = (): ProviderAdapter => ({ name: "no-start", async runTurn() { starts += 1; throw new Error("must not start"); } });
  const meta = { "x-codex-turn-metadata": JSON.stringify({ thread_id: "t", turn_id: "u", request_kind: "turn", sandbox: "none", sandbox_mode: "danger-full-access", model: "chatgpt-web/high", workspaces: { [process.cwd().replace(/\\/g, "/")]: {} } }) };
  const cases: Array<{ model: unknown; body: unknown }> = [
    { model: "gpt-5.6-sol", body: { model: "gpt-5.6-sol", input: [] } },
    { model: "chatgpt-web/unknown-model-xyz", body: { model: "chatgpt-web/unknown-model-xyz", input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Hi" }] }], client_metadata: meta } },
    { model: "openai/gpt-5", body: { model: "openai/gpt-5", input: [] } },
    { model: "", body: { model: "", input: [] } },
  ];
  for (const { model, body } of cases) {
    const res = await responseRequest(new Request("http://127.0.0.1/v1/responses", { method: "POST", headers: bearer(token), body: JSON.stringify(body) }), config, factory);
    expect([model, res.status]).toEqual([model, 400]);
    const payload = await res.json() as { error?: { type?: string; code?: string; message?: string } };
    if (payload.error?.code !== "unsupported_model") throw new Error("model=" + JSON.stringify(model) + " got=" + JSON.stringify(payload));
    expect(payload.error?.type).toBe("invalid_request_error");
    expect(typeof payload.error?.message).toBe("string");
  }
  expect(starts).toBe(0);
});
