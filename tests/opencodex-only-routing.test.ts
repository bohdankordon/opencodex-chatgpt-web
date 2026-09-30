import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { defaultConfig, isExternalProviderMode, resolveIntegrationMode } from "../src/config";
import { assertDirectCodexIntegration, detectLegacyDirectRoute, getCodexHome } from "../src/codex-integration";
import { readCodexModelContextOverride } from "../src/codex-integration-document";
import { getCodexJournalPath, getCodexJournalRecoveryPath } from "../src/codex-integration-shared";
import { ensureOpencodexProviderTokenFile } from "../src/opencodex-provider-auth";
const roots: string[] = [];
afterEach(() => {
  delete process.env.CODEX_HOME;
  delete process.env.CODEX_CHATGPT_WEB_HOME;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function isolate(): string {
  const root = mkdtempSync(join(tmpdir(), "s4d-only-"));
  roots.push(root);
  const codexHome = join(root, "codex");
  mkdirSync(codexHome, { recursive: true });
  process.env.CODEX_HOME = codexHome;
  process.env.CODEX_CHATGPT_WEB_HOME = join(root, "app");
  mkdirSync(process.env.CODEX_CHATGPT_WEB_HOME as string, { recursive: true });
  return root;
}
test("default config is OpenCodex-only", () => {
  expect(defaultConfig("browser-only").integrationMode).toBe("external-provider");
  expect(defaultConfig("full").integrationMode).toBe("external-provider");
});
test("old direct values normalize to provider", () => {
  expect(resolveIntegrationMode({ integrationMode: "direct" })).toBe("external-provider");
  expect(resolveIntegrationMode({ integrationMode: "external-provider" })).toBe("external-provider");
  expect(resolveIntegrationMode({})).toBe("external-provider");
  expect(isExternalProviderMode({ integrationMode: "direct" })).toBe(true);
  expect(() => resolveIntegrationMode({ integrationMode: "bogus" })).toThrow();
});
test("Direct mutations are always disabled", () => {
  isolate();
  expect(() => assertDirectCodexIntegration()).toThrow(/OpenCodex/);
  expect(() => assertDirectCodexIntegration({ integrationMode: "direct" })).toThrow(/OpenCodex/);
});
test("legacy detection never mutates", () => {
  const root = isolate();
  const codexHome = join(root, "codex");
  writeFileSync(join(codexHome, "config.toml"), "sentinel=1\n");
  const clean = detectLegacyDirectRoute();
  expect(clean.hasJournal).toBe(false);
  expect(readFileSync(join(codexHome, "config.toml"), "utf8")).toBe("sentinel=1\n");
  mkdirSync(join(process.env.CODEX_CHATGPT_WEB_HOME as string, "codex"), { recursive: true });
  writeFileSync(getCodexJournalPath(), "not-json");
  const found = detectLegacyDirectRoute();
  expect(found.hasJournal).toBe(true);
  expect(readFileSync(join(codexHome, "config.toml"), "utf8")).toBe("sentinel=1\n");
  expect(existsSync(getCodexJournalRecoveryPath())).toBe(false);
});
test("tilde Codex home still expands", () => {
  process.env.CODEX_HOME = "~/custom-codex-home";
  expect(getCodexHome()).toBe(join(homedir(), "custom-codex-home"));
});
test("context override helper still reads", () => {
  const root = isolate();
  const codexHome = join(root, "codex");
  writeFileSync(join(codexHome, "config.toml"), "model_context_window = 1000000\n");
  expect(readCodexModelContextOverride()).toEqual({ contextWindow: 1000000 });
});
test("provider token resolves and materializes under the isolated home", () => {
  isolate();
  const config = defaultConfig("browser-only");
  const appHome = process.env.CODEX_CHATGPT_WEB_HOME as string;
  const realDefault = join(homedir(), ".codex-chatgpt-web");
  expect(config.providerTokenFile.startsWith(appHome)).toBe(true);
  expect(config.providerTokenFile.startsWith(realDefault)).toBe(false);
  const { created } = ensureOpencodexProviderTokenFile(config.providerTokenFile, config.controlToken);
  expect(created).toBe(true);
  expect(existsSync(config.providerTokenFile)).toBe(true);
});
