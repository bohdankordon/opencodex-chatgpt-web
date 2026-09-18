const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const launcherRoot = path.resolve(__dirname, "..");
const electronMain = fs.readFileSync(path.join(launcherRoot, "electron", "main.cjs"), "utf8");
const {
  DIRECT: DIRECT_INTEGRATION_MODE,
  assertOwnershipExpectationCurrent,
  assertOwnershipContinuity,
  resolveOwnershipContext,
  EXTERNAL_PROVIDER: EXTERNAL_INTEGRATION_MODE,
} = require("../electron/integration-mode.cjs");
const { buildStartupRoutePolicy } = require("../electron/startup-route-policy.cjs");
const { validateRuntimeOwnershipHealth } = require("../electron/runtime-health.cjs");

// G3 startup routing tests. Pure units cover the health validator and route
// policy; main-flow functions are executed from source slices with stubbed
// collaborators, mirroring the existing renderer-wiring vm pattern.

const DIRECT_CONFIG = {
  mode: "browser-only",
  browserHost: "launcher",
  host: "127.0.0.1",
  port: 17841,
  integrationMode: "direct",
  releaseVersion: "9.9.9",
};

const EXTERNAL_CONFIG = {
  mode: "browser-only",
  browserHost: "launcher",
  host: "127.0.0.1",
  port: 17841,
  integrationMode: "external-provider",
  releaseVersion: "9.9.9",
};

function directHealth(overrides) {
  return {
    status: "ok",
    service: "codex-chatgpt-web",
    mode: "browser-only",
    version: "9.9.9",
    integration_mode: "direct",
    routing_owner: "codex-chatgpt-web",
    provider_base_url: "http://127.0.0.1:17841/v1",
    pid: 7,
    port: 17841,
    accepting_turns: true,
    ...overrides,
  };
}

function externalHealth(overrides) {
  return {
    status: "ok",
    service: "codex-chatgpt-web",
    mode: "browser-only",
    version: "9.9.9",
    integration_mode: "external-provider",
    routing_owner: "external-router",
    provider_base_url: "http://127.0.0.1:17841/v1",
    pid: 7,
    port: 17841,
    accepting_turns: true,
    ...overrides,
  };
}

function scriptedReads(values) {
  let calls = 0;
  return {
    count: () => calls,
    next: () => {
      const value = values[Math.min(calls, values.length - 1)];
      calls += 1;
      if (value instanceof Error) throw value;
      return value;
    },
  };
}

function startupSupervisor(options) {
  const calls = [];
  const setup = scriptedReads(options.setupReads);
  const config = scriptedReads(options.configReads);
  return {
    calls,
    supervisor: {
      readSetupConfig: () => {
        calls.push("readSetupConfig");
        return setup.next();
      },
      readConfig: () => {
        calls.push("readConfig");
        return config.next();
      },
      proxyHealthPayload: async () => {
        calls.push("proxyHealthPayload");
        return options.health;
      },
      startIfConfigured: async () => {
        calls.push("startIfConfigured");
        return { status: options.status || "ready" };
      },
    },
  };
}

function sliceMainFunction(startMarker, endMarker) {
  const start = electronMain.indexOf(startMarker);
  if (start < 0) throw new Error("main.cjs is missing " + startMarker);
  const end = electronMain.indexOf(endMarker, start + 1);
  if (end < 0) throw new Error("main.cjs slice end is missing for " + startMarker);
  return electronMain.slice(start, end);
}

const startBridgeSource = sliceMainFunction(
  "async function startConfiguredBridgeRuntime(",
  "function completeStartupReadyState(",
);
const readyStateSource = sliceMainFunction(
  "function completeStartupReadyState(",
  "async function recoverStartupRoute(",
);
const recoverSource = sliceMainFunction(
  "async function recoverStartupRoute(",
  "function trayImage()",
);

function runStartBridge(sourceExtras) {
  const context = {
    assertOwnershipExpectationCurrent,
    validateRuntimeOwnershipHealth,
    buildStartupRoutePolicy,
    ...sourceExtras,
  };
  vm.createContext(context);
  context.startConfiguredBridgeRuntime = vm.runInContext(startBridgeSource + "\nstartConfiguredBridgeRuntime;", context);
  return context;
}

function recoverContext(options) {
  const settings = options || {};
  const config = settings.config || EXTERNAL_CONFIG;
  const supervisor = settings.supervisor
    || startupSupervisor({ setupReads: [config], configReads: [config], health: null }).supervisor;
  const warnings = [];
  let restores = 0;
  const context = {
    DIRECT_INTEGRATION_MODE,
    assertOwnershipExpectationCurrent,
    runtimeSupervisor: supervisor,
    restoreCodexRouteAfterRuntimeFailure: async () => {
      restores += 1;
      return { restored: true };
    },
  };
  vm.createContext(context);
  context.recoverStartupRoute = vm.runInContext(recoverSource + "\nrecoverStartupRoute;", context);
  const ownership = settings.ownership
    || resolveOwnershipContext({ requestedMode: undefined, supervisor, action: "runtime-startup" });
  return {
    recoverStartupRoute: context.recoverStartupRoute,
    ownership,
    logger: { warn: (...args) => warnings.push(args) },
    warnings,
    get restores() {
      return restores;
    },
  };
}

function readyContext() {
  const context = { DIRECT_INTEGRATION_MODE };
  vm.createContext(context);
  context.completeStartupReadyState = vm.runInContext(readyStateSource + "\ncompleteStartupReadyState;", context);
  return context;
}

function countOccurrences(haystack, needle) {
  return haystack.split(needle).length - 1;
}

test("startup route policy follows routing mode only", () => {
  assert.deepEqual(buildStartupRoutePolicy("direct"), {
    integrationMode: "direct",
    connectDirectRoute: true,
    restoreDirectRouteOnFailure: true,
  });
  assert.deepEqual(buildStartupRoutePolicy("external-provider"), {
    integrationMode: "external-provider",
    connectDirectRoute: false,
    restoreDirectRouteOnFailure: false,
  });
  assert.throws(() => buildStartupRoutePolicy("opencodex"), /requires direct or external-provider/);
  assert.throws(() => buildStartupRoutePolicy(undefined), /requires direct or external-provider/);
});

test("G3.13 Direct startup connects the Direct route as before", async () => {
  const bed = startupSupervisor({ setupReads: [DIRECT_CONFIG], configReads: [DIRECT_CONFIG], health: directHealth() });
  const ownership = resolveOwnershipContext({ requestedMode: undefined, supervisor: bed.supervisor, action: "runtime-startup" });
  let connects = 0;
  const context = runStartBridge({
    runtimeHost: {
      connectBridgeRoute: async () => {
        connects += 1;
        return { installed: true, active: true, changed: true };
      },
    },
    runtimeSupervisor: bed.supervisor,
  });
  const started = await context.startConfiguredBridgeRuntime({
    startupOwnership: ownership,
    runtimeHost: context.runtimeHost,
    runtimeSupervisor: context.runtimeSupervisor,
  });
  assert.equal(connects, 1);
  assert.equal(started.runtime.status, "ready");
  assert.equal(started.runtime.bridgeRouteChanged, true);
});

test("G3.13 Direct startup reports an unchanged route without restart churn", async () => {
  const bed = startupSupervisor({ setupReads: [DIRECT_CONFIG], configReads: [DIRECT_CONFIG], health: directHealth() });
  const ownership = resolveOwnershipContext({ requestedMode: undefined, supervisor: bed.supervisor, action: "runtime-startup" });
  const context = runStartBridge({
    runtimeHost: { connectBridgeRoute: async () => ({ installed: true, active: true, changed: false }) },
    runtimeSupervisor: bed.supervisor,
  });
  const started = await context.startConfiguredBridgeRuntime({
    startupOwnership: ownership,
    runtimeHost: context.runtimeHost,
    runtimeSupervisor: context.runtimeSupervisor,
  });
  assert.equal(started.runtime.bridgeRouteChanged, false);
});

test("G3.14 External startup calls zero route connect", async () => {
  const bed = startupSupervisor({ setupReads: [EXTERNAL_CONFIG], configReads: [EXTERNAL_CONFIG], health: externalHealth() });
  const ownership = resolveOwnershipContext({ requestedMode: undefined, supervisor: bed.supervisor, action: "runtime-startup" });
  let connects = 0;
  const context = runStartBridge({
    runtimeHost: {
      connectBridgeRoute: async () => {
        connects += 1;
        return { installed: true, active: true, changed: true };
      },
    },
    runtimeSupervisor: bed.supervisor,
  });
  const started = await context.startConfiguredBridgeRuntime({
    startupOwnership: ownership,
    runtimeHost: context.runtimeHost,
    runtimeSupervisor: context.runtimeSupervisor,
  });
  assert.equal(connects, 0);
  assert.equal(started.runtime.status, "ready");
  assert.equal(started.runtime.bridgeRouteChanged, false);
});

test("G3.22 launcher-owned External install still skips route connect", async () => {
  const bed = startupSupervisor({ setupReads: [EXTERNAL_CONFIG], configReads: [EXTERNAL_CONFIG], health: externalHealth() });
  bed.supervisor.readState = () => ({ ownerPid: 4242, daemonPid: 4243, tunnelPid: null });
  const ownership = resolveOwnershipContext({ requestedMode: undefined, supervisor: bed.supervisor, action: "runtime-startup" });
  let connects = 0;
  const context = runStartBridge({
    runtimeHost: {
      connectBridgeRoute: async () => {
        connects += 1;
        return { installed: true, active: true, changed: true };
      },
    },
    runtimeSupervisor: bed.supervisor,
  });
  const started = await context.startConfiguredBridgeRuntime({
    startupOwnership: ownership,
    runtimeHost: context.runtimeHost,
    runtimeSupervisor: context.runtimeSupervisor,
  });
  assert.equal(connects, 0);
  assert.equal(started.runtime.status, "ready");
});

test("G3.15 External startup success performs zero route restore", async () => {
  const context = recoverContext({ integrationMode: "external-provider" });
  const result = await context.recoverStartupRoute({
    startupOwnership: context.ownership,
    logger: context.logger,
    stateStore: {},
  });
  assert.equal(result.restored, false);
  assert.equal(result.skipped, true);
  assert.equal(context.restores, 0);
});

test("G3.16 External runtime-start failure performs zero route restore", async () => {
  const context = recoverContext({ integrationMode: "external-provider", fluctuate: true });
  const result = await context.recoverStartupRoute({
    startupOwnership: context.ownership,
    logger: context.logger,
    stateStore: {},
  });
  assert.equal(result.restored, false);
  assert.equal(result.skipped, true);
  assert.equal(context.restores, 0);
});

test("G3.17 External health mismatch fails without route restore", async () => {
  const bed = startupSupervisor({ setupReads: [EXTERNAL_CONFIG], configReads: [EXTERNAL_CONFIG], health: directHealth() });
  const ownership = resolveOwnershipContext({ requestedMode: undefined, supervisor: bed.supervisor, action: "runtime-startup" });
  const context = runStartBridge({
    runtimeHost: { connectBridgeRoute: async () => ({ installed: true, active: true, changed: true }) },
    runtimeSupervisor: bed.supervisor,
  });
  await assert.rejects(
    context.startConfiguredBridgeRuntime({
      startupOwnership: ownership,
      runtimeHost: context.runtimeHost,
      runtimeSupervisor: context.runtimeSupervisor,
    }),
    /ownership mismatch/,
  );
  const recovery = recoverContext({ integrationMode: "external-provider" });
  const recovered = await recovery.recoverStartupRoute({
    startupOwnership: ownership,
    logger: recovery.logger,
    stateStore: {},
  });
  assert.equal(recovered.restored, false);
  assert.equal(recovered.skipped, true);
  assert.equal(recovery.restores, 0);
});

test("G3.18 Direct health mismatch never connects a wrong-owner bridge", async () => {
  const bed = startupSupervisor({ setupReads: [DIRECT_CONFIG], configReads: [DIRECT_CONFIG], health: externalHealth() });
  const ownership = resolveOwnershipContext({ requestedMode: undefined, supervisor: bed.supervisor, action: "runtime-startup" });
  let connects = 0;
  const context = runStartBridge({
    runtimeHost: {
      connectBridgeRoute: async () => {
        connects += 1;
        return { installed: true, active: true, changed: true };
      },
    },
    runtimeSupervisor: bed.supervisor,
  });
  await assert.rejects(
    context.startConfiguredBridgeRuntime({
      startupOwnership: ownership,
      runtimeHost: context.runtimeHost,
      runtimeSupervisor: context.runtimeSupervisor,
    }),
    /ownership mismatch/,
  );
  assert.equal(connects, 0);
});

test("G3.19 External startup requires no direct Codex route", async () => {
  const bed = startupSupervisor({ setupReads: [EXTERNAL_CONFIG], configReads: [EXTERNAL_CONFIG], health: externalHealth() });
  const ownership = resolveOwnershipContext({ requestedMode: undefined, supervisor: bed.supervisor, action: "runtime-startup" });
  const context = runStartBridge({ runtimeSupervisor: bed.supervisor });
  const started = await context.startConfiguredBridgeRuntime({
    startupOwnership: ownership,
    runtimeHost: context.runtimeHost,
    runtimeSupervisor: context.runtimeSupervisor,
  });
  assert.equal(started.runtime.status, "ready");
});

test("G3.20 External startup probes only bridge health, never the router", async () => {
  const bed = startupSupervisor({ setupReads: [EXTERNAL_CONFIG], configReads: [EXTERNAL_CONFIG], health: externalHealth() });
  const ownership = resolveOwnershipContext({ requestedMode: undefined, supervisor: bed.supervisor, action: "runtime-startup" });
  const context = runStartBridge({
    runtimeHost: {},
    runtimeSupervisor: bed.supervisor,
  });
  const started = await context.startConfiguredBridgeRuntime({
    startupOwnership: ownership,
    runtimeHost: context.runtimeHost,
    runtimeSupervisor: context.runtimeSupervisor,
  });
  assert.equal(started.runtime.status, "ready");
  assert.deepEqual(bed.calls, [
    "readSetupConfig",
    "startIfConfigured",
    "readSetupConfig",
    "readConfig",
    "proxyHealthPayload",
  ]);
});

test("G3.23 External to Direct flip fails with zero route calls", async () => {
  const directConfig = { ...DIRECT_CONFIG };
  const bed = startupSupervisor({ setupReads: [EXTERNAL_CONFIG, directConfig], configReads: [directConfig], health: directHealth() });
  const ownership = resolveOwnershipContext({ requestedMode: undefined, supervisor: bed.supervisor, action: "runtime-startup" });
  assert.equal(ownership.integrationMode, "external-provider");
  let connects = 0;
  let restores = 0;
  const context = runStartBridge({
    runtimeHost: {
      connectBridgeRoute: async () => {
        connects += 1;
        return { installed: true, active: true, changed: true };
      },
    },
    runtimeSupervisor: bed.supervisor,
  });
  await assert.rejects(
    context.startConfiguredBridgeRuntime({
      startupOwnership: ownership,
      runtimeHost: context.runtimeHost,
      runtimeSupervisor: context.runtimeSupervisor,
    }),
    /changed|mismatch/,
  );
  assert.equal(connects, 0);
  const recovery = recoverContext({ supervisor: bed.supervisor, ownership });
  const recovered = await recovery.recoverStartupRoute({
    startupOwnership: ownership,
    logger: recovery.logger,
    stateStore: {},
  });
  assert.equal(recovered.skipped, true);
  assert.equal(recovery.restores, 0);
});

test("G3.24 Direct to External flip fails before Direct connect", async () => {
  const bed = startupSupervisor({
    setupReads: [DIRECT_CONFIG, EXTERNAL_CONFIG],
    configReads: [EXTERNAL_CONFIG],
    health: externalHealth(),
  });
  const ownership = resolveOwnershipContext({ requestedMode: undefined, supervisor: bed.supervisor, action: "runtime-startup" });
  assert.equal(ownership.integrationMode, "direct");
  let connects = 0;
  const context = runStartBridge({
    runtimeHost: {
      connectBridgeRoute: async () => {
        connects += 1;
        return { installed: true, active: true, changed: true };
      },
    },
    runtimeSupervisor: bed.supervisor,
  });
  await assert.rejects(
    context.startConfiguredBridgeRuntime({
      startupOwnership: ownership,
      runtimeHost: context.runtimeHost,
      runtimeSupervisor: context.runtimeSupervisor,
    }),
    /changed|mismatch/,
  );
  assert.equal(connects, 0);
  const recovery = recoverContext({ supervisor: bed.supervisor, ownership });
  const recovered = await recovery.recoverStartupRoute({
    startupOwnership: ownership,
    logger: recovery.logger,
    stateStore: {},
  });
  assert.equal(recovered.skipped, true);
  assert.equal(recovered.ownershipChanged, true);
  assert.equal(recovery.restores, 0);
});

test("G3.25 configured startup losing its config fails closed", async () => {
  const bed = startupSupervisor({
    setupReads: [DIRECT_CONFIG, null],
    configReads: [DIRECT_CONFIG],
    health: directHealth(),
  });
  const ownership = resolveOwnershipContext({ requestedMode: undefined, supervisor: bed.supervisor, action: "runtime-startup" });
  let connects = 0;
  const context = runStartBridge({
    runtimeHost: {
      connectBridgeRoute: async () => {
        connects += 1;
        return { installed: true, active: true, changed: true };
      },
    },
    runtimeSupervisor: bed.supervisor,
  });
  await assert.rejects(
    context.startConfiguredBridgeRuntime({
      startupOwnership: ownership,
      runtimeHost: context.runtimeHost,
      runtimeSupervisor: context.runtimeSupervisor,
    }),
    /changed/,
  );
  assert.equal(connects, 0);
});

test("G3.26 configured startup turning damaged fails closed", async () => {
  const bed = startupSupervisor({
    setupReads: [DIRECT_CONFIG, new Error("Unexpected token")],
    configReads: [DIRECT_CONFIG],
    health: directHealth(),
  });
  const ownership = resolveOwnershipContext({ requestedMode: undefined, supervisor: bed.supervisor, action: "runtime-startup" });
  const context = runStartBridge({
    runtimeHost: { connectBridgeRoute: async () => ({ installed: true, active: true, changed: true }) },
    runtimeSupervisor: bed.supervisor,
  });
  await assert.rejects(
    context.startConfiguredBridgeRuntime({
      startupOwnership: ownership,
      runtimeHost: context.runtimeHost,
      runtimeSupervisor: context.runtimeSupervisor,
    }),
    /damaged/,
  );
});

test("G3.27 version-skewed External install starts without route connect", async () => {
  const skewed = { ...EXTERNAL_CONFIG, releaseVersion: "0.0.0" };
  const bed = startupSupervisor({ setupReads: [skewed], configReads: [skewed], health: externalHealth() });
  const ownership = resolveOwnershipContext({ requestedMode: undefined, supervisor: bed.supervisor, action: "runtime-startup" });
  assert.equal(ownership.integrationMode, "external-provider");
  let connects = 0;
  const context = runStartBridge({
    runtimeHost: {
      connectBridgeRoute: async () => {
        connects += 1;
        return { installed: true, active: true, changed: true };
      },
    },
    runtimeSupervisor: bed.supervisor,
  });
  const started = await context.startConfiguredBridgeRuntime({
    startupOwnership: ownership,
    runtimeHost: context.runtimeHost,
    runtimeSupervisor: context.runtimeSupervisor,
  });
  assert.equal(started.runtime.status, "ready");
  assert.equal(connects, 0);
  assert.equal(started.runtime.bridgeRouteChanged, false);
});

test("G3.28 External startup readiness ignores absent catalog counters", async () => {
  const quiet = externalHealth();
  delete quiet.successful_model_catalog_requests;
  delete quiet.model_catalog_requests;
  const bed = startupSupervisor({ setupReads: [EXTERNAL_CONFIG], configReads: [EXTERNAL_CONFIG], health: quiet });
  const ownership = resolveOwnershipContext({ requestedMode: undefined, supervisor: bed.supervisor, action: "runtime-startup" });
  const context = runStartBridge({
    runtimeHost: {},
    runtimeSupervisor: bed.supervisor,
  });
  const started = await context.startConfiguredBridgeRuntime({
    startupOwnership: ownership,
    runtimeHost: context.runtimeHost,
    runtimeSupervisor: context.runtimeSupervisor,
  });
  assert.equal(started.runtime.status, "ready");
});

test("G3.29 External catalog failure publishes no Direct failure claim", async () => {
  const source = sliceMainFunction(
    "function startCatalogVerificationMonitor(",
    "async function restoreCodexRouteAfterRuntimeFailure(",
  );
  const state = { coreSetupComplete: true, codexCatalogVerified: false, codexRestartRequired: true, language: "en" };
  const operations = [];
  const events = [];
  let tick;
  const payload = {
    pid: 10,
    successful_model_catalog_requests: 0,
    model_catalog_requests: 1,
    last_model_catalog_result: { request: 1, at: "2026-09-16T10:00:00Z", status: 502, failure: { stage: "transport" } },
  };
  vm.runInNewContext(source + "\nstartCatalogVerificationMonitor({ logger, stateStore });", {
    catalogVerificationInFlight: false,
    catalogVerificationTimer: null,
    lastOperation: null,
    stopCatalogVerificationMonitor() {},
    runtimeSupervisor: {
      readConfig: () => ({ integrationMode: "external-provider" }),
      proxyHealthPayload: async () => payload,
    },
    stateStore: { read: () => state, update: (patch) => Object.assign(state, patch) },
    setInterval: (callback) => {
      tick = callback;
      return { unref() {} };
    },
    logger: { info: (...args) => events.push(args), warn: (...args) => events.push(args), debug: (...args) => events.push(args) },
    send() {},
    publishOperation: (op) => operations.push(op),
    nativeCopyFor: () => ({ catalogFailure: "Catalog failed (HTTP {status}; {reason})." }),
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(operations.length, 0);
  assert.equal(state.codexCatalogVerified, false);
  assert.equal(state.codexRestartRequired, true);
  await tick();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(operations.length, 0);
  assert.equal(state.codexCatalogVerified, false);
  assert.equal(state.codexRestartRequired, true);
});

test("G3.30 ready state leaves restart untouched without a route change", () => {
  const context = readyContext({ browserOnly: false });
  const updated = [];
  const sent = [];
  const monitored = [];
  context.completeStartupReadyState({
    stateStore: { read: () => ({}), update: (patch) => { updated.push(patch); return patch; } },
    send: (channel, value) => sent.push([channel, value]),
    config: { mode: "full", experimentalBiggerContext: false, experimentalSkillAttachments: false, zeroRiskProEnabled: false },
    bridgeRouteChanged: false,
    integrationMode: "external-provider",
    startMonitor: () => monitored.push(true),
  });
  assert.equal(monitored.length, 0);
  assert.equal(updated.length, 1);
  assert.equal("codexRestartRequired" in updated[0], false);
  assert.equal("codexCatalogVerified" in updated[0], false);
  assert.equal(updated[0].coreSetupComplete, true);
});

test("ready state keeps Direct catalog monitoring and restart semantics", () => {
  const context = readyContext({ browserOnly: false });
  const updated = [];
  const monitored = [];
  context.completeStartupReadyState({
    stateStore: { read: () => ({}), update: (patch) => { updated.push(patch); return patch; } },
    send: () => {},
    config: { mode: "full", experimentalBiggerContext: false, experimentalSkillAttachments: false, zeroRiskProEnabled: false },
    bridgeRouteChanged: true,
    integrationMode: "direct",
    startMonitor: () => monitored.push(true),
  });
  assert.equal(monitored.length, 1);
  assert.equal(updated[0].codexRestartRequired, true);
  assert.equal(updated[0].codexCatalogVerified, false);
});

test("startup flow keeps route calls behind ownership gates", () => {
  assert.equal(countOccurrences(electronMain, "runtimeHost.connectBridgeRoute()"), 1);
  assert.equal(countOccurrences(electronMain, "return restoreCodexRouteAfterRuntimeFailure({ logger, stateStore });"), 1);
  assert.equal(
    countOccurrences(electronMain, "recoverStartupRoute({ startupOwnership: recoveryOwnership, logger, stateStore })"),
    3,
  );
  assert.ok(!electronMain.includes("[\"route\", \"connect\"]"));
  assert.ok(!electronMain.includes("[\"route\", \"disconnect\"]"));
  assert.ok(!electronMain.includes("[\"route\", \"status\"]"));
  assert.ok(!startBridgeSource.includes(".owner"));
  const upgradeAt = electronMain.indexOf("runtimeHost.upgradeManagedRuntime()");
  const captureAt = electronMain.indexOf("action: \"runtime-startup\"", upgradeAt);
  const reconcileAt = electronMain.indexOf("startConfiguredBridgeRuntime({", captureAt);
  assert.ok(upgradeAt > 0 && captureAt > upgradeAt && reconcileAt > captureAt);
});

// Two-capture startup window regressions (G3 blocker fix). Each test models
// FIRST CAPTURE, async/upgrade window with config drift, SECOND CAPTURE,
// then the continuity gate: the gate, not the later reconcile checks, must
// reject drift before any route behavior.

function loadUpgradePatch() {
  const start = electronMain.indexOf("function buildUpgradeCompletionPatch({");
  const end = electronMain.indexOf("async function startConfiguredBridgeRuntime(", start);
  if (start < 0 || end < 0) throw new Error("upgrade patch builder slice is missing");
  const context = { EXTERNAL_INTEGRATION_MODE };
  vm.createContext(context);
  context.buildUpgradeCompletionPatch = vm.runInContext(
    electronMain.slice(start, end) + "\nbuildUpgradeCompletionPatch;",
    context,
  );
  return context;
}

test("G3.1 pre External to post Direct rejects before start or connect", async () => {
  const bed = startupSupervisor({ setupReads: [EXTERNAL_CONFIG, DIRECT_CONFIG], configReads: [DIRECT_CONFIG], health: directHealth() });
  const pre = resolveOwnershipContext({ requestedMode: undefined, supervisor: bed.supervisor, action: "runtime-startup" });
  assert.equal(pre.integrationMode, "external-provider");
  const post = resolveOwnershipContext({ requestedMode: undefined, supervisor: bed.supervisor, action: "runtime-startup" });
  assert.equal(post.integrationMode, "direct");
  assert.throws(
    () => assertOwnershipContinuity({ before: pre.expectation, after: post.expectation, action: "runtime-startup" }),
    /changed while preparing runtime-startup/,
  );
  let connects = 0;
  const context = runStartBridge({
    runtimeHost: {
      connectBridgeRoute: async () => {
        connects += 1;
        return { installed: true, active: true, changed: true };
      },
    },
    runtimeSupervisor: bed.supervisor,
  });
  const unguarded = await context.startConfiguredBridgeRuntime({
    startupOwnership: post,
    runtimeHost: context.runtimeHost,
    runtimeSupervisor: context.runtimeSupervisor,
  });
  assert.equal(unguarded.runtime.status, "ready");
  assert.equal(connects, 1);
  const recovery = recoverContext({ supervisor: bed.supervisor, ownership: pre });
  const recovered = await recovery.recoverStartupRoute({
    startupOwnership: pre,
    logger: recovery.logger,
    stateStore: {},
  });
  assert.equal(recovered.skipped, true);
  assert.equal(recovery.restores, 0);
});

test("G3.2 pre Direct to post External rejects with zero route calls", async () => {
  const bed = startupSupervisor({
    setupReads: [DIRECT_CONFIG, EXTERNAL_CONFIG],
    configReads: [EXTERNAL_CONFIG],
    health: externalHealth(),
  });
  const pre = resolveOwnershipContext({ requestedMode: undefined, supervisor: bed.supervisor, action: "runtime-startup" });
  assert.equal(pre.integrationMode, "direct");
  const post = resolveOwnershipContext({ requestedMode: undefined, supervisor: bed.supervisor, action: "runtime-startup" });
  assert.equal(post.integrationMode, "external-provider");
  assert.throws(
    () => assertOwnershipContinuity({ before: pre.expectation, after: post.expectation, action: "runtime-startup" }),
    /changed while preparing runtime-startup/,
  );
  const recovery = recoverContext({ supervisor: bed.supervisor, ownership: pre });
  const recovered = await recovery.recoverStartupRoute({
    startupOwnership: pre,
    logger: recovery.logger,
    stateStore: {},
  });
  assert.equal(recovered.skipped, true);
  assert.equal(recovered.ownershipChanged, true);
  assert.equal(recovery.restores, 0);
});

test("G3.3 pre configured to post missing rejects", async () => {
  const bed = startupSupervisor({ setupReads: [DIRECT_CONFIG, null], configReads: [DIRECT_CONFIG], health: directHealth() });
  const pre = resolveOwnershipContext({ requestedMode: undefined, supervisor: bed.supervisor, action: "runtime-startup" });
  const post = resolveOwnershipContext({ requestedMode: undefined, supervisor: bed.supervisor, action: "runtime-startup" });
  assert.equal(post.canonical.kind, "missing");
  assert.throws(
    () => assertOwnershipContinuity({ before: pre.expectation, after: post.expectation, action: "runtime-startup" }),
    /changed while preparing runtime-startup/,
  );
  const recovery = recoverContext({ supervisor: bed.supervisor, ownership: pre });
  const recovered = await recovery.recoverStartupRoute({
    startupOwnership: pre,
    logger: recovery.logger,
    stateStore: {},
  });
  assert.equal(recovered.skipped, true);
  assert.equal(recovery.restores, 0);
});

test("G3.4 pre configured to post damaged rejects", async () => {
  const bed = startupSupervisor({
    setupReads: [DIRECT_CONFIG, new Error("Unexpected token")],
    configReads: [DIRECT_CONFIG],
    health: directHealth(),
  });
  const pre = resolveOwnershipContext({ requestedMode: undefined, supervisor: bed.supervisor, action: "runtime-startup" });
  assert.throws(
    () => resolveOwnershipContext({ requestedMode: undefined, supervisor: bed.supervisor, action: "runtime-startup" }),
    /damaged/,
  );
  const recovery = recoverContext({ supervisor: bed.supervisor, ownership: pre });
  const recovered = await recovery.recoverStartupRoute({
    startupOwnership: pre,
    logger: recovery.logger,
    stateStore: {},
  });
  assert.equal(recovered.skipped, true);
  assert.equal(recovery.restores, 0);
});

test("G3.5-6 unchanged ownership passes continuity across the window", async () => {
  for (const config of [DIRECT_CONFIG, EXTERNAL_CONFIG]) {
    const health = config.integrationMode === "direct" ? directHealth() : externalHealth();
    const bed = startupSupervisor({ setupReads: [config, { ...config }], configReads: [{ ...config }], health });
    const pre = resolveOwnershipContext({ requestedMode: undefined, supervisor: bed.supervisor, action: "runtime-startup" });
    const post = resolveOwnershipContext({ requestedMode: undefined, supervisor: bed.supervisor, action: "runtime-startup" });
    const kept = assertOwnershipContinuity({ before: pre.expectation, after: post.expectation, action: "runtime-startup" });
    assert.equal(kept.integrationMode, config.integrationMode);
    let connects = 0;
    const context = runStartBridge({
      runtimeHost: {
        connectBridgeRoute: async () => {
          connects += 1;
          return { installed: true, active: true, changed: false };
        },
      },
      runtimeSupervisor: bed.supervisor,
    });
    const started = await context.startConfiguredBridgeRuntime({
      startupOwnership: post,
      runtimeHost: context.runtimeHost,
      runtimeSupervisor: context.runtimeSupervisor,
    });
    assert.equal(started.runtime.status, "ready");
    assert.equal(connects, config.integrationMode === "direct" ? 1 : 0);
  }
});

test("G3.10 external upgrade completion sets no restart requirement", () => {
  const context = loadUpgradePatch();
  const patch = context.buildUpgradeCompletionPatch({
    upgrade: { updated: true, mode: "full", integrationMode: "external-provider" },
    snapshotConfig: { experimentalBiggerContext: false, experimentalSkillAttachments: false, zeroRiskProEnabled: true },
  });
  assert.equal(patch.coreSetupComplete, true);
  assert.equal("codexRestartRequired" in patch, false);
  assert.equal("codexCatalogVerified" in patch, false);
  assert.equal(patch.zeroRiskProEnabled, true);
  assert.equal(patch.mcpRuntimeInstalled, true);
  assert.equal(patch.mcpSetupComplete, false);
});

test("G3.11 direct upgrade completion preserves restart behavior", () => {
  const context = loadUpgradePatch();
  const full = context.buildUpgradeCompletionPatch({
    upgrade: { updated: true, mode: "full", integrationMode: "direct" },
    snapshotConfig: { experimentalBiggerContext: true },
  });
  assert.equal(full.codexRestartRequired, true);
  assert.equal(full.codexCatalogVerified, false);
  assert.equal(full.experimentalBiggerContext, true);
  assert.equal(full.mcpRuntimeInstalled, true);
  const browserOnly = context.buildUpgradeCompletionPatch({
    upgrade: { updated: true, mode: "browser-only", integrationMode: "direct" },
    snapshotConfig: {},
  });
  assert.equal(browserOnly.codexRestartRequired, true);
  assert.equal(browserOnly.mcpGuideStep, 0);
});

test("startup captures continuity across the upgrade window in order", () => {
  const preCapture = electronMain.indexOf("recoveryOwnership = resolveOwnershipContext({");
  const upgradeAt = electronMain.indexOf("runtimeHost.upgradeManagedRuntime()", preCapture);
  const postCapture = electronMain.indexOf("const startupOwnership = resolveOwnershipContext({", upgradeAt);
  const continuityAt = electronMain.indexOf("assertOwnershipContinuity({", postCapture);
  const reconcileAt = electronMain.indexOf("startConfiguredBridgeRuntime({", continuityAt);
  for (const entry of [preCapture, upgradeAt, postCapture, continuityAt, reconcileAt]) {
    assert.ok(entry > 0);
  }
  assert.ok(preCapture < upgradeAt && upgradeAt < postCapture && postCapture < continuityAt && continuityAt < reconcileAt);
  const continuityBlock = electronMain.slice(postCapture, reconcileAt);
  assert.ok(!continuityBlock.includes("upgrade.updated"));
});
