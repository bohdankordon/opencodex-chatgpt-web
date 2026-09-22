import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig, loadConfig, saveConfig } from "../src/config";
import { generateExternalClientToken } from "../src/external-client";

const roots: string[] = [];
const previousHome = process.env.CODEX_CHATGPT_WEB_HOME;

afterAll(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  if (previousHome === undefined) delete process.env.CODEX_CHATGPT_WEB_HOME;
  else process.env.CODEX_CHATGPT_WEB_HOME = previousHome;
});

function isolatedHome(): string {
  const root = mkdtempSync(join(tmpdir(), "codex-chatgpt-web-external-client-config-"));
  roots.push(root);
  process.env.CODEX_CHATGPT_WEB_HOME = root;
  return root;
}

function configPath(root: string): string {
  return join(root, "config.json");
}

function loadFailure(): string {
  try {
    loadConfig();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("Expected loading the configuration to fail");
}

test("configuration written before external clients existed still loads unchanged", () => {
  const root = isolatedHome();
  const base = defaultConfig("browser-only");
  const legacy = { ...base } as Record<string, unknown>;
  delete legacy.externalClients;
  const path = configPath(root);
  const before = JSON.stringify(legacy, null, 2) + "\n";
  writeFileSync(path, before);

  const config = loadConfig();
  expect(config.externalClients).toEqual([]);
  expect(config.integrationMode).toBe("direct");
  expect(config.mode).toBe(base.mode);
  expect(config.port).toBe(base.port);
  expect(config.appName).toBe(base.appName);
  expect(config.controlToken).toBe(base.controlToken);
  // Loading is pure: an absent field is read as "no external clients" and is not written back.
  expect(readFileSync(path, "utf8")).toBe(before);
});

test("an external client list that is not an array is a configuration error", () => {
  const root = isolatedHome();
  writeFileSync(configPath(root), JSON.stringify({
    ...defaultConfig("browser-only"),
    externalClients: { id: "hermes-local" },
  }) + "\n");
  const message = loadFailure();
  expect(message).toContain("externalClients must be an array");
  expect(message).toContain("config.json");
});

test("duplicate external client credentials are rejected without echoing a secret", () => {
  const root = isolatedHome();
  const secret = generateExternalClientToken();
  writeFileSync(configPath(root), JSON.stringify({
    ...defaultConfig("browser-only"),
    externalClients: [
      { id: "hermes-local", token: secret },
      { id: "client-123", token: secret },
    ],
  }) + "\n");
  const message = loadFailure();
  expect(message).toContain("duplicate external client token");
  expect(message).not.toContain(secret);
});

test("external client credentials round-trip through a fresh save", () => {
  const source = isolatedHome();
  const token = generateExternalClientToken();
  const record = { id: "hermes-local", token, label: "Hermes" };
  writeFileSync(configPath(source), JSON.stringify({
    ...defaultConfig("browser-only"),
    externalClients: [record],
  }, null, 2) + "\n");

  const loaded = loadConfig();
  expect(loaded.externalClients).toEqual([record]);

  const target = isolatedHome();
  saveConfig(loaded);
  const persistedPath = configPath(target);
  expect(existsSync(persistedPath)).toBe(true);
  const persisted = JSON.parse(readFileSync(persistedPath, "utf8")) as { externalClients: unknown };
  expect(persisted.externalClients).toEqual([record]);

  const reloaded = loadConfig();
  expect(reloaded.externalClients).toEqual([record]);
  expect(reloaded).toEqual(loaded);
});

test.skipIf(process.platform === "win32")("the credential store stays owner-only", () => {
  const root = isolatedHome();
  saveConfig({
    ...defaultConfig("browser-only"),
    externalClients: [{ id: "hermes-local", token: generateExternalClientToken() }],
  });
  // POSIX modes only: Windows ACLs are owned by the installer, not by POSIX bits.
  expect(statSync(root).mode & 0o777).toBe(0o700);
  expect(statSync(configPath(root)).mode & 0o777).toBe(0o600);
});
