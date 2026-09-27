import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultBrokerEndpoint, defaultConfig, loadConfig, loadConfigForSetup } from "../src/config";
import { buildExternalProviderModelCatalog } from "../src/model-catalog";
import {
  compactRequest,
  modelsRequest,
  responseRequest,
} from "../src/server";
import { formatSetupReport } from "../src/setup";

function isolatedHome(): string {
  const root = mkdtempSync(join(tmpdir(), "codex-chatgpt-web-external-"));
  process.env.CODEX_CHATGPT_WEB_HOME = root;
  process.env.CODEX_HOME = join(root, "codex");
  mkdirSync(join(root, "codex"), { recursive: true });
  return root;
}

test("legacy configs without integrationMode keep direct ownership", () => {
  const root = isolatedHome();
  try {
    const legacy = { ...defaultConfig("browser-only") } as Record<string, unknown>;
    delete legacy.integrationMode;
    writeFileSync(join(root, "config.json"), `${JSON.stringify(legacy)}\n`);
    expect(loadConfig().integrationMode).toBe("direct");
    expect(loadConfigForSetup().integrationMode).toBe("direct");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an explicit external-provider alias survives a missing bridgeEnabled-style field", () => {
  const root = isolatedHome();
  try {
    const raw = {
      ...defaultConfig("browser-only"),
      integrationMode: undefined,
      codexIntegrationMode: "external-provider",
    } as Record<string, unknown>;
    delete raw.integrationMode;
    writeFileSync(join(root, "config.json"), `${JSON.stringify(raw)}\n`);
    expect(loadConfig().integrationMode).toBe("external-provider");
    expect(loadConfigForSetup().integrationMode).toBe("external-provider");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("conflicting aliases keep the conservative external-provider ownership", () => {
  const root = isolatedHome();
  try {
    writeFileSync(join(root, "config.json"), `${JSON.stringify({
      ...defaultConfig("browser-only"),
      integrationMode: "direct",
      codexIntegrationMode: "external-provider",
    })}\n`);
    expect(loadConfig().integrationMode).toBe("external-provider");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("external-provider Full setup report includes both routing and connector guidance", () => {
  const report = formatSetupReport({
    mode: "full",
    configPath: "/tmp/config.json",
    loginCreated: false,
    serviceLoaded: false,
    tunnelReady: true,
    codexRestartRequired: false,
    connectorSetupRequired: true,
    integrationMode: "external-provider",
  });
  expect(report).toContain("Codex routing was not changed");
  expect(report).toContain("attach the tunnel to the ChatGPT connector");
  expect(report).toContain("Keep Codex pointed at OpenCodex");
});

test("external-provider model lists do not call native Codex and omit unavailable models", async () => {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { ensureOpencodexProviderTokenFile } = await import("../src/opencodex-provider-auth");
  const prevHome = process.env.CODEX_CHATGPT_WEB_HOME;
  const appHome = mkdtempSync(join(tmpdir(), "s4b-pc-"));
  process.env.CODEX_CHATGPT_WEB_HOME = appHome;
  const config = defaultConfig("browser-only");
  config.integrationMode = "external-provider";
  config.proAvailable = false;
  const { token } = ensureOpencodexProviderTokenFile(config.providerTokenFile, config.controlToken);
  const headers = new Headers(); headers.set("authorization", "Bearer " + token);
  let upstreamCalls = 0;
  const response = await modelsRequest(new Request("http://127.0.0.1:17841/v1/models", { headers }), config, async () => { upstreamCalls += 1; throw new Error("native"); });
  expect(upstreamCalls).toBe(0);
  expect(response.status).toBe(200);
  if (prevHome === undefined) delete process.env.CODEX_CHATGPT_WEB_HOME; else process.env.CODEX_CHATGPT_WEB_HOME = prevHome;
  const body = await response.json() as { data: Array<{ id: string; capabilities?: string[] }> };
  expect(body.data.map(model => model.id)).toEqual([
    "chatgpt-web/gpt-5.6-sol-instant",
    "chatgpt-web/gpt-5.6-sol",
  ]);
  expect(body.data.every(model => model.capabilities?.includes("tools") !== true)).toBe(true);
});

test("external-provider Full catalogs advertise tools and compact only for supported Web models", () => {
  const config = defaultConfig("full");
  config.integrationMode = "external-provider";
  config.proAvailable = true;
  const catalog = buildExternalProviderModelCatalog(config) as {
    data: Array<{ id: string; capabilities: string[]; context_window: number }>;
  };
  expect(catalog.data.map(model => model.id)).toContain("chatgpt-web/gpt-5.6-pro");
  expect(catalog.data.find(model => model.id === "chatgpt-web/gpt-5.6-sol")?.capabilities).toEqual(
    expect.arrayContaining(["tools", "compact", "reasoning"]),
  );
});

test("external-provider catalog groups account-supported effort without advertising legacy routes", () => {
  const config = defaultConfig("browser-only");
  config.integrationMode = "external-provider";
  config.extraHighAvailable = false;
  const catalog = buildExternalProviderModelCatalog(config) as {
    data: Array<{ id: string; reasoning_efforts: string[]; default_reasoning_effort: string }>;
  };
  expect(catalog.data.map(model => model.id)).toEqual([
    "chatgpt-web/gpt-5.6-sol-instant", "chatgpt-web/gpt-5.6-sol",
  ]);
  expect(catalog.data.find(model => model.id === "chatgpt-web/gpt-5.6-sol")?.reasoning_efforts)
    .toEqual(["medium", "high"]);
  expect(catalog.data.find(model => model.id === "chatgpt-web/gpt-5.6-sol")?.default_reasoning_effort)
    .toBe("high");
  config.extraHighAvailable = true;
  expect((buildExternalProviderModelCatalog(config) as typeof catalog).data
    .find(model => model.id === "chatgpt-web/gpt-5.6-sol")?.reasoning_efforts)
    .toEqual(["medium", "high", "xhigh"]);
});

test("external-provider Responses reject unknown models instead of native fallback", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { ensureOpencodexProviderTokenFile } = await import("../src/opencodex-provider-auth");
  const prevHome = process.env.CODEX_CHATGPT_WEB_HOME;
  const appHome = mkdtempSync(join(tmpdir(), "s4b-unk-"));
  process.env.CODEX_CHATGPT_WEB_HOME = appHome;
  const config = defaultConfig("browser-only");
  config.integrationMode = "external-provider";
  const { token } = ensureOpencodexProviderTokenFile(config.providerTokenFile, config.controlToken);
  const headers = new Headers({ "content-type": "application/json" }); headers.set("authorization", "Bearer " + token);
  const response = await responseRequest(new Request("http://127.0.0.1:17841/v1/responses", { method: "POST", headers, body: JSON.stringify({ model: "gpt-5.6-sol", input: [] }) }), config, () => { throw new Error("adapter must not start"); });
  expect(response.status).toBe(400);
  const body = await response.json() as { error: { message: string; code?: string } };
  expect(body.error.message).toContain("not provided by codex-chatgpt-web");
  expect(body.error.code).toBe("unsupported_model");
  if (prevHome === undefined) delete process.env.CODEX_CHATGPT_WEB_HOME; else process.env.CODEX_CHATGPT_WEB_HOME = prevHome;
  rmSync(appHome, { recursive: true, force: true });
});

test("external-provider compact keeps canonical header metadata authoritative and rejects native models", async () => {
  // S4B: OpenCodex compaction uses ordinary POST /v1/responses, never the legacy
  // /responses/compact endpoint. Provider-authenticated /compact answers 501
  // without binding identity or starting the browser; missing Bearer is 401.
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { ensureOpencodexProviderTokenFile } = await import("../src/opencodex-provider-auth");
  const prevHome = process.env.CODEX_CHATGPT_WEB_HOME;
  const appHome = mkdtempSync(join(tmpdir(), "s4b-cpt-"));
  process.env.CODEX_CHATGPT_WEB_HOME = appHome;
  const config = defaultConfig("full");
  config.integrationMode = "external-provider";
  const { token } = ensureOpencodexProviderTokenFile(config.providerTokenFile, config.controlToken);
  const auth = () => { const h = new Headers({ "content-type": "application/json" }); h.set("authorization", "Bearer " + token); return h; };
  let starts = 0;
  const factory = () => ({ name: "no", async runTurn() { starts += 1; throw new Error("must not run"); } });
  const noAuth = await compactRequest(new Request("http://127.0.0.1:17841/v1/responses/compact", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "gpt-5.6-sol", input: [] }) }), config, factory);
  expect(noAuth.status).toBe(401);
  for (const model of ["gpt-5.6-sol", "chatgpt-web/gpt-5.6-sol"]) {
    const res = await compactRequest(new Request("http://127.0.0.1:17841/v1/responses/compact", { method: "POST", headers: auth(), body: JSON.stringify({ model, input: [] }) }), config, factory);
    expect([model, res.status]).toEqual([model, 501]);
    const body = await res.json() as { error?: { code?: string } };
    expect(body.error?.code).toBe("unsupported_operation");
  }
  expect(starts).toBe(0);
  if (prevHome === undefined) delete process.env.CODEX_CHATGPT_WEB_HOME; else process.env.CODEX_CHATGPT_WEB_HOME = prevHome;
  rmSync(appHome, { recursive: true, force: true });
});
