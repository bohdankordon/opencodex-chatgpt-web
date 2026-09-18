"use strict"; // G5 placeholder
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { RuntimeHost } = require("../electron/runtime.cjs");
const launcherRoot = path.resolve(__dirname, "..");
const electronMain = fs.readFileSync(path.join(launcherRoot, "electron", "main.cjs"), "utf8");
const electronRuntime = fs.readFileSync(path.join(launcherRoot, "electron", "runtime.cjs"), "utf8");

const DIRECT_CONFIG = { mode: "browser-only", browserHost: "launcher", host: "127.0.0.1", port: 17841, integrationMode: "direct", releaseVersion: "9.9.9" };
const EXTERNAL_CONFIG = { mode: "browser-only", browserHost: "launcher", host: "127.0.0.1", port: 17841, integrationMode: "external-provider", releaseVersion: "9.9.9" };

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

// Real-FS Remove fixture. Temp dirs model: bridge home (coreHome with
// config.json + codex/ journals + secrets/), Codex home (config.toml +
// models_cache.json), and a signed-in profile dir with a sentinel file.
// The mocked core CLI emulates `uninstall --yes --launcher-control` by
// deleting the bridge config file; route behavior is scripted per test.
function removeFixture(options) {
  const settings = options || {};
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "g5-remove-"));
  const coreHome = path.join(root, "core");
  const codexHome = path.join(root, "codex");
  const userData = path.join(root, "userdata");
  fs.mkdirSync(path.join(coreHome, "codex"), { recursive: true });
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(userData, { recursive: true });
  const configPath = path.join(coreHome, "config.json");
  const setupReads = scriptedReads(settings.setupReads !== undefined ? settings.setupReads : [settings.config !== undefined ? settings.config : DIRECT_CONFIG]);
  const useScript = settings.setupReads !== undefined;
  const readFile = () => {
    // Scripted reads model TOCTOU sequences without file I/O; otherwise the
    // real temp config file is truth (missing -> null, malformed -> throws
    // so canonical resolution fails closed as damaged, never Direct).
    if (useScript) return setupReads.next();
    if (!fs.existsSync(configPath)) return null;
    return JSON.parse(fs.readFileSync(configPath, "utf8"));
  };
  if (settings.writeConfig !== false && settings.config !== undefined && settings.config !== null) {
    fs.writeFileSync(configPath, JSON.stringify(settings.config));
  }
  const sentinel = path.join(userData, "profile-sentinel.txt");
  fs.writeFileSync(sentinel, "signed-in-session");
  const events = [];
  const spawns = [];
  const supervisor = {
    coreHome,
    configPath,
    readSetupConfig: () => readFile(),
    readConfig: () => readFile(),
    stopForSetup: async () => { events.push("supervisor-stop"); if (settings.stopFails) throw new Error(settings.stopFails); return { status: "stopped" }; },
    prepareExternalMigration: () => { events.push("prepare-external-migration"); if (settings.stopFails) throw new Error(settings.stopFails); },
  };
  const host = new RuntimeHost({
    app: { getPath: () => path.join(root, "appdata"), getVersion: () => "1.1.3" },
    logger: { info() {}, warn() {}, error() {} },
    sourceRoot: "/source",
    browserDescriptorPath: path.join(coreHome, "launcher-browser.json"),
    codexHome,
    launchAgentsDir: path.join(root, "launchagents"),
    supervisor,
  });
  if (settings.owner) {
    host.runtimeConfigSnapshot = () => ({ configured: settings.config !== null, owner: settings.owner, mode: "browser-only", serialized: "s", config: settings.config });
  }
  host.launcherControlEnvironment = () => ({ CODEX_WEB_GPT_LAUNCHER_CONTROL_TOKEN: "test-token" });
  host.run = async (name, args) => {
    const action = args.join(" ");
    spawns.push(action);
    events.push(action);
    // The expected-ownership suffix binds the destructive child to the exact
    // ownership the Launcher proved; match by prefix and assert the suffix
    // per test below instead of exact-matching the legacy bare command.
    if (action === "uninstall --yes --launcher-control"
      || action.startsWith("uninstall --yes --launcher-control ")) {
      if (settings.uninstallFails) throw new Error(settings.uninstallFails);
      if (typeof settings.onUninstall === "function") settings.onUninstall({ configPath, codexHome, coreHome });
      else fs.rmSync(configPath, { force: true });
      return { code: 0, stdout: "uninstalled\n", stderr: "" };
    }
    if (action === "route status") {
      return { stdout: JSON.stringify(settings.routeStatus !== undefined ? settings.routeStatus : { installed: false, active: false, errors: [] }) };
    }
    if (action === "route disconnect") {
      events.push("route-disconnect-applied");
      return { stdout: JSON.stringify({ changed: true, active: false }) };
    }
    throw new Error(`Unexpected command: ${action}`);
  };
  return {
    host, root, coreHome, codexHome, userData, configPath, sentinel, events, spawns,
    routePaths: () => ({
      codexConfig: path.join(codexHome, "config.toml"),
      modelsCache: path.join(codexHome, "models_cache.json"),
      journal: path.join(coreHome, "codex", "integration-journal.json"),
      recovery: path.join(coreHome, "codex", "integration-journal.recovery.json"),
    }),
    routeSpawns: () => spawns.filter((a) => a.startsWith("route ")),
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

test("G5.1 Direct Remove runs core uninstall with route verification", async () => {
  const fixture = removeFixture({ config: DIRECT_CONFIG });
  try {
    await fixture.host.uninstallIntegration();
    // The destructive child carries the Launcher-proved Direct expectation;
    // core revalidates these flags under the shared lifecycle lock.
    assert.deepEqual(fixture.spawns, [
      "uninstall --yes --launcher-control --expected-installation-kind configured --expected-integration-mode direct",
      "route status",
    ]);
    assert.equal(fs.existsSync(fixture.configPath), false);
    assert.equal(fs.readFileSync(fixture.sentinel, "utf8"), "signed-in-session");
  } finally { fixture.cleanup(); }
});

test("G5.2 External Remove issues zero route commands", async () => {
  const fixture = removeFixture({ config: EXTERNAL_CONFIG });
  const rp = fixture.routePaths();
  fs.writeFileSync(rp.codexConfig, "router-owned route\n");
  fs.writeFileSync(rp.modelsCache, "router cache\n");
  try {
    await fixture.host.uninstallIntegration({ integrationMode: "external-provider" });
    assert.deepEqual(fixture.spawns, [
      "uninstall --yes --launcher-control --expected-installation-kind configured --expected-integration-mode external-provider",
    ]);
    assert.equal(fixture.routeSpawns().length, 0);
    assert.equal(fs.existsSync(fixture.configPath), false);
    assert.equal(fs.readFileSync(rp.codexConfig, "utf8"), "router-owned route\n");
    assert.equal(fs.readFileSync(rp.modelsCache, "utf8"), "router cache\n");
  } finally { fixture.cleanup(); }
});

test("G5 expected-ownership args derive only from trusted Launcher ownership", async () => {
  const fixture = removeFixture({ config: DIRECT_CONFIG });
  try {
    // Configured installs carry their canonical mode; the mode strings are
    // the Launcher-trusted G1 values, never renderer input.
    assert.deepEqual(
      fixture.host.uninstallExpectedOwnershipArgs({ canonical: { kind: "configured" }, integrationMode: "direct" }),
      ["--expected-installation-kind", "configured", "--expected-integration-mode", "direct"],
    );
    assert.deepEqual(
      fixture.host.uninstallExpectedOwnershipArgs({ canonical: { kind: "configured" }, integrationMode: "external-provider" }),
      ["--expected-installation-kind", "configured", "--expected-integration-mode", "external-provider"],
    );
    // Missing installs carry kind-only: never a fake Direct default, and no
    // mode flag that core would reject alongside kind=missing.
    assert.deepEqual(
      fixture.host.uninstallExpectedOwnershipArgs({ canonical: { kind: "missing" }, integrationMode: undefined }),
      ["--expected-installation-kind", "missing"],
    );
    assert.deepEqual(
      fixture.host.uninstallExpectedOwnershipArgs(null),
      ["--expected-installation-kind", "missing"],
    );
    // Anything outside the allowlisted modes fails closed before spawn.
    assert.throws(
      () => fixture.host.uninstallExpectedOwnershipArgs({ canonical: { kind: "configured" }, integrationMode: "bogus" }),
      /routing ownership state is invalid/,
    );
  } finally { fixture.cleanup(); }
});

test("G5 missing Remove spawns kind-only expected ownership", async () => {
  const fixture = removeFixture({ config: null });
  try {
    await fixture.host.uninstallIntegration();
    assert.deepEqual(fixture.spawns, ["uninstall --yes --launcher-control --expected-installation-kind missing"]);
    assert.equal(fixture.routeSpawns().length, 0);
    assert.equal(fs.existsSync(fixture.configPath), false);
  } finally { fixture.cleanup(); }
});

test("G5.3 renderer Direct cannot override canonical External", async () => {
  const fixture = removeFixture({ config: EXTERNAL_CONFIG });
  try {
    await assert.rejects(fixture.host.uninstallIntegration({ integrationMode: "direct" }), /CLI-only|mismatch/);
    assert.equal(fixture.spawns.length, 0);
    assert.equal(fixture.events.filter((e) => e === "supervisor-stop").length, 0);
    assert.equal(fs.existsSync(fixture.configPath), true);
  } finally { fixture.cleanup(); }
});

test("G5.4 renderer External cannot override canonical Direct", async () => {
  const fixture = removeFixture({ config: DIRECT_CONFIG });
  try {
    await assert.rejects(fixture.host.uninstallIntegration({ integrationMode: "external-provider" }), /CLI-only|mismatch/);
    assert.equal(fixture.spawns.length, 0);
    assert.equal(fs.existsSync(fixture.configPath), true);
  } finally { fixture.cleanup(); }
});

test("G5.5 damaged config fails before destructive mutation", async () => {
  const fixture = removeFixture({ config: { mode: "browser-only", browserHost: "launcher", integrationMode: "bogus" } });
  try {
    await assert.rejects(fixture.host.uninstallIntegration(), /damaged|Invalid integration/);
    assert.equal(fixture.spawns.length, 0);
    assert.equal(fixture.events.filter((e) => e === "supervisor-stop").length, 0);
    assert.equal(fs.existsSync(fixture.configPath), true);
  } finally { fixture.cleanup(); }
});

test("G5.6 process owner does not choose routing removal policy", async () => {
  const directExternal = removeFixture({ config: DIRECT_CONFIG, owner: "external", stopFails: "stop failed" });
  directExternal.host.run = async (name, args) => {
    const action = args.join(" ");
    directExternal.spawns.push(action);
    if (action === "route status") return { stdout: JSON.stringify({ installed: false, active: false, errors: [] }) };
    throw new Error(`Unexpected command: ${action}`);
  };
  try {
    await assert.rejects(directExternal.host.uninstallIntegration(), /cleanup did not complete/);
    assert.ok(directExternal.spawns.includes("route status"));
  } finally { directExternal.cleanup(); }
  const externalLauncher = removeFixture({ config: EXTERNAL_CONFIG, owner: "launcher", stopFails: "stop failed" });
  try {
    await assert.rejects(externalLauncher.host.uninstallIntegration({ integrationMode: "external-provider" }), /stop failed/);
    assert.equal(externalLauncher.routeSpawns().length, 0);
  } finally { externalLauncher.cleanup(); }
});

test("G5.7-10 External Remove leaves route files byte-identical", async () => {
  const fixture = removeFixture({ config: EXTERNAL_CONFIG });
  const rp = fixture.routePaths();
  const original = { codexConfig: "router-owned route v3\n", modelsCache: "{\"router\":true}\n", journal: "stale? no - router journal\n", recovery: "router recovery\n" };
  fs.writeFileSync(rp.codexConfig, original.codexConfig);
  fs.writeFileSync(rp.modelsCache, original.modelsCache);
  fs.writeFileSync(rp.journal, original.journal);
  fs.writeFileSync(rp.recovery, original.recovery);
  try {
    await assert.rejects(
      fixture.host.uninstallIntegration({ integrationMode: "external-provider" }),
      /Direct integration journal exists/,
    );
    assert.equal(fixture.routeSpawns().length, 0);
    assert.equal(fs.readFileSync(rp.codexConfig, "utf8"), original.codexConfig);
    assert.equal(fs.readFileSync(rp.modelsCache, "utf8"), original.modelsCache);
    assert.equal(fs.readFileSync(rp.journal, "utf8"), original.journal);
    assert.equal(fs.readFileSync(rp.recovery, "utf8"), original.recovery);
    assert.equal(fs.existsSync(fixture.configPath), true);
  } finally { fixture.cleanup(); }
});

test("G5.11-13 External Remove has zero route/provider surface", async () => {
  const fixture = removeFixture({ config: EXTERNAL_CONFIG });
  try {
    await fixture.host.uninstallIntegration({ integrationMode: "external-provider" });
    assert.equal(fixture.routeSpawns().length, 0);
    const blob = fixture.spawns.join(" ");
    assert.equal(blob.includes("route"), false);
    assert.equal(blob.includes("ocx"), false);
    assert.equal(blob.includes(":10100"), false);
    assert.equal(/provider/i.test(blob) && !blob.includes("external-provider"), false);
    assert.equal(blob.includes("replace-codex-route"), false);
  } finally { fixture.cleanup(); }
});

test("G5.14-15 Direct uninstall follows core journal semantics", async () => {
  const fixture = removeFixture({
    config: DIRECT_CONFIG,
    onUninstall: ({ codexHome }) => {
      fs.rmSync(fixture.configPath, { force: true });
      fs.writeFileSync(path.join(codexHome, "config.toml"), "restored-prior-route\n");
    },
  });
  const rp = fixture.routePaths();
  fs.writeFileSync(rp.codexConfig, "bridge-active-route\n");
  try {
    await fixture.host.uninstallIntegration();
    assert.equal(fs.readFileSync(rp.codexConfig, "utf8"), "restored-prior-route\n");
    assert.equal(fs.existsSync(fixture.configPath), false);
  } finally { fixture.cleanup(); }
});

test("G5.16 Direct stop failure keeps bridge, restores route, keeps error", async () => {
  const fixture = removeFixture({ config: DIRECT_CONFIG, stopFails: "probe timeout" });
  const rp = fixture.routePaths();
  fs.writeFileSync(rp.codexConfig, "bridge-active-route\n");
  let uninstallSpawned = false;
  let routeActive = true;
  fixture.host.run = async (name, args) => {
    const action = args.join(" ");
    if (action.startsWith("uninstall --yes --launcher-control")) uninstallSpawned = true;
    fixture.spawns.push(action);
    fixture.events.push(action);
    if (action === "route status") return { stdout: JSON.stringify({ installed: true, active: routeActive, errors: [] }) };
    if (action === "route disconnect") {
      routeActive = false;
      return { stdout: JSON.stringify({ changed: true, active: false }) };
    }
    throw new Error(`Unexpected command: ${action}`);
  };
  try {
    await assert.rejects(fixture.host.uninstallIntegration(), /cleanup did not complete/);
    assert.equal(uninstallSpawned, false);
    assert.equal(fs.existsSync(fixture.configPath), true);
    assert.deepEqual(fixture.events.slice(0, 4), ["supervisor-stop", "route status", "route disconnect", "route status"]);
  } finally { fixture.cleanup(); }
});

test("G5.20-22 External Remove deletes bridge, keeps router state, needs no router", async () => {
  const fixture = removeFixture({ config: EXTERNAL_CONFIG });
  const rp = fixture.routePaths();
  fs.writeFileSync(rp.codexConfig, "router-owned route\n");
  fs.writeFileSync(rp.modelsCache, "router cache\n");
  const tunnelKey = path.join(fixture.coreHome, "secrets", "tunnel-runtime-automatic.key");
  fs.mkdirSync(path.dirname(tunnelKey), { recursive: true });
  fs.writeFileSync(tunnelKey, "bridge-key\n");
  try {
    await fixture.host.uninstallIntegration({ integrationMode: "external-provider" });
    assert.equal(fs.existsSync(fixture.configPath), false);
    assert.equal(fs.readFileSync(rp.codexConfig, "utf8"), "router-owned route\n");
    assert.equal(fs.readFileSync(rp.modelsCache, "utf8"), "router cache\n");
    assert.equal(fixture.routeSpawns().length, 0);
  } finally { fixture.cleanup(); }
});

test("G5.23 External cleanup failure performs no Direct compensation", async () => {
  const fixture = removeFixture({ config: EXTERNAL_CONFIG, uninstallFails: "bridge delete failed" });
  const rp = fixture.routePaths();
  fs.writeFileSync(rp.codexConfig, "router-owned route\n");
  try {
    const error = await fixture.host.uninstallIntegration({ integrationMode: "external-provider" }).then(() => null, (e) => e);
    assert.match(String(error && error.message), /bridge delete failed/);
    assert.ok(!String(error && error.message).includes("Codex route"));
    assert.equal(fixture.routeSpawns().length, 0);
    assert.equal(fs.readFileSync(rp.codexConfig, "utf8"), "router-owned route\n");
    assert.equal(fs.readFileSync(fixture.sentinel, "utf8"), "signed-in-session");
  } finally { fixture.cleanup(); }
});

test("G5.26 Direct-to-External drift aborts before core uninstall", async () => {
  const fixture = removeFixture({ setupReads: [DIRECT_CONFIG, EXTERNAL_CONFIG], writeConfig: false });
  const rp = fixture.routePaths();
  fs.writeFileSync(rp.codexConfig, "bridge-active-route\n");
  try {
    await assert.rejects(fixture.host.uninstallIntegration(), /changed while preparing/);
    assert.ok(!fixture.spawns.some((a) => a.startsWith("uninstall --yes --launcher-control")));
    assert.equal(fixture.routeSpawns().length, 0);
    assert.equal(fs.readFileSync(rp.codexConfig, "utf8"), "bridge-active-route\n");
  } finally { fixture.cleanup(); }
});

test("G5.27 External-to-Direct drift aborts bridge deletion", async () => {
  const fixture = removeFixture({ setupReads: [EXTERNAL_CONFIG, DIRECT_CONFIG], writeConfig: false });
  try {
    await assert.rejects(fixture.host.uninstallIntegration({ integrationMode: "external-provider" }), /changed while preparing|mismatch/);
    assert.ok(!fixture.spawns.some((a) => a.startsWith("uninstall --yes --launcher-control")));
    assert.equal(fixture.routeSpawns().length, 0);
  } finally { fixture.cleanup(); }
});

test("G5.28-29 missing and damaged drift fail closed", async () => {
  const missing = removeFixture({ setupReads: [DIRECT_CONFIG, null], writeConfig: false });
  try {
    await assert.rejects(missing.host.uninstallIntegration(), /changed while preparing/);
    assert.ok(!missing.spawns.some((a) => a.startsWith("uninstall --yes --launcher-control")));
  } finally { missing.cleanup(); }
  const damaged = removeFixture({ setupReads: [new Error("unexpected token in JSON")], writeConfig: false });
  try {
    await assert.rejects(damaged.host.uninstallIntegration(), /damaged/i);
    assert.equal(damaged.spawns.length, 0);
  } finally { damaged.cleanup(); }
});

test("G5.31-32 Direct ordering: route cleanup failure precedes any bridge deletion", async () => {
  const fixture = removeFixture({ config: DIRECT_CONFIG, uninstallFails: "route cleanup failed" });
  let routeActive = true;
  fixture.host.run = async (name, args) => {
    const action = args.join(" ");
    fixture.spawns.push(action);
    fixture.events.push(action);
    if (action.startsWith("uninstall --yes --launcher-control")) throw new Error("route cleanup failed");
    if (action === "route status") return { stdout: JSON.stringify({ installed: true, active: routeActive, errors: [] }) };
    if (action === "route disconnect") {
      routeActive = false;
      return { stdout: JSON.stringify({ changed: true, active: false }) };
    }
    throw new Error(`Unexpected command: ${action}`);
  };
  try {
    await assert.rejects(fixture.host.uninstallIntegration(), /route cleanup failed/);
    assert.equal(fs.existsSync(fixture.configPath), true);
    const uninstallIndex = fixture.events.findIndex((e) => e.startsWith("uninstall --yes --launcher-control"));
    const restoreIndex = fixture.events.indexOf("route disconnect");
    assert.ok(uninstallIndex >= 0 && restoreIndex > uninstallIndex);
  } finally { fixture.cleanup(); }
});

test("G5.33-34 External has no route phase; missing Remove is idempotent", async () => {
  const external = removeFixture({ config: EXTERNAL_CONFIG });
  try {
    await external.host.uninstallIntegration({ integrationMode: "external-provider" });
    assert.equal(external.routeSpawns().length, 0);
  } finally { external.cleanup(); }
  const missing = removeFixture({ config: null });
  try {
    await missing.host.uninstallIntegration();
    await missing.host.uninstallIntegration();
    assert.equal(missing.routeSpawns().length, 0);
    assert.equal(fs.existsSync(missing.configPath), false);
  } finally { missing.cleanup(); }
});

test("G5.37 Remove never wipes the signed-in profile area", async () => {
  for (const config of [DIRECT_CONFIG, EXTERNAL_CONFIG]) {
    const fixture = removeFixture({ config });
    try {
      if (config.integrationMode === "external-provider") {
        await fixture.host.uninstallIntegration({ integrationMode: "external-provider" });
      } else {
        await fixture.host.uninstallIntegration();
      }
      assert.equal(fs.readFileSync(fixture.sentinel, "utf8"), "signed-in-session");
    } finally { fixture.cleanup(); }
  }
  const uninstallSlices = [
    electronMain.slice(electronMain.indexOf('handle("launcher:uninstall-integration"'), electronMain.indexOf('handle("launcher:setup-core"')),
    electronRuntime.slice(electronRuntime.indexOf("async uninstallIntegration("), electronRuntime.indexOf("async setupCore(")),
  ];
  for (const source of uninstallSlices) {
    assert.doesNotMatch(source, /userData/);
    assert.doesNotMatch(source, /rmSync\(\s*\w*[Uu]ser[Dd]ata/);
    assert.doesNotMatch(source, /launcher-state\.json/);
  }
});

function uninstallHandlerSource() {
  const start = electronMain.indexOf('handle("launcher:uninstall-integration"');
  const end = electronMain.indexOf('handle("launcher:setup-core"', start);
  return electronMain.slice(start, end);
}

async function runRemoveIpc({ config, uninstallBehavior }) {
  const { resolveOwnershipContext, extractRequestedIntegrationMode: realExtract } = require("../electron/integration-mode.cjs");
  let current = config;
  const supervisor = {
    readSetupConfig: () => {
      if (current instanceof Error) throw current;
      return current;
    },
    readConfig: () => {
      if (current instanceof Error) throw current;
      return current;
    },
  };
  const calls = { stateUpdates: [], descriptorWrites: 0, monitorStops: 0 };
  const runtimeHost = {
    supervisor,
    uninstallIntegration: async (...args) => {
      calls.uninstallArgs = args;
      if (uninstallBehavior === "fail") throw new Error("synthetic remove failure");
      return { code: 0, stdout: "uninstalled\n" };
    },
  };
  const copy = { cancel: "Cancel", remove: "Remove", removeTitle: "t", removeMessage: "m", removeDetail: "d" };
  const context = {
    handle: (_name, handler) => { context.__handler = handler; },
    IS_DEV_PROFILE: false,
    dialog: { showMessageBox: async () => ({ response: 1 }) },
    mainWindow: {},
    nativeCopyFor: () => copy,
    stateStore: {
      read: () => ({ language: "en" }),
      update: (patch) => { calls.stateUpdates.push(patch); return patch; },
    },
    browserHost: { writeDescriptor: () => { calls.descriptorWrites += 1; } },
    runtimeHost,
    runtimeSupervisor: supervisor,
    resolveSetupOwnership: (requestedMode, action) => resolveOwnershipContext({ requestedMode, supervisor, action }),
    extractRequestedIntegrationMode: realExtract,
    send() {},
    stopCatalogVerificationMonitor: () => { calls.monitorStops += 1; },
    logger: { warn() {}, info() {}, error() {}, debug() {} },
    DIRECT_INTEGRATION_MODE: "direct",
  };
  vm.createContext(context);
  vm.runInContext(uninstallHandlerSource() + "\nthis.__captured = __handler;", context);
  let result;
  let error;
  try { result = await context.__handler(); } catch (e) { error = e; }
  return { result, error, calls };
}

test("G5 Direct Remove state requires Codex restart; External must not", async () => {
  const direct = await runRemoveIpc({ config: DIRECT_CONFIG });
  assert.equal(direct.error, undefined);
  assert.equal(direct.result.cancelled, false);
  assert.equal(direct.calls.stateUpdates.length, 1);
  assert.equal(direct.calls.stateUpdates[0].coreSetupComplete, false);
  assert.equal(direct.calls.stateUpdates[0].codexRestartRequired, true);
  assert.equal(direct.calls.descriptorWrites, 1);
  const external = await runRemoveIpc({ config: EXTERNAL_CONFIG });
  assert.equal(external.error, undefined);
  assert.equal(external.calls.stateUpdates.length, 1);
  assert.equal(external.calls.stateUpdates[0].coreSetupComplete, false);
  assert.equal(external.calls.stateUpdates[0].codexRestartRequired, false);
  assert.ok(!("restartRequired" in (external.result || {})) || external.result.restartRequired !== true);
});

test("G5 Remove failure marks no success state", async () => {
  const out = await runRemoveIpc({ config: DIRECT_CONFIG, uninstallBehavior: "fail" });
  assert.match(String(out.error && out.error.message), /synthetic remove failure/);
  assert.equal(out.calls.stateUpdates.length, 0);
  assert.equal(out.calls.descriptorWrites, 1);
});

