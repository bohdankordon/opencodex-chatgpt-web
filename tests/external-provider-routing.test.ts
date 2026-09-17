import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  activateCodexIntegration,
  assertDirectCodexIntegration,
  commitExternalProviderOwnershipHandoff,
  deactivateCodexIntegration,
  getCodexJournalPath,
  getCodexJournalRecoveryPath,
  inspectCodexIntegration,
  installCodexIntegration,
  preflightCodexIntegration,
  uninstallCodexIntegration,
} from "../src/codex-integration";
import { defaultConfig, getConfigPath } from "../src/config";
import { preflightSetup } from "../src/setup";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function isolate(): { root: string; codexHome: string } {
  const root = mkdtempSync(join(tmpdir(), "codex-chatgpt-web-external-route-"));
  roots.push(root);
  const codexHome = join(root, "codex");
  mkdirSync(codexHome, { recursive: true });
  process.env.CODEX_HOME = codexHome;
  process.env.CODEX_CHATGPT_WEB_HOME = join(root, "app");
  mkdirSync(join(root, "app"), { recursive: true });
  return { root, codexHome };
}

test("external-provider setup never writes Codex config or models cache", () => {
  const { codexHome } = isolate();
  const config = defaultConfig("browser-only");
  config.integrationMode = "external-provider";
  const fixture = `openai_base_url = "http://127.0.0.1:1455/v1"\nmodel_provider = "opencodex"\n`;
  writeFileSync(join(codexHome, "config.toml"), fixture);
  writeFileSync(join(process.env.CODEX_CHATGPT_WEB_HOME!, "config.json"), `${JSON.stringify(config)}\n`);

  expect(() => preflightCodexIntegration(config, { replaceExistingRoute: true }))
    .toThrow(/external-provider mode/);
  expect(() => installCodexIntegration(config, { replaceExistingRoute: true }))
    .toThrow(/external-provider mode/);
  expect(() => activateCodexIntegration()).toThrow(/external-provider mode/);
  expect(uninstallCodexIntegration(config)).toEqual({ changed: false });
  expect(readFileSync(join(codexHome, "config.toml"), "utf8")).toBe(fixture);
  expect(existsSync(join(codexHome, "models_cache.json"))).toBe(false);
});

test("persisted malformed integration ownership fails closed before route mutation", () => {
  const { codexHome } = isolate();
  const fixture = `openai_base_url = "http://127.0.0.1:1455/v1"\nmodel_provider = "opencodex"\n`;
  writeFileSync(join(codexHome, "config.toml"), fixture);
  const malformed = {
    ...defaultConfig("browser-only"),
    integrationMode: "external-providr",
  } as Record<string, unknown>;
  writeFileSync(
    join(process.env.CODEX_CHATGPT_WEB_HOME!, "config.json"),
    `${JSON.stringify(malformed)}\n`,
  );

  expect(() => assertDirectCodexIntegration()).toThrow(/Invalid integrationMode/);
  expect(readFileSync(join(codexHome, "config.toml"), "utf8")).toBe(fixture);
  expect(existsSync(join(codexHome, "models_cache.json"))).toBe(false);
});

test("persisted ownership guard does not require a complete runtime config", () => {
  isolate();
  const configPath = join(process.env.CODEX_CHATGPT_WEB_HOME!, "config.json");
  writeFileSync(configPath, `${JSON.stringify({ integrationMode: "direct" })}\n`);
  expect(() => assertDirectCodexIntegration()).not.toThrow();

  writeFileSync(configPath, `${JSON.stringify({ integrationMode: "external-provider" })}\n`);
  expect(() => assertDirectCodexIntegration()).toThrow(/external-provider mode/);
});

test("external-provider preflight refuses --replace-codex-route before any Codex write on every OS", () => {
  const { root } = isolate();
  expect(() => preflightSetup({
    mode: "browser-only",
    integrationMode: "external-provider",
    browserHostDescriptorPath: join(root, "launcher-host.json"),
    replaceCodexRoute: true,
    acknowledgedUnofficial: true,
  })).toThrow(/cannot be used in external-provider mode/);
});

test("external-provider transition refuses an active Direct route until it is explicitly disconnected", () => {
  const { root, codexHome } = isolate();
  const direct = defaultConfig("browser-only");
  writeFileSync(join(codexHome, "config.toml"), "model = \"gpt-5.6-sol\"\n");
  installCodexIntegration(direct, { replaceExistingRoute: true });
  const directText = readFileSync(join(codexHome, "config.toml"), "utf8");

  const externalOptions = {
    mode: "browser-only" as const,
    integrationMode: "external-provider" as const,
    browserHostDescriptorPath: join(root, "launcher-host.json"),
    acknowledgedUnofficial: true,
  };
  expect(() => preflightSetup(externalOptions)).toThrow(/Direct route is still active.*route disconnect/);
  expect(readFileSync(join(codexHome, "config.toml"), "utf8")).toBe(directText);

  expect(deactivateCodexIntegration()).toEqual({ changed: true, active: false });
  expect(() => preflightSetup(externalOptions)).not.toThrow();
});

test("Direct disconnect hands route ownership to an external provider without rewriting its route", () => {
  const { root, codexHome } = isolate();
  const configPath = join(codexHome, "config.toml");
  const original = [
    'model = "gpt-5.6-sol"',
    'openai_base_url = "https://native.example/v1"',
    'experimental_realtime_webrtc_call_base_url = "https://voice.example/v1"',
    "",
    "[features]",
    "multi_agent = false",
    "multi_agent_v2 = true",
    "",
    "[agents]",
    "max_depth = 7",
    "",
  ].join("\n");
  writeFileSync(configPath, original);
  const direct = defaultConfig("browser-only");
  installCodexIntegration(direct, { replaceExistingRoute: true });
  expect(inspectCodexIntegration()).toMatchObject({ installed: true, active: true, errors: [] });

  expect(deactivateCodexIntegration()).toEqual({ changed: true, active: false });
  expect(readFileSync(configPath, "utf8")).toBe(original);
  expect(inspectCodexIntegration()).toMatchObject({ installed: true, active: false, errors: [] });

  const externalRoute = original
    .replace("https://native.example/v1", "http://127.0.0.1:10100/v1")
    .replace("https://voice.example/v1", "http://127.0.0.1:10100/realtime");
  writeFileSync(configPath, externalRoute);
  const journalBefore = readFileSync(getCodexJournalPath(), "utf8");
  const recoveryBefore = readFileSync(getCodexJournalRecoveryPath(), "utf8");
  const externalOptions = {
    mode: "browser-only" as const,
    integrationMode: "external-provider" as const,
    browserHostDescriptorPath: join(root, "launcher-host.json"),
    acknowledgedUnofficial: true,
  };

  expect(() => preflightSetup(externalOptions)).not.toThrow();
  expect(readFileSync(configPath, "utf8")).toBe(externalRoute);
  expect(readFileSync(getCodexJournalPath(), "utf8")).toBe(journalBefore);
  expect(readFileSync(getCodexJournalRecoveryPath(), "utf8")).toBe(recoveryBefore);
  expect(existsSync(getConfigPath())).toBe(false);

  const external = { ...direct, integrationMode: "external-provider" as const };
  expect(commitExternalProviderOwnershipHandoff(external)).toEqual({ retired: true });
  expect(readFileSync(configPath, "utf8")).toBe(externalRoute);
  expect(readFileSync(configPath, "utf8")).not.toContain("17841");
  expect(existsSync(getCodexJournalPath())).toBe(false);
  expect(existsSync(getCodexJournalRecoveryPath())).toBe(false);
  expect(JSON.parse(readFileSync(getConfigPath(), "utf8"))).toMatchObject({
    integrationMode: "external-provider",
  });
  expect(inspectCodexIntegration()).toMatchObject({ installed: false, active: false, errors: [] });
});

test("external-provider handoff rejects a disconnected journal whose route still targets this bridge", () => {
  const { root, codexHome } = isolate();
  const configPath = join(codexHome, "config.toml");
  writeFileSync(configPath, 'model = "gpt-5.6-sol"\n');
  const direct = defaultConfig("browser-only");
  installCodexIntegration(direct);
  deactivateCodexIntegration();
  writeFileSync(configPath, 'model = "gpt-5.6-sol"\nopenai_base_url = "http://127.0.0.1:17841/v1"\n');

  expect(() => preflightSetup({
    mode: "browser-only",
    integrationMode: "external-provider",
    browserHostDescriptorPath: join(root, "launcher-host.json"),
    acknowledgedUnofficial: true,
  })).toThrow(/still points directly at codex-chatgpt-web/);
  expect(existsSync(getCodexJournalPath())).toBe(true);
});

test("external-provider handoff keeps non-route Compatibility V1 restoration strict", () => {
  const { root, codexHome } = isolate();
  const configPath = join(codexHome, "config.toml");
  const original = 'model = "gpt-5.6-sol"\n\n[features]\nmulti_agent = false\n';
  writeFileSync(configPath, original);
  const direct = defaultConfig("browser-only");
  installCodexIntegration(direct);
  deactivateCodexIntegration();
  writeFileSync(
    configPath,
    original.replace("multi_agent = false", "multi_agent = true")
      .replace('model = "gpt-5.6-sol"', 'model = "gpt-5.6-sol"\nopenai_base_url = "http://127.0.0.1:10100/v1"'),
  );

  expect(() => preflightSetup({
    mode: "browser-only",
    integrationMode: "external-provider",
    browserHostDescriptorPath: join(root, "launcher-host.json"),
    acknowledgedUnofficial: true,
  })).toThrow(/did not cleanly release.*multi_agent/s);
  expect(existsSync(getCodexJournalPath())).toBe(true);
});

test("external-provider handoff rejects a malformed inactive journal without changing files", () => {
  const { root, codexHome } = isolate();
  const configPath = join(codexHome, "config.toml");
  const externalRoute = 'model = "gpt-5.6-sol"\nopenai_base_url = "http://127.0.0.1:10100/v1"\n';
  writeFileSync(configPath, 'model = "gpt-5.6-sol"\n');
  const direct = defaultConfig("browser-only");
  installCodexIntegration(direct);
  deactivateCodexIntegration();
  writeFileSync(configPath, externalRoute);
  writeFileSync(getCodexJournalPath(), "{ malformed\n");
  writeFileSync(getCodexJournalRecoveryPath(), "{ malformed\n");

  expect(() => preflightSetup({
    mode: "browser-only",
    integrationMode: "external-provider",
    browserHostDescriptorPath: join(root, "launcher-host.json"),
    acknowledgedUnofficial: true,
  })).toThrow(/JSON Parse error|Invalid Codex integration journal/);
  expect(readFileSync(configPath, "utf8")).toBe(externalRoute);
  expect(readFileSync(getCodexJournalPath(), "utf8")).toBe("{ malformed\n");
  expect(readFileSync(getCodexJournalRecoveryPath(), "utf8")).toBe("{ malformed\n");
  expect(existsSync(getConfigPath())).toBe(false);
});

test("external-provider preflight does not repair a missing journal copy", () => {
  const { root, codexHome } = isolate();
  const configPath = join(codexHome, "config.toml");
  const externalRoute = 'model = "gpt-5.6-sol"\nopenai_base_url = "http://127.0.0.1:10100/v1"\n';
  writeFileSync(configPath, 'model = "gpt-5.6-sol"\n');
  installCodexIntegration(defaultConfig("browser-only"));
  deactivateCodexIntegration();
  writeFileSync(configPath, externalRoute);
  const primaryBefore = readFileSync(getCodexJournalPath(), "utf8");
  rmSync(getCodexJournalRecoveryPath());

  expect(() => preflightSetup({
    mode: "browser-only",
    integrationMode: "external-provider",
    browserHostDescriptorPath: join(root, "launcher-host.json"),
    acknowledgedUnofficial: true,
  })).not.toThrow();
  expect(readFileSync(configPath, "utf8")).toBe(externalRoute);
  expect(readFileSync(getCodexJournalPath(), "utf8")).toBe(primaryBefore);
  expect(existsSync(getCodexJournalRecoveryPath())).toBe(false);
  expect(existsSync(getConfigPath())).toBe(false);
});

test("direct setup still owns Codex routing by default", () => {
  const { codexHome } = isolate();
  const config = defaultConfig("browser-only");
  writeFileSync(join(codexHome, "config.toml"), "model = \"gpt-5.6-sol\"\n");
  const journal = installCodexIntegration(config, { replaceExistingRoute: true });
  expect(journal.active).toBe(true);
  expect(readFileSync(join(codexHome, "config.toml"), "utf8")).toContain("openai_base_url");
});
