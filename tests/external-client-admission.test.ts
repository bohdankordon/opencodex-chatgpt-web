import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncomingMeta, ProviderAdapter } from "../src/adapters/base";
import { chatGptTurnSessions } from "../src/adapters/chatgpt-web/turn-execution";
import { defaultConfig } from "../src/config";
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

test("every external authentication failure returns one byte-equivalent flat 401", async () => {
  isolatedEnvironment();
  const token = generateExternalClientToken();
  const wrongSameLength = token.endsWith("A") ? token.slice(0, -1) + "B" : token.slice(0, -1) + "A";
  expect(wrongSameLength.length).toBe(token.length);
  const body = responsesBody("chatgpt-web/light");
  const direct = directConfig();
  const external = withExternalClient(externalProviderConfig(), token);

  const cases: Array<[string, TestConfig, Array<[string, string]>]> = [
    ["direct + valid-looking client id + correct token", direct, clientHeaders(token)],
    ["direct + invalid client header", direct, [[HEADER, "Hermes-Local"], ["authorization", "Bearer " + token]]],
    ["direct + missing token", direct, [[HEADER, "hermes-local"]]],
    ["external-provider + invalid client header", external, [[HEADER, "Hermes-Local"], ["authorization", "Bearer " + token]]],
    ["external-provider + empty client header", external, [[HEADER, ""], ["authorization", "Bearer " + token]]],
    ["external-provider + duplicate client header", external, [[HEADER, "hermes-local, hermes-2"], ["authorization", "Bearer " + token]]],
    ["external-provider + unknown id + plausible token", external, [[HEADER, "unknown-client"], ["authorization", "Bearer " + token]]],
    ["external-provider + known id + missing token", external, [[HEADER, "hermes-local"]]],
    ["external-provider + known id + malformed bearer", external, [[HEADER, "hermes-local"], ["authorization", "Basic " + token]]],
    ["external-provider + known id + wrong same-length token", external, [[HEADER, "hermes-local"], ["authorization", "Bearer " + wrongSameLength]]],
    ["external-provider + known id + wrong different-length token", external, [[HEADER, "hermes-local"], ["authorization", "Bearer " + token.slice(1)]]],
  ];

  const bodies: string[] = [];
  for (const [label, config, headers] of cases) {
    await withServer(config, async ({ port, upstream, adapterStarts }) => {
      const response = await post(port, "/v1/responses", body, headers);
      const text = await response.text();
      expect([label, response.status, response.headers.get("content-type")]).toEqual([label, 401, "application/json"]);
      expect([label, text]).toEqual([label, AUTH_FAILURE_BODY]);
      expect([label, text.includes(token), text.includes("hermes-local"), text.includes(config.controlToken)])
        .toEqual([label, false, false, false]);
      expect([label, upstream.length, adapterStarts()]).toEqual([label, 0, 0]);
      bodies.push(text);
    });
  }
  expect(bodies).toHaveLength(cases.length);
  expect(new Set(bodies).size).toBe(1);
});

test("authentication precedes every route decision", async () => {
  isolatedEnvironment();
  const token = generateExternalClientToken();
  const config = withExternalClient(externalProviderConfig(), token);
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
    const wrongBodies: string[] = [];
    for (const model of models) {
      const response = await post(port, "/v1/responses", responsesBody(model), [
        [HEADER, "hermes-local"],
        ["authorization", "Bearer " + "W".repeat(43)],
      ]);
      const text = await response.text();
      expect([model, response.status, text]).toEqual([model, 401, AUTH_FAILURE_BODY]);
      wrongBodies.push(text);
    }
    // A wrong credential never discloses route information, whatever model was requested.
    expect(new Set(wrongBodies).size).toBe(1);

    for (const model of models) {
      const response = await post(port, "/v1/responses", responsesBody(model), clientHeaders(token));
      const text = await response.text();
      expect([model, response.status, JSON.parse(text).error.type])
        .toEqual([model, 400, "invalid_request_error"]);
    }
    expect(upstream.length).toBe(0);
    expect(adapterStarts()).toBe(0);
  });
});

test("the shared predicate admits compatible routes to read-only execution and keeps route rejections", async () => {
  isolatedEnvironment();
  const token = generateExternalClientToken();

  const plus = withExternalClient(externalProviderConfig(), token);
  let adapterRuns = 0;
  const factory = () => emittingAdapter(
    "external-read-only-adapter",
    () => { adapterRuns += 1; },
  );
  for (const model of ["chatgpt-web/light", "chatgpt-web/medium", "chatgpt-web/high"]) {
    const response = await responseRequest(
      inProcessRequest(responsesBody(model), clientHeaders(token)),
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
      inProcessRequest(responsesBody(model), clientHeaders(token)),
      plus,
      factory,
    );
    const text = await response.text();
    expect([model, response.status, JSON.parse(text).error.type]).toEqual([model, 400, "invalid_request_error"]);
    expect([model, text.includes("unsupported_operation")]).toEqual([model, false]);
  }
  expect(adapterRuns).toBe(3);

  const gated = withExternalClient({ ...externalProviderConfig(), proAvailable: true, extraHighAvailable: true }, token);
  for (const model of ["chatgpt-web/extra-high", "chatgpt-web/pro"]) {
    const response = await responseRequest(
      inProcessRequest(responsesBody(model), clientHeaders(token)),
      gated,
      factory,
    );
    expect([model, response.status]).toEqual([model, 200]);
  }

  const lunaOnly = withExternalClient({ ...externalProviderConfig(), solAvailable: false }, token);
  for (const model of ["chatgpt-web/luna", "chatgpt-web/think"]) {
    const response = await responseRequest(
      inProcessRequest(responsesBody(model), clientHeaders(token)),
      lunaOnly,
      factory,
    );
    expect([model, response.status]).toEqual([model, 400]);
  }

  const zeroRisk = withExternalClient(
    { ...externalProviderConfig("full"), browserInteractionMode: "manual", solAvailable: true },
    token,
  );
  for (const model of ["chatgpt-web/zero-risk", "chatgpt-web/zero-risk-pro"]) {
    const response = await responseRequest(
      inProcessRequest(responsesBody(model), clientHeaders(token)),
      zeroRisk,
      factory,
    );
    expect([model, response.status]).toEqual([model, 400]);
  }
});

test("external route admission precedes parsing and rejects local continuation", async () => {
  isolatedEnvironment();
  const token = generateExternalClientToken();
  const config = withExternalClient(externalProviderConfig(), token);
  chatGptTurnSessions.clear();
  let adapterRuns = 0;
  const factory = () => emittingAdapter(
    "external-read-only-adapter",
    () => { adapterRuns += 1; },
  );
  // The Responses parser rejects this body after route admission passes.
  const unparsable = await responseRequest(
    inProcessRequest({ model: "chatgpt-web/light", input: 42 }, clientHeaders(token)),
    config,
    factory,
  );
  expect(unparsable.status).toBe(400);

  // Bridge-local continuation is never used for authenticated external traffic.
  const continuation = await responseRequest(
    inProcessRequest(
      responsesBody("chatgpt-web/light", { previous_response_id: "resp_missing" }),
      clientHeaders(token),
    ),
    config,
    factory,
  );
  const text = await continuation.text();
  expect(continuation.status).toBe(400);
  expect(text.includes("previous_response_id")).toBe(true);
  expect([text.includes(token), text.includes("hermes-local")]).toEqual([false, false]);
  expect([adapterRuns, chatGptTurnSessions.activeCount()]).toEqual([0, 0]);
});

test("external requests cannot mint native authority from believable metadata", async () => {
  isolatedEnvironment();
  const token = generateExternalClientToken();
  const config = withExternalClient(externalProviderConfig(), token);
  const metadata = JSON.stringify({ thread_id: "thread_spoof", turn_id: "turn_spoof" });
  const bound: Array<{ threadId: string; turnId: string }> = [];
  let adapterRuns = 0;
  const adapterFactory = () => emittingAdapter(
    "spy-adapter",
    () => { adapterRuns += 1; },
  );

  const cases: Array<[string, unknown, Array<[string, string]>]> = [
    ["body metadata", responsesBody("chatgpt-web/light", { client_metadata: { "x-codex-turn-metadata": metadata } }), clientHeaders(token)],
    ["header metadata", responsesBody("chatgpt-web/light"), [...clientHeaders(token), ["x-codex-turn-metadata", metadata]]],
    ["malformed metadata", responsesBody("chatgpt-web/light", { client_metadata: { "x-codex-turn-metadata": "{not json" } }), clientHeaders(token)],
    ["lookalike fields", responsesBody("chatgpt-web/light", {
      thread_id: "thread_spoof",
      turn_id: "turn_spoof",
      parent_thread_id: "thread_parent",
      prompt_cache_key: "cache_key",
    }), clientHeaders(token)],
  ];
  for (const [label, body, headers] of cases) {
    const response = await responseRequest(
      inProcessRequest(body, headers),
      config,
      adapterFactory,
      { onTurnIdentity: identity => bound.push(identity) },
    );
    expect([label, response.status]).toEqual([label, 200]);
  }
  expect(bound).toEqual([]);
  expect(adapterRuns).toBe(4);
});

test("legacy header-absent behavior is unchanged", async () => {
  isolatedEnvironment();
  const token = generateExternalClientToken();
  const external = withExternalClient(externalProviderConfig(), token);
  const nativeAuthorization: Array<[string, string]> = [["authorization", "Bearer codex-oauth-token"]];
  const metadata = JSON.stringify({ thread_id: "thread_legacy", turn_id: "turn_legacy" });

  // 1. External-provider Web request without native metadata keeps its existing error.
  const missingMetadata = await responseRequest(
    inProcessRequest(responsesBody("chatgpt-web/light"), nativeAuthorization),
    external,
    () => { throw new Error("the browser adapter must not start"); },
  );
  expect([missingMetadata.status, JSON.parse(await missingMetadata.text()).error.message])
    .toEqual([400, METADATA_ERROR_MESSAGE]);

  // 2. External-provider Web request with valid native metadata still reaches the adapter, and
  // the legacy trusted flag is still set for it.
  let trusted: boolean | undefined;
  const bound: Array<{ threadId: string; turnId: string }> = [];
  const legacyWeb = await responseRequest(
    inProcessRequest(
      responsesBody("chatgpt-web/light", { client_metadata: { "x-codex-turn-metadata": metadata } }),
      nativeAuthorization,
    ),
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
    inProcessRequest(responsesBody("gpt-5.6-sol"), nativeAuthorization),
    external,
    () => { throw new Error("the browser adapter must not start"); },
  );
  expect([nativeModel.status, JSON.parse(await nativeModel.text()).error.message])
    .toEqual([400, "Model gpt-5.6-sol is not provided by codex-chatgpt-web in external-provider mode"]);

  // 4. Direct native request still uses native passthrough; 5. Direct Web request still adapts;
  // 6. /v1/models keeps its Phase C legacy catalog when the dedicated header is absent.
  const direct = directConfig();
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
      .toEqual(["chatgpt-web/light", "chatgpt-web/medium", "chatgpt-web/high"]);
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
  isolatedEnvironment();
  const token = generateExternalClientToken();
  const config = withExternalClient(externalProviderConfig(), token);
  await withServer(config, async ({ port, upstream, adapterStarts }) => {
    // Compaction is unsupported for an authenticated external client: one deterministic answer,
    // whatever the request contains. This supersedes the Phase D expectation that compact kept
    // its native-metadata contract for external traffic, which leaked a pre-auth oracle.
    const compact = await post(
      port,
      "/v1/responses/compact",
      { model: "chatgpt-web/light", input: USER_INPUT },
      clientHeaders(token),
    );
    expect([compact.status, JSON.parse(await compact.text()).error]).toEqual([
      501,
      {
        message: "Authenticated external-client compaction is not supported",
        type: "unsupported_operation",
        code: "unsupported_operation",
      },
    ]);

    for (const path of ["/v1/alpha/search", "/v1/images/generations", "/v1/images/edits"]) {
      const response = await post(port, path, { model: "gpt-5.6-sol", prompt: "x" }, clientHeaders(token));
      expect([path, response.status]).toEqual([path, 501]);
    }
    expect([upstream.length, adapterStarts()]).toEqual([0, 0]);
  });
});
