import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import {
  extractChatGptTurnEnvironment,
  extractChatGptTurnUserRevision,
} from "../src/adapters/chatgpt-web/environment";
import { bridgeToResponsesSSE } from "../src/bridge";
import { defaultConfig } from "../src/config";
import { ensureOpencodexProviderTokenFile } from "../src/opencodex-provider-auth";
import {
  COMPACT_PROMPT,
  SUMMARY_PREFIX,
  decodeCompactionSummary,
  encodeCompactionSummary,
} from "../src/responses/compaction";
import { parseRequest } from "../src/responses/parser";
import { responseRequest } from "../src/server";
import type { AdapterEvent } from "../src/types";

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

const codexFirstTurn = () => withoutUnderscore(load("codex-first-turn.json"));
const providerFirstTurn = () => withoutUnderscore(load("provider-first-turn.json"));

/** Fixtures use a synthetic root; extraction needs a real absolute root on this platform. */
const tempRoots: string[] = [];
afterAll(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function withRealRoot(body: unknown): { body: unknown; root: string } {
  const root = mkdtempSync(join(tmpdir(), "s4a-267-"));
  tempRoots.push(root);
  const portable = root.replace(/\\/g, "/");
  const text = JSON.stringify(body).replaceAll("/synthetic/work", portable);
  return { body: JSON.parse(text), root: portable };
}

test("2.67 normal Codex turn keeps the frozen top-level contract", () => {
  const body = codexFirstTurn() as Record<string, unknown>;
  expect(Object.keys(body).sort()).toEqual([
    "client_metadata", "include", "input", "instructions", "model",
    "parallel_tool_calls", "prompt_cache_key", "reasoning", "store", "stream",
    "text", "tool_choice", "tools", "access_programs",
  ].sort());
  expect(body.model).toBe("chatgpt-web/high");
  expect(body.store).toBe(false);
  expect(body.stream).toBe(true);
  expect(body.tool_choice).toBe("auto");
  expect(body.parallel_tool_calls).toBe(true);
  expect(body.reasoning).toEqual({ effort: "medium" });
  expect(body.text).toEqual({ verbosity: "low" });
  expect(body.include).toEqual(["reasoning.encrypted_content"]);
  expect(body.prompt_cache_key).toBe("thread_s4a_01");
  for (const absent of ["previous_response_id", "metadata", "service_tier", "max_output_tokens", "truncation", "background", "prompt"]) {
    expect(body).not.toHaveProperty(absent);
  }
});

test("2.67 normal turn parses tools, metadata, environment, and revision", () => {
  const { body, root } = withRealRoot(codexFirstTurn());
  const parsed = parseRequest(body);
  expect(parsed.modelId).toBe("chatgpt-web/high");
  expect(parsed.previousResponseId).toBeUndefined();
  expect(parsed._compactionRequest).toBeUndefined();
  const names = (parsed.context.tools ?? []).map(tool => tool.namespace ? `${tool.namespace}__${tool.name}` : tool.name);
  expect(names).toContain("exec_command");
  expect(names).toContain("apply_patch");
  expect(names).toContain("image_gen__imagegen");
  expect(names).toContain("tool_search");
  expect(names).not.toContain("web_search");
  const freeform = (parsed.context.tools ?? []).find(tool => tool.name === "apply_patch");
  expect(freeform?.freeform).toBe(true);
  expect(extractChatGptTurnEnvironment(parsed).cwd.replace(/\\/g, "/")).toBe(root);
  expect(extractChatGptTurnUserRevision(parsed)).toEqual([
    { type: "input_text", text: "Inspect the workspace read-only." },
  ]);
});

test("2.67 provider-bound turn is stripped yet recovers via native metadata", () => {
  const raw = providerFirstTurn() as Record<string, unknown>;
  expect(raw).not.toHaveProperty("access_programs");
  for (const item of raw.input as Record<string, unknown>[]) {
    expect(item).not.toHaveProperty("id");
    expect(item).not.toHaveProperty("internal_chat_message_metadata_passthrough");
  }
  const tools = raw.tools as Record<string, unknown>[];
  expect(tools.find(tool => tool.name === "apply_patch")).toMatchObject({ type: "function" });
  expect(tools.find(tool => tool.name === "image_gen__imagegen")).toMatchObject({ type: "function" });
  expect(tools.find(tool => tool.name === "tool_search")).toMatchObject({ type: "function" });
  const webSearch = tools.find(tool => tool.type === "web_search");
  expect(webSearch).toBeDefined();
  expect(webSearch).not.toHaveProperty("external_web_access");
  const { body } = withRealRoot(raw);
  const untrusted = parseRequest(body);
  expect(() => extractChatGptTurnUserRevision(untrusted)).toThrow();
  const parsed = parseRequest(body);
  parsed._externalProviderTrusted = true;
  expect(extractChatGptTurnUserRevision(parsed)).toEqual([
    { type: "input_text", text: "Inspect the workspace read-only." },
  ]);
});

test("2.67 replay continuation carries full history without provider state", () => {
  const { body } = withRealRoot(withoutUnderscore(load("replay-continuation.json")));
  const raw = body as Record<string, unknown>;
  expect(raw).not.toHaveProperty("previous_response_id");
  const parsed = parseRequest(body);
  parsed._externalProviderTrusted = true;
  expect(parsed.previousResponseId).toBeUndefined();
  const messages = parsed.context.messages;
  expect(messages.filter(message => message.role === "assistant").length).toBeGreaterThan(0);
  const results = messages.filter(message => message.role === "toolResult");
  expect(results).toHaveLength(1);
  expect(results[0]).toMatchObject({ toolCallId: "call_s4a_01", toolName: "exec_command", content: "round-0" });
  expect(extractChatGptTurnUserRevision(parsed)).toEqual([
    { type: "input_text", text: "Also list hidden files." },
  ]);
});

test("2.67 v2 compaction trigger is a compaction request", () => {
  const fixture = load("compaction.json") as Record<string, Record<string, unknown>>;
  const body = withoutUnderscore(fixture.v2_trigger) as Record<string, unknown>;
  const parsed = parseRequest(body);
  expect(parsed._compactionRequest).toBe(true);
  const rawInput = body.input as unknown[];
  expect(rawInput.some(item => (item as Record<string, unknown>).type === "compaction_trigger")).toBe(true);
});

test("2.67 routed summarizer keeps the v2 marker without a trigger", () => {
  const fixture = load("compaction.json") as Record<string, Record<string, unknown>>;
  const body = withoutUnderscore(fixture.routed_summarizer) as Record<string, unknown>;
  expect(body).not.toHaveProperty("tools");
  expect(body).not.toHaveProperty("tool_choice");
  expect(body).not.toHaveProperty("parallel_tool_calls");
  expect(body).not.toHaveProperty("text");
  expect(body.stream).toBe(true);
  const input = body.input as Record<string, unknown>[];
  expect(input.some(item => item.type === "compaction_trigger")).toBe(false);
  const tail = input.at(-1) as Record<string, unknown>;
  const tailText = ((tail.content as Record<string, unknown>[])[0] as Record<string, unknown>).text as string;
  expect(tailText).toBe(COMPACT_PROMPT);
  const parsed = parseRequest(body);
  expect(parsed._compactionRequest).toBe(true);
  expect(parsed._compactionResponseFormat).toBe("message");
});

test("2.67 routed summarizer returns assistant text over HTTP", async () => {
  const summary = "Synthetic handoff summary.";
  const fixture = load("compaction.json") as Record<string, Record<string, unknown>>;
  const body = withoutUnderscore(fixture.routed_summarizer) as Record<string, unknown>;
  (body as Record<string, unknown>).model = "chatgpt-web/high";
  (body as Record<string, unknown>).stream = false;
  // The routed summarizer arrives fully stripped; the S4B provider Bearer gate plus
  // the external-provider trust binding lets the bridge complete it, as in production.
  const appHome = mkdtempSync(join(tmpdir(), "s4b-267-"));
  tempRoots.push(appHome);
  const prevHome = process.env.CODEX_CHATGPT_WEB_HOME;
  process.env.CODEX_CHATGPT_WEB_HOME = appHome;
  const config = defaultConfig("browser-only");
  config.integrationMode = "external-provider";
  const { token } = ensureOpencodexProviderTokenFile(config.providerTokenFile, config.controlToken);
  const headers = new Headers({ "content-type": "application/json" });
  headers.set("authorization", "Bearer " + token);
  const response = await responseRequest(new Request("http://127.0.0.1/v1/responses", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  }), config, () => ({
    name: "test-web-compactor",
    async runTurn(_parsed, _incoming, emit) {
      emit({ type: "text_delta", text: summary, phase: "final_answer" });
      emit({ type: "done", stopReason: "stop", endTurn: true });
    },
  }));
  if (prevHome === undefined) delete process.env.CODEX_CHATGPT_WEB_HOME; else process.env.CODEX_CHATGPT_WEB_HOME = prevHome;
  expect(response.status).toBe(200);
  const payload = await response.json() as { output: Array<{ type: string; role: string; content: Array<{ type: string; text: string }> }> };
  expect(payload.output).toHaveLength(1);
  expect(payload.output[0]).toMatchObject({ type: "message", role: "assistant" });
  expect(payload.output[0]!.content[0]).toMatchObject({ type: "output_text", text: summary });
});

test("2.67 native responses marker still compacts; unknown marker stays fail-closed", () => {
  const native = {
    model: "chatgpt-web/high",
    client_metadata: { "x-codex-turn-metadata": JSON.stringify({ request_kind: "compaction", thread_id: "t", turn_id: "u", compaction: { implementation: "responses", strategy: "memento" } }) },
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Summarize." }] }],
  };
  expect(parseRequest(native)._compactionRequest).toBe(true);
  const unknown = {
    model: "chatgpt-web/high",
    client_metadata: { "x-codex-turn-metadata": JSON.stringify({ request_kind: "compaction", thread_id: "t", turn_id: "u", compaction: { implementation: "responses_compaction_v2", strategy: "prefix_compaction" } }) },
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Summarize." }] }],
  };
  expect(() => parseRequest(unknown)).toThrow("Unsupported native text compaction");
});

test("2.67 post-compaction replay decodes the stored summary", () => {
  const fixture = load("compaction.json") as Record<string, Record<string, unknown>>;
  const body = withoutUnderscore(fixture.replay);
  const parsed = parseRequest(body);
  expect(parsed._compactionRequest).toBeUndefined();
  const raw = (withoutUnderscore(fixture.replay) as Record<string, unknown>).input as Record<string, unknown>[];
  const stored = raw.find(item => item.type === "compaction");
  const decoded = decodeCompactionSummary(stored?.encrypted_content as string);
  expect(decoded).toBe("Synthetic summary: workspace inspected, continue implementation.");
  const users = parsed.context.messages.filter(message => message.role === "user");
  expect(users.some(message => typeof message.content === "string" && message.content.startsWith(`${SUMMARY_PREFIX}\n\nSynthetic summary:`))).toBe(true);
});

test("2.67 tool_search round exposes deferred tools under exact wire names", () => {
  const fixture = load("tools.json") as Record<string, Record<string, unknown>>;
  const parsed = parseRequest({
    model: "chatgpt-web/high",
    tools: withoutUnderscore(fixture.declarations_provider_side),
    input: withoutUnderscore(fixture.tool_search_round),
  });
  const names = (parsed.context.tools ?? []).map(tool => tool.namespace ? `${tool.namespace}__${tool.name}` : tool.name);
  expect(names).toContain("tool_search");
  expect(names).toContain("subagents__spawn_worker");
  const assistant = parsed.context.messages.filter(message => message.role === "assistant");
  expect(assistant.some(message => message.content.some(part => part.type === "toolCall" && part.name === "tool_search" && part.id === "tscall_s4a_01"))).toBe(true);
  const results = parsed.context.messages.filter(message => message.role === "toolResult");
  expect(results.some(message => message.toolCallId === "tscall_s4a_01" && typeof message.content === "string" && message.content.includes("subagents__spawn_worker"))).toBe(true);
});

test("2.67 call IDs survive replay; custom calls keep raw input; denial stays text", () => {
  const fixture = load("tools.json") as Record<string, Record<string, unknown>>;
  const parsed = parseRequest({
    model: "chatgpt-web/high",
    tools: withoutUnderscore(fixture.declarations_provider_side),
    input: withoutUnderscore(fixture.function_call_round),
  });
  const calls = parsed.context.messages
    .filter(message => message.role === "assistant")
    .flatMap(message => message.content)
    .filter(part => part.type === "toolCall");
  expect(calls.find(call => call.id === "call_s4a_01")).toMatchObject({ name: "exec_command" });
  expect(calls.find(call => call.id === "call_s4a_patch_01")).toMatchObject({ name: "apply_patch", arguments: { input: expect.stringContaining("Begin Patch") } });
  const results = parsed.context.messages.filter(message => message.role === "toolResult");
  expect(results.find(message => message.toolCallId === "call_s4a_01")).toMatchObject({ toolName: "exec_command", content: "round-0", isError: false });
  const denial = results.find(message => message.toolCallId === "call_s4a_denied_01");
  expect(denial).toMatchObject({ isError: false });
  expect(String((denial as { content: unknown }).content)).toContain("approval_denied");
});

test("2.67 stripped post-compaction continuation authorizes", async () => {
  const summary = "Synthetic handoff summary for continuation.";
  const thread = "thread_s4a_cont_01";
  const appHome = mkdtempSync(join(tmpdir(), "s4b-267c-"));
  tempRoots.push(appHome);
  const prevHome = process.env.CODEX_CHATGPT_WEB_HOME;
  process.env.CODEX_CHATGPT_WEB_HOME = appHome;
  const config = defaultConfig("browser-only");
  config.integrationMode = "external-provider";
  const { token } = ensureOpencodexProviderTokenFile(config.providerTokenFile, config.controlToken);
  const authHeaders = () => { const h = new Headers({ "content-type": "application/json" }); h.set("authorization", "Bearer " + token); return h; };
  const root = process.cwd().replace(/\\/g, "/");
  const envText = `<environment_context>\n  <cwd>${root}</cwd>\n  <shell>powershell</shell>\n  <filesystem><workspace_roots><root>${root}</root></workspace_roots><permission_profile type=\"disabled\"><file_system type=\"unrestricted\" /></permission_profile></filesystem>\n</environment_context>`;
  const history = [
    { type: "message", role: "developer", content: [{ type: "input_text", text: "Synthetic developer prelude." }] },
    { type: "message", role: "user", content: [{ type: "input_text", text: envText }] },
    { type: "message", role: "user", content: [{ type: "input_text", text: "Original probe task." }] },
  ];
  const send = (body: unknown, factory: Parameters<typeof responseRequest>[2]) =>
    responseRequest(new Request("http://127.0.0.1/v1/responses", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify(body),
    }), config, factory);
  const summarizer = await send({
    model: "chatgpt-web/high",
    stream: false,
    client_metadata: { "x-codex-turn-metadata": JSON.stringify({ thread_id: thread, turn_id: "turn_s4a_cont_01", request_kind: "compaction", sandbox: "none", sandbox_mode: "danger-full-access", model: "chatgpt-web/high", compaction: { trigger: "auto", reason: "context_limit", implementation: "responses_compaction_v2", phase: "mid_turn", strategy: "memento" } }) },
    input: [...history, { type: "message", role: "user", content: [{ type: "input_text", text: COMPACT_PROMPT }] }],
  }, () => ({
    name: "test-web-compactor",
    async runTurn(_parsed, _incoming, emit) {
      emit({ type: "text_delta", text: summary, phase: "final_answer" });
      emit({ type: "done", stopReason: "stop", endTurn: true });
    },
  }));
  expect(summarizer.status).toBe(200);
  let started = false;
  const continuation = await send({
    model: "chatgpt-web/high",
    stream: false,
    client_metadata: { "x-codex-turn-metadata": JSON.stringify({ thread_id: thread, turn_id: "turn_s4a_cont_02", request_kind: "turn", sandbox: "none", sandbox_mode: "danger-full-access", model: "chatgpt-web/high", workspaces: { [root]: {} } }) },
    input: [...history, { type: "compaction", encrypted_content: encodeCompactionSummary(summary) }],
  }, () => ({
    name: "test-web-continuation",
    async runTurn(_parsed, _incoming, emit) {
      started = true;
      emit({ type: "text_delta", text: "continued", phase: "final_answer" });
      emit({ type: "done", stopReason: "stop", endTurn: true });
    },
  }));
  expect(continuation.status).toBe(200);
  expect(started).toBe(true);
  if (prevHome === undefined) delete process.env.CODEX_CHATGPT_WEB_HOME; else process.env.CODEX_CHATGPT_WEB_HOME = prevHome;
});

test("2.67 metadata envelopes carry the captured compaction object", () => {
  const fixture = load("metadata.json") as Record<string, Record<string, unknown>>;
  expect(fixture.turn.request_kind).toBe("turn");
  expect(fixture.continuation.request_kind).toBe("turn");
  expect(fixture.compaction_v2.request_kind).toBe("compaction");
  expect(fixture.compaction_v2.compaction).toEqual({
    trigger: "auto", reason: "context_limit", implementation: "responses_compaction_v2", phase: "mid_turn", strategy: "memento",
  });
  expect(fixture.continuation.window_number).toBe(1);
  expect(fixture.continuation.turn_id).not.toBe(fixture.turn.turn_id);
  expect(fixture.continuation.thread_id).toBe(fixture.turn.thread_id);
});

test("2.67 text SSE contract ends with exactly one completed terminal", async () => {
  const fixture = load("sse-text-turn.json") as { frames: string[]; usage: Record<string, number> };
  expect(fixture.frames.at(-1)).toBe("response.completed");
  expect(fixture.frames.filter(frame => frame === "response.completed")).toHaveLength(1);
  async function* turn(): AsyncGenerator<AdapterEvent> {
    yield { type: "text_delta", text: "Hello.", phase: "final_answer" };
    yield { type: "done", stopReason: "stop", endTurn: true, usage: { inputTokens: 200, outputTokens: 10, totalTokens: 210 } };
  }
  const seen: string[] = [];
  let sequence = -1;
  let monotonic = true;
  const stream = bridgeToResponsesSSE(turn(), "chatgpt-web/high");
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    buffered += decoder.decode(next.value, { stream: true });
  }
  buffered += decoder.decode();
  expect(buffered).toContain("data: [DONE]");
  for (const chunk of buffered.split("\n\n")) {
    const line = chunk.split("\n").find(part => part.startsWith("data: "));
    if (!line || line === "data: [DONE]") continue;
    const payload = JSON.parse(line.slice("data: ".length)) as { type: string; sequence_number: number };
    seen.push(payload.type);
    if (payload.sequence_number !== sequence + 1) monotonic = false;
    sequence = payload.sequence_number;
  }
  expect(seen).toEqual(fixture.frames);
  expect(monotonic).toBe(true);
});
