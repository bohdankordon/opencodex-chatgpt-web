import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncomingMeta, ProviderAdapter } from "../src/adapters/base";
import { chatGptTurnSessions } from "../src/adapters/chatgpt-web/turn-execution";
import { defaultConfig } from "../src/config";
import { ensureOpencodexProviderTokenFile, readOpencodexProviderTokenFile } from "../src/opencodex-provider-auth";
import { EXTERNAL_CLIENT_ID_HEADER, generateExternalClientToken } from "../src/external-client";
import { responseRequest, startServer } from "../src/server";
import type { AdapterEvent, CodexParsedRequest } from "../src/types";

const HEADER = EXTERNAL_CLIENT_ID_HEADER;
const AUTH_FAILURE_MESSAGE = "External client authentication failed";
const METADATA_ERROR_MESSAGE = "External-provider ChatGPT Web requests require native Codex turn metadata in client_metadata";
const AUTH_FAILURE_BODY = JSON.stringify({
  error: { message: AUTH_FAILURE_MESSAGE, type: "authentication_error", code: "invalid_api_key" },
});

const roots: string[] = [];
const previousHome = process.env.CODEX_CHATGPT_WEB_HOME;
const previousCodexHome = process.env.CODEX_HOME;

afterAll(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  if (previousHome === undefined) delete process.env.CODEX_CHATGPT_WEB_HOME;
  else process.env.CODEX_CHATGPT_WEB_HOME = previousHome;
  if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = previousCodexHome;
});

function isolatedEnvironment(): string {
  const root = mkdtempSync(join(tmpdir(), "codex-chatgpt-web-admission-"));
  roots.push(root);
  process.env.CODEX_CHATGPT_WEB_HOME = join(root, "app");
  process.env.CODEX_HOME = join(root, "codex");
  mkdirSync(process.env.CODEX_CHATGPT_WEB_HOME, { recursive: true });
  mkdirSync(process.env.CODEX_HOME, { recursive: true });
  return root;
}

type TestConfig = ReturnType<typeof defaultConfig>;

function directConfig(mode: "browser-only" | "full" = "browser-only"): TestConfig {
  return { ...defaultConfig(mode), port: 0 };
}

function externalProviderConfig(mode: "browser-only" | "full" = "browser-only"): TestConfig {
  return { ...defaultConfig(mode), port: 0, integrationMode: "external-provider" };
}

function withExternalClient(config: TestConfig, token: string, id = "hermes-local"): TestConfig {
  config.externalClients = [{ id, token }];
  return config;
}

function clientHeaders(token: string, id = "hermes-local"): Array<[string, string]> {
  return [[HEADER, id], ["authorization", "Bearer " + token]];
}

function providerBearer(config: Pick<ReturnType<typeof defaultConfig>, "providerTokenFile" | "controlToken">): Array<[string, string]> {
  try { readOpencodexProviderTokenFile(config.providerTokenFile); }
  catch { ensureOpencodexProviderTokenFile(config.providerTokenFile, config.controlToken); }
  const token = readOpencodexProviderTokenFile(config.providerTokenFile);
  return [["authorization", "Bearer " + token]];
}

function nativeModelsFixture(): Record<string, unknown> {
  return {
    models: [{
      slug: "gpt-5.6-sol",
      display_name: "5.6 Sol",
      visibility: "list",
      supported_in_api: true,
      supported_reasoning_levels: [{ effort: "low", description: "Low" }],
      tool_mode: "code_mode_only",
    }],
  };
}

interface ServerContext {
  port: number;
  upstream: Request[];
  adapterStarts: () => number;
}

async function withServer<T>(config: TestConfig, run: (context: ServerContext) => Promise<T>): Promise<T> {
  const upstream: Request[] = [];
  let adapterStarts = 0;
  const server = startServer(config, {
    fetchUpstream: async input => {
      upstream.push(input);
      return Response.json(nativeModelsFixture());
    },
    adapterFactory: () => {
      adapterStarts += 1;
      throw new Error("the browser adapter must not start");
    },
  });
  try {
    await Bun.sleep(0);
    return await run({ port: server.port!, upstream, adapterStarts: () => adapterStarts });
  } finally {
    await server.stop(true);
  }
}

async function post(
  port: number,
  path: string,
  body: unknown,
  headers: Array<[string, string]> = [],
): Promise<Response> {
  const requestHeaders = new Headers(headers);
  requestHeaders.set("content-type", "application/json");
  return fetch("http://127.0.0.1:" + port + path, {
    method: "POST",
    headers: requestHeaders,
    body: JSON.stringify(body),
  });
}

function inProcessRequest(body: unknown, headers: Array<[string, string]>): Request {
  const requestHeaders = new Headers(headers);
  requestHeaders.set("content-type", "application/json");
  return new Request("http://127.0.0.1:17841/v1/responses", {
    method: "POST",
    headers: requestHeaders,
    body: JSON.stringify(body),
  });
}

function emittingAdapter(name: string, onRun?: (parsed: CodexParsedRequest) => void): ProviderAdapter {
  return {
    name,
    async runTurn(parsed: CodexParsedRequest, _incoming: IncomingMeta, emit: (event: AdapterEvent) => void) {
      onRun?.(parsed);
      emit({ type: "text_delta", text: "ok", phase: "final_answer" });
      emit({
        type: "done",
        stopReason: "stop",
        endTurn: true,
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, estimated: true },
      });
    },
  };
}

const USER_INPUT = [{ type: "message", role: "user", content: [{ type: "input_text", text: "Hello" }] }];

function responsesBody(model: unknown, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { model, stream: true, input: USER_INPUT, ...extra };
}

function providerMetadata(model: unknown): Record<string, unknown> {
  const root = process.cwd().replace(/\\/g, "/");
  return { "x-codex-turn-metadata": JSON.stringify({ thread_id: "thread_test", turn_id: "turn_test", request_kind: "turn", sandbox: "none", sandbox_mode: "danger-full-access", model: typeof model === "string" ? model : "chatgpt-web/high", workspaces: { [root]: {} } }) };
}

function providerBody(model: unknown, extra: Record<string, unknown> = {}): Record<string, unknown> {
  if (extra.client_metadata !== undefined) return responsesBody(model, extra);
  return responsesBody(model, { client_metadata: providerMetadata(model), ...extra });
}

test("every external authentication failure returns one byte-equivalent flat 401", async () => {
  // S4B: Direct keeps the legacy external-client flat 401; the OpenCodex provider
  // path uses its own dedicated flat 401 (Bearer provider secret). Within each
  // mode every credential shape shares one body, leaks nothing, and starts no work.
  isolatedEnvironment();
  const token = generateExternalClientToken();
  const wrongSameLength = token.endsWith("A") ? token.slice(0, -1) + "B" : token.slice(0, -1) + "A";
  expect(wrongSameLength.length).toBe(token.length);
  const body = responsesBody("chatgpt-web/light");
  const direct = directConfig();
  const directCases: Array<[string, Array<[string, string]>]> = [
    ["direct + valid-looking client id + correct token", clientHeaders(token)],
    ["direct + invalid client header", [[HEADER, "Hermes-Local"], ["authorization", "Bearer " + token]]],
    ["direct + missing token", [[HEADER, "hermes-local"]]],
  ];
  const directBodies = new Set<string>();
  for (const [label, headers] of directCases) {
    await withServer(direct, async ({ port, upstream, adapterStarts }) => {
      const response = await post(port, "/v1/responses", body, headers);
      const text = await response.text();
      expect([label, response.status, response.headers.get("content-type")]).toEqual([label, 401, "application/json"]);
      expect([label, text]).toEqual([label, AUTH_FAILURE_BODY]);
      expect([label, text.includes(token), text.includes("hermes-local")]).toEqual([label, false, false]);
      expect([label, upstream.length, adapterStarts()]).toEqual([label, 0, 0]);
      directBodies.add(text);
    });
  }
  expect(directBodies.size).toBe(1);
  const external = externalProviderConfig();
  const PROVIDER_FAILURE_BODY = JSON.stringify({ error: { message: "OpenCodex provider authentication failed", type: "authentication_error", code: "invalid_api_key" } });
  await withServer(external, async ({ port, upstream, adapterStarts }) => {
    const { readOpencodexProviderTokenFile } = await import("../src/opencodex-provider-auth");
    const providerToken = readOpencodexProviderTokenFile(external.providerTokenFile);
    const wrongProvider = providerToken.endsWith("A") ? providerToken.slice(0, -1) + "B" : providerToken.slice(0, -1) + "A";
    const cases: Array<[string, Array<[string, string]>]> = [
      ["provider missing", []],
      ["provider malformed-basic", [["authorization", "Basic " + providerToken]]],
      ["provider malformed-bare", [["authorization", "Bearer"]]],
      ["provider wrong-same-length", [["authorization", "Bearer " + wrongProvider]]],
      ["provider wrong-short", [["authorization", "Bearer " + providerToken.slice(1)]]],
      ["provider header-only", [[HEADER, "hermes-local"]]],
    ];
    const bodies = new Set<string>();
    for (const [label, headers] of cases) {
      const response = await post(port, "/v1/responses", body, headers);
      const text = await response.text();
      expect([label, response.status]).toEqual([label, 401]);
      expect([label, text]).toEqual([label, PROVIDER_FAILURE_BODY]);
      expect(text.includes(providerToken)).toBe(false);
      expect([label, upstream.length, adapterStarts()]).toEqual([label, 0, 0]);
      bodies.add(text);
    }
    expect(bodies.size).toBe(1);
  });
});

test("authentication precedes every route decision", async () => {
  // S4B: provider Bearer precedes every route decision; wrong/missing share one
  // provider 401 without disclosure, valid Bearer reaches model validation (400)
  // without browser submission.
  isolatedEnvironment();
  const config = externalProviderConfig();
  const models = [
    "gpt-5.6-sol",
    "chatgpt-web/not-a-route",
    "chatgpt-web/luna",
    "chatgpt-web/think",
    "chatgpt-web/zero-risk",
    "chatgpt-web/pro",
    "chatgpt-web/extra-high",
  ];
  await withServer(config, async ({ port, upstream, adapterStarts }) => {
    const { readOpencodexProviderTokenFile } = await import("../src/opencodex-provider-auth");
    const providerToken = readOpencodexProviderTokenFile(config.providerTokenFile);
    const PROVIDER_FAILURE = JSON.stringify({ error: { message: "OpenCodex provider authentication failed", type: "authentication_error", code: "invalid_api_key" } });
    const wrongBodies: string[] = [];
    for (const model of models) {
      const response = await post(port, "/v1/responses", responsesBody(model), [
        ["authorization", "Bearer " + "W".repeat(43)],
      ]);
      const text = await response.text();
      expect([model, response.status, text]).toEqual([model, 401, PROVIDER_FAILURE]);
      wrongBodies.push(text);
    }
    expect(new Set(wrongBodies).size).toBe(1);
    for (const model of models) {
      const response = await post(port, "/v1/responses", responsesBody(model), [["authorization", "Bearer " + providerToken]]);
      const text = await response.text();
      expect([model, response.status, JSON.parse(text).error.type])
        .toEqual([model, 400, "invalid_request_error"]);
    }
    expect(upstream.length).toBe(0);
    expect(adapterStarts()).toBe(0);
  });
});

test("the shared predicate admits compatible routes to read-only execution and keeps route rejections", async () => {
  // S4B: provider Bearer admits compatible Web routes; unknown/ineligible stay 400.
  isolatedEnvironment();
  const plus = externalProviderConfig();
  let adapterRuns = 0;
  const factory = () => emittingAdapter(
    "external-read-only-adapter",
    () => { adapterRuns += 1; },
  );
  for (const model of ["chatgpt-web/light", "chatgpt-web/medium", "chatgpt-web/high"]) {
    const response = await responseRequest(
      inProcessRequest(providerBody(model), providerBearer(plus)),
      plus,
      factory,
    );
    expect([model, response.status]).toEqual([model, 200]);
  }
  expect(adapterRuns).toBe(3);
  for (const model of [
    "gpt-5.6-sol",
    "chatgpt-web/not-a-route",
    "chatgpt-web/luna",
    "chatgpt-web/think",
    "chatgpt-web/zero-risk",
    "chatgpt-web/zero-risk-pro",
    "chatgpt-web/extra-high",
    "chatgpt-web/pro",
  ]) {
    const response = await responseRequest(
      inProcessRequest(responsesBody(model), providerBearer(plus)),
      plus,
      factory,
    );
    const text = await response.text();
    expect([model, response.status, JSON.parse(text).error.type]).toEqual([model, 400, "invalid_request_error"]);
    expect([model, text.includes("unsupported_operation")]).toEqual([model, false]);
  }
  expect(adapterRuns).toBe(3);

  const gated = { ...externalProviderConfig(), proAvailable: true, extraHighAvailable: true };
  for (const model of ["chatgpt-web/extra-high", "chatgpt-web/pro"]) {
    const response = await responseRequest(
      inProcessRequest(providerBody(model), providerBearer(gated)),
      gated,
      factory,
    );
    expect([model, response.status]).toEqual([model, 200]);
  }

  const lunaOnly = { ...externalProviderConfig(), solAvailable: false };
  for (const model of ["chatgpt-web/luna", "chatgpt-web/think"]) {
    const response = await responseRequest(
      inProcessRequest(providerBody(model), providerBearer(lunaOnly)),
      lunaOnly,
      factory,
    );
    // S4B: Luna-only accounts serve Luna rows on the provider path (Web eligibility).
    expect([model, response.status]).toEqual([model, 200]);
  }

  const zeroRisk = { ...externalProviderConfig("full"), browserInteractionMode: "manual" as const, solAvailable: true };
  for (const model of ["chatgpt-web/zero-risk", "chatgpt-web/zero-risk-pro"]) {
    const response = await responseRequest(
      inProcessRequest(responsesBody(model), providerBearer(zeroRisk)),
      zeroRisk,
      factory,
    );
    expect([model, response.status]).toEqual([model, 400]);
  }
});

test("grouped effort admission and trusted family reach one resolved external execution", async () => {
  // S4B: provider Bearer admits grouped efforts; spoofed family fields stay inert
  // prompt text (trusted family comes from the route, not the caller). No external
  // request identity on this path; routing still resolves effort/family/backend.
  isolatedEnvironment();
  const config = { ...externalProviderConfig(), proAvailable: true, extraHighAvailable: true };
  const seen: CodexParsedRequest[] = [];
  const factory = () => emittingAdapter("resolved-route-spy", parsed => seen.push(parsed));
  const call = async (model: string, effort?: string, account: TestConfig = config, extra: Record<string, unknown> = {}) => {
    const root = process.cwd().replace(/\\/g, "/");
    const validMeta = { "x-codex-turn-metadata": JSON.stringify({ thread_id: "thread_test", turn_id: "turn_test", request_kind: "turn", sandbox: "none", sandbox_mode: "danger-full-access", model: model, workspaces: { [root]: {} } }) };
    const mergedExtra = { stream: false, ...(effort === undefined ? {} : { reasoning: { effort } }), ...extra } as Record<string, unknown>;
    const extraMeta = (mergedExtra.client_metadata ?? {}) as Record<string, unknown>;
    (mergedExtra as Record<string, unknown>).client_metadata = { ...validMeta, ...extraMeta };
    const body = responsesBody(model, mergedExtra);
    const response = await responseRequest(inProcessRequest(body, providerBearer(account)), account, factory);
    return response.status;
  };
  for (const [model, effort, family] of [
    ["chatgpt-web/gpt-5.6-sol-instant", "low", "5.6"],
    ["chatgpt-web/gpt-5.6-sol", "medium", "5.6"],
    ["chatgpt-web/gpt-5.6-sol", "high", "5.6"],
    ["chatgpt-web/gpt-5.6-sol", "xhigh", "5.6"],
    ["chatgpt-web/gpt-5.6-pro", "max", "5.6"],
    ["chatgpt-web/gpt-6-pro", "max", "6"],
  ] as const) {
    expect(await call(model, effort, config, {
      _chatgptModelFamily: "spoofed",
      client_metadata: { modelFamily: "spoofed", _chatgptModelFamily: "spoofed" },
    })).toBe(200);
    const parsed = seen.at(-1)!;
    expect(parsed.options.reasoning).toBe(effort);
    expect(parsed._chatgptModelFamily).toBe(family);
    expect(parsed.modelId).toBe("gpt-5.6-sol");
    expect(parsed._externalRequestIdentity).toBeUndefined();
    expect(parsed._externalProviderTrusted).toBe(true);
  }
  expect(await call("chatgpt-web/gpt-5.6-sol")).toBe(200);
  expect(seen.at(-1)!.options.reasoning).toBe("high");
  const beforeRejected = seen.length;
  for (const [model, effort] of [
    ["chatgpt-web/gpt-5.6-sol", "low"],
    ["chatgpt-web/gpt-5.6-sol", "invented"],
    ["chatgpt-web/gpt-5.6-pro", "high"],
    ["chatgpt-web/gpt-6-pro", "medium"],
  ]) expect(await call(model!, effort!)).toBe(400);
  const noXhigh = { ...externalProviderConfig(), extraHighAvailable: false };
  expect(await call("chatgpt-web/gpt-5.6-sol", "xhigh", noXhigh)).toBe(400);
  const noPro = externalProviderConfig();
  expect(await call("chatgpt-web/gpt-5.6-pro", "max", noPro)).toBe(400);
  expect(await call("chatgpt-web/gpt-6-pro", "max", noPro)).toBe(400);
  expect(seen).toHaveLength(beforeRejected);
});

test("legacy external slugs keep their fixed binding only for matching effort", async () => {
  isolatedEnvironment();
  const config = { ...externalProviderConfig(), proAvailable: true };
  const seen: CodexParsedRequest[] = [];
  const factory = () => emittingAdapter("legacy-route-spy", parsed => seen.push(parsed));
  for (const [model, effort, resolved] of [
    ["chatgpt-web/medium", "medium", "medium"],
    ["chatgpt-web/pro", "max", "max"],
    ["chatgpt-web/pro", "ultra", "max"],
  ]) {
    const response = await responseRequest(inProcessRequest(providerBody(model, { stream: false, reasoning: { effort } }), providerBearer(config)), config, factory);
    expect(response.status).toBe(200);
    expect(seen.at(-1)!.options.reasoning).toBe(resolved);
    expect(seen.at(-1)!._chatgptModelFamily).toBeUndefined();
  }
  const before = seen.length;
  // S4B: legacy fixed routes accept known efforts with the fixed binding (high+medium
  // capture proves this); only unknown efforts are rejected before browser.
  for (const effort of ["low", "xhigh"]) {
    const response = await responseRequest(inProcessRequest(providerBody("chatgpt-web/medium", { reasoning: { effort } }), providerBearer(config)), config, factory);
    expect([effort, response.status]).toEqual([effort, 200]);
  }
  expect(seen).toHaveLength(before + 2);
  const bad = await responseRequest(inProcessRequest(responsesBody("chatgpt-web/medium", { reasoning: { effort: "invented" } }), providerBearer(config)), config, factory);
  expect(bad.status).toBe(400);
  expect(seen).toHaveLength(before + 2);
});

test("external route admission parses after authentication and rejects local continuation", async () => {
  isolatedEnvironment();
  const config = externalProviderConfig();
  chatGptTurnSessions.clear();
  let adapterRuns = 0;
  const factory = () => emittingAdapter(
    "external-read-only-adapter",
    () => { adapterRuns += 1; },
  );
  // The Responses parser rejects this body after route admission passes.
  const unparsable = await responseRequest(
    inProcessRequest({ model: "chatgpt-web/light", input: 42 }, providerBearer(config)),
    config,
    factory,
  );
  expect(unparsable.status).toBe(400);

  // Bridge-local continuation is never used for authenticated external traffic.
  const continuation = await responseRequest(
    inProcessRequest(
      responsesBody("chatgpt-web/light", { previous_response_id: "resp_missing" }),
      providerBearer(config),
    ),
    config,
    factory,
  );
  const text = await continuation.text();
  expect(continuation.status).toBe(400);
  expect(text.includes("previous_response_id")).toBe(true);
  expect(text.includes("hermes-local")).toBe(false);
  expect(text.includes(readOpencodexProviderTokenFile(config.providerTokenFile))).toBe(false);
  expect([adapterRuns, chatGptTurnSessions.activeCount()]).toEqual([0, 0]);
});

test("external requests cannot mint native authority from believable metadata", async () => {
  isolatedEnvironment();
  const config = externalProviderConfig();
  const metadata = JSON.stringify({ thread_id: "thread_spoof", turn_id: "turn_spoof" });
  const bound: Array<{ threadId: string; turnId: string }> = [];
  let adapterRuns = 0;
  const adapterFactory = () => emittingAdapter("spy-adapter", () => { adapterRuns += 1; });
  const cases: Array<[string, unknown]> = [
    ["body metadata", responsesBody("chatgpt-web/light", { client_metadata: { "x-codex-turn-metadata": metadata } })],
    ["header metadata", responsesBody("chatgpt-web/light")],
    ["malformed metadata", responsesBody("chatgpt-web/light", { client_metadata: { "x-codex-turn-metadata": "{not json" } })],
    ["lookalike fields", responsesBody("chatgpt-web/light", { thread_id: "thread_spoof", turn_id: "turn_spoof", parent_thread_id: "thread_parent", prompt_cache_key: "cache_key" })],
  ];
  for (const [label, body] of cases) {
    const headers = label === "header metadata" ? [...providerBearer(config), ["x-codex-turn-metadata", metadata] as [string, string]] : providerBearer(config);
    const response = await responseRequest(inProcessRequest(body, headers), config, adapterFactory, { onTurnIdentity: identity => bound.push(identity) });
    // S4B: valid body/header metadata reaches the adapter; malformed and lookalike
    // (no valid native envelope) fail closed without minting authority.
    const expected = label === "body metadata" || label === "header metadata" ? 200 : 400;
    expect([label, response.status]).toEqual([label, expected]);
  }
  // S4B provider binds HTTP tracking identity from valid native envelopes (for
  // interrupt/cancel), but spoofed top-level fields never become execution authority:
  // the adapter runs only for the two valid envelopes, and parsed requests carry
  // _externalProviderTrusted, never a native authority object.
  expect(bound).toEqual([
    { threadId: "thread_spoof", turnId: "turn_spoof" },
    { threadId: "thread_spoof", turnId: "turn_spoof" },
    { threadId: "thread_spoof", turnId: "turn_spoof" },
    { threadId: "thread_spoof", turnId: "turn_spoof" },
  ]);
  expect(adapterRuns).toBe(2);
});

test("legacy header-absent behavior is unchanged", async () => {
  // S4B: external-provider without provider Bearer is 401 provider (not legacy
  // 400/200); with Bearer the trusted Web path still works and native models
  // stay unsupported_model. Direct behavior below is unchanged.
  isolatedEnvironment();
  const external = externalProviderConfig();
  // Ensure the provider file exists so missing-Bearer is 401, not 500.
  providerBearer(external);
  const metadata = JSON.stringify({ thread_id: "thread_legacy", turn_id: "turn_legacy" });
  const withoutBearer: Array<[string, string]> = [["authorization", "Bearer codex-oauth-token"]];
  const missingNoAuth = await responseRequest(inProcessRequest(responsesBody("chatgpt-web/light"), withoutBearer), external, () => { throw new Error("no start"); });
  expect(missingNoAuth.status).toBe(401);
  let trusted: boolean | undefined;
  const bound: Array<{ threadId: string; turnId: string }> = [];
  const legacyWeb = await responseRequest(
    inProcessRequest(responsesBody("chatgpt-web/light", { client_metadata: { "x-codex-turn-metadata": metadata } }), providerBearer(external)),
    external,
    () => emittingAdapter("legacy-web-adapter", parsed => { trusted = parsed._externalProviderTrusted; }),
    { onTurnIdentity: identity => bound.push(identity) },
  );
  expect(legacyWeb.status).toBe(200);
  expect(trusted).toBe(true);
  // The legacy path binds identity from both the raw envelope and the parsed request; that is
  // pre-existing behavior at the reviewed HEAD and is deliberately unchanged by Phase D.
  expect(bound).toEqual([
    { threadId: "thread_legacy", turnId: "turn_legacy" },
    { threadId: "thread_legacy", turnId: "turn_legacy" },
  ]);

  // 3. External-provider native model keeps its existing model_not_found.
  const nativeModel = await responseRequest(
    inProcessRequest(responsesBody("gpt-5.6-sol"), providerBearer(external)),
    external,
    () => { throw new Error("the browser adapter must not start"); },
  );
  expect([nativeModel.status, JSON.parse(await nativeModel.text()).error.message])
    .toEqual([400, "Model gpt-5.6-sol is not provided by codex-chatgpt-web"]);

  // 4. Direct native request still uses native passthrough; 5. Direct Web request still adapts;
  // 6. /v1/models keeps its Phase C legacy catalog when the dedicated header is absent.
  const direct = directConfig();
  const nativeAuthorization: Array<[string, string]> = [["authorization", "Bearer codex-oauth-token"]];
  let directAdapterRuns = 0;
  const directWeb = await responseRequest(
    inProcessRequest(responsesBody("chatgpt-web/light"), nativeAuthorization),
    direct,
    () => emittingAdapter("direct-web-adapter", () => { directAdapterRuns += 1; }),
  );
  expect([directWeb.status, directAdapterRuns]).toEqual([200, 1]);

  // The passthrough fetch is not injectable on this endpoint, so the native branch is proven
  // without any outbound call: without a Bearer the passthrough rejects before contacting Codex.
  const nativePassthrough = await responseRequest(
    inProcessRequest(responsesBody("gpt-5.6-sol"), []),
    direct,
    () => { throw new Error("the browser adapter must not start"); },
  );
  expect([nativePassthrough.status, JSON.parse(await nativePassthrough.text()).error.message])
    .toEqual([502, "Native Codex passthrough requires the incoming Bearer authorization"]);

  await withServer(direct, async ({ port }) => {
    const models = await fetch("http://127.0.0.1:" + port + "/v1/models", { headers: nativeAuthorization });
    const catalog = await models.json() as { models: Array<{ slug: string }> };
    expect(models.status).toBe(200);
    expect(catalog.models.filter(model => model.slug.startsWith("chatgpt-web/")).map(model => model.slug))
      .toEqual(["chatgpt-web/gpt-5.6-sol-instant", "chatgpt-web/gpt-5.6-sol",
        "chatgpt-web/light", "chatgpt-web/medium", "chatgpt-web/high"]);
  });
});

test("an external token never authorizes admin control", async () => {
  isolatedEnvironment();
  const token = generateExternalClientToken();
  const config = withExternalClient(externalProviderConfig(), token);
  expect(token).not.toBe(config.controlToken);
  await withServer(config, async ({ port }) => {
    for (const path of [
      "/admin/drain",
      "/admin/resume",
      "/admin/cancel-turn",
      "/admin/interrupt-turn",
      "/admin/cancel-turns",
      "/admin/shutdown",
    ]) {
      const response = await post(port, path, {}, [["authorization", "Bearer " + token]]);
      expect([path, response.status]).toEqual([path, 401]);
    }
    // The control credential itself still authorizes, and resume restores the drained state.
    const drained = await post(port, "/admin/drain", {}, [["authorization", "Bearer " + config.controlToken]]);
    expect(drained.status).toBe(200);
    const resumed = await post(port, "/admin/resume", {}, [["authorization", "Bearer " + config.controlToken]]);
    expect(resumed.status).toBe(200);
  });
});

test("an external credential grants no native endpoint authority", async () => {
  // S4B: provider Bearer required; /compact answers 501 with the provider message
  // (OpenCodex uses ordinary /v1/responses), search/images stay 501, no work starts.
  isolatedEnvironment();
  const config = externalProviderConfig();
  await withServer(config, async ({ port, upstream, adapterStarts }) => {
    const { readOpencodexProviderTokenFile } = await import("../src/opencodex-provider-auth");
    const providerToken = readOpencodexProviderTokenFile(config.providerTokenFile);
    const auth: Array<[string, string]> = [["authorization", "Bearer " + providerToken]];
    const compact = await post(port, "/v1/responses/compact", { model: "chatgpt-web/light", input: USER_INPUT }, auth);
    expect([compact.status, JSON.parse(await compact.text()).error]).toEqual([501, { message: "OpenCodex compaction uses POST /v1/responses; this endpoint is not part of the OpenCodex provider contract", type: "unsupported_operation", code: "unsupported_operation" }]);
    for (const path of ["/v1/alpha/search", "/v1/images/generations", "/v1/images/edits"]) {
      const response = await post(port, path, { model: "gpt-5.6-sol", prompt: "x" }, auth);
      expect([path, response.status]).toEqual([path, 501]);
    }
    expect([upstream.length, adapterStarts()]).toEqual([0, 0]);
    const noAuth = await post(port, "/v1/responses/compact", { model: "chatgpt-web/light", input: USER_INPUT }, []);
    expect(noAuth.status).toBe(401);
  });
});
