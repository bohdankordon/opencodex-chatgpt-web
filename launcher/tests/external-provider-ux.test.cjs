const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const launcherRoot = path.resolve(__dirname, "..");
const repositoryRoot = path.resolve(launcherRoot, "..");
const appSource = fs.readFileSync(path.join(launcherRoot, "src", "App.tsx"), "utf8");
const electronMain = fs.readFileSync(path.join(launcherRoot, "electron", "main.cjs"), "utf8");
const preloadSource = fs.readFileSync(path.join(launcherRoot, "electron", "preload.cjs"), "utf8");
const stateSource = fs.readFileSync(path.join(launcherRoot, "electron", "state.cjs"), "utf8");
const {
  DIRECT: DIRECT_INTEGRATION_MODE,
  EXTERNAL_PROVIDER: EXTERNAL_INTEGRATION_MODE,
  extractRequestedIntegrationMode,
  readIntegrationInstallationState,
} = require("../electron/integration-mode.cjs");

function sliceMainFunction(startMarker, endMarker) {
  const start = electronMain.indexOf(startMarker);
  if (start < 0) throw new Error("main.cjs is missing " + startMarker);
  const end = electronMain.indexOf(endMarker, start + 1);
  if (end < 0) throw new Error("main.cjs slice end is missing for " + startMarker);
  return electronMain.slice(start, end);
}

function countOccurrences(haystack, needle) {
  return haystack.split(needle).length - 1;
}

function loadI18nModule() {
  const ts = require("typescript");
  const source = fs.readFileSync(path.join(launcherRoot, "src", "i18n.ts"), "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023 },
  }).outputText;
  const loaded = { exports: {} };
  Function("module", "exports", "require", output)(loaded, loaded.exports, require);
  return loaded.exports;
}

function loadNativeCopy() {
  const languages = require("../electron/languages.json");
  const copySource = electronMain.slice(
    electronMain.indexOf("const NATIVE_COPY ="),
    electronMain.indexOf("function updateTrayMenu("),
  );
  return Function(`${copySource}\nreturn { NATIVE_COPY, nativeCopyFor };`)();
}
// FINAL-A 17: first-install ownership intent (renderer source audits).

test("FINAL-A new install defaults to Direct", () => {
  assert.match(appSource, /useState<LauncherIntegrationMode>\("direct"\)/);
});

test("FINAL-A new install can select External provider", () => {
  assert.match(appSource, /role="radiogroup" aria-label=\{copy\.routingTitle\}/);
  assert.match(appSource, /copy\.routingDirectBody/);
  assert.match(appSource, /copy\.routingExternalBody/);
  assert.match(appSource, /onClick=\{\(\) => setRoutingChoice\("direct"\)\}/);
  assert.match(appSource, /onClick=\{\(\) => setRoutingChoice\("external-provider"\)\}/);
});

test("ownership selector is first-install only, never a migration surface", () => {
  // Supplemental source audit: canonical installation state gates the picker,
  // never readiness bookkeeping. Behavioral proof lives in the classification
  // matrix below (configured/damaged + coreSetupComplete=false hides it).
  assert.match(appSource, /snapshot\.integrationInstallationState === "missing"/);
  assert.ok(!appSource.match(/const isNewInstall = snapshot\.state\.coreSetupComplete/), "readiness must not decide installation existence");
  assert.match(appSource, /\{!devProfile && isNewInstall \? \(/);
  const settingsStart = appSource.indexOf("function SettingsSurface(");
  assert.ok(settingsStart > 0, "Settings surface must exist");
  const settingsSource = appSource.slice(settingsStart);
  assert.ok(!settingsSource.includes("routingChoice"), "no routing picker in Settings");
  assert.ok(!settingsSource.includes("integrationMode: routingChoice"), "no ownership input in Settings");
});

test("renderer exposes canonical installation state, never routing mode", () => {
  assert.ok(!appSource.includes("state.integrationMode"));
  assert.ok(!appSource.includes("snapshot.integrationMode"));
  assert.match(appSource, /integrationInstallationState/);
  assert.match(electronMain, /integrationInstallationState: getIntegrationInstallationState\(\)/);
  assert.match(electronMain, /function getIntegrationInstallationState\(\)/);
});

test("FINAL-A renderer fixes gating through shared ready flags, not mode branches", () => {
  assert.ok(countOccurrences(appSource, '"external-provider"') <= 4);
  assert.ok(!appSource.includes('integrationMode === "external-provider"'));
  assert.match(appSource, /complete=\{snapshot\.state\.codexCatalogVerified === true\}/);
  assert.match(appSource, /disabled=\{!manualInteraction && !snapshot\.state\.codexCatalogVerified\}/);
  assert.match(appSource, /snapshot\.state\.codexRestartRequired \? \(/);
});
// FINAL-A 17-18: setup intent and ready semantics through the real main handler.

function runSetupCoreHandler({ ownership, input, setupBehavior }) {
  const source = sliceMainFunction('handle("launcher:setup-core",', 'handle("launcher:setup-mcp",');
  let handler;
  const updates = [];
  const monitorCalls = [];
  const seen = {};
  const state = { browserInteractionMode: "automatic", coreSetupComplete: false };
  // Mirror the real repairCompletionPatch: External strips Direct restart/catalog
  // flags so repairs preserve them; FINAL-A setup success re-marks ready after it.
  const repairCompletionPatch = (owner, directPatch) => {
    if (owner && owner.integrationMode === EXTERNAL_INTEGRATION_MODE) {
      const { codexCatalogVerified, codexRestartRequired, ...rest } = directPatch;
      return rest;
    }
    return directPatch;
  };
  vm.runInNewContext(source, {
    handle: (_name, fn) => { handler = fn; },
    IS_DEV_PROFILE: false,
    EXTERNAL_INTEGRATION_MODE,
    stateStore: {
      read: () => ({ ...state }),
      update: (patch) => { updates.push(patch); Object.assign(state, patch); return { ...state }; },
    },
    browserHost: {
      probeAuthentication: async () => ({ authenticated: true, status: "ready" }),
      returnToIdle: async () => {},
    },
    runtimeHost: {
      setupCore: async (request) => { seen.request = request; return setupBehavior(request); },
      setupDevCore: async () => { throw new Error("unexpected DEV path"); },
      runtimeConfigSnapshot: () => ({ config: {} }),
      assertOwnershipExpectationCurrent: () => {},
    },
    resolveSetupOwnership: (requestedMode, action) => {
      seen.requestedMode = requestedMode;
      seen.action = action;
      return ownership;
    },
    extractRequestedIntegrationMode,
    createRepairRuntimeValidation: () => undefined,
    repairCompletionPatch,
    smokePassedThisSession: true,
    smokePassedForCurrentVersion: () => false,
    send: () => {},
    startCatalogVerificationMonitor: () => { monitorCalls.push(true); },
    logger: { warn: () => {}, info: () => {} },
  });
  return { handler, updates, monitorCalls, seen };
}

test("FINAL-A External reaches setupCore only as first-install requested intent", async () => {
  const ownership = { integrationMode: "external-provider", newInstallation: true, expectation: {} };
  const bed = runSetupCoreHandler({
    ownership,
    input: { integrationMode: "external-provider" },
    setupBehavior: () => ({ mode: "browser-only", stdout: "ok" }),
  });
  const result = await bed.handler({}, { integrationMode: "external-provider" });
  assert.equal(bed.seen.action, "setup-core");
  assert.equal(bed.seen.requestedMode, "external-provider");
  assert.equal(bed.seen.request.integrationMode, "external-provider");
  assert.equal(result.ok, true);
  assert.equal(result.restartRequired, false);
});

test("FINAL-A successful External setup marks bridge ready without Direct monitor", async () => {
  const ownership = { integrationMode: "external-provider", newInstallation: true, expectation: {} };
  const bed = runSetupCoreHandler({
    ownership,
    input: { integrationMode: "external-provider" },
    setupBehavior: () => ({ mode: "full", stdout: "ok" }),
  });
  await bed.handler({}, { integrationMode: "external-provider" });
  assert.equal(bed.updates.length, 1);
  assert.equal(bed.updates[0].coreSetupComplete, true);
  assert.equal(bed.updates[0].codexCatalogVerified, true);
  assert.equal(bed.updates[0].codexRestartRequired, false);
  assert.equal(bed.monitorCalls.length, 0);
});

test("FINAL-A failed External health marks nothing ready", async () => {
  const ownership = { integrationMode: "external-provider", newInstallation: true, expectation: {} };
  const bed = runSetupCoreHandler({
    ownership,
    input: { integrationMode: "external-provider" },
    setupBehavior: () => { throw new Error("bridge ownership-health failed"); },
  });
  await assert.rejects(bed.handler({}, { integrationMode: "external-provider" }), /ownership-health/);
  assert.equal(bed.updates.length, 0);
});

test("FINAL-A configured Direct reinstall keeps Direct semantics", async () => {
  const ownership = { integrationMode: "direct", newInstallation: false, expectation: {} };
  const bed = runSetupCoreHandler({
    ownership,
    input: undefined,
    setupBehavior: () => ({ mode: "browser-only", stdout: "ok" }),
  });
  const result = await bed.handler({}, undefined);
  assert.equal(bed.seen.requestedMode, undefined);
  assert.equal(bed.seen.request.integrationMode, "direct");
  assert.equal(bed.updates[0].codexCatalogVerified, false);
  assert.equal(bed.updates[0].codexRestartRequired, true);
  assert.equal(bed.monitorCalls.length, 1);
  assert.equal(result.restartRequired, true);
});

test("FINAL-A configured External reinstall preserves canonical ownership", async () => {
  const ownership = { integrationMode: "external-provider", newInstallation: false, expectation: {} };
  const bed = runSetupCoreHandler({
    ownership,
    input: undefined,
    setupBehavior: () => ({ mode: "browser-only", stdout: "ok" }),
  });
  const result = await bed.handler({}, undefined);
  assert.equal(bed.seen.requestedMode, undefined);
  assert.equal(bed.seen.request.integrationMode, "external-provider");
  assert.equal(bed.updates[0].codexCatalogVerified, true);
  assert.equal(bed.updates[0].codexRestartRequired, false);
  assert.equal(result.restartRequired, false);
});

test("FINAL-A canonical config remains authority with CLI-only migration", () => {
  assert.match(electronMain, /resolveSetupOwnership\(extractRequestedIntegrationMode\(input\), "setup-core"\)/);
  const modeSource = fs.readFileSync(path.join(launcherRoot, "electron", "integration-mode.cjs"), "utf8");
  assert.match(modeSource, /ownership migration is CLI-only/);
});
function runReadyState({ integrationMode, bridgeRouteChanged, mode }) {
  const source = sliceMainFunction(
    "function completeStartupReadyState(",
    "async function recoverStartupRoute(",
  );
  const context = { DIRECT_INTEGRATION_MODE, EXTERNAL_INTEGRATION_MODE };
  vm.createContext(context);
  context.completeStartupReadyState = vm.runInContext(
    source + "\ncompleteStartupReadyState;",
    context,
  );
  const updated = [];
  const monitored = [];
  context.completeStartupReadyState({
    stateStore: { read: () => ({}), update: (patch) => { updated.push(patch); return patch; } },
    send: () => {},
    config: { mode, experimentalBiggerContext: false, experimentalSkillAttachments: false, zeroRiskProEnabled: false },
    bridgeRouteChanged,
    integrationMode,
    startMonitor: () => monitored.push(true),
  });
  return { updated, monitored };
}

test("FINAL-A healthy External startup is ready with no restart and no monitor", () => {
  const { updated, monitored } = runReadyState({
    integrationMode: "external-provider",
    bridgeRouteChanged: false,
    mode: "browser-only",
  });
  assert.equal(updated.length, 1);
  assert.equal(updated[0].coreSetupComplete, true);
  assert.equal(updated[0].codexCatalogVerified, true);
  assert.equal(updated[0].codexRestartRequired, false);
  assert.equal(monitored.length, 0);
});

test("FINAL-A failed External health never reaches ready publishing", async () => {
  const startSource = sliceMainFunction(
    "async function startConfiguredBridgeRuntime(",
    "function completeStartupReadyState(",
  );
  const context = {
    assertOwnershipExpectationCurrent: () => {},
    validateRuntimeOwnershipHealth: require("../electron/runtime-health.cjs").validateRuntimeOwnershipHealth,
    buildStartupRoutePolicy: require("../electron/startup-route-policy.cjs").buildStartupRoutePolicy,
  };
  vm.createContext(context);
  context.startConfiguredBridgeRuntime = vm.runInContext(
    startSource + "\nstartConfiguredBridgeRuntime;",
    context,
  );
  const directConfig = { mode: "browser-only", integrationMode: "direct" };
  const externalHealth = {
    status: "ok", integration_mode: "external-provider", routing_owner: "external-router",
    provider_base_url: "http://127.0.0.1:17841/v1",
  };
  const supervisor = {
    startIfConfigured: async () => ({ status: "ready" }),
    readConfig: () => directConfig,
    proxyHealthPayload: async () => externalHealth,
  };
  let readyPublished = false;
  await assert.rejects(context.startConfiguredBridgeRuntime({
    startupOwnership: { integrationMode: "direct", expectation: {} },
    runtimeHost: {},
    runtimeSupervisor: supervisor,
  }));
  assert.equal(readyPublished, false);
  const startAt = electronMain.indexOf("startConfiguredBridgeRuntime({");
  const readyAt = electronMain.indexOf("completeStartupReadyState({");
  assert.ok(startAt > 0 && readyAt > startAt);
});

test("FINAL-A Direct catalog-monitor semantics are unchanged", () => {
  const { updated, monitored } = runReadyState({
    integrationMode: "direct",
    bridgeRouteChanged: true,
    mode: "full",
  });
  assert.equal(updated[0].codexCatalogVerified, false);
  assert.equal(updated[0].codexRestartRequired, true);
  assert.equal(monitored.length, 1);
  const monitorSource = sliceMainFunction(
    "function startCatalogVerificationMonitor(",
    "async function restoreCodexRouteAfterRuntimeFailure(",
  );
  assert.match(monitorSource, /codexCatalogVerified: true,/);
  assert.match(monitorSource, /config\.integrationMode === "external-provider"/);
});
// FINAL-A 20: copy truthfulness across every locale.

test("FINAL-A selector labels and External helper text", () => {
  const { copyFor } = loadI18nModule();
  const en = copyFor("en");
  assert.equal(en.routingDirect, "Direct");
  assert.match(en.routingDirectBody, /Selected by default/);
  assert.equal(en.routingExternal, "External provider/router");
  assert.match(en.routingExternalBody, /manages only the ChatGPT Web bridge/);
  assert.match(en.routingExternalBody, /does not install, register, or configure/);
  assert.match(en.routingExternalBody, /release the route/);
  assert.match(en.routingExternalBody, /OpenCodex/);
  for (const language of ["zh-CN", "zh-TW", "ja", "ko"]) {
    const copy = copyFor(language);
    for (const key of ["routingTitle", "routingDirect", "routingDirectBody", "routingExternal", "routingExternalBody"]) {
      assert.ok(typeof copy[key] === "string" && copy[key].trim().length > 0, `${language}.${key}`);
    }
    assert.notEqual(copy.routingExternalBody, en.routingExternalBody);
  }
});

test("FINAL-A install and remove copy is truthful for both modes", () => {
  const { copyFor } = loadI18nModule();
  const olds = {
    "en": ["Any current custom route is saved and restored", "Restore the previous Codex model route", "Integration removed; restart Codex once"],
    "zh-CN": ["当前自定义路由会被保存", "恢复此前的 Codex 模型路由", "集成已移除；请重启一次 Codex"],
    "ja": ["現在のカスタムルートは保存され", "以前の Codex モデルルートを復元", "統合を削除しました。Codex を一度再起動してください"],
    "ko": ["현재 사용자 지정 경로가 있다면 저장되며", "이전 Codex 모델 경로를 복원", "통합이 제거되었습니다. Codex를 한 번 다시 시작하세요"],
    "zh-TW": ["目前的自訂路由會被儲存", "還原先前的 Codex 模型路由", "整合已移除；請重新啟動一次 Codex"],
  };
  for (const language of ["en", "zh-CN", "zh-TW", "ja", "ko"]) {
    const copy = copyFor(language);
    const haystack = [copy.stepInstallBody, copy.uninstallIntegrationBody, copy.integrationRemoved].join("\n");
    for (const old of olds[language]) assert.ok(!haystack.includes(old), `${language} still has: ${old}`);
    assert.ok(copy.stepInstallBody.includes("Direct") && copy.stepInstallBody.includes("external"));
    assert.ok(copy.uninstallIntegrationBody.includes("Direct"));
  }
  assert.match(copyFor("en").integrationRemoved, /only if/);
  assert.ok(!copyFor("en").mcpCatalogRequired.includes("restart Codex once"));
});

test("FINAL-A native Remove dialog is generic and truthful in every language", () => {
  const { NATIVE_COPY, nativeCopyFor } = loadNativeCopy();
  const oldMessages = {
    "en": ["restore the previous model route", "must be restarted once"],
    "zh-CN": ["恢复此前的模型路由", "需要重启一次"],
    "zh-TW": ["還原先前的模型路由", "需要重新啟動一次"],
    "ja": ["以前のモデルルートを復元", "再起動する必要があります"],
    "ko": ["이전 모델 경로를 복원", "다시 시작해야 합니다"],
  };
  const english = nativeCopyFor("en");
  assert.deepEqual(Object.keys(NATIVE_COPY).sort(), ["en", "ja", "ko", "zh-CN", "zh-TW"]);
  for (const language of Object.keys(NATIVE_COPY)) {
    const copy = nativeCopyFor(language);
    assert.deepEqual(Object.keys(copy).sort(), Object.keys(english).sort());
    const haystack = `${copy.removeMessage}\n${copy.removeDetail}`;
    for (const old of oldMessages[language]) assert.ok(!haystack.includes(old), `${language} still has: ${old}`);
    assert.ok(copy.removeDetail.includes("Direct"), `${language} must scope route restore to Direct`);
    assert.ok(/untouch|不变|不變|変更されません|유지됩니다/.test(copy.removeDetail), `${language} must leave routers untouched`);
    if (language !== "en") assert.notEqual(copy.removeMessage, english.removeMessage);
  }
  assert.match(english.removeDetail, /only if/);
});
// FINAL-A 21-22: no migration surface, no duplicate ownership authority.

test("FINAL-A exposes no ownership setter IPC", () => {
  assert.ok(!preloadSource.includes("integrationMode"), "preload passes setup input opaquely");
  assert.ok(!electronMain.includes("launcher:set-integration-mode"));
  assert.ok(!electronMain.includes("launcher:set-ownership"));
  assert.match(preloadSource, /setupCore: \(input\) => ipcRenderer\.invoke\("launcher:setup-core", input\)/);
});

test("FINAL-A persists no ownership into launcher-state.json", () => {
  assert.ok(!stateSource.includes("integrationMode"));
  for (const line of electronMain.split("\n")) {
    assert.ok(!(line.includes("stateStore.update") && line.includes("integrationMode")), `ownership in UI state: ${line.trim()}`);
  }
});

test("FINAL-A setup request integrationMode stays first-install intent only", () => {
  assert.match(electronMain, /setupCore\(\{ integrationMode: ownership\.integrationMode \}, ownership\.expectation/);
  assert.ok(!electronMain.includes("setupCore(input,"));
});

test("FINAL-A docs describe the ownership-aware Launcher lifecycle", () => {
  const providerDoc = fs.readFileSync(path.join(repositoryRoot, "docs", "opencodex-provider.md"), "utf8");
  assert.ok(!providerDoc.includes("has not yet been taught"));
  assert.match(providerDoc, /CLI-only/);
  assert.match(providerDoc, /owns only the/);
  const architectureDoc = fs.readFileSync(path.join(repositoryRoot, "docs", "architecture.md"), "utf8");
  assert.match(architectureDoc, /external-provider/);
  assert.match(architectureDoc, /lifecycle lock/);
  const validationDoc = fs.readFileSync(path.join(repositoryRoot, "docs", "release-validation.md"), "utf8");
  assert.match(validationDoc, /External/);
  assert.match(validationDoc, /migration is CLI-only/);
  const readme = fs.readFileSync(path.join(repositoryRoot, "README.md"), "utf8");
  assert.match(readme, /docs\/opencodex-provider\.md/);
});

// Canonical installation-state blocker matrix (behavioral). The picker gate
// and the setup/Remove refreshes are not re-stated here: the shipped renderer
// expressions are read out of App.tsx and executed, the classification comes
// from the real G1 reader, and the snapshot protocol runs through the real
// main.cjs handler. Every case keeps Launcher readiness coreSetupComplete=false,
// the value that used to open a false migration surface through
// `coreSetupComplete !== true`.

function extractBalancedBlock(source, openIndex) {
  let depth = 0;
  let quote = null;
  for (let index = openIndex; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      if (char === "\\") index += 1;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") { quote = char; continue; }
    if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(openIndex + 1, index);
    }
  }
  throw new Error("Unbalanced block while reading App.tsx");
}

// The shipped picker gate expression, executed against a snapshot fixture.
function rendererPickerGate() {
  const match = appSource.match(/const isNewInstall = ([^;]+);/);
  if (!match) throw new Error("App.tsx is missing the canonical isNewInstall gate");
  return Function("snapshot", `return (${match[1]});`);
}

// A shipped async renderer flow, executed against mocked props and a mocked
// preload API. TypeScript syntax is transpiled so the real body runs verbatim.
function loadRendererFlow({ marker, name, params }) {
  const ts = require("typescript");
  const start = appSource.indexOf(marker);
  if (start < 0) throw new Error(`App.tsx is missing ${name}`);
  const openIndex = start + marker.length - 1;
  assert.equal(appSource[openIndex], "{", `${name} marker must end with an opening brace`);
  const body = extractBalancedBlock(appSource, openIndex);
  const output = ts.transpileModule(
    `async function ${name}(${params}) {${body}}`,
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023 } },
  ).outputText;
  const loaded = { exports: {} };
  Function("module", "exports", "require", `${output}\nmodule.exports = ${name};`)(loaded, loaded.exports, require);
  return loaded.exports;
}

const RENDERER_INSTALL_MARKER = "const install = () => run(async () => {";
const RENDERER_REMOVE_MARKER = "const uninstallIntegration = async () => {";

// Real canonical fixture -> real classification -> real picker gate -> real
// install() request -> real snapshot refresh. setupCore writes the canonical
// config, so afterSetupConfig models the post-setup config the next snapshot
// must re-read.
async function rendererSetupRequest({ canonicalConfig, afterSetupConfig, routingChoice, devProfile = false }) {
  const holder = { value: canonicalConfig };
  const supervisor = { readSetupConfig: () => holder.value };
  const installationState = readIntegrationInstallationState(supervisor);
  const pickerVisible = rendererPickerGate()({
    integrationInstallationState: installationState,
    state: { coreSetupComplete: false },
  });
  const setupCalls = [];
  const refreshed = [];
  const api = {
    setupCore: async (...args) => {
      setupCalls.push(args);
      if (afterSetupConfig !== undefined) holder.value = afterSetupConfig;
    },
    snapshot: async () => {
      const fresh = readIntegrationInstallationState(supervisor);
      return {
        state: { coreSetupComplete: fresh !== "missing", browserSmokePassed: false },
        integrationInstallationState: fresh,
        version: "9.9.9",
      };
    },
  };
  const install = loadRendererFlow({
    marker: RENDERER_INSTALL_MARKER,
    name: "install",
    params: "devProfile, isNewInstall, routingChoice, api, updateState",
  });
  await install(devProfile, pickerVisible, routingChoice, api, (value) => refreshed.push(value));
  return { installationState, pickerVisible, setupCalls, refreshed };
}

// Real SettingsSurface removal flow, executed against a mocked API. The
// snapshot it requests reports the canonical state main would observe
// immediately after a successful Remove.
async function rendererRemoveRequest({ installationStateAfterRemove }) {
  const refreshed = [];
  const markers = [];
  let snapshotCalls = 0;
  const api = {
    uninstallIntegration: async () => ({ cancelled: false, state: { coreSetupComplete: false } }),
    snapshot: async () => {
      snapshotCalls += 1;
      return {
        state: { coreSetupComplete: false },
        integrationInstallationState: installationStateAfterRemove,
        version: "9.9.9",
      };
    },
  };
  const remove = loadRendererFlow({
    marker: RENDERER_REMOVE_MARKER,
    name: "uninstallIntegration",
    params: "api, updateState, setBusy, setError, setIntegrationRemoved",
  });
  await remove(
    api,
    (value) => refreshed.push(value),
    () => {},
    (message) => markers.push(message),
    () => markers.push("removed"),
  );
  return { snapshotCalls, refreshed, markers };
}

// The real launcher:snapshot handler, with the canonical reader wired to a
// mutable fixture so every call re-reads canonical state.
function loadSnapshotHandler(canonical) {
  const source = `${sliceMainFunction("function getIntegrationInstallationState(", 'handle("launcher:set-language",')}\n}\nregisterIpc;`;
  const handlers = {};
  const sandbox = {
    ipcMain: {},
    registerLoggedIpc: (_ipcMain, _logger, channel, handler) => { handlers[channel] = handler; },
    readIntegrationInstallationState,
    runtimeSupervisor: { readSetupConfig: () => canonical.value },
    runtimeHost: {
      supervisor: { readSetupConfig: () => canonical.value },
      browserConnectorName: () => "Codex",
      setupConnectorName: () => "Codex Zero Risk",
      mcpCredentialsConfigured: () => false,
    },
    browserHost: { snapshot: () => null },
    LAUNCHER_PROFILE: { kind: "production", codexHome: "C:/codex" },
    CORE_HOME: "C:/core",
    launcherUserData: "C:/user-data",
    GITHUB_URL: "https://github.com",
    X_URL: "https://x.com",
    CONNECTORS_URL: "https://connectors",
    TUNNELS_URL: "https://tunnels",
    KEYS_URL: "https://keys",
    process,
    app: { isPackaged: false, getVersion: () => "5.0.9" },
    updateController: { getState: () => ({ status: "disabled" }) },
    smokePassedThisSession: false,
    lastOperation: null,
  };
  const registerIpc = vm.runInNewContext(source, sandbox);
  registerIpc({
    logger: { recent: () => [] },
    stateStore: { read: () => ({ version: 1, language: null }) },
  });
  return handlers["launcher:snapshot"];
}

test("genuinely new install classifies missing and offers Direct by default", async () => {
  const direct = await rendererSetupRequest({ canonicalConfig: null, routingChoice: "direct" });
  assert.equal(direct.installationState, "missing");
  assert.equal(direct.pickerVisible, true);
  assert.deepEqual(direct.setupCalls, [[{ integrationMode: "direct" }]]);
  const external = await rendererSetupRequest({ canonicalConfig: null, routingChoice: "external-provider" });
  assert.equal(external.pickerVisible, true);
  assert.deepEqual(external.setupCalls, [[{ integrationMode: "external-provider" }]]);
});

test("the picker gate reads canonical state only, never readiness bookkeeping", () => {
  const gate = rendererPickerGate();
  // The old gate (coreSetupComplete !== true) showed the picker in every
  // configured case below, which is exactly the false migration surface.
  assert.equal(gate({ integrationInstallationState: "missing", state: { coreSetupComplete: false } }), true);
  assert.equal(gate({ integrationInstallationState: "missing", state: { coreSetupComplete: true } }), true);
  assert.equal(gate({ integrationInstallationState: "configured", state: { coreSetupComplete: false } }), false);
  assert.equal(gate({ integrationInstallationState: "configured", state: { coreSetupComplete: true } }), false);
  assert.equal(gate({ integrationInstallationState: "damaged", state: { coreSetupComplete: false } }), false);
  assert.equal(gate({ integrationInstallationState: "damaged", state: { coreSetupComplete: true } }), false);
});

test("configured Direct with false readiness hides the picker and reinstalls with no mode", async () => {
  const result = await rendererSetupRequest({
    canonicalConfig: { mode: "full", integrationMode: "direct" },
    routingChoice: "external-provider",
  });
  assert.equal(result.installationState, "configured");
  assert.equal(result.pickerVisible, false);
  assert.deepEqual(result.setupCalls, [[]]);
});

test("configured External with false readiness hides the picker and reinstalls with no mode", async () => {
  const result = await rendererSetupRequest({
    canonicalConfig: { mode: "full", integrationMode: "external-provider" },
    routingChoice: "direct",
  });
  assert.equal(result.installationState, "configured");
  assert.equal(result.pickerVisible, false);
  assert.deepEqual(result.setupCalls, [[]]);
});

test("CLI-created installs with absent Launcher state classify configured and hide the picker", async () => {
  const fixtures = [
    ["External", { mode: "browser-only", integrationMode: "external-provider" }],
    ["Direct", { mode: "full", integrationMode: "direct" }],
    ["legacy alias External", { mode: "full", codexIntegrationMode: "external-provider" }],
    ["implicit Direct", { mode: "full" }],
  ];
  for (const [label, canonicalConfig] of fixtures) {
    const result = await rendererSetupRequest({ canonicalConfig, routingChoice: "external-provider" });
    assert.equal(result.installationState, "configured", label);
    assert.equal(result.pickerVisible, false, label);
    assert.deepEqual(result.setupCalls, [[]], label);
  }
});

test("failure and reset style readiness never reopens first-install ownership intent", async () => {
  const canonicalConfig = { mode: "full", integrationMode: "direct" };
  const supervisor = { readSetupConfig: () => canonicalConfig };
  const readinessStates = [
    { coreSetupComplete: false },
    { coreSetupComplete: false, codexCatalogVerified: false, codexRestartRequired: true },
    {
      coreSetupComplete: false,
      mcpSetupComplete: false,
      mcpRuntimeInstalled: false,
      browserInteractionMode: "automatic",
    },
  ];
  for (const state of readinessStates) {
    const installationState = readIntegrationInstallationState(supervisor);
    assert.equal(installationState, "configured");
    assert.equal(rendererPickerGate()({ integrationInstallationState: installationState, state }), false);
  }
});

test("DEV profile never sends first-install ownership intent", async () => {
  const result = await rendererSetupRequest({
    canonicalConfig: null,
    routingChoice: "external-provider",
    devProfile: true,
  });
  assert.equal(result.installationState, "missing");
  assert.deepEqual(result.setupCalls, [[]]);
});

test("damaged canonical config hides the picker and sends no mode intent", async () => {
  const damagedFixtures = [{ integrationMode: "opencodex" }, { integrationMode: 5 }, [], "not-an-object"];
  for (const canonicalConfig of damagedFixtures) {
    const result = await rendererSetupRequest({ canonicalConfig, routingChoice: "direct" });
    assert.equal(result.installationState, "damaged", JSON.stringify(canonicalConfig));
    assert.equal(result.pickerVisible, false, JSON.stringify(canonicalConfig));
    assert.deepEqual(result.setupCalls, [[]], JSON.stringify(canonicalConfig));
  }
  const unreadable = { readSetupConfig: () => { throw new Error("Unexpected token u in JSON at position 0"); } };
  assert.equal(readIntegrationInstallationState(unreadable), "damaged");
  const undefinedReader = { readSetupConfig: () => undefined };
  assert.equal(readIntegrationInstallationState(undefinedReader), "damaged");
});

test("unexpected supervisor misuse throws instead of looking damaged", () => {
  assert.throws(() => readIntegrationInstallationState(null), /no configuration reader/);
  assert.throws(() => readIntegrationInstallationState({}), /no configuration reader/);
});

test("setup success refreshes the renderer to configured without a restart", async () => {
  const result = await rendererSetupRequest({
    canonicalConfig: null,
    afterSetupConfig: { mode: "browser-only", integrationMode: "external-provider" },
    routingChoice: "external-provider",
  });
  assert.equal(result.installationState, "missing");
  assert.deepEqual(result.setupCalls, [[{ integrationMode: "external-provider" }]]);
  assert.equal(result.refreshed.length, 1, "setup must refresh through a full snapshot");
  assert.equal(result.refreshed[0].integrationInstallationState, "configured");
  assert.equal(rendererPickerGate()({
    integrationInstallationState: result.refreshed[0].integrationInstallationState,
    state: result.refreshed[0].state,
  }), false);
});

test("Remove success refreshes the renderer to missing so intent may legitimately return", async () => {
  const removed = await rendererRemoveRequest({ installationStateAfterRemove: "missing" });
  assert.equal(removed.snapshotCalls, 1, "Remove must re-read canonical state");
  assert.equal(removed.refreshed.length, 1, "Remove must refresh through a full snapshot");
  assert.equal(removed.refreshed[0].integrationInstallationState, "missing");
  assert.ok(removed.markers.includes("removed"));
  assert.equal(rendererPickerGate()({
    integrationInstallationState: removed.refreshed[0].integrationInstallationState,
    state: removed.refreshed[0].state,
  }), true);
});

test("Remove that leaves damaged canonical config refreshes to damaged with no intent", async () => {
  const removed = await rendererRemoveRequest({ installationStateAfterRemove: "damaged" });
  assert.equal(removed.refreshed.length, 1);
  assert.equal(removed.refreshed[0].integrationInstallationState, "damaged");
  assert.equal(rendererPickerGate()({
    integrationInstallationState: removed.refreshed[0].integrationInstallationState,
    state: removed.refreshed[0].state,
  }), false);
});

test("initial snapshot carries canonical installation state and re-reads it per call", async () => {
  const canonical = { value: null };
  const snapshot = loadSnapshotHandler(canonical);
  const first = await snapshot();
  assert.ok(Object.prototype.hasOwnProperty.call(first, "integrationInstallationState"));
  assert.equal(first.integrationInstallationState, "missing");
  assert.equal(first.state.version, 1);
  assert.ok(!("integrationMode" in first), "routing mode is never exposed to the renderer");
  canonical.value = { mode: "full", integrationMode: "direct" };
  assert.equal((await snapshot()).integrationInstallationState, "configured");
  canonical.value = { mode: "full", integrationMode: "external-provider" };
  assert.equal((await snapshot()).integrationInstallationState, "configured");
  canonical.value = { integrationMode: "opencodex" };
  assert.equal((await snapshot()).integrationInstallationState, "damaged");
  canonical.value = null;
  assert.equal((await snapshot()).integrationInstallationState, "missing");
});
