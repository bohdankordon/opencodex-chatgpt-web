import { afterAll, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CHATGPT_WEB_LUNA_MODEL_ROUTE,
  CHATGPT_WEB_LUNA_THINK_MODEL_ROUTE,
  CHATGPT_WEB_MODEL_ROUTES,
  CHATGPT_WEB_ZERO_RISK_MODEL_ROUTE,
  CHATGPT_WEB_ZERO_RISK_PRO_MODEL_ROUTE,
  isChatGptWebRouteAvailableToExternalClient,
  type ChatGptWebModelRoute,
} from "../src/chatgpt-web-models";
import { defaultConfig } from "../src/config";
import * as externalClientModule from "../src/external-client";
import { EXTERNAL_CLIENT_ID_HEADER, generateExternalClientToken } from "../src/external-client";
import { buildExternalProviderModelCatalog } from "../src/model-catalog";
import { startServer } from "../src/server";

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
  const root = mkdtempSync(join(tmpdir(), "codex-chatgpt-web-catalog-profile-"));
  roots.push(root);
  process.env.CODEX_CHATGPT_WEB_HOME = join(root, "app");
  process.env.CODEX_HOME = join(root, "codex");
  mkdirSync(process.env.CODEX_CHATGPT_WEB_HOME, { recursive: true });
  mkdirSync(process.env.CODEX_HOME, { recursive: true });
  return root;
}

function route(slug: string): ChatGptWebModelRoute {
  const match = CHATGPT_WEB_MODEL_ROUTES.find(candidate => candidate.slug === slug);
  if (!match) throw new Error("Unknown ChatGPT Web route: " + slug);
  return match;
}

function externalProviderConfig(mode: "browser-only" | "full" = "browser-only"): ReturnType<typeof defaultConfig> {
  return { ...defaultConfig(mode), integrationMode: "external-provider" };
}

function modelIds(catalog: { data: Array<{ id: string }> }): string[] {
  return catalog.data.map(row => row.id);
}

const sol = { solAvailable: true, proAvailable: false };
const solExtraHigh = { solAvailable: true, proAvailable: false, extraHighAvailable: true };
const solPro = { solAvailable: true, proAvailable: true, extraHighAvailable: true };
const lunaOnly = { solAvailable: false, proAvailable: false };
const zeroRisk = { solAvailable: true, proAvailable: true, extraHighAvailable: true, browserInteractionMode: "manual" as const };

test("the external route predicate accepts automatic Sol routes for a capable account", () => {
  expect(isChatGptWebRouteAvailableToExternalClient(route("chatgpt-web/light"), sol)).toBe(true);
  expect(isChatGptWebRouteAvailableToExternalClient(route("chatgpt-web/medium"), sol)).toBe(true);
  expect(isChatGptWebRouteAvailableToExternalClient(route("chatgpt-web/high"), sol)).toBe(true);
  expect(isChatGptWebRouteAvailableToExternalClient(route("chatgpt-web/extra-high"), solExtraHigh)).toBe(true);
  expect(isChatGptWebRouteAvailableToExternalClient(route("chatgpt-web/pro"), solPro)).toBe(true);
});

test("the external route predicate rejects gated routes this account cannot use", () => {
  expect(isChatGptWebRouteAvailableToExternalClient(route("chatgpt-web/extra-high"), sol)).toBe(false);
  expect(isChatGptWebRouteAvailableToExternalClient(
    route("chatgpt-web/extra-high"),
    { ...sol, extraHighAvailable: undefined },
  )).toBe(false);
  expect(isChatGptWebRouteAvailableToExternalClient(route("chatgpt-web/pro"), sol)).toBe(false);
  expect(isChatGptWebRouteAvailableToExternalClient(route("chatgpt-web/pro"), solExtraHigh)).toBe(false);
});

test("the external route predicate is safe when a route is passed directly", () => {
  // None of these combinations can reach the predicate through availableChatGptWebModelRoutes(),
  // which is exactly why the predicate must be total on its own.
  expect(isChatGptWebRouteAvailableToExternalClient(route("chatgpt-web/light"), lunaOnly)).toBe(false);
  expect(isChatGptWebRouteAvailableToExternalClient(route("chatgpt-web/pro"), lunaOnly)).toBe(false);
  expect(isChatGptWebRouteAvailableToExternalClient(CHATGPT_WEB_LUNA_MODEL_ROUTE, lunaOnly)).toBe(false);
  expect(isChatGptWebRouteAvailableToExternalClient(CHATGPT_WEB_LUNA_THINK_MODEL_ROUTE, sol)).toBe(false);
  expect(isChatGptWebRouteAvailableToExternalClient(CHATGPT_WEB_LUNA_THINK_MODEL_ROUTE, lunaOnly)).toBe(false);
  expect(isChatGptWebRouteAvailableToExternalClient(route("chatgpt-web/light"), zeroRisk)).toBe(false);
  expect(isChatGptWebRouteAvailableToExternalClient(
    CHATGPT_WEB_ZERO_RISK_MODEL_ROUTE,
    { ...zeroRisk, browserInteractionMode: undefined },
  )).toBe(false);
  expect(isChatGptWebRouteAvailableToExternalClient(
    CHATGPT_WEB_ZERO_RISK_PRO_MODEL_ROUTE,
    { ...zeroRisk, browserInteractionMode: undefined },
  )).toBe(false);
  expect(isChatGptWebRouteAvailableToExternalClient(
    CHATGPT_WEB_ZERO_RISK_PRO_MODEL_ROUTE,
    { solAvailable: true, proAvailable: true, zeroRiskProEnabled: true },
  )).toBe(false);
});

test("the legacy external-provider catalog keeps its exact rows", () => {
  const catalog = buildExternalProviderModelCatalog(externalProviderConfig());
  expect(catalog).toEqual({
    object: "list",
    data: [
      {
        id: "chatgpt-web/light",
        object: "model",
        created: 0,
        owned_by: "codex-chatgpt-web",
        name: "ChatGPT Web — Instant",
        display_name: "ChatGPT Web — Instant",
        description: "ChatGPT Web Instant through the native Codex harness.",
        context_window: 41_000,
        max_context_window: 41_000,
        input_modalities: ["text", "image"],
        capabilities: ["reasoning", "compact"],
        supports_tools: false,
        supports_reasoning: true,
        supports_compact: true,
        reasoning_efforts: ["low"],
        default_reasoning_effort: "low",
      },
      {
        id: "chatgpt-web/medium",
        object: "model",
        created: 0,
        owned_by: "codex-chatgpt-web",
        name: "ChatGPT Web — Medium",
        display_name: "ChatGPT Web — Medium",
        description: "ChatGPT Web Medium through the native Codex harness.",
        context_window: 90_000,
        max_context_window: 90_000,
        input_modalities: ["text", "image"],
        capabilities: ["reasoning", "compact"],
        supports_tools: false,
        supports_reasoning: true,
        supports_compact: true,
        reasoning_efforts: ["medium"],
        default_reasoning_effort: "medium",
      },
      {
        id: "chatgpt-web/high",
        object: "model",
        created: 0,
        owned_by: "codex-chatgpt-web",
        name: "ChatGPT Web — High",
        display_name: "ChatGPT Web — High",
        description: "ChatGPT Web High through the native Codex harness.",
        context_window: 90_000,
        max_context_window: 90_000,
        input_modalities: ["text", "image"],
        capabilities: ["reasoning", "compact"],
        supports_tools: false,
        supports_reasoning: true,
        supports_compact: true,
        reasoning_efforts: ["high"],
        default_reasoning_effort: "high",
      },
    ],
  });
});

test("the legacy profile stays the default and the Full legacy rows keep their tool surface", () => {
  const config = externalProviderConfig("full");
  const implicit = buildExternalProviderModelCatalog(config) as { data: Array<Record<string, unknown>> };
  const explicit = buildExternalProviderModelCatalog(config, "legacy") as { data: Array<Record<string, unknown>> };
  expect(implicit).toEqual(explicit);
  expect(implicit.data.map(row => row.id)).toEqual([
    "chatgpt-web/light", "chatgpt-web/medium", "chatgpt-web/high",
  ]);
  expect(implicit.data[0]).toMatchObject({
    capabilities: ["reasoning", "tools", "compact"],
    supports_tools: true,
    supports_reasoning: true,
    supports_compact: true,
    context_window: 41_000,
  });
});

test("an automatic Sol account serves the same routes under either profile", () => {
  const config = externalProviderConfig();
  const legacy = buildExternalProviderModelCatalog(config) as { data: Array<{ id: string }> };
  const external = buildExternalProviderModelCatalog(config, "external-client") as { data: Array<{ id: string }> };
  expect(modelIds(legacy)).toEqual(["chatgpt-web/light", "chatgpt-web/medium", "chatgpt-web/high"]);
  expect(modelIds(external)).toEqual(modelIds(legacy));
  // Identical on this account is correct: the profile filters, it does not manufacture a difference.
  expect(external).toEqual(legacy);
});

test("gated rows survive external-client filtering exactly when the account permits them", () => {
  const extraHigh = { ...externalProviderConfig(), extraHighAvailable: true };
  expect(modelIds(buildExternalProviderModelCatalog(extraHigh, "external-client") as { data: Array<{ id: string }> }))
    .toEqual(["chatgpt-web/light", "chatgpt-web/medium", "chatgpt-web/high", "chatgpt-web/extra-high"]);

  const pro = { ...externalProviderConfig("full"), proAvailable: true, extraHighAvailable: true };
  expect(modelIds(buildExternalProviderModelCatalog(pro, "external-client") as { data: Array<{ id: string }> }))
    .toEqual([
      "chatgpt-web/light", "chatgpt-web/medium", "chatgpt-web/high", "chatgpt-web/extra-high", "chatgpt-web/pro",
    ]);

  const proWithoutExtraHigh = { ...externalProviderConfig("full"), proAvailable: true, extraHighAvailable: false };
  expect(modelIds(buildExternalProviderModelCatalog(proWithoutExtraHigh, "external-client") as { data: Array<{ id: string }> }))
    .toEqual(["chatgpt-web/light", "chatgpt-web/medium", "chatgpt-web/high", "chatgpt-web/pro"]);
});

test("Luna-only and Zero Risk accounts expose no external-client rows", () => {
  const luna = { ...externalProviderConfig(), solAvailable: false };
  const lunaLegacy = buildExternalProviderModelCatalog(luna) as { data: Array<{ id: string }> };
  const lunaExternal = buildExternalProviderModelCatalog(luna, "external-client") as { data: unknown[] };
  expect(modelIds(lunaLegacy)).toEqual(["chatgpt-web/luna", "chatgpt-web/think"]);
  expect(lunaExternal.data).toEqual([]);

  const manual = { ...externalProviderConfig("full"), browserInteractionMode: "manual" as const, solAvailable: true };
  const manualLegacy = buildExternalProviderModelCatalog(manual) as { data: Array<{ id: string }> };
  expect(modelIds(manualLegacy)).toEqual(["chatgpt-web/zero-risk"]);
  expect((buildExternalProviderModelCatalog(manual, "external-client") as { data: unknown[] }).data).toEqual([]);

  const manualPro = { ...manual, zeroRiskProEnabled: true };
  expect(modelIds(buildExternalProviderModelCatalog(manualPro) as { data: Array<{ id: string }> }))
    .toEqual(["chatgpt-web/zero-risk", "chatgpt-web/zero-risk-pro"]);
  expect((buildExternalProviderModelCatalog(manualPro, "external-client") as { data: unknown[] }).data).toEqual([]);
});

test("external-client filtering repackages no row metadata", () => {
  const config = { ...externalProviderConfig("full"), proAvailable: true, extraHighAvailable: true };
  const legacy = buildExternalProviderModelCatalog(config) as { data: Array<Record<string, unknown>> };
  const external = buildExternalProviderModelCatalog(config, "external-client") as { data: Array<Record<string, unknown>> };
  expect(external.data.length).toBeGreaterThan(3);
  for (const row of external.data) {
    const match = legacy.data.find(candidate => candidate.id === row.id);
    if (!match) throw new Error("The legacy profile is missing row " + String(row.id));
    expect(row).toEqual(match);
  }
});

function nativeModelsFixture(): Record<string, unknown> {
  return {
    models: [{
      slug: "gpt-5.6-sol",
      display_name: "5.6 Sol",
      priority: 1,
      visibility: "list",
      supported_in_api: true,
      multi_agent_version: "v2",
      supported_reasoning_levels: [{ effort: "low", description: "Low" }],
      tool_mode: "code_mode_only",
      context_window: 300_000,
      max_context_window: 320_000,
      auto_compact_token_limit: 270_000,
    }],
  };
}

async function withServer<T>(
  config: ReturnType<typeof defaultConfig>,
  run: (port: number, upstream: Request[]) => Promise<T>,
): Promise<T> {
  const upstream: Request[] = [];
  const server = startServer(config, {
    fetchUpstream: async input => {
      upstream.push(input);
      return Response.json(nativeModelsFixture());
    },
  });
  try {
    await Bun.sleep(0);
    return await run(server.port!, upstream);
  } finally {
    await server.stop(true);
  }
}

function catalogUrl(port: number): string {
  return "http://127.0.0.1:" + port + "/v1/models";
}

test("header presence - not header validity - selects the external-provider catalog profile", async () => {
  isolatedEnvironment();
  const config = externalProviderConfig();
  const token = generateExternalClientToken();
  config.externalClients = [{ id: "hermes-local", token }];
  await withServer(config, async (port, upstream) => {
    const legacy = await fetch(catalogUrl(port));
    const legacyBody = await legacy.text();
    expect(legacy.status).toBe(200);

    const variants: Array<[string, HeadersInit]> = [
      ["valid", [[EXTERNAL_CLIENT_ID_HEADER, "hermes-local"]]],
      ["invalid", [[EXTERNAL_CLIENT_ID_HEADER, "Hermes-Local"]]],
      ["empty", [[EXTERNAL_CLIENT_ID_HEADER, ""]]],
      ["repeated", [[EXTERNAL_CLIENT_ID_HEADER, "hermes-local"], [EXTERNAL_CLIENT_ID_HEADER, "hermes-2"]]],
      ["malformed", [[EXTERNAL_CLIENT_ID_HEADER, "not a client id"]]],
    ];
    const bodies: string[] = [];
    for (const [label, headers] of variants) {
      const response = await fetch(catalogUrl(port), { headers });
      expect([label, response.status]).toEqual([label, 200]);
      bodies.push(await response.text());
    }
    // On an automatic Sol account both profiles render the same rows, so equal bodies are correct.
    for (const body of bodies) expect(body).toBe(legacyBody);
    // The external-provider catalog never contacts native Codex, whatever the header says.
    expect(upstream).toHaveLength(0);
  });
});

test("a Luna-only account shows a different external-provider catalog once the header is present", async () => {
  isolatedEnvironment();
  const config = { ...externalProviderConfig(), solAvailable: false };
  await withServer(config, async port => {
    const legacy = await fetch(catalogUrl(port));
    const legacyBody = await legacy.text();
    expect(JSON.parse(legacyBody).data.map((row: { id: string }) => row.id))
      .toEqual(["chatgpt-web/luna", "chatgpt-web/think"]);

    const withHeader = await fetch(catalogUrl(port), {
      headers: [[EXTERNAL_CLIENT_ID_HEADER, "hermes-local"]],
    });
    const headerBody = await withHeader.text();
    expect(withHeader.status).toBe(200);
    expect(JSON.parse(headerBody).data).toEqual([]);
    expect(headerBody).not.toBe(legacyBody);
    // Different body, different entity tag; identical body above kept its tag unchanged.
    expect(withHeader.headers.get("etag")).not.toBe(legacy.headers.get("etag"));
  });
});

test("catalog profile selection ignores Authorization and leaks no credential material", async () => {
  isolatedEnvironment();
  const config = externalProviderConfig();
  const token = generateExternalClientToken();
  config.externalClients = [{ id: "hermes-local", token }];
  await withServer(config, async (port, upstream) => {
    const headers: Array<[string, HeadersInit]> = [
      ["no authorization", [[EXTERNAL_CLIENT_ID_HEADER, "hermes-local"]]],
      ["wrong bearer", [[EXTERNAL_CLIENT_ID_HEADER, "hermes-local"], ["authorization", "Bearer not-the-token"]]],
      ["plausible bearer", [[EXTERNAL_CLIENT_ID_HEADER, "hermes-local"], ["authorization", "Bearer " + token]]],
      ["empty bearer", [[EXTERNAL_CLIENT_ID_HEADER, "hermes-local"], ["authorization", "Bearer "]]],
    ];
    const bodies: string[] = [];
    for (const [label, requestHeaders] of headers) {
      const response = await fetch(catalogUrl(port), { headers: requestHeaders });
      expect([label, response.status]).toEqual([label, 200]);
      bodies.push(await response.text());
    }
    for (const body of bodies) {
      expect(body).toBe(bodies[0]!);
      expect(body).not.toContain(token);
      expect(body).not.toContain("hermes-local");
      expect(body).not.toContain(config.controlToken);
      expect(body).not.toContain("externalClients");
    }
    expect(upstream).toHaveLength(0);
  });
});

test("model discovery never calls a credential lookup, token verification, or decoy comparison", async () => {
  isolatedEnvironment();
  const config = externalProviderConfig();
  const token = generateExternalClientToken();
  config.externalClients = [{ id: "hermes-local", token }];
  const find = spyOn(externalClientModule, "findExternalClient");
  const verify = spyOn(externalClientModule, "verifyExternalClientToken");
  const decoy = spyOn(externalClientModule, "dummyTimingSafeCompare");
  try {
    await withServer(config, async port => {
      await fetch(catalogUrl(port));
      await fetch(catalogUrl(port), { headers: [[EXTERNAL_CLIENT_ID_HEADER, "hermes-local"]] });
      await fetch(catalogUrl(port), {
        headers: [[EXTERNAL_CLIENT_ID_HEADER, "hermes-local"], ["authorization", "Bearer " + token]],
      });
    });
    // Asserted before restoring: mockRestore resets the recorded calls.
    expect(find).not.toHaveBeenCalled();
    expect(verify).not.toHaveBeenCalled();
    expect(decoy).not.toHaveBeenCalled();
  } finally {
    find.mockRestore();
    verify.mockRestore();
    decoy.mockRestore();
  }
});

test("catalog construction imports no credential primitive", () => {
  const source = readFileSync(new URL("../src/model-catalog.ts", import.meta.url), "utf8");
  for (const forbidden of [
    // The profile name itself contains "external-client"; the credential module is an import.
    'from "./external-client"',
    "externalClients",
    "verifyExternalClientToken",
    "findExternalClient",
    "dummyTimingSafeCompare",
    "Authorization",
    "Bearer",
  ]) {
    expect([forbidden, source.includes(forbidden)]).toEqual([forbidden, false]);
  }
});

test("Direct mode rejects the dedicated header instead of forwarding it upstream", async () => {
  isolatedEnvironment();
  const config = { ...defaultConfig("browser-only"), port: 0 };
  expect(config.integrationMode).toBe("direct");
  await withServer(config, async (port, upstream) => {
    const common = { authorization: "Bearer codex-oauth-token" };
    const withoutHeader = await fetch(catalogUrl(port), { headers: common });
    const withoutBody = await withoutHeader.text();
    // Security correction (Phase D follow-up): Direct mode has no external-client lifecycle, so a
    // dedicated header fails closed instead of entering the native models request. This
    // intentionally supersedes the earlier Phase C expectation that Direct kept native behavior
    // with the header present, because that forwarded an external credential into the native
    // Codex trust domain.
    const withHeader = await fetch(catalogUrl(port), {
      headers: { ...common, [EXTERNAL_CLIENT_ID_HEADER]: "hermes-local" },
    });
    const withBody = await withHeader.text();

    expect(withoutHeader.status).toBe(200);
    expect(upstream).toHaveLength(1);
    expect(upstream[0]!.url.startsWith("https://chatgpt.com/backend-api/codex/models")).toBe(true);
    expect(upstream[0]!.method).toBe("GET");
    expect(upstream[0]!.headers.get("authorization")).toBe("Bearer codex-oauth-token");
    expect(upstream.every(request => request.headers.get(EXTERNAL_CLIENT_ID_HEADER) === null)).toBe(true);

    expect([withHeader.status, withHeader.headers.get("content-type")]).toEqual([401, "application/json"]);
    expect(JSON.parse(withBody)).toEqual({
      error: { message: "External client authentication failed", type: "authentication_error", code: "invalid_api_key" },
    });

    const body = JSON.parse(withoutBody) as { models: Array<{ slug: string; supported_in_api?: boolean }> };
    expect(body.models.map(model => model.slug)).toEqual([
      "gpt-5.6-sol", "chatgpt-web/light", "chatgpt-web/medium", "chatgpt-web/high",
    ]);
    expect(body.models.filter(model => model.slug.startsWith("chatgpt-web/"))).toHaveLength(3);
  });
});

test("the external-client profile is never served on the Direct models path", async () => {
  isolatedEnvironment();
  const config = { ...defaultConfig("browser-only"), port: 0, solAvailable: false };
  await withServer(config, async (port, upstream) => {
    // Header absent keeps legacy Luna-only Direct discovery.
    const legacy = await fetch(catalogUrl(port), { headers: { authorization: "Bearer codex-oauth-token" } });
    const legacyBody = await legacy.json() as { models: Array<{ slug: string }> };
    expect(legacy.status).toBe(200);
    expect(upstream).toHaveLength(1);
    expect(legacyBody.models[0]!.slug).toBe("gpt-5.6-sol");
    expect(legacyBody.models.filter(model => model.slug.startsWith("chatgpt-web/")).map(model => model.slug))
      .toEqual(["chatgpt-web/luna", "chatgpt-web/think"]);

    // Header present is a flat 401 in Direct mode: the restricted catalog is never served here.
    const restricted = await fetch(catalogUrl(port), {
      headers: { authorization: "Bearer codex-oauth-token", [EXTERNAL_CLIENT_ID_HEADER]: "hermes-local" },
    });
    expect(restricted.status).toBe(401);
    expect(upstream).toHaveLength(1);
  });
});

test("the dedicated header enters external admission instead of reaching the native path", async () => {
  isolatedEnvironment();
  const config = externalProviderConfig();
  const server = startServer(config, {
    adapterFactory: () => {
      throw new Error("the browser adapter must not start in this stage");
    },
  });
  try {
    await Bun.sleep(0);
    const response = await fetch("http://127.0.0.1:" + server.port + "/v1/responses", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [EXTERNAL_CLIENT_ID_HEADER]: "hermes-local",
        "authorization": "Bearer external-client-token",
        "x-codex-turn-metadata": JSON.stringify({ thread_id: "thread_a", turn_id: "turn_a" }),
      },
      body: JSON.stringify({ model: "gpt-5.6-sol", input: [] }),
    });
    // Phase D: the dedicated header enters the external-client admission surface, so an
    // unconfigured credential is rejected flatly instead of reaching the native path.
    expect(response.status).toBe(401);
    const body = await response.json() as { error: { message: string; type: string; code: string } };
    expect(body.error).toEqual({
      message: "External client authentication failed",
      type: "authentication_error",
      code: "invalid_api_key",
    });
  } finally {
    await server.stop(true);
  }
});
