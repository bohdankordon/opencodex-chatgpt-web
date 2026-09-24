import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncomingMeta, ProviderAdapter } from "../src/adapters/base";
import type { AdapterEvent, CodexParsedRequest } from "../src/types";
import { chatGptTurnSessions } from "../src/adapters/chatgpt-web/turn-execution";
import { defaultConfig } from "../src/config";
import { EXTERNAL_CLIENT_ID_HEADER, generateExternalClientToken } from "../src/external-client";
import { compactRequest, startServer } from "../src/server";

// Network isolation: every native-capable endpoint below receives the injected fetchUpstream stub,
// and every stub request is answered locally. Requests that must not reach a native boundary are
// asserted by call count 0. The native /v1/responses and /v1/responses/compact passthrough is NOT
// injectable, so this file never sends a header-absent request that could reach it: every
// dedicated-header case returns before any passthrough, and the legacy compact regressions use a
// Web model, which is served by the injected adapter factory.

const HEADER = EXTERNAL_CLIENT_ID_HEADER;
const AUTH_FAILURE_BODY = JSON.stringify({
  error: { message: "External client authentication failed", type: "authentication_error", code: "invalid_api_key" },
});
const COMPACT_UNSUPPORTED_BODY = JSON.stringify({
  error: {
    message: "Authenticated external-client compaction is not supported",
    type: "unsupported_operation",
    code: "unsupported_operation",
  },
});
const SEARCH_UNSUPPORTED_BODY = JSON.stringify({
  error: {
    message: "Authenticated external-client native search is not supported",
    type: "unsupported_operation",
    code: "unsupported_operation",
  },
});
const IMAGES_UNSUPPORTED_BODY = JSON.stringify({
  error: {
    message: "Authenticated external-client native image requests are not supported",
    type: "unsupported_operation",
    code: "unsupported_operation",
  },
});
const METADATA_ERROR_MESSAGE = "External-provider ChatGPT Web requests require native Codex turn metadata in client_metadata";

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
  const root = mkdtempSync(join(tmpdir(), "codex-chatgpt-web-native-gate-"));
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

function clientHeaders(token: string, extra: Array<[string, string]> = []): Array<[string, string]> {
  return [[HEADER, "hermes-local"], ["authorization", "Bearer " + token], ...extra];
}

const METADATA_HEADER = "x-codex-turn-metadata";
const SPOOFED_METADATA = JSON.stringify({ thread_id: "thread_spoof", turn_id: "turn_spoof" });

interface ServerContext {
  port: number;
  upstream: Request[];
  adapterStarts: () => number;
}

// The stub records and answers locally, so no corrected endpoint can reach a provider even if the
// gate regressed; the assertions then fail on the recorded call count instead of hitting a network.
async function withServer<T>(config: TestConfig, run: (context: ServerContext) => Promise<T>): Promise<T> {
  const upstream: Request[] = [];
  let adapterStarts = 0;
  const server = startServer(config, {
    fetchUpstream: async input => {
      upstream.push(input);
      // A complete native models fixture: the direct catalog augmentation needs one list-visible
      // model with reasoning metadata, and search/image forwarding accepts the same payload.
      return Response.json({
        object: "list",
        data: [],
        models: [{
          slug: "gpt-5.6-sol",
          display_name: "5.6 Sol",
          visibility: "list",
          supported_in_api: true,
          supported_reasoning_levels: [{ effort: "low", description: "Low" }],
          tool_mode: "code_mode_only",
        }],
      });
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

function inProcessRequest(path: string, body: unknown, headers: Array<[string, string]>): Request {
  const requestHeaders = new Headers(headers);
  requestHeaders.set("content-type", "application/json");
  return new Request("http://127.0.0.1:17841" + path, {
    method: "POST",
    headers: requestHeaders,
    body: JSON.stringify(body),
  });
}

function emittingAdapter(name: string, onRun?: () => void): ProviderAdapter {
  return {
    name,
    async runTurn(_parsed: CodexParsedRequest, _incoming: IncomingMeta, emit: (event: AdapterEvent) => void) {
      onRun?.();
      emit({ type: "text_delta", text: "Summary", phase: "final_answer" });
      emit({
        type: "done",
        stopReason: "stop",
        endTurn: true,
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, estimated: true },
      });
    },
  };
}

test("Direct models rejects every dedicated header shape without contacting upstream", async () => {
  isolatedEnvironment();
  const token = generateExternalClientToken();
  const config = withExternalClient(directConfig(), token);
  await withServer(config, async ({ port, upstream }) => {
    const variants: Array<[string, Array<[string, string]>]> = [
      ["valid id + external bearer", [[HEADER, "hermes-local"], ["authorization", "Bearer " + token]]],
      ["unknown id + plausible bearer", [[HEADER, "unknown-client"], ["authorization", "Bearer " + token]]],
      ["invalid id", [[HEADER, "Hermes-Local"], ["authorization", "Bearer " + token]]],
      ["empty id", [[HEADER, ""], ["authorization", "Bearer " + token]]],
      ["comma-joined id", [[HEADER, "hermes-local, hermes-2"], ["authorization", "Bearer " + token]]],
      ["no authorization", [[HEADER, "hermes-local"]]],
    ];
    const bodies: string[] = [];
    for (const [label, headers] of variants) {
      const response = await fetch("http://127.0.0.1:" + port + "/v1/models", { headers });
      const text = await response.text();
      expect([label, response.status, text]).toEqual([label, 401, AUTH_FAILURE_BODY]);
      bodies.push(text);
    }
    expect(new Set(bodies).size).toBe(1);
    // No native models request may carry an external credential out of the bridge.
    expect(upstream).toHaveLength(0);
  });
});

test("Direct models keeps its native request when the dedicated header is absent", async () => {
  isolatedEnvironment();
  const config = directConfig();
  await withServer(config, async ({ port, upstream }) => {
    const response = await fetch("http://127.0.0.1:" + port + "/v1/models", {
      headers: { authorization: "Bearer codex-oauth-token" },
    });
    expect(response.status).toBe(200);
    expect(upstream).toHaveLength(1);
    expect(upstream[0]!.url.startsWith("https://chatgpt.com/backend-api/codex/models")).toBe(true);
    expect(upstream[0]!.headers.get("authorization")).toBe("Bearer codex-oauth-token");
  });
});

test("compact classifies the dedicated header before promotion and native identity extraction", () => {
  const source = readFileSync(new URL("../src/server.ts", import.meta.url), "utf8");
  const compactStart = source.indexOf("export async function compactRequest(");
  const startServerAt = source.indexOf("export function startServer(", compactStart);
  expect(compactStart).toBeGreaterThan(0);
  expect(startServerAt).toBeGreaterThan(compactStart);
  const compact = source.slice(compactStart, startServerAt);
  const classify = compact.indexOf("authenticateExternalClientRequest(req, config)");
  const promotion = compact.indexOf("applyCodexTurnMetadataHeader(raw, req, { headerWins: true })");
  const identity = compact.indexOf("extractCodexTurnIdentityFromBody(raw)");
  const metadataError = compact.indexOf("externalProviderTurnMetadataError(config, raw.model");
  const passthrough = compact.indexOf("forwardNativeCodexRequest(nativeRequest, \"responses/compact\"");
  expect([classify > 0, promotion > 0, identity > 0, metadataError > 0, passthrough > 0])
    .toEqual([true, true, true, true, true]);
  expect(classify).toBeLessThan(promotion);
  expect(classify).toBeLessThan(identity);
  expect(classify).toBeLessThan(metadataError);
  expect(classify).toBeLessThan(passthrough);
});

test("authenticated external compact gets one unsupported answer and binds no native identity", async () => {
  isolatedEnvironment();
  const token = generateExternalClientToken();
  const config = withExternalClient(externalProviderConfig(), token);
  chatGptTurnSessions.clear();
  const bound: Array<{ threadId: string; turnId: string }> = [];
  let adapterStarts = 0;
  const adapterFactory = (): ProviderAdapter => ({
    name: "spy-adapter",
    async runTurn() {
      adapterStarts += 1;
      throw new Error("the browser adapter must not start");
    },
  });
  const bodies = [
    { model: "chatgpt-web/medium", input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Compact this" }] }] },
    { model: "gpt-5.6-sol", input: [] },
    { model: "chatgpt-web/luna", input: [] },
    { model: "chatgpt-web/medium", previous_response_id: "resp_missing", input: [] },
  ];
  const metadataVariants: Array<string | undefined> = [SPOOFED_METADATA, "{not json", undefined];
  for (const body of bodies) {
    for (const metadata of metadataVariants) {
      const headers = clientHeaders(token, metadata === undefined ? [] : [[METADATA_HEADER, metadata]]);
      const response = await compactRequest(
        inProcessRequest("/v1/responses/compact", body, headers),
        config,
        adapterFactory,
        { onTurnIdentity: identity => bound.push(identity) },
      );
      expect([JSON.stringify(body), metadata ?? "none", response.status, await response.text()])
        .toEqual([JSON.stringify(body), metadata ?? "none", 501, COMPACT_UNSUPPORTED_BODY]);
    }
  }
  expect(bound).toEqual([]);
  expect(adapterStarts).toBe(0);
  expect(chatGptTurnSessions.activeCount()).toBe(0);
});

test("Direct compact rejects the dedicated header before any native work", async () => {
  isolatedEnvironment();
  const token = generateExternalClientToken();
  const config = withExternalClient(directConfig(), token);
  const bound: Array<{ threadId: string; turnId: string }> = [];
  let adapterStarts = 0;
  const variants: Array<Array<[string, string]>> = [
    clientHeaders(token, [[METADATA_HEADER, SPOOFED_METADATA]]),
    [[HEADER, "hermes-local"]],
    [[HEADER, "Hermes-Local"], ["authorization", "Bearer " + token]],
  ];
  for (const headers of variants) {
    const response = await compactRequest(
      inProcessRequest("/v1/responses/compact", { model: "gpt-5.6-sol", input: [] }, headers),
      config,
      () => { adapterStarts += 1; throw new Error("the browser adapter must not start"); },
      { onTurnIdentity: identity => bound.push(identity) },
    );
    expect([response.status, await response.text()]).toEqual([401, AUTH_FAILURE_BODY]);
  }
  expect(bound).toEqual([]);
  expect(adapterStarts).toBe(0);
});

test("external compact wrong credentials never disclose model or metadata state", async () => {
  isolatedEnvironment();
  const config = withExternalClient(externalProviderConfig(), generateExternalClientToken());
  const bodies: string[] = [];
  for (const model of ["gpt-5.6-sol", "chatgpt-web/not-a-route", "chatgpt-web/luna", "chatgpt-web/medium"]) {
    for (const metadata of [SPOOFED_METADATA, "{not json", undefined]) {
      const headers: Array<[string, string]> = [
        [HEADER, "hermes-local"],
        ["authorization", "Bearer " + "W".repeat(43)],
        ...(metadata === undefined ? [] : [[METADATA_HEADER, metadata]] as Array<[string, string]>),
      ];
      const response = await compactRequest(
        inProcessRequest("/v1/responses/compact", { model, input: [] }, headers),
        config,
        () => { throw new Error("the browser adapter must not start"); },
      );
      const text = await response.text();
      expect([model, metadata ?? "none", response.status, text])
        .toEqual([model, metadata ?? "none", 401, AUTH_FAILURE_BODY]);
      bodies.push(text);
    }
  }
  expect(new Set(bodies).size).toBe(1);
});

test("the real compact route never binds spoofed identity for external traffic", async () => {
  isolatedEnvironment();
  const token = generateExternalClientToken();
  const config = withExternalClient(externalProviderConfig(), token);
  await withServer(config, async ({ port, upstream, adapterStarts }) => {
    const good = await post(
      port,
      "/v1/responses/compact",
      { model: "chatgpt-web/medium", input: [] },
      clientHeaders(token, [[METADATA_HEADER, SPOOFED_METADATA]]),
    );
    expect([good.status, await good.text()]).toEqual([501, COMPACT_UNSUPPORTED_BODY]);

    const wrong = await post(
      port,
      "/v1/responses/compact",
      { model: "chatgpt-web/medium", input: [] },
      [[HEADER, "hermes-local"], ["authorization", "Bearer " + "W".repeat(43)], [METADATA_HEADER, SPOOFED_METADATA]],
    );
    expect([wrong.status, await wrong.text()]).toEqual([401, AUTH_FAILURE_BODY]);
    expect([upstream.length, adapterStarts()]).toEqual([0, 0]);
  });
});

test("Direct search and image endpoints reject the dedicated header before upstream", async () => {
  isolatedEnvironment();
  const token = generateExternalClientToken();
  const config = withExternalClient(directConfig(), token);
  await withServer(config, async ({ port, upstream }) => {
    for (const path of ["/v1/alpha/search", "/v1/images/generations", "/v1/images/edits"]) {
      const variants: Array<Array<[string, string]>> = [
        clientHeaders(token),
        [[HEADER, "Hermes-Local"]],
        [[HEADER, ""]],
      ];
      for (const headers of variants) {
        const response = await post(port, path, { model: "gpt-5.6-sol" }, headers);
        expect([path, response.status, await response.text()]).toEqual([path, 401, AUTH_FAILURE_BODY]);
      }
    }
    expect(upstream).toHaveLength(0);
  });
});

test("external-provider search and image endpoints authenticate before their unsupported answer", async () => {
  isolatedEnvironment();
  const token = generateExternalClientToken();
  const config = withExternalClient(externalProviderConfig(), token);
  await withServer(config, async ({ port, upstream }) => {
    const paths: Array<[string, string]> = [
      ["/v1/alpha/search", SEARCH_UNSUPPORTED_BODY],
      ["/v1/images/generations", IMAGES_UNSUPPORTED_BODY],
      ["/v1/images/edits", IMAGES_UNSUPPORTED_BODY],
    ];
    for (const [path, body] of paths) {
      const wrong = await post(
        port,
        path,
        { model: "gpt-5.6-sol" },
        [[HEADER, "hermes-local"], ["authorization", "Bearer " + "W".repeat(43)]],
      );
      expect([path, "wrong", wrong.status, await wrong.text()])
        .toEqual([path, "wrong", 401, AUTH_FAILURE_BODY]);

      const good = await post(port, path, { model: "gpt-5.6-sol" }, clientHeaders(token));
      expect([path, "good", good.status, await good.text()]).toEqual([path, "good", 501, body]);
    }
    expect(upstream).toHaveLength(0);
  });
});

test("header-absent legacy behavior on the corrected endpoints is unchanged", async () => {
  isolatedEnvironment();
  const token = generateExternalClientToken();
  const external = withExternalClient(externalProviderConfig(), token);

  // Direct search and images still use the injected native stub when no dedicated header is sent.
  await withServer(directConfig(), async ({ port, upstream }) => {
    const nativeAuthorization: Array<[string, string]> = [["authorization", "Bearer codex-oauth-token"]];
    const search = await post(port, "/v1/alpha/search", { query: "x" }, nativeAuthorization);
    expect(search.status).toBe(200);
    const images = await post(port, "/v1/images/generations", { prompt: "x" }, nativeAuthorization);
    expect(images.status).toBe(200);
    expect(upstream).toHaveLength(2);
  });

  // External-provider search and images keep their existing unsupported answer without the header.
  await withServer(external, async ({ port, upstream }) => {
    for (const path of ["/v1/alpha/search", "/v1/images/generations", "/v1/images/edits"]) {
      const response = await post(port, path, { model: "gpt-5.6-sol" });
      expect([path, response.status]).toEqual([path, 501]);
    }
    expect(upstream).toHaveLength(0);
  });

  // External-provider compact keeps its native-metadata contract without the header.
  const missingMetadata = await compactRequest(
    inProcessRequest(
      "/v1/responses/compact",
      { model: "chatgpt-web/medium", input: [] },
      [["authorization", "Bearer codex-oauth-token"]],
    ),
    external,
    () => { throw new Error("the browser adapter must not start"); },
  );
  expect([missingMetadata.status, JSON.parse(await missingMetadata.text()).error.message])
    .toEqual([400, METADATA_ERROR_MESSAGE]);

  // ...and a header-absent compact with valid native metadata still enters the legacy path: the
  // injected adapter factory is reached, which can only happen after the external gate is skipped.
  // (The full legacy compaction turn stays covered by the existing external-provider suite.)
  let adapterCalls = 0;
  let legacyThrew = false;
  const metadata = JSON.stringify({ thread_id: "thread_legacy", turn_id: "turn_legacy" });
  try {
    const legacy = await compactRequest(
      inProcessRequest(
        "/v1/responses/compact",
        { model: "chatgpt-web/medium", input: [] },
        [["authorization", "Bearer codex-oauth-token"], [METADATA_HEADER, metadata]],
      ),
      external,
      () => {
        adapterCalls += 1;
        throw new Error("legacy compact path reached");
      },
    );
    expect(legacy.status).not.toBe(401);
  } catch {
    legacyThrew = true;
  }
  expect([adapterCalls, legacyThrew]).toEqual([1, true]);
});
