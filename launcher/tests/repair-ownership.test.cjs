"use strict"; // G4 placeholder
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { RuntimeHost } = require("../electron/runtime.cjs");
const { buildSetupOwnershipPolicy } = require("../electron/setup-policy.cjs");
const { validateRuntimeOwnershipHealth } = require("../electron/runtime-health.cjs");
const launcherRoot = path.resolve(__dirname, "..");
const electronMain = fs.readFileSync(path.join(launcherRoot, "electron", "main.cjs"), "utf8");

const DIRECT_CONFIG = { mode: "browser-only", browserHost: "launcher", host: "127.0.0.1", port: 17841, integrationMode: "direct", releaseVersion: "9.9.9" };
const EXTERNAL_CONFIG = { mode: "browser-only", browserHost: "launcher", host: "127.0.0.1", port: 17841, integrationMode: "external-provider", releaseVersion: "9.9.9" };

function directHealth(overrides) {
  return { status: "ok", service: "codex-chatgpt-web", mode: "browser-only", version: "9.9.9", integration_mode: "direct", routing_owner: "codex-chatgpt-web", provider_base_url: "http://127.0.0.1:17841/v1", pid: 7, port: 17841, accepting_turns: true, ...overrides };
}
function externalHealth(overrides) {
  return { status: "ok", service: "codex-chatgpt-web", mode: "browser-only", version: "9.9.9", integration_mode: "external-provider", routing_owner: "external-router", provider_base_url: "http://127.0.0.1:17841/v1", pid: 7, port: 17841, accepting_turns: true, ...overrides };
}

function simpleHost(existingConfig, interactionMode) {
  const host = new RuntimeHost({
    app: { getPath: () => path.join(os.tmpdir(), "g4-repair-test"), getVersion: () => "1.1.3" },
    logger: { info() {}, warn() {}, error() {} },
    sourceRoot: "/source",
    browserDescriptorPath: "/runtime/launcher-browser.json",
    supervisor: { readConfig: () => existingConfig, readSetupConfig: () => existingConfig, stopForSetup: async () => ({ status: "stopped" }), startIfConfigured: async () => ({ status: "ready" }) },
    getBrowserInteractionMode: () => interactionMode || "automatic",
  });
  let invocation;
  host.runSetup = async (name, args, options) => { invocation = { name, args, policy: options ? options.ownershipPolicy : undefined }; await (options && options.afterRuntimeReady ? options.afterRuntimeReady() : undefined); return { code: 0, stdout: "", stderr: "" }; };
  return { host, invocation: () => invocation };
}

function ownershipPair(args) {
  const out = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--integration-mode") { out.push(args[i], args[i + 1]); i += 1; }
    else if (args[i] === "--replace-codex-route") out.push(args[i]);
  }
  return out;
}

test("G4.1 Direct existing repair uses Direct policy", async () => {
  const fixture = simpleHost({ mode: "browser-only", browserHost: "launcher", integrationMode: "direct" });
  await fixture.host.setupCore();
  assert.deepEqual(ownershipPair(fixture.invocation().args), ["--integration-mode", "direct", "--replace-codex-route"]);
  assert.equal(fixture.invocation().policy.integrationMode, "direct");
  assert.equal(fixture.invocation().policy.checkpointScope, "direct-integration");
});

test("G4.2-4 External existing repair uses External policy with zero replace", async () => {
  const fixture = simpleHost({ mode: "browser-only", browserHost: "launcher", integrationMode: "external-provider" });
  await fixture.host.setupCore({ integrationMode: "external-provider" });
  assert.deepEqual(ownershipPair(fixture.invocation().args), ["--integration-mode", "external-provider"]);
  assert.equal(fixture.invocation().args.includes("--replace-codex-route"), false);
  assert.equal(fixture.invocation().policy.checkpointScope, "bridge-only");
});

test("G4.5 Direct repair retains expected replace behavior", async () => {
  const core = simpleHost({ mode: "browser-only", browserHost: "launcher", integrationMode: "direct" });
  await core.host.setupCore();
  assert.equal(core.invocation().args.includes("--replace-codex-route"), true);
  const mcp = simpleHost({ mode: "full", browserHost: "launcher", integrationMode: "direct", automaticTunnel: { tunnelId: "tunnel_0123456789abcdef0123456789abcdef", runtimeKeyFile: "/tmp/k", profileDir: "/tmp", profileName: "p" } });
  mcp.host.mcpCredentialsConfigured = () => true;
  await mcp.host.setupMcp({ interactionMode: "automatic" });
  assert.equal(mcp.invocation().args.includes("--replace-codex-route"), true);
  const directUpgradePolicy = buildSetupOwnershipPolicy({ integrationMode: "direct", operation: "runtime-upgrade", profile: "production" });
  assert.equal(directUpgradePolicy.checkpointScope, "direct-integration");
  assert.equal(directUpgradePolicy.replaceCodexRoute, false);
  assert.deepEqual(directUpgradePolicy.integrationArgs, ["--integration-mode", "direct"]);
});

test("G4.6 renderer mismatch cannot migrate repair ownership", async () => {
  const ext = simpleHost({ mode: "browser-only", browserHost: "launcher", integrationMode: "external-provider" });
  await assert.rejects(ext.host.setupCore({ integrationMode: "direct" }), /CLI-only|mismatch/);
  const dir = simpleHost({ mode: "browser-only", browserHost: "launcher", integrationMode: "direct" });
  await assert.rejects(dir.host.setupCore({ integrationMode: "external-provider" }), /CLI-only|mismatch/);
});

test("G4.7 damaged config cannot become Direct repair", async () => {
  const bad = simpleHost({ mode: "browser-only", browserHost: "launcher", integrationMode: "bogus" });
  await assert.rejects(bad.host.setupCore(), /damaged|Invalid integration/);
  const nullHost = simpleHost(undefined);
  nullHost.host.supervisor.readSetupConfig = () => { throw new Error("unexpected token in JSON"); };
  await assert.rejects(nullHost.host.setupCore(), /damaged|invalid/i);
});

test("G4.8 process owner does not select repair routing policy", async () => {
  const directPolicy = buildSetupOwnershipPolicy({ integrationMode: "direct", operation: "setup-core", profile: "production" });
  assert.equal(directPolicy.checkpointScope, "direct-integration");
  const externalPolicy = buildSetupOwnershipPolicy({ integrationMode: "external-provider", operation: "setup-core", profile: "production" });
  assert.equal(externalPolicy.checkpointScope, "bridge-only");
  const directHost = simpleHost({ mode: "browser-only", browserHost: "launcher", integrationMode: "direct" });
  directHost.host.runtimeConfigSnapshot = () => ({ configured: true, owner: "external", mode: "browser-only", serialized: "s", config: { mode: "browser-only" } });
  await directHost.host.setupCore();
  assert.equal(directHost.invocation().policy.checkpointScope, "direct-integration");
  const externalHost = simpleHost({ mode: "browser-only", browserHost: "launcher", integrationMode: "external-provider" });
  externalHost.host.runtimeConfigSnapshot = () => ({ configured: true, owner: "launcher", mode: "browser-only", serialized: "s", config: { mode: "browser-only" } });
  await externalHost.host.setupCore({ integrationMode: "external-provider" });
  assert.equal(externalHost.invocation().policy.checkpointScope, "bridge-only");
});

function mainHelpers() {
  const start = electronMain.indexOf("// Repair completion state (G4)");
  const end = electronMain.indexOf("// Ownership-aware bridge startup reconciliation (G3)");
  const source = electronMain.slice(start, end);
  const context = { runtimeSupervisor: null, validateRuntimeOwnershipHealth, EXTERNAL_INTEGRATION_MODE: "external-provider" };
  vm.createContext(context);
  vm.runInContext(source + "\nthis.__helpers = { repairCompletionPatch, validateRepairBridgeHealth };", context);
  return context.__helpers;
}

test("G4.36-40 repairCompletionPatch truthfulness", () => {
  const { repairCompletionPatch } = mainHelpers();
  const direct = { integrationMode: "direct" };
  const external = { integrationMode: "external-provider" };
  const directPatch = { coreSetupComplete: true, codexCatalogVerified: false, codexRestartRequired: true, mcpRuntimeInstalled: true };
  assert.deepEqual(repairCompletionPatch(direct, directPatch), directPatch);
  const extPatch = repairCompletionPatch(external, directPatch);
  assert.equal(extPatch.coreSetupComplete, true);
  assert.equal(extPatch.mcpRuntimeInstalled, true);
  assert.equal("codexRestartRequired" in extPatch, false);
  assert.equal("codexCatalogVerified" in extPatch, false);
  assert.equal("externalRouterHealthy" in extPatch, false);
});

// NOTE (§28): spy-only assertions below prove zero EXPLICIT route lifecycle
// commands (connect/restore/status). Direct subprocess route mutation inside
// setup is covered separately by the G4.BLOCKER real-file rollback tests.
test("G4.9-10 repair issues zero explicit route lifecycle commands", async () => {
  for (const mode of ["direct", "external-provider"]) {
    const config = mode === "direct" ? { mode: "browser-only", browserHost: "launcher", integrationMode: "direct" } : { mode: "browser-only", browserHost: "launcher", integrationMode: "external-provider" };
    const fixture = simpleHost(config);
    let routes = 0;
    fixture.host.connectBridgeRoute = async () => { routes += 1; return {}; };
    fixture.host.restoreBridgeRoute = async () => { routes += 1; return {}; };
    fixture.host.restoreBridgeRouteWithinOperation = async () => { routes += 1; return {}; };
    fixture.host.bridgeStatus = async () => { routes += 1; return {}; };
    if (mode === "direct") await fixture.host.setupCore();
    else await fixture.host.setupCore({ integrationMode: "external-provider" });
    assert.equal(routes, 0);
  }
});

test("G4.11 External repair failure issues zero explicit route restore", async () => {
  const existing = { mode: "browser-only", browserHost: "launcher", integrationMode: "external-provider" };
  const host = new RuntimeHost({
    app: { getPath: () => os.tmpdir(), getVersion: () => "1.1.3" },
    logger: { info() {}, warn() {}, error() {} },
    sourceRoot: "/source",
    browserDescriptorPath: "/runtime/launcher-browser.json",
    supervisor: { readConfig: () => existing, readSetupConfig: () => existing, stopForSetup: async () => ({}), startIfConfigured: async () => ({ status: "ready" }) },
    getBrowserInteractionMode: () => "automatic",
  });
  let routes = 0;
  host.restoreBridgeRoute = async () => { routes += 1; return {}; };
  host.restoreBridgeRouteWithinOperation = async () => { routes += 1; return {}; };
  host.connectBridgeRoute = async () => { routes += 1; return {}; };
  host.bridgeStatus = async () => { routes += 1; return {}; };
  host.run = async (name, args) => {
    if (args.includes("--preflight-only")) return { code: 0, stdout: "", stderr: "" };
    throw new Error("synthetic External repair failure");
  };
  host.captureSetupCheckpoint = () => [];
  host.restoreSetupCheckpoint = () => {};
  host.restorePreviousRuntime = async () => {};
  await assert.rejects(host.setupCore({ integrationMode: "external-provider" }), /synthetic External repair failure/);
  assert.equal(routes, 0);
});

test("G4.13-14 External repair needs no Codex route or provider action", async () => {
  const fixture = simpleHost({ mode: "browser-only", browserHost: "launcher", integrationMode: "external-provider" });
  const seen = [];
  fixture.host.run = async (name, args) => { seen.push(...args); return { code: 0, stdout: "", stderr: "" }; };
  fixture.host.supervisor.stopForSetup = async () => ({});
  fixture.host.supervisor.startIfConfigured = async () => ({ status: "ready" });
  fixture.host.captureSetupCheckpoint = () => [];
  fixture.host.restoreSetupCheckpoint = () => {};
  fixture.host.restorePreviousRuntime = async () => {};
  await fixture.host.setupCore({ integrationMode: "external-provider" });
  const blob = seen.join(" ");
  assert.equal(/provider/i.test(blob) && !/external-provider/.test(blob), false);
  assert.equal(blob.includes("ocx"), false);
  assert.equal(blob.includes(":10100"), false);
  assert.equal(blob.includes("route"), false);
});

function realHost(initialConfig) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "g4-repair-"));
  const coreHome = path.join(root, "core");
  const codexHome = path.join(root, "codex");
  fs.mkdirSync(path.join(coreHome, "codex"), { recursive: true });
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(path.join(coreHome, "secrets"), { recursive: true });
  fs.mkdirSync(path.join(coreHome, "tunnel", "profiles"), { recursive: true });
  const configPath = path.join(coreHome, "config.json");
  if (initialConfig !== null) fs.writeFileSync(configPath, JSON.stringify(initialConfig));
  const readFile = () => { if (!fs.existsSync(configPath)) return null; return JSON.parse(fs.readFileSync(configPath, "utf8")); };
  const host = new RuntimeHost({
    app: { getPath: () => path.join(root, "userdata"), getVersion: () => "1.1.3" },
    logger: { info() {}, warn() {}, error() {} },
    sourceRoot: "/source",
    browserDescriptorPath: path.join(coreHome, "launcher-browser.json"),
    codexHome,
    launchAgentsDir: path.join(root, "launchagents"),
    supervisor: { coreHome, configPath, readSetupConfig: readFile, readConfig: readFile, stopForSetup: async () => ({}), startIfConfigured: async () => ({ status: "ready" }) },
  });
  return { host, root, coreHome, codexHome, configPath, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test("G4.15-18 External failed repair via real path preserves route files", async () => {
  const initial = { mode: "browser-only", browserHost: "launcher", integrationMode: "external-provider" };
  const fixture = realHost(initial);
  const codexConfig = path.join(fixture.codexHome, "config.toml");
  const journal = path.join(fixture.coreHome, "codex", "integration-journal.json");
  const modelsCache = path.join(fixture.codexHome, "models_cache.json");
  const tunnelKey = path.join(fixture.coreHome, "secrets", "tunnel-runtime-automatic.key");
  fs.writeFileSync(codexConfig, "router-owned route\n");
  fs.writeFileSync(journal, "router-owned journal\n");
  fs.writeFileSync(modelsCache, "router cache\n");
  fs.writeFileSync(tunnelKey, "bridge-key-before\n");
  const bridgeBefore = fs.readFileSync(fixture.configPath, "utf8");
  let scope;
  const origCapture = fixture.host.captureSetupCheckpoint.bind(fixture.host);
  fixture.host.captureSetupCheckpoint = (s, sc) => { scope = sc; return origCapture(s, sc); };
  fixture.host.run = async (name, args) => {
    if (args.includes("--preflight-only")) return { code: 0, stdout: "", stderr: "" };
    fs.writeFileSync(tunnelKey, "mutated-bridge-key\n");
    fs.writeFileSync(codexConfig, "concurrent router change\n");
    throw new Error("synthetic External repair failure");
  };
  try {
    await assert.rejects(fixture.host.setupCore({ integrationMode: "external-provider" }), /synthetic External repair failure/);
    assert.equal(scope, "bridge-only");
    assert.equal(fs.readFileSync(fixture.configPath, "utf8"), bridgeBefore);
    assert.equal(fs.readFileSync(tunnelKey, "utf8"), "bridge-key-before\n");
    assert.equal(fs.readFileSync(codexConfig, "utf8"), "concurrent router change\n");
    assert.equal(fs.readFileSync(journal, "utf8"), "router-owned journal\n");
    assert.equal(fs.readFileSync(modelsCache, "utf8"), "router cache\n");
  } finally { fixture.cleanup(); }
});

test("G4.19 Direct failed repair retains Direct rollback", async () => {
  const initial = { mode: "browser-only", browserHost: "launcher" };
  const fixture = realHost(initial);
  const codexConfig = path.join(fixture.codexHome, "config.toml");
  fs.writeFileSync(codexConfig, "direct-route-before\n");
  const bridgeBefore = fs.readFileSync(fixture.configPath, "utf8");
  let scope;
  const origCapture = fixture.host.captureSetupCheckpoint.bind(fixture.host);
  fixture.host.captureSetupCheckpoint = (s, sc) => { scope = sc; return origCapture(s, sc); };
  fixture.host.run = async (name, args) => {
    if (args.includes("--preflight-only")) return { code: 0, stdout: "", stderr: "" };
    fs.writeFileSync(fixture.configPath, JSON.stringify({ mode: "full", browserHost: "launcher" }));
    fs.writeFileSync(codexConfig, "mutated-direct-route\n");
    throw new Error("synthetic Direct repair failure");
  };
  try {
    await assert.rejects(fixture.host.setupCore(), /synthetic Direct repair failure/);
    assert.equal(scope, "direct-integration");
    assert.equal(fs.readFileSync(fixture.configPath, "utf8"), bridgeBefore);
    assert.equal(fs.readFileSync(codexConfig, "utf8"), "direct-route-before\n");
  } finally { fixture.cleanup(); }
});

function setupCoreHandlerSource() {
  const start = electronMain.indexOf(`handle("launcher:setup-core",`);
  const end = electronMain.indexOf(`handle("launcher:setup-mcp",`, start);
  return electronMain.slice(start, end);
}

async function runRepairCore({ preConfig, postConfig, health, mutateDuringSetup }) {
  const { resolveOwnershipContext, assertOwnershipExpectationCurrent: realAssert, extractRequestedIntegrationMode: realExtract } = require("../electron/integration-mode.cjs");
  let current = preConfig;
  let healthPayload = health;
  const calls = { routes: 0, stateUpdates: [], monitor: 0 };
  const supervisor = {
    readSetupConfig: () => {
      if (current instanceof Error) throw current;
      return current;
    },
    readConfig: () => {
      if (current instanceof Error) throw current;
      return current;
    },
    proxyHealthPayload: async () => healthPayload,
  };
  const { repairCompletionPatch: realPatch } = mainHelpers();
  const runtimeHost = {
    setupCore: async (input, expectation, hook) => {
      // Emulate the real runSetup transaction: the repair validator hook
      // runs BEFORE commit, while the checkpoint is live. A hook failure
      // rejects the setup instead of committing then failing afterwards.
      calls.hookWired = typeof hook === "function";
      if (mutateDuringSetup) mutateDuringSetup({ setConfig: (c) => { current = c; }, setHealth: (h) => { healthPayload = h; } });
      else if (postConfig !== undefined && postConfig !== "__keep") current = postConfig;
      if (hook) await hook();
      return { mode: "browser-only", stdout: "" };
    },
    setupDevCore: async () => { throw new Error("unexpected DEV"); },
    assertOwnershipExpectationCurrent: (expectation, action) => realAssert({ supervisor, expectation, action }),
    runtimeConfigSnapshot: () => ({ config: { zeroRiskProEnabled: false } }),
    connectBridgeRoute: async () => { calls.routes += 1; return {}; },
    restoreBridgeRoute: async () => { calls.routes += 1; return {}; },
  };
  const stateStore = { read: () => ({ browserInteractionMode: "automatic", coreSetupComplete: false }), update: (patch) => { calls.stateUpdates.push(patch); return patch; } };
  const context = {
    handle: (_name, handler) => { context.__handler = handler; },
    IS_DEV_PROFILE: false,
    stateStore,
    browserHost: { probeAuthentication: async () => ({ authenticated: true }), returnToIdle: async () => {} },
    runtimeHost,
    runtimeSupervisor: supervisor,
    resolveSetupOwnership: (requestedMode, action) => resolveOwnershipContext({ requestedMode, supervisor, action }),
    extractRequestedIntegrationMode: realExtract,
    smokePassedThisSession: true,
    smokePassedForCurrentVersion: () => true,
    send() {},
    startCatalogVerificationMonitor: () => { calls.monitor += 1; },
    logger: { warn() {}, info() {}, error() {}, debug() {} },
    validateRepairBridgeHealth: async (ownership) => {
      const config = supervisor.readConfig();
      const h = await supervisor.proxyHealthPayload(config);
      validateRuntimeOwnershipHealth({ config, integrationMode: ownership.integrationMode, health: h });
    },
    repairCompletionPatch: realPatch,
    EXTERNAL_INTEGRATION_MODE: "external-provider",
    // G4 blocker fix: the handler now creates the validator and passes it
    // INTO setupCore (transactional), instead of validating after return.
    createRepairRuntimeValidation: (ownership, action) => async () => {
      runtimeHost.assertOwnershipExpectationCurrent(ownership.expectation, action);
      await context.validateRepairBridgeHealth(ownership, action);
    },
  };
  vm.createContext(context);
  vm.runInContext(setupCoreHandlerSource() + "\nthis.__captured = __handler;", context);
  const handler = context.__handler;
  let result;
  let error;
  try { result = await handler({}, undefined); } catch (e) { error = e; }
  return { result, error, calls, getConfig: () => current };
}

test("G4.20 External repair with correct health succeeds truthfully", async () => {
  const out = await runRepairCore({ preConfig: EXTERNAL_CONFIG, health: externalHealth() });
  assert.equal(out.error, undefined);
  assert.equal(out.result.ok, true);
  assert.equal(out.result.restartRequired, false);
  assert.equal(out.calls.routes, 0);
  const patch = out.calls.stateUpdates[0];
  assert.equal(patch.coreSetupComplete, true);
  // FINAL-A: successful External setup/reinstall already passed G4 transactional
  // continuity + bridge ownership-health validation inside runSetup, so the bridge
  // is Launcher-ready. codexCatalogVerified means health-validated bridge
  // readiness (not Direct catalog proof); no Codex restart is required.
  assert.equal(patch.codexCatalogVerified, true);
  assert.equal(patch.codexRestartRequired, false);
  assert.equal("externalRouterHealthy" in patch, false);
});

test("G4.21 External repair with Direct health fails with zero explicit route commands", async () => {
  const out = await runRepairCore({ preConfig: EXTERNAL_CONFIG, health: directHealth() });
  assert.match(String(out.error && out.error.message), /ownership mismatch/i);
  assert.equal(out.calls.routes, 0);
  assert.equal(out.calls.stateUpdates.length, 0);
});

test("G4.22 Direct repair with External health fails with zero explicit route commands", async () => {
  const out = await runRepairCore({ preConfig: DIRECT_CONFIG, health: externalHealth() });
  assert.match(String(out.error && out.error.message), /ownership mismatch/i);
  assert.equal(out.calls.routes, 0);
  assert.equal(out.calls.stateUpdates.length, 0);
});

test("G4.23-24 wrong routing_owner or provider URL fails", async () => {
  const badOwner = await runRepairCore({ preConfig: EXTERNAL_CONFIG, health: externalHealth({ routing_owner: "codex-chatgpt-web" }) });
  assert.match(String(badOwner.error && badOwner.error.message), /routing owner/i);
  assert.equal(badOwner.calls.stateUpdates.length, 0);
  const badUrl = await runRepairCore({ preConfig: DIRECT_CONFIG, health: directHealth({ provider_base_url: "http://127.0.0.1:9999/v1" }) });
  assert.match(String(badUrl.error && badUrl.error.message), /provider URL/i);
  assert.equal(badUrl.calls.stateUpdates.length, 0);
});

test("G4.25 External-to-Direct drift during repair fails with zero explicit route commands", async () => {
  const out = await runRepairCore({ preConfig: EXTERNAL_CONFIG, health: externalHealth(), mutateDuringSetup: ({ setConfig }) => setConfig(DIRECT_CONFIG) });
  assert.match(String(out.error && out.error.message), /changed while preparing|mismatch/i);
  assert.equal(out.calls.routes, 0);
  assert.equal(out.calls.stateUpdates.length, 0);
});

test("G4.26 Direct-to-External drift during repair fails with zero explicit route commands", async () => {
  const out = await runRepairCore({ preConfig: DIRECT_CONFIG, health: directHealth(), mutateDuringSetup: ({ setConfig }) => setConfig(EXTERNAL_CONFIG) });
  assert.match(String(out.error && out.error.message), /changed while preparing|mismatch/i);
  assert.equal(out.calls.routes, 0);
  assert.equal(out.calls.stateUpdates.length, 0);
});

test("G4.27 configured-to-missing during repair fails closed", async () => {
  const out = await runRepairCore({ preConfig: EXTERNAL_CONFIG, health: externalHealth(), mutateDuringSetup: ({ setConfig }) => setConfig(null) });
  assert.match(String(out.error && out.error.message), /changed while preparing|damaged|missing/i);
  assert.equal(out.calls.routes, 0);
  assert.equal(out.calls.stateUpdates.length, 0);
});

test("G4.28 configured-to-damaged during repair fails closed", async () => {
  const out = await runRepairCore({ preConfig: DIRECT_CONFIG, health: directHealth(), mutateDuringSetup: ({ setConfig }) => setConfig({ mode: "browser-only", browserHost: "launcher", integrationMode: "bogus" }) });
  assert.match(String(out.error && out.error.message), /changed while preparing|damaged|Invalid integration/i);
  assert.equal(out.calls.routes, 0);
  assert.equal(out.calls.stateUpdates.length, 0);
});

test("G4.40 Direct repair state preserves existing guidance", async () => {
  const out = await runRepairCore({ preConfig: DIRECT_CONFIG, health: directHealth() });
  assert.equal(out.error, undefined);
  assert.equal(out.result.restartRequired, true);
  const patch = out.calls.stateUpdates[0];
  assert.equal(patch.coreSetupComplete, true);
  assert.equal(patch.codexCatalogVerified, false);
  assert.equal(patch.codexRestartRequired, true);
});

function upgradePatchHelper() {
  const start = electronMain.indexOf("function buildUpgradeCompletionPatch(");
  const end = electronMain.indexOf("// Ownership-aware bridge startup", start);
  const source = electronMain.slice(start, end);
  const context = { EXTERNAL_INTEGRATION_MODE: "external-provider" };
  vm.createContext(context);
  vm.runInContext(source + "\nthis.__upgrade = { buildUpgradeCompletionPatch };", context);
  return context.__upgrade;
}

test("G4.29 Direct managed update keeps Direct policy and restart", async () => {
  const policy = buildSetupOwnershipPolicy({ integrationMode: "direct", operation: "runtime-upgrade", profile: "production" });
  assert.equal(policy.checkpointScope, "direct-integration");
  assert.equal(policy.replaceCodexRoute, false);
  assert.deepEqual(policy.integrationArgs, ["--integration-mode", "direct"]);
  const { buildUpgradeCompletionPatch } = upgradePatchHelper();
  const patch = buildUpgradeCompletionPatch({ upgrade: { integrationMode: "direct", mode: "browser-only" }, snapshotConfig: {} });
  assert.equal(patch.coreSetupComplete, true);
  assert.equal(patch.codexCatalogVerified, false);
  assert.equal(patch.codexRestartRequired, true);
});

test("G4.30 External managed update is bridge-only with no restart", async () => {
  const policy = buildSetupOwnershipPolicy({ integrationMode: "external-provider", operation: "runtime-upgrade", profile: "production" });
  assert.equal(policy.checkpointScope, "bridge-only");
  assert.equal(policy.replaceCodexRoute, false);
  assert.deepEqual(policy.integrationArgs, ["--integration-mode", "external-provider"]);
  const existing = { mode: "browser-only", browserHost: "launcher", integrationMode: "external-provider", releaseVersion: "0.0.0" };
  const host = new RuntimeHost({
    app: { getPath: () => os.tmpdir(), getVersion: () => "9.9.9" },
    logger: { info() {}, warn() {}, error() {} },
    sourceRoot: "/source",
    browserDescriptorPath: "/runtime/launcher-browser.json",
    supervisor: { readConfig: () => existing, readSetupConfig: () => existing, stopForSetup: async () => ({}), startIfConfigured: async () => ({ status: "ready" }) },
    getBrowserInteractionMode: () => "automatic",
  });
  let scope;
  host.captureSetupCheckpoint = (s, sc) => { scope = sc; return []; };
  host.restoreSetupCheckpoint = () => {};
  host.restorePreviousRuntime = async () => {};
  const seen = [];
  host.run = async (name, args) => { seen.push(...args); return { code: 0, stdout: "", stderr: "" }; };
  const out = await host.upgradeManagedRuntime();
  assert.equal(out.updated, true);
  assert.equal(out.integrationMode, "external-provider");
  assert.equal(scope, "bridge-only");
  assert.equal(seen.includes("--replace-codex-route"), false);
  assert.deepEqual(seen.filter((a) => a === "--integration-mode").length, 2);
  const { buildUpgradeCompletionPatch } = upgradePatchHelper();
  const patch = buildUpgradeCompletionPatch({ upgrade: out, snapshotConfig: {} });
  assert.equal(patch.coreSetupComplete, true);
  assert.equal("codexRestartRequired" in patch, false);
  assert.equal("codexCatalogVerified" in patch, false);
});

test("G4.31-32 External update health and failure add zero route calls", async () => {
  const { buildStartupRoutePolicy } = require("../electron/startup-route-policy.cjs");
  assert.equal(buildStartupRoutePolicy("external-provider").connectDirectRoute, false);
  const existing = { mode: "browser-only", browserHost: "launcher", integrationMode: "external-provider", releaseVersion: "0.0.0" };
  const host = new RuntimeHost({
    app: { getPath: () => os.tmpdir(), getVersion: () => "9.9.9" },
    logger: { info() {}, warn() {}, error() {} },
    sourceRoot: "/source",
    browserDescriptorPath: "/runtime/launcher-browser.json",
    supervisor: { readConfig: () => existing, readSetupConfig: () => existing, stopForSetup: async () => ({}), startIfConfigured: async () => ({ status: "ready" }) },
    getBrowserInteractionMode: () => "automatic",
  });
  let routes = 0;
  host.connectBridgeRoute = async () => { routes += 1; return {}; };
  host.restoreBridgeRoute = async () => { routes += 1; return {}; };
  host.restoreBridgeRouteWithinOperation = async () => { routes += 1; return {}; };
  host.captureSetupCheckpoint = () => [];
  host.restoreSetupCheckpoint = () => {};
  host.restorePreviousRuntime = async () => {};
  host.run = async (name, args) => {
    if (args.includes("--preflight-only")) return { code: 0, stdout: "", stderr: "" };
    throw new Error("synthetic External update failure");
  };
  await assert.rejects(host.upgradeManagedRuntime(), /synthetic External update failure/);
  assert.equal(routes, 0);
});

test("G4.33-35 update performs no provider action and keeps continuity", async () => {
  const existing = { mode: "browser-only", browserHost: "launcher", integrationMode: "external-provider", releaseVersion: "0.0.0" };
  const host = new RuntimeHost({
    app: { getPath: () => os.tmpdir(), getVersion: () => "9.9.9" },
    logger: { info() {}, warn() {}, error() {} },
    sourceRoot: "/source",
    browserDescriptorPath: "/runtime/launcher-browser.json",
    supervisor: { readConfig: () => existing, readSetupConfig: () => existing, stopForSetup: async () => ({}), startIfConfigured: async () => ({ status: "ready" }) },
    getBrowserInteractionMode: () => "automatic",
  });
  const seen = [];
  host.captureSetupCheckpoint = () => [];
  host.restoreSetupCheckpoint = () => {};
  host.restorePreviousRuntime = async () => {};
  host.run = async (name, args) => { seen.push(...args); return { code: 0, stdout: "", stderr: "" }; };
  await host.upgradeManagedRuntime();
  const blob = seen.join(" ");
  assert.equal(blob.includes("ocx"), false);
  assert.equal(/provider/i.test(blob) && !blob.includes("external-provider"), false);
  const { assertOwnershipContinuity } = require("../electron/integration-mode.cjs");
  const { resolveOwnershipContext } = require("../electron/integration-mode.cjs");
  const sup = { readSetupConfig: () => EXTERNAL_CONFIG };
  const before = resolveOwnershipContext({ supervisor: sup, action: "x" }).expectation;
  const after = resolveOwnershipContext({ supervisor: sup, action: "x" }).expectation;
  assert.doesNotThrow(() => assertOwnershipContinuity({ before, after, action: "runtime-startup" }));
  const supDirect = { readSetupConfig: () => DIRECT_CONFIG };
  const afterDirect = resolveOwnershipContext({ supervisor: supDirect, action: "x" }).expectation;
  assert.throws(() => assertOwnershipContinuity({ before, after: afterDirect, action: "runtime-startup" }), /changed while preparing/);
});

test("G4 absent journal stays absent through External repair rollback", async () => {
  const initial = { mode: "browser-only", browserHost: "launcher", integrationMode: "external-provider" };
  const fixture = realHost(initial);
  const journal = path.join(fixture.coreHome, "codex", "integration-journal.json");
  const recovery = path.join(fixture.coreHome, "codex", "integration-journal.recovery.json");
  assert.equal(fs.existsSync(journal), false);
  assert.equal(fs.existsSync(recovery), false);
  fixture.host.run = async (name, args) => {
    if (args.includes("--preflight-only")) return { code: 0, stdout: "", stderr: "" };
    throw new Error("synthetic absent-journal failure");
  };
  try {
    await assert.rejects(fixture.host.setupCore({ integrationMode: "external-provider" }), /synthetic absent-journal failure/);
    assert.equal(fs.existsSync(journal), false);
    assert.equal(fs.existsSync(recovery), false);
  } finally { fixture.cleanup(); }
});

// G4 blocker-fix regressions: validation INSIDE runSetup via afterRuntimeReady.
// Each test mutates real temporary route artifacts during the mocked setup
// subprocess, then fails the transactional hook. The G2 checkpoint must still
// be live, so runSetup catch/rollback restores files. Spy-only route counts
// are insufficient because Direct route mutation happens inside setup.

function directRouteFiles(fixture) {
  return {
    codexConfig: path.join(fixture.codexHome, "config.toml"),
    modelsCache: path.join(fixture.codexHome, "models_cache.json"),
    journal: path.join(fixture.coreHome, "codex", "integration-journal.json"),
    recovery: path.join(fixture.coreHome, "codex", "integration-journal.recovery.json"),
  };
}

test("G4.BLOCKER Direct health failure inside transaction restores route files", async () => {
  const initial = { mode: "browser-only", browserHost: "launcher", host: "127.0.0.1", port: 17841, integrationMode: "direct" };
  const fixture = realHost(initial);
  const files = directRouteFiles(fixture);
  const original = { codexConfig: "ORIGINAL-direct-route\n", modelsCache: "ORIGINAL-cache\n", journal: "ORIGINAL-journal\n", recovery: "ORIGINAL-recovery\n" };
  fs.writeFileSync(files.codexConfig, original.codexConfig);
  fs.writeFileSync(files.modelsCache, original.modelsCache);
  fs.writeFileSync(files.journal, original.journal);
  fs.writeFileSync(files.recovery, original.recovery);
  const bridgeBefore = fs.readFileSync(fixture.configPath, "utf8");
  let scope;
  const origCapture = fixture.host.captureSetupCheckpoint.bind(fixture.host);
  fixture.host.captureSetupCheckpoint = (s, sc) => { scope = sc; return origCapture(s, sc); };
  let routes = 0;
  fixture.host.connectBridgeRoute = async () => { routes += 1; return {}; };
  fixture.host.restoreBridgeRoute = async () => { routes += 1; return {}; };
  fixture.host.restoreBridgeRouteWithinOperation = async () => { routes += 1; return {}; };
  fixture.host.run = async (name, args) => {
    if (args.includes("--preflight-only")) return { code: 0, stdout: "", stderr: "" };
    fs.writeFileSync(files.codexConfig, "MUTATED-direct-route\n");
    fs.writeFileSync(files.modelsCache, "MUTATED-cache\n");
    fs.writeFileSync(files.journal, "MUTATED-journal\n");
    fs.writeFileSync(files.recovery, "MUTATED-recovery\n");
    return { code: 0, stdout: "", stderr: "" };
  };
  const { validateRuntimeOwnershipHealth: realHealth } = require("../electron/runtime-health.cjs");
  const badHealth = { status: "ok", service: "codex-chatgpt-web", mode: "browser-only", version: "9.9.9", integration_mode: "external-provider", routing_owner: "external-router", provider_base_url: "http://127.0.0.1:17841/v1", pid: 7, port: 17841, accepting_turns: true };
  const hook = async () => {
    const config = fixture.host.supervisor.readConfig();
    realHealth({ config, integrationMode: "direct", health: badHealth });
  };
  try {
    await assert.rejects(fixture.host.setupCore({}, undefined, hook), /ownership mismatch/i);
    assert.equal(scope, "direct-integration");
    assert.equal(fs.readFileSync(files.codexConfig, "utf8"), original.codexConfig);
    assert.equal(fs.readFileSync(files.modelsCache, "utf8"), original.modelsCache);
    assert.equal(fs.readFileSync(files.journal, "utf8"), original.journal);
    assert.equal(fs.readFileSync(files.recovery, "utf8"), original.recovery);
    assert.equal(fs.readFileSync(fixture.configPath, "utf8"), bridgeBefore);
    assert.equal(routes, 0);
  } finally { fixture.cleanup(); }
});

test("G4.BLOCKER Direct ownership drift inside transaction restores route files", async () => {
  const initial = { mode: "browser-only", browserHost: "launcher", integrationMode: "direct" };
  const fixture = realHost(initial);
  const files = directRouteFiles(fixture);
  const original = { codexConfig: "ORIGINAL-direct-route\n", modelsCache: "ORIGINAL-cache\n", journal: "ORIGINAL-journal\n" };
  fs.writeFileSync(files.codexConfig, original.codexConfig);
  fs.writeFileSync(files.modelsCache, original.modelsCache);
  fs.writeFileSync(files.journal, original.journal);
  const bridgeBefore = fs.readFileSync(fixture.configPath, "utf8");
  const pre = fixture.host.validateSetupOwnership(undefined, undefined, "setup-core");
  let scope;
  const origCapture = fixture.host.captureSetupCheckpoint.bind(fixture.host);
  fixture.host.captureSetupCheckpoint = (s, sc) => { scope = sc; return origCapture(s, sc); };
  let routes = 0;
  fixture.host.connectBridgeRoute = async () => { routes += 1; return {}; };
  fixture.host.restoreBridgeRoute = async () => { routes += 1; return {}; };
  fixture.host.restoreBridgeRouteWithinOperation = async () => { routes += 1; return {}; };
  fixture.host.run = async (name, args) => {
    if (args.includes("--preflight-only")) return { code: 0, stdout: "", stderr: "" };
    fs.writeFileSync(files.codexConfig, "MUTATED-direct-route\n");
    fs.writeFileSync(files.modelsCache, "MUTATED-cache\n");
    fs.writeFileSync(files.journal, "MUTATED-journal\n");
    fs.writeFileSync(fixture.configPath, JSON.stringify({ mode: "browser-only", browserHost: "launcher", integrationMode: "external-provider" }));
    return { code: 0, stdout: "", stderr: "" };
  };
  const hook = async () => { fixture.host.assertOwnershipExpectationCurrent(pre.expectation, "setup-core"); };
  try {
    await assert.rejects(fixture.host.setupCore({}, undefined, hook), /changed while preparing/i);
    assert.equal(scope, "direct-integration");
    assert.equal(fs.readFileSync(files.codexConfig, "utf8"), original.codexConfig);
    assert.equal(fs.readFileSync(files.modelsCache, "utf8"), original.modelsCache);
    assert.equal(fs.readFileSync(files.journal, "utf8"), original.journal);
    assert.equal(fs.readFileSync(fixture.configPath, "utf8"), bridgeBefore);
    assert.equal(routes, 0);
  } finally { fixture.cleanup(); }
});

test("G4.BLOCKER External hook failure stays bridge-only", async () => {
  const initial = { mode: "browser-only", browserHost: "launcher", integrationMode: "external-provider" };
  const fixture = realHost(initial);
  const files = directRouteFiles(fixture);
  const tunnelKey = path.join(fixture.coreHome, "secrets", "tunnel-runtime-automatic.key");
  fs.writeFileSync(files.codexConfig, "router-owned route\n");
  fs.writeFileSync(files.modelsCache, "router cache\n");
  fs.writeFileSync(files.journal, "router journal\n");
  fs.writeFileSync(tunnelKey, "bridge-key-before\n");
  const bridgeBefore = fs.readFileSync(fixture.configPath, "utf8");
  let scope;
  const origCapture = fixture.host.captureSetupCheckpoint.bind(fixture.host);
  fixture.host.captureSetupCheckpoint = (s, sc) => { scope = sc; return origCapture(s, sc); };
  let routes = 0;
  fixture.host.connectBridgeRoute = async () => { routes += 1; return {}; };
  fixture.host.restoreBridgeRoute = async () => { routes += 1; return {}; };
  fixture.host.restoreBridgeRouteWithinOperation = async () => { routes += 1; return {}; };
  fixture.host.run = async (name, args) => {
    if (args.includes("--preflight-only")) return { code: 0, stdout: "", stderr: "" };
    fs.writeFileSync(tunnelKey, "mutated-bridge-key\n");
    fs.writeFileSync(files.codexConfig, "concurrent router change\n");
    fs.writeFileSync(files.modelsCache, "concurrent router cache\n");
    fs.writeFileSync(files.journal, "concurrent router journal\n");
    return { code: 0, stdout: "", stderr: "" };
  };
  const hook = async () => { throw new Error("Bridge ownership mismatch: synthetic External validation failure"); };
  try {
    await assert.rejects(fixture.host.setupCore({ integrationMode: "external-provider" }, undefined, hook), /synthetic External validation failure/);
    assert.equal(scope, "bridge-only");
    assert.equal(fs.readFileSync(fixture.configPath, "utf8"), bridgeBefore);
    assert.equal(fs.readFileSync(tunnelKey, "utf8"), "bridge-key-before\n");
    assert.equal(fs.readFileSync(files.codexConfig, "utf8"), "concurrent router change\n");
    assert.equal(fs.readFileSync(files.modelsCache, "utf8"), "concurrent router cache\n");
    assert.equal(fs.readFileSync(files.journal, "utf8"), "concurrent router journal\n");
    assert.equal(routes, 0);
  } finally { fixture.cleanup(); }
});

test("G4.BLOCKER transaction commit point: success keeps mutation, hook failure rolls back", async () => {
  const initial = { mode: "browser-only", browserHost: "launcher", integrationMode: "direct" };
  const successFixture = realHost(initial);
  const successFiles = directRouteFiles(successFixture);
  fs.writeFileSync(successFiles.codexConfig, "ORIGINAL\n");
  fs.writeFileSync(successFiles.journal, "ORIGINAL-journal\n");
  successFixture.host.run = async (name, args) => {
    if (args.includes("--preflight-only")) return { code: 0, stdout: "", stderr: "" };
    fs.writeFileSync(successFiles.codexConfig, "COMMITTED\n");
    fs.writeFileSync(successFiles.journal, "COMMITTED-journal\n");
    return { code: 0, stdout: "", stderr: "" };
  };
  try {
    await successFixture.host.setupCore({}, undefined, async () => {});
    assert.equal(fs.readFileSync(successFiles.codexConfig, "utf8"), "COMMITTED\n");
    assert.equal(fs.readFileSync(successFiles.journal, "utf8"), "COMMITTED-journal\n");
  } finally { successFixture.cleanup(); }
  const failFixture = realHost(initial);
  const failFiles = directRouteFiles(failFixture);
  fs.writeFileSync(failFiles.codexConfig, "ORIGINAL\n");
  fs.writeFileSync(failFiles.journal, "ORIGINAL-journal\n");
  failFixture.host.run = async (name, args) => {
    if (args.includes("--preflight-only")) return { code: 0, stdout: "", stderr: "" };
    fs.writeFileSync(failFiles.codexConfig, "MUTATED\n");
    fs.writeFileSync(failFiles.journal, "MUTATED-journal\n");
    return { code: 0, stdout: "", stderr: "" };
  };
  try {
    await assert.rejects(failFixture.host.setupCore({}, undefined, async () => { throw new Error("synthetic hook failure"); }), /synthetic hook failure/);
    assert.equal(fs.readFileSync(failFiles.codexConfig, "utf8"), "ORIGINAL\n");
    assert.equal(fs.readFileSync(failFiles.journal, "utf8"), "ORIGINAL-journal\n");
  } finally { failFixture.cleanup(); }
});

function extractComposeSource(mainSource) {
  const startMarker = "function composeAfterRuntimeReady(";
  const sliceStart = mainSource.indexOf(startMarker);
  assert.notEqual(sliceStart, -1, "main.cjs is missing function composeAfterRuntimeReady(");
  const openBrace = mainSource.indexOf("{", sliceStart);
  assert.notEqual(openBrace, -1, "main.cjs composeAfterRuntimeReady has no opening brace");
  let depth = 0;
  let inString = null;
  let inLineComment = false;
  let inBlockComment = false;
  let escaped = false;
  let sliceEnd = -1;
  for (let i = openBrace; i < mainSource.length; i += 1) {
    const ch = mainSource[i];
    const next = mainSource[i + 1];
    if (inLineComment) {
      if (ch === "\n") inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      if (ch === "*" && next === "/") {
        inBlockComment = false;
        i += 1;
      }
      continue;
    }
    if (inString !== null) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === inString) inString = null;
      continue;
    }
    if (ch === "/" && next === "/") {
      inLineComment = true;
      i += 1;
      continue;
    }
    if (ch === "/" && next === "*") {
      inBlockComment = true;
      i += 1;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      inString = ch;
      continue;
    }
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        sliceEnd = i + 1;
        break;
      }
    }
  }
  assert.notEqual(sliceEnd, -1, "main.cjs composeAfterRuntimeReady boundary not found");
  return mainSource.slice(sliceStart, sliceEnd);
}

function composeHelper(mainSource) {
  const source = extractComposeSource(mainSource === undefined ? electronMain : mainSource);
  const context = {};
  vm.createContext(context);
  vm.runInContext(source + "\nthis.__compose = { composeAfterRuntimeReady };", context);
  assert.equal(
    typeof context.__compose.composeAfterRuntimeReady,
    "function",
    "composeAfterRuntimeReady was not extracted from main.cjs",
  );
  return context.__compose;
}

test("composeHelper extracts the shipped function from LF and CRLF source", () => {
  const lfSource = electronMain.split("\r\n").join("\n");
  const crlfSource = lfSource.split("\n").join("\r\n");
  assert.ok(crlfSource.includes("\r\n"), "CRLF fixture must contain carriage returns");
  for (const variant of [
    { label: "LF", text: lfSource },
    { label: "CRLF", text: crlfSource },
  ]) {
    const extracted = composeHelper(variant.text);
    assert.equal(typeof extracted.composeAfterRuntimeReady, "function", `extraction failed for ${variant.label} source`);
    const sentinel = async () => {};
    assert.equal(
      extracted.composeAfterRuntimeReady(undefined, sentinel),
      sentinel,
      `identity branch failed for ${variant.label} source`,
    );
  }
});

test("G4 hook composition preserves browser behavior exactly once", async () => {
  const { composeAfterRuntimeReady } = composeHelper();
  const order = [];
  const browserHook = async () => { order.push("browser"); };
  const validator = async () => { order.push("validator"); };
  assert.equal(typeof composeAfterRuntimeReady(undefined, validator), "function");
  await composeAfterRuntimeReady(undefined, validator)();
  assert.deepEqual(order, ["validator"]);
  order.length = 0;
  const composed = composeAfterRuntimeReady(browserHook, validator);
  await composed();
  assert.deepEqual(order, ["browser", "validator"]);
  await assert.rejects(composed(), /more than once/);
  assert.equal(composeAfterRuntimeReady(browserHook, undefined), browserHook);
});

test("G4 setupCore receives the transactional validator hook", async () => {
  const fixture = simpleHost({ mode: "browser-only", browserHost: "launcher", integrationMode: "direct" });
  await fixture.host.setupCore({}, undefined, async () => {});
  assert.equal(typeof fixture.invocation().policy, "object");
  const out = await runRepairCore({ preConfig: DIRECT_CONFIG, health: directHealth() });
  assert.equal(out.error, undefined);
  assert.equal(out.calls.hookWired, true);
});

