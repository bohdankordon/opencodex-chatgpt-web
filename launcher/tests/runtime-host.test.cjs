const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { CURRENT_CONNECTOR_NAME, DEV_CONNECTOR_NAME } = require("../electron/connector-identity.cjs");
const { RuntimeHost } = require("../electron/runtime.cjs");
const { buildSetupOwnershipPolicy } = require("../electron/setup-policy.cjs");

// Direct-integration transaction policy for tests that drive runSetup
// directly. Production callers build this from their validated ownership
// context; these fixtures pin the pre-G2 Direct scenarios explicitly.
function directTransactionPolicy(operation, profile) {
  return buildSetupOwnershipPolicy({ integrationMode: "direct", operation, profile: profile || "production" });
}

function hostFor(existingConfig, interactionMode = "automatic") {
  const host = new RuntimeHost({
    app: {
      getPath: () => path.join(os.tmpdir(), "codex-web-gpt-runtime-host-test"),
      getVersion: () => "1.1.3",
    },
    logger: { info() {}, warn() {}, error() {} },
    sourceRoot: "/source",
    browserDescriptorPath: "/runtime/launcher-browser.json",
    supervisor: {
      readConfig: () => existingConfig,
      readSetupConfig: () => existingConfig,
      stopForSetup: async () => ({ status: "stopped" }),
      startIfConfigured: async () => ({ status: "ready" }),
    },
    getBrowserInteractionMode: () => interactionMode,
  });
  let invocation;
  host.runSetup = async (name, args, options = {}) => {
    invocation = { name, args };
    await options.afterRuntimeReady?.();
    return { code: 0, stdout: "", stderr: "" };
  };
  return { host, invocation: () => invocation };
}

function devHostFor(existingConfig, interactionMode = "automatic") {
  const host = new RuntimeHost({
    app: {
      getPath: () => path.join(os.tmpdir(), "codex-web-gpt-dev-runtime-host-test"),
      getVersion: () => "1.1.3",
    },
    logger: { info() {}, warn() {}, error() {} },
    sourceRoot: "/source",
    browserDescriptorPath: "/dev/runtime/launcher-browser.json",
    coreHome: "/dev",
    launcherProfile: "development",
    supervisor: {
      readConfig: () => existingConfig,
      readSetupConfig: () => existingConfig,
      stopForSetup: async () => ({ status: "stopped" }),
      startIfConfigured: async () => ({ status: "ready" }),
    },
    getBrowserInteractionMode: () => interactionMode,
  });
  let invocation;
  host.runDevSetup = async (name, args, options = {}) => {
    invocation = { name, args };
    await options.afterRuntimeReady?.();
    return { code: 0, stdout: "", stderr: "" };
  };
  return { host, invocation: () => invocation };
}

test("core setup preserves an existing full-harness installation", async () => {
  const fixture = hostFor({ mode: "full", appName: "Codex Native2" });
  const result = await fixture.host.setupCore();
  assert.equal(result.mode, "full");
  assert.deepEqual(fixture.invocation().args, [
    "setup",
    "--full",
    "--browser-host-descriptor",
    "/runtime/launcher-browser.json",
    "--automatic-browser-interaction",
    "--refresh-account-capabilities",
    "--integration-mode",
    "direct",
    "--replace-codex-route",
    "--acknowledge-unofficial",
    "--restart-service",
  ]);
});

test("core setup replaces the known legacy connector identity with the direct-turn identity", async () => {
  const fixture = hostFor({ mode: "full", appName: "Codex Native" });
  await fixture.host.setupCore();
  assert.equal(fixture.invocation().args.includes("--app-name"), false);
  assert.equal(fixture.host.setupConnectorName(), CURRENT_CONNECTOR_NAME);
});

test("core setup starts in browser-only mode when no installation exists", async () => {
  const fixture = hostFor(null);
  const result = await fixture.host.setupCore();
  assert.equal(result.mode, "browser-only");
  assert.deepEqual(fixture.invocation().args.slice(0, 2), ["setup", "--browser-only"]);
  assert.equal(fixture.invocation().args.includes("--refresh-account-capabilities"), true);
  assert.equal(fixture.invocation().args.includes("--replace-codex-route"), true);
  assert.equal(fixture.invocation().args.includes("--chrome"), false);
});

test("core setup refuses an implicit Automatic fallback for a new Zero Risk installation", async () => {
  const fixture = hostFor(null, "manual");
  await assert.rejects(
    fixture.host.setupCore(),
    /Zero Risk must be installed through MCP setup because tunnel credentials are required/,
  );
  assert.equal(fixture.invocation(), undefined);
});

test("Zero Risk can be enabled only from an installed Full harness", async () => {
  await assert.rejects(
    hostFor(null).host.setBrowserInteractionMode("manual"),
    /Install the Codex integration/,
  );
  await assert.rejects(
    hostFor({ mode: "browser-only", browserHost: "launcher" }).host.setBrowserInteractionMode("manual"),
    /Connect the Full MCP harness/,
  );
});

test("browser interaction mode changes reuse the transactional setup and refresh only automatic capabilities", async () => {
  const config = {
    mode: "full",
    browserHost: "launcher",
    appName: "Codex Native2",
    experimentalBiggerContext: true,
  };
  const manual = hostFor(config);
  const manualResult = await manual.host.setBrowserInteractionMode("manual");
  assert.equal(manualResult.mode, "manual");
  assert.equal(manual.invocation().args.includes("--zero-risk-browser-interaction"), true);
  assert.equal(manual.invocation().args.includes("--refresh-account-capabilities"), false);
  assert.equal(manual.invocation().args.includes("--standard-context"), true);

  const automatic = hostFor(config);
  const automaticResult = await automatic.host.setBrowserInteractionMode("automatic");
  assert.equal(automaticResult.mode, "automatic");
  assert.equal(automatic.invocation().args.includes("--automatic-browser-interaction"), true);
  assert.equal(automatic.invocation().args.includes("--refresh-account-capabilities"), true);
  assert.equal(automatic.invocation().args.includes("--bigger-context"), true);
});

test("switching back from Zero Risk preserves the saved automatic connector identity", async () => {
  const fixture = hostFor({
    mode: "full",
    browserHost: "launcher",
    appName: "Codex Zero Risk",
    automaticAppName: "Codex Native2",
    browserInteractionMode: "manual",
  }, "manual");
  await fixture.host.setBrowserInteractionMode("automatic");
  const args = fixture.invocation().args;
  assert.equal(args.includes("--app-name"), false);
  assert.equal(fixture.host.setupConnectorName(), CURRENT_CONNECTOR_NAME);
  assert.equal(args.includes("Codex Zero Risk"), false);
});

test("DEV core setup configures only the isolated harness contract", async () => {
  const fixture = devHostFor(null);
  const result = await fixture.host.setupDevCore();
  assert.equal(result.mode, "browser-only");
  assert.deepEqual(fixture.invocation(), {
    name: "dev-profile-setup",
    args: [
      "dev",
      "setup",
      "--browser-only",
      "--browser-host-descriptor",
      "/dev/runtime/launcher-browser.json",
      "--automatic-browser-interaction",
      "--refresh-account-capabilities",
      "--acknowledge-unofficial",
    ],
  });
  assert.equal(fixture.invocation().args.includes("--replace-codex-route"), false);
  assert.equal(fixture.invocation().args.includes("--restart-service"), false);
});

test("Bigger Context uses the setup transaction and refreshes the production Codex catalog", async () => {
  const fixture = hostFor({ mode: "full", appName: "Codex Native2" });
  const result = await fixture.host.setBiggerContext(true);
  assert.equal(result.enabled, true);
  assert.deepEqual(fixture.invocation(), {
    name: "bigger-context",
    args: [
      "setup",
      "--full",
      "--browser-host-descriptor",
      "/runtime/launcher-browser.json",
      "--automatic-browser-interaction",
      "--integration-mode",
      "direct",
      "--replace-codex-route",
      "--acknowledge-unofficial",
      "--restart-service",
      "--bigger-context",
    ],
  });
});

test("Bigger Context updates the isolated DEV config without installing a Codex route", async () => {
  const fixture = devHostFor({ mode: "browser-only" });
  const result = await fixture.host.setBiggerContext(false);
  assert.equal(result.enabled, false);
  assert.deepEqual(fixture.invocation(), {
    name: "bigger-context",
    args: [
      "dev",
      "setup",
      "--browser-only",
      "--browser-host-descriptor",
      "/dev/runtime/launcher-browser.json",
      "--automatic-browser-interaction",
      "--acknowledge-unofficial",
      "--standard-context",
    ],
  });
});

test("Zero Risk Pro transaction installs or removes only its explicit model profile", async () => {
  const config = {
    mode: "full",
    browserHost: "launcher",
    browserInteractionMode: "manual",
    appName: "Codex Zero Risk",
    automaticAppName: "Codex Native2",
  };
  const enabled = hostFor(config, "manual");
  const result = await enabled.host.setZeroRiskPro(true);
  assert.equal(result.enabled, true);
  assert.deepEqual(enabled.invocation(), {
    name: "zero-risk-pro",
    args: [
      "setup",
      "--full",
      "--browser-host-descriptor",
      "/runtime/launcher-browser.json",
      "--zero-risk-browser-interaction",
      "--acknowledge-unofficial",
      "--standard-context",
      "--zero-risk-pro",
      "--integration-mode",
      "direct",
      "--replace-codex-route",
      "--restart-service",
    ],
  });

  const disabled = hostFor(config, "manual");
  await disabled.host.setZeroRiskPro(false);
  assert.equal(disabled.invocation().args.includes("--zero-risk-default"), true);
  await assert.rejects(
    hostFor({ ...config, browserInteractionMode: "automatic" }).host.setZeroRiskPro(true),
    /only while the Full Zero Risk harness is active/,
  );
});

test("DEV setup child environment removes launcher-rebound production aliases", async () => {
  const fixture = devHostFor(null);
  assert.deepEqual(fixture.host.devSetupEnvironment({
    KEEP_ME: "yes",
    CODEX_CHATGPT_WEB_HOME: "/dev",
    CODEX_HOME: "/dev/codex-home",
    CODEX_WEB_GPT_DEV_HOME: "/stale-dev",
    CODEX_WEB_GPT_LAUNCHER_DATA_DIR: "/dev/launcher",
  }), {
    KEEP_ME: "yes",
    CODEX_WEB_GPT_DEV_HOME: path.resolve("/dev"),
  });

  let runOptions;
  fixture.host.captureSetupCheckpoint = () => [];
  fixture.host.devSetupEnvironment = () => ({ ISOLATED_DEV_ENV: "yes" });
  fixture.host.run = async (_name, _args, options) => {
    runOptions = options;
    return { code: 0, stdout: "", stderr: "" };
  };

  await RuntimeHost.prototype.runDevSetup.call(fixture.host, "dev-environment-test", [], {
    ownershipPolicy: directTransactionPolicy("setup-core", "development"),
  });
  assert.equal(runOptions.embedded, true);
  assert.deepEqual(runOptions.environment, { ISOLATED_DEV_ENV: "yes" });
});

test("DEV MCP setup reuses only DEV-home credentials and targets its distinct connector", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-dev-mcp-host-"));
  const runtimeKeyFile = path.join(root, "runtime.key");
  fs.writeFileSync(runtimeKeyFile, "private key\n", { mode: 0o600 });
  const fixture = devHostFor({
    purpose: "dev-harness",
    mode: "full",
    browserHost: "launcher",
    appName: "Codex Native2",
    tunnel: {
      tunnelId: "tunnel_0123456789abcdef0123456789abcdef",
      runtimeKeyFile,
    },
  });
  try {
    await fixture.host.setupDevMcp();
    assert.deepEqual(fixture.invocation(), {
      name: "dev-mcp-setup",
      args: [
        "dev",
        "setup",
        "--full",
        "--browser-host-descriptor",
        "/dev/runtime/launcher-browser.json",
        "--automatic-browser-interaction",
        "--acknowledge-unofficial",
      ],
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("DEV doctor requires live tunnel readiness without probing a Responses listener", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-dev-doctor-"));
  const runtimeKeyFile = path.join(root, "runtime.key");
  fs.writeFileSync(runtimeKeyFile, "private key\n", { mode: 0o600 });
  const fixture = devHostFor({
    purpose: "dev-harness",
    mode: "full",
    appName: "Codex Native2 DEV",
    tunnel: { runtimeKeyFile },
  });
  fixture.host.supervisor.readTunnelHealth = async () => ({
    ready: true,
    detail: "ready",
  });
  try {
    const report = await fixture.host.devDoctor();
    assert.equal(report.ok, true);
    assert.deepEqual(report.checks.map(check => [check.id, check.status]), [
      ["dev-profile", "ok"],
      ["dev-tunnel-credentials", "ok"],
      ["dev-tunnel-runtime", "ok"],
      ["responses-listener", "ok"],
    ]);
    assert.match(report.checks.at(-1).message, /never starts a Responses listener/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("production doctor parses its structured unhealthy report from exit status one", async () => {
  const fixture = hostFor(null);
  let runOptions;
  fixture.host.run = async (_name, _args, options) => {
    runOptions = options;
    return {
      code: 1,
      stdout: JSON.stringify({
        ok: false,
        mode: "full",
        checks: [{ id: "browser-host", status: "error", message: "busy" }],
      }),
      stderr: "",
    };
  };

  const report = await fixture.host.doctor();

  assert.equal(report.ok, false);
  assert.equal(report.checks[0].message, "busy");
  assert.deepEqual(runOptions.acceptedExitCodes, [0, 1]);
});

test("production and DEV setup entrypoints reject the opposite launcher profile", async () => {
  await assert.rejects(hostFor(null).host.setupDevCore(), /isolated DEV launcher/);
  await assert.rejects(devHostFor(null).host.setupCore(), /unavailable in the isolated DEV launcher profile/);
});

test("launcher update transaction upgrades its owned full runtime with saved configuration", async () => {
  const fixture = hostFor({
    mode: "full",
    browserHost: "launcher",
    appName: "Codex Native2",
    releaseVersion: "1.1.1",
    solAvailable: true,
    extraHighAvailable: false, proAvailable: false,
  });
  fixture.host.bridgeStatus = async () => ({ installed: true, active: true, errors: [] });

  const result = await fixture.host.upgradeManagedRuntime();

  assert.deepEqual(fixture.invocation().args, [
    "setup",
    "--full",
    "--browser-host-descriptor",
    "/runtime/launcher-browser.json",
    "--automatic-browser-interaction",
    "--refresh-account-capabilities",
    "--integration-mode",
    "direct",
    "--acknowledge-unofficial",
    "--restart-service",
  ]);
  assert.deepEqual(result, {
    updated: true,
    mode: "full",
    fromVersion: "1.1.1",
    toVersion: "1.1.3",
    connectorMigrated: false,
    stdout: "",
  });
});

test("launcher migrates the legacy connector identity even when the release version is unchanged", async () => {
  const fixture = hostFor({
    mode: "full",
    browserHost: "launcher",
    appName: "Codex Native",
    releaseVersion: "1.1.3",
  });
  fixture.host.bridgeStatus = async () => ({ installed: true, active: true, errors: [] });

  const result = await fixture.host.upgradeManagedRuntime();

  assert.deepEqual(fixture.invocation().args, [
    "setup",
    "--full",
    "--browser-host-descriptor",
    "/runtime/launcher-browser.json",
    "--automatic-browser-interaction",
    "--refresh-account-capabilities",
    "--integration-mode",
    "direct",
    "--acknowledge-unofficial",
    "--restart-service",
  ]);
  assert.equal(result.updated, true);
  assert.equal(result.connectorMigrated, true);
  assert.equal(result.fromVersion, result.toVersion);
});

test("launcher update transaction does not preserve a stale disconnected route preference", async () => {
  const fixture = hostFor({
    mode: "browser-only",
    browserHost: "launcher",
    releaseVersion: "1.1.1",
  });

  const result = await fixture.host.upgradeManagedRuntime();

  assert.equal(result.updated, true);
  assert.equal("bridgeEnabled" in result, false);
  assert.equal(fixture.invocation().args.includes("disconnect"), false);
  assert.equal(fixture.invocation().args.includes("--refresh-account-capabilities"), true);
});

test("launcher update preserves Zero Risk and never probes its account capabilities", async () => {
  const fixture = hostFor({
    mode: "full",
    browserHost: "launcher",
    browserInteractionMode: "manual",
    appName: "Codex Zero Risk",
    releaseVersion: "1.1.1",
  });

  assert.equal((await fixture.host.upgradeManagedRuntime()).updated, true);
  assert.equal(fixture.invocation().args.includes("--zero-risk-browser-interaction"), true);
  assert.equal(fixture.invocation().args.includes("--automatic-browser-interaction"), false);
  assert.equal(fixture.invocation().args.includes("--refresh-account-capabilities"), false);
});

test("launcher update transaction leaves current and externally owned runtimes unchanged", async () => {
  const current = hostFor({ mode: "browser-only", browserHost: "launcher", releaseVersion: "1.1.3" });
  const currentFull = hostFor({
    mode: "full",
    browserHost: "launcher",
    appName: "Codex Native2",
    releaseVersion: "1.1.3",
  });
  const external = hostFor({ mode: "browser-only", browserHost: "managed-chrome", releaseVersion: "1.1.1" });

  assert.deepEqual(await current.host.upgradeManagedRuntime(), { updated: false });
  assert.deepEqual(await currentFull.host.upgradeManagedRuntime(), { updated: false });
  assert.deepEqual(await external.host.upgradeManagedRuntime(), { updated: false });
  assert.equal(current.invocation(), undefined);
  assert.equal(currentFull.invocation(), undefined);
  assert.equal(external.invocation(), undefined);
});

test("MCP setup reuses valid private credentials without exposing or rewriting them", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-saved-mcp-"));
  const keyPath = path.join(root, "tunnel-runtime.key");
  fs.writeFileSync(keyPath, "saved-private-runtime-key\n", { mode: 0o600 });
  const fixture = hostFor({
    mode: "full",
    appName: "Codex Native2",
    tunnel: {
      tunnelId: "tunnel_0123456789abcdef0123456789abcdef",
      runtimeKeyFile: keyPath,
    },
  });
  try {
    assert.equal(fixture.host.mcpCredentialsConfigured(), true);
    await fixture.host.setupMcp({ replace: false });
    assert.deepEqual(fixture.invocation().args, [
      "setup",
      "--full",
      "--browser-host-descriptor",
      "/runtime/launcher-browser.json",
      "--automatic-browser-interaction",
      "--integration-mode",
      "direct",
      "--replace-codex-route",
      "--acknowledge-unofficial",
      "--restart-service",
    ]);
    assert.equal(fixture.invocation().args.includes("--refresh-account-capabilities"), false);
    assert.equal(fixture.invocation().args.includes("--replace-codex-route"), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("new MCP setup uses the fixed connector without a CLI name override", async () => {
  const fixture = hostFor(null);
  await fixture.host.setupMcp({
    replace: true,
    tunnelId: "tunnel_0123456789abcdef0123456789abcdef",
    runtimeKey: "new-private-runtime-key",
  });

  assert.deepEqual(fixture.invocation().args.slice(0, 5), [
    "setup",
    "--full",
    "--browser-host-descriptor",
    "/runtime/launcher-browser.json",
    "--automatic-browser-interaction",
  ]);
  assert.equal(fixture.invocation().args.includes("--app-name"), false);
  assert.equal(fixture.host.setupConnectorName(), CURRENT_CONNECTOR_NAME);
});

test("MCP credential replacement remains explicit and requires a complete new pair", async () => {
  const fixture = hostFor(null);
  await assert.rejects(
    Promise.resolve().then(() => fixture.host.setupMcp({ replace: true })),
    /Tunnel ID must be/,
  );
  await assert.rejects(
    Promise.resolve().then(() => fixture.host.setupMcp({
      replace: true,
      tunnelId: "tunnel_0123456789abcdef0123456789abcdef",
    })),
    /runtime key is required/,
  );
});

test("mutating launcher operations are serialized before lifecycle changes begin", async () => {
  const fixture = hostFor(null);
  fixture.host.lifecycleOperation = "mcp-setup";
  await assert.rejects(fixture.host.setupCore(), /Another launcher operation is active: mcp-setup/);
  assert.equal(fixture.invocation(), undefined);
});

function bridgeFixture({ active }) {
  const calls = [];
  let routeActive = active;
  const supervisor = {
    readConfig: () => ({ mode: "browser-only" }),
    readSetupConfig: () => ({ mode: "browser-only" }),
    startIfConfigured: async () => {
      calls.push("runtime:start");
      return { status: "ready" };
    },
    stopForSetup: async () => {
      calls.push("runtime:stop");
      return { status: "stopped" };
    },
  };
  const host = new RuntimeHost({
    app: { getPath: () => path.join(os.tmpdir(), "codex-web-gpt-bridge-test") },
    logger: { info() {}, warn() {}, error() {} },
    sourceRoot: "/source",
    browserDescriptorPath: "/runtime/launcher-browser.json",
    supervisor,
  });
  host.run = async (_name, args) => {
    const action = args.join(" ");
    calls.push(action);
    if (action === "route status") {
      return { stdout: JSON.stringify({ installed: true, active: routeActive, errors: [] }) };
    }
    if (action === "route connect") {
      routeActive = true;
      return { stdout: JSON.stringify({ changed: true, active: true }) };
    }
    if (action === "route disconnect") {
      routeActive = false;
      return { stdout: JSON.stringify({ changed: true, active: false }) };
    }
    throw new Error(`Unexpected command: ${action}`);
  };
  return { calls, host, supervisor };
}

test("launcher connects an inactive installed route", async () => {
  const fixture = bridgeFixture({ active: false });
  const result = await fixture.host.connectBridgeRoute();
  assert.equal(result.active, true);
  assert.deepEqual(fixture.calls, ["route status", "route connect", "route status"]);
});

test("launcher leaves an already connected route unchanged", async () => {
  const fixture = bridgeFixture({ active: true });
  const result = await fixture.host.connectBridgeRoute();
  assert.equal(result.active, true);
  assert.deepEqual(fixture.calls, ["route status"]);
});

test("bridge connection rejects a route command that did not reach the requested state", async () => {
  const fixture = bridgeFixture({ active: false });
  fixture.host.run = async (_name, args) => {
    const action = args.join(" ");
    fixture.calls.push(action);
    if (action === "route status") {
      return { stdout: JSON.stringify({ installed: true, active: false, errors: [] }) };
    }
    return { stdout: JSON.stringify({ changed: false, active: false }) };
  };
  await assert.rejects(fixture.host.connectBridgeRoute(), /remained disconnected/);
  assert.deepEqual(fixture.calls, ["route status", "route connect", "runtime:stop"]);
});

test("startup recovery can restore the Codex route without requiring a healthy local runtime", async () => {
  const fixture = bridgeFixture({ active: true });
  const result = await fixture.host.restoreBridgeRoute("runtime-start-fail-safe");
  assert.equal(result.active, false);
  assert.deepEqual(fixture.calls, ["route status", "route disconnect", "route status"]);
});

test("failed runtime cleanup during removal still restores the previous Codex route", async () => {
  const calls = [];
  const config = { mode: "full", browserHost: "launcher", releaseVersion: "1.1.2" };
  const host = new RuntimeHost({
    app: { getPath: () => path.join(os.tmpdir(), "codex-web-gpt-uninstall-fail-safe") },
    logger: { info() {}, warn() {}, error() {} },
    sourceRoot: "/source",
    browserDescriptorPath: "/runtime/launcher-browser.json",
    supervisor: {
      readConfig: () => config,
      readSetupConfig: () => config,
      stopForSetup: async () => {
        calls.push("runtime:stop");
        throw new Error("Tunnel health probe timed out after 5000ms");
      },
    },
  });
  let routeActive = true;
  host.run = async (_name, args) => {
    const action = args.join(" ");
    calls.push(action);
    if (action === "route status") {
      return { stdout: JSON.stringify({ installed: true, active: routeActive, errors: [] }) };
    }
    if (action === "route disconnect") {
      routeActive = false;
      return { stdout: JSON.stringify({ changed: true, active: false }) };
    }
    throw new Error(`Unexpected command: ${action}`);
  };

  await assert.rejects(
    host.uninstallIntegration(),
    /previous Codex route was restored, but launcher runtime cleanup did not complete/,
  );
  assert.deepEqual(calls, ["runtime:stop", "route status", "route disconnect", "route status"]);
});

test("integration removal is accepted only after a new status process observes it absent", async () => {
  const calls = [];
  const config = { mode: "browser-only", browserHost: "launcher", releaseVersion: "2.1.8" };
  const host = new RuntimeHost({
    app: { getPath: () => path.join(os.tmpdir(), "codex-web-gpt-uninstall-success") },
    logger: { info() {}, warn() {}, error() {} },
    sourceRoot: "/source",
    browserDescriptorPath: "/runtime/launcher-browser.json",
    supervisor: {
      readConfig: () => config,
      readSetupConfig: () => config,
      stopForSetup: async () => { calls.push("runtime:stop"); },
    },
  });
  host.launcherControlEnvironment = () => ({ CODEX_WEB_GPT_LAUNCHER_CONTROL_TOKEN: "test-token" });
  host.run = async (_name, args) => {
    const action = args.join(" ");
    calls.push(action);
    if (action === "uninstall --yes --launcher-control") {
      return { stdout: "uninstalled\n" };
    }
    if (action === "route status") {
      return { stdout: JSON.stringify({ installed: false, active: false, errors: [] }) };
    }
    throw new Error(`Unexpected command: ${action}`);
  };

  await host.uninstallIntegration();
  assert.deepEqual(calls, [
    "runtime:stop",
    "uninstall --yes --launcher-control",
    "route status",
  ]);
});

test("integration removal rejects a command that leaves an inactive journal behind", async () => {
  const calls = [];
  const config = { mode: "browser-only", browserHost: "launcher", releaseVersion: "2.1.8" };
  const host = new RuntimeHost({
    app: { getPath: () => path.join(os.tmpdir(), "codex-web-gpt-uninstall-stale") },
    logger: { info() {}, warn() {}, error() {} },
    sourceRoot: "/source",
    browserDescriptorPath: "/runtime/launcher-browser.json",
    supervisor: {
      readConfig: () => config,
      readSetupConfig: () => config,
      stopForSetup: async () => { calls.push("runtime:stop"); },
    },
  });
  host.launcherControlEnvironment = () => ({ CODEX_WEB_GPT_LAUNCHER_CONTROL_TOKEN: "test-token" });
  host.run = async (_name, args) => {
    const action = args.join(" ");
    calls.push(action);
    if (action === "uninstall --yes --launcher-control") {
      return { stdout: "uninstalled\n" };
    }
    if (action === "route status") {
      return { stdout: JSON.stringify({ installed: true, active: false, errors: [] }) };
    }
    throw new Error(`Unexpected command: ${action}`);
  };

  await assert.rejects(
    host.uninstallIntegration(),
    /integration removal did not persist in the active config/,
  );
  assert.deepEqual(calls, [
    "runtime:stop",
    "uninstall --yes --launcher-control",
    "route status",
    "route status",
  ]);
});

test("connector verification uses the current identity and rejects a legacy local runtime", () => {
  const full = hostFor({ mode: "full", appName: "Codex Native2" });
  assert.equal(full.host.mcpConnectorName(), "Codex Native2");
  assert.equal(full.host.browserConnectorName(), "Codex Native2");
  const defaultName = hostFor(null);
  assert.equal(defaultName.host.browserConnectorName(), CURRENT_CONNECTOR_NAME);
  const legacyFull = hostFor({ mode: "full", appName: "Codex Native" });
  assert.equal(legacyFull.host.browserConnectorName(), "Codex Native2");
  assert.throws(
    () => legacyFull.host.mcpConnectorName(),
    /still targets legacy ChatGPT connector.*create that connector as a new ChatGPT plugin/,
  );
  const invalidFull = hostFor({ mode: "full", appName: "   " });
  assert.throws(() => invalidFull.host.mcpConnectorName(), /Connector name is invalid/);
  assert.throws(() => invalidFull.host.browserConnectorName(), /Connector name is invalid/);
  const browserOnly = hostFor({ mode: "browser-only", appName: "Codex Native" });
  assert.equal(browserOnly.host.browserConnectorName(), "Codex Native2");
  assert.throws(() => browserOnly.host.mcpConnectorName(), /MCP runtime is not configured/);
  const dev = devHostFor({ mode: "full", appName: "Codex Native2" });
  assert.equal(dev.host.browserConnectorName(), DEV_CONNECTOR_NAME);
  assert.equal(dev.host.mcpConnectorName(), DEV_CONNECTOR_NAME);
});

test("launcher-controlled CLI operations use the live descriptor token", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-runtime-control-"));
  const descriptorPath = path.join(root, "launcher-browser.json");
  fs.writeFileSync(descriptorPath, `${JSON.stringify({
    pid: process.pid,
    control: { token: "launcher-live-control-token-0123456789abcdefghijkl" },
  })}\n`);
  const host = new RuntimeHost({
    app: { getPath: () => root },
    logger: { info() {}, warn() {}, error() {} },
    sourceRoot: "/source",
    browserDescriptorPath: descriptorPath,
    supervisor: { readConfig: () => null },
  });
  try {
    assert.deepEqual(host.launcherControlEnvironment(), {
      CODEX_WEB_GPT_LAUNCHER_CONTROL_TOKEN: "launcher-live-control-token-0123456789abcdefghijkl",
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("failed first-time setup removes its route before restoring the unconfigured state", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-first-setup-rollback-"));
  const coreHome = path.join(root, "core");
  const codexHome = path.join(root, "codex");
  const journalPath = path.join(coreHome, "codex", "integration-journal.json");
  const recoveryJournalPath = path.join(coreHome, "codex", "integration-journal.recovery.json");
  const configPath = path.join(root, "config.json");
  const codexConfigPath = path.join(codexHome, "config.toml");
  const codexModelsCachePath = path.join(codexHome, "models_cache.json");
  fs.mkdirSync(codexHome, { recursive: true });
  fs.writeFileSync(codexConfigPath, "original codex config\n");
  fs.writeFileSync(codexModelsCachePath, "original codex models cache\n");
  let cleared = 0;
  let stops = 0;
  const calls = [];
  const supervisor = {
    coreHome,
    configPath,
    readConfig: () => fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, "utf8")) : null,
    readSetupConfig: () => fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, "utf8")) : null,
    stopForSetup: async () => {
      stops += 1;
      return { status: "stopped" };
    },
    startIfConfigured: async () => ({ status: fs.existsSync(configPath) ? "ready" : "not-configured" }),
    clearState: () => { cleared += 1; },
  };
  const host = new RuntimeHost({
    app: { getPath: () => root },
    logger: { info() {}, warn() {}, error() {} },
    sourceRoot: "/source",
    browserDescriptorPath: path.join(root, "launcher-browser.json"),
    codexHome,
    supervisor,
  });
  host.run = async (_name, args) => {
    calls.push(args);
    if (args.includes("--preflight-only")) return { code: 0, stdout: "", stderr: "" };
    fs.mkdirSync(path.dirname(journalPath), { recursive: true });
    fs.writeFileSync(configPath, `${JSON.stringify({ mode: "browser-only", browserHost: "launcher" })}\n`);
    fs.writeFileSync(journalPath, "partial integration journal\n");
    fs.writeFileSync(recoveryJournalPath, "partial recovery journal\n");
    fs.writeFileSync(codexConfigPath, "partially changed codex config\n");
    fs.rmSync(codexModelsCachePath);
    throw new Error("synthetic setup failure");
  };
  try {
    await assert.rejects(
      host.runSetup("core-setup", ["setup", "--browser-only"], { ownershipPolicy: directTransactionPolicy("setup-core") }),
      /synthetic setup failure; incomplete first-time setup was rolled back/,
    );
    assert.deepEqual(calls.map((args) => args.join(" ")), [
      "setup --browser-only --preflight-only",
      "setup --browser-only",
    ]);
    assert.equal(fs.existsSync(configPath), false);
    assert.equal(fs.existsSync(journalPath), false);
    assert.equal(fs.existsSync(recoveryJournalPath), false);
    assert.equal(fs.readFileSync(codexConfigPath, "utf8"), "original codex config\n");
    assert.equal(fs.readFileSync(codexModelsCachePath, "utf8"), "original codex models cache\n");
    assert.equal(stops, 2);
    assert.equal(cleared, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a failed setup preflight leaves the previous runtime running and untouched", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-setup-preflight-"));
  const configPath = path.join(root, "config.json");
  const config = { mode: "browser-only", browserHost: "launcher", releaseVersion: "4.0.7" };
  fs.writeFileSync(configPath, `${JSON.stringify(config)}\n`);
  let stops = 0;
  let starts = 0;
  const host = new RuntimeHost({
    app: { getPath: () => root },
    logger: { info() {}, warn() {}, error() {} },
    sourceRoot: "/source",
    browserDescriptorPath: path.join(root, "launcher-browser.json"),
    codexHome: path.join(root, "codex"),
    supervisor: {
      configPath,
      readSetupConfig: () => config,
      readConfig: () => config,
      stopForSetup: async () => { stops += 1; },
      startIfConfigured: async () => { starts += 1; return { status: "needs-setup" }; },
    },
  });
  host.run = async (_name, args) => {
    assert.equal(args.includes("--preflight-only"), true);
    throw new Error("multi_agent_v2 in Codex [features] is unsupported");
  };
  try {
    await assert.rejects(
      host.runSetup("runtime-upgrade", ["setup", "--browser-only"], { ownershipPolicy: directTransactionPolicy("runtime-upgrade") }),
      /multi_agent_v2 in Codex \[features\] is unsupported$/,
    );
    assert.equal(stops, 0);
    assert.equal(starts, 0);
    assert.deepEqual(JSON.parse(fs.readFileSync(configPath, "utf8")), config);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a browser-mode commit failure restores the previous runtime inside setup", async () => {
  const previousConfig = {
    mode: "full",
    browserHost: "launcher",
    browserInteractionMode: "manual",
    releaseVersion: "1.1.3",
  };
  let stops = 0;
  let starts = 0;
  let checkpointRestores = 0;
  let runtimeRestores = 0;
  const host = new RuntimeHost({
    app: {
      getPath: () => path.join(os.tmpdir(), "codex-web-gpt-browser-commit-rollback"),
      getVersion: () => "1.1.3",
    },
    logger: { info() {}, warn() {}, error() {} },
    sourceRoot: "/source",
    browserDescriptorPath: "/runtime/launcher-browser.json",
    supervisor: {
      readSetupConfig: () => previousConfig,
      readConfig: () => previousConfig,
      stopForSetup: async () => { stops += 1; },
      startIfConfigured: async () => { starts += 1; return { status: "ready" }; },
    },
  });
  host.captureSetupCheckpoint = () => ({ exact: "checkpoint" });
  host.setupCheckpointChanged = () => true;
  host.restoreSetupCheckpoint = () => { checkpointRestores += 1; };
  host.restorePreviousRuntime = async () => { runtimeRestores += 1; };
  host.run = async () => ({ code: 0, stdout: "", stderr: "" });

  await assert.rejects(
    host.runSetup("browser-interaction-mode", ["setup", "--full"], {
      afterRuntimeReady: async () => { throw new Error("surface ownership failed"); },
      ownershipPolicy: directTransactionPolicy("browser-interaction-mode"),
    }),
    /surface ownership failed/,
  );
  assert.equal(stops, 1);
  assert.equal(starts, 1);
  assert.equal(checkpointRestores, 1);
  assert.equal(runtimeRestores, 1);
});

test("launcher delegates an existing terminal-managed installation to the migration-aware CLI", async () => {
  let config = { mode: "full", browserHost: "managed-chrome", releaseVersion: "0.1.16" };
  let prepared = 0;
  let launcherStops = 0;
  const coreHome = path.join(os.tmpdir(), "codex-web-gpt-runtime-host-migration-core");
  const supervisor = {
    coreHome,
    configPath: path.join(coreHome, "config.json"),
    readSetupConfig: () => config,
    readConfig: () => {
      if (config.browserHost !== "launcher") throw new Error("not launcher-owned");
      return config;
    },
    prepareExternalMigration: () => { prepared += 1; },
    stopForSetup: async () => { launcherStops += 1; },
    startIfConfigured: async () => ({ status: "ready" }),
  };
  const host = new RuntimeHost({
    app: { getPath: () => path.join(os.tmpdir(), "codex-web-gpt-runtime-host-migration") },
    logger: { info() {}, warn() {}, error() {} },
    sourceRoot: "/source",
    browserDescriptorPath: "/runtime/launcher-browser.json",
    codexHome: path.join(coreHome, "codex"),
    launchAgentsDir: path.join(coreHome, "LaunchAgents"),
    supervisor,
  });
  host.run = async (_name, args) => {
    if (args.includes("--preflight-only")) return { code: 0, stdout: "", stderr: "" };
    config = { mode: "full", browserHost: "launcher", releaseVersion: "0.2.0" };
    return { code: 0, stdout: "", stderr: "" };
  };

  await host.runSetup("core-setup", ["setup", "--full"], { ownershipPolicy: directTransactionPolicy("setup-core") });
  assert.equal(prepared, 1);
  assert.equal(launcherStops, 0);
});

test("failed terminal migration verifies the unchanged previous runtime instead of claiming recovery", async () => {
  const config = { mode: "browser-only", browserHost: "managed-chrome", releaseVersion: "0.1.16" };
  const calls = [];
  const coreHome = path.join(os.tmpdir(), "codex-web-gpt-runtime-host-migration-failure-core");
  const host = new RuntimeHost({
    app: { getPath: () => path.join(os.tmpdir(), "codex-web-gpt-runtime-host-migration-failure") },
    logger: { info() {}, warn() {}, error() {} },
    sourceRoot: "/source",
    browserDescriptorPath: "/runtime/launcher-browser.json",
    codexHome: path.join(coreHome, "codex"),
    launchAgentsDir: path.join(coreHome, "LaunchAgents"),
    supervisor: {
      coreHome,
      configPath: path.join(coreHome, "config.json"),
      readSetupConfig: () => config,
      readConfig: () => { throw new Error("not launcher-owned"); },
      prepareExternalMigration() {},
    },
  });
  host.run = async (_name, args) => {
    calls.push(args.join(" "));
    if (args.includes("--preflight-only")) return { code: 0, stdout: "", stderr: "" };
    if (args[0] === "setup") throw new Error("synthetic migration failure");
    return { code: 0, stdout: '{"ok":true}', stderr: "" };
  };

  await assert.rejects(
    host.runSetup("core-setup", ["setup", "--browser-only"], { ownershipPolicy: directTransactionPolicy("setup-core") }),
    /synthetic migration failure$/,
  );
  assert.deepEqual(calls, [
    "setup --browser-only --preflight-only",
    "setup --browser-only",
    "doctor --json",
  ]);
});

test("failed launcher update restores every mutable setup file before restarting the previous runtime", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-setup-checkpoint-"));
  const coreHome = path.join(root, "core");
  const codexHome = path.join(root, "codex");
  const configPath = path.join(coreHome, "config.json");
  const journalPath = path.join(coreHome, "codex", "integration-journal.json");
  const recoveryJournalPath = path.join(coreHome, "codex", "integration-journal.recovery.json");
  const keyPath = path.join(coreHome, "secrets", "tunnel-runtime.key");
  const profileDir = path.join(coreHome, "tunnel", "profiles");
  const profilePath = path.join(profileDir, "custom.yaml");
  const codexConfigPath = path.join(codexHome, "config.toml");
  const sharedDirectory = path.join(root, "shared");
  const sharedConfigPath = path.join(sharedDirectory, "config.toml");
  const codexModelsCachePath = path.join(codexHome, "models_cache.json");
  const oldConfig = {
    mode: "full",
    browserHost: "launcher",
    releaseVersion: "0.1.16",
    tunnel: {
      runtimeKeyFile: keyPath,
      profileDir,
      profileName: "custom",
    },
  };
  for (const file of [configPath, journalPath, recoveryJournalPath, keyPath, profilePath, codexConfigPath, codexModelsCachePath]) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }
  fs.writeFileSync(configPath, `${JSON.stringify(oldConfig)}\n`, { mode: 0o600 });
  fs.writeFileSync(journalPath, "old journal\n", { mode: 0o600 });
  fs.writeFileSync(recoveryJournalPath, "old recovery journal\n", { mode: 0o600 });
  fs.writeFileSync(keyPath, "old key\n", { mode: 0o600 });
  fs.writeFileSync(profilePath, "old profile\n", { mode: 0o600 });
  fs.mkdirSync(sharedDirectory, { mode: 0o750 });
  fs.writeFileSync(sharedConfigPath, "old codex config\n", { mode: 0o640 });
  fs.symlinkSync(sharedConfigPath, codexConfigPath);
  const linkTarget = fs.readlinkSync(codexConfigPath);
  const linkInode = fs.lstatSync(codexConfigPath).ino;
  const directoryMode = fs.statSync(sharedDirectory).mode & 0o777;
  const fileMode = fs.statSync(sharedConfigPath).mode & 0o777;
  fs.writeFileSync(codexModelsCachePath, "old codex models cache\n", { mode: 0o600 });

  let startAttempts = 0;
  const readConfig = () => JSON.parse(fs.readFileSync(configPath, "utf8"));
  const supervisor = {
    coreHome,
    configPath,
    readSetupConfig: readConfig,
    readConfig,
    stopForSetup: async () => ({ status: "stopped" }),
    startIfConfigured: async () => {
      startAttempts += 1;
      if (readConfig().releaseVersion !== oldConfig.releaseVersion) {
        throw new Error("synthetic updated runtime startup failure");
      }
      return { status: "ready" };
    },
  };
  const host = new RuntimeHost({
    app: { getPath: () => path.join(root, "launcher") },
    logger: { info() {}, warn() {}, error() {} },
    sourceRoot: "/source",
    browserDescriptorPath: path.join(coreHome, "runtime", "launcher-browser.json"),
    codexHome,
    supervisor,
  });
  host.run = async (_name, args) => {
    if (args.includes("--preflight-only")) return { code: 0, stdout: "", stderr: "" };
    fs.writeFileSync(configPath, `${JSON.stringify({ ...oldConfig, releaseVersion: "0.2.0" })}\n`);
    fs.writeFileSync(journalPath, "new journal\n");
    fs.writeFileSync(recoveryJournalPath, "new recovery journal\n");
    fs.writeFileSync(keyPath, "new key\n");
    fs.writeFileSync(profilePath, "new profile\n");
    fs.writeFileSync(codexConfigPath, "new codex config\n");
    fs.rmSync(codexModelsCachePath);
    return { code: 0, stdout: "", stderr: "" };
  };

  try {
    await assert.rejects(
      host.runSetup("core-setup", ["setup", "--full"], { ownershipPolicy: directTransactionPolicy("setup-core") }),
      /synthetic updated runtime startup failure$/,
    );
    assert.equal(startAttempts, 2);
    assert.deepEqual(readConfig(), oldConfig);
    assert.equal(fs.readFileSync(journalPath, "utf8"), "old journal\n");
    assert.equal(fs.readFileSync(recoveryJournalPath, "utf8"), "old recovery journal\n");
    assert.equal(fs.readFileSync(keyPath, "utf8"), "old key\n");
    assert.equal(fs.readFileSync(profilePath, "utf8"), "old profile\n");
    assert.equal(fs.readFileSync(codexConfigPath, "utf8"), "old codex config\n");
    assert.equal(fs.lstatSync(codexConfigPath).isSymbolicLink(), true);
    assert.equal(fs.lstatSync(codexConfigPath).ino, linkInode);
    assert.equal(fs.readlinkSync(codexConfigPath), linkTarget);
    assert.equal(fs.statSync(sharedDirectory).mode & 0o777, directoryMode);
    assert.equal(fs.statSync(sharedConfigPath).mode & 0o777, fileMode);
    assert.equal(fs.readFileSync(codexModelsCachePath, "utf8"), "old codex models cache\n");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("failed terminal migration restores removed launchd ownership before verifying the old runtime", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-terminal-checkpoint-"));
  const coreHome = path.join(root, "core");
  const codexHome = path.join(root, "codex");
  const launchAgentsDir = path.join(root, "LaunchAgents");
  const configPath = path.join(coreHome, "config.json");
  const daemonPlist = path.join(launchAgentsDir, "io.github.codex-chatgpt-web.daemon.plist");
  const tunnelPlist = path.join(launchAgentsDir, "io.github.codex-chatgpt-web.tunnel.plist");
  const oldConfig = {
    mode: "full",
    browserHost: "managed-chrome",
    releaseVersion: "0.1.16",
  };
  for (const file of [configPath, daemonPlist, tunnelPlist]) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }
  fs.writeFileSync(configPath, `${JSON.stringify(oldConfig)}\n`, { mode: 0o600 });
  fs.writeFileSync(daemonPlist, "old daemon plist\n", { mode: 0o600 });
  fs.writeFileSync(tunnelPlist, "old tunnel plist\n", { mode: 0o600 });

  let startAttempts = 0;
  const calls = [];
  const readConfig = () => JSON.parse(fs.readFileSync(configPath, "utf8"));
  const supervisor = {
    coreHome,
    configPath,
    readSetupConfig: readConfig,
    readConfig: () => {
      const config = readConfig();
      if (config.browserHost !== "launcher") throw new Error("not launcher-owned");
      return config;
    },
    prepareExternalMigration() {},
    startIfConfigured: async () => {
      startAttempts += 1;
      throw new Error("synthetic launcher startup failure");
    },
  };
  const host = new RuntimeHost({
    app: { getPath: () => path.join(root, "launcher") },
    logger: { info() {}, warn() {}, error() {} },
    sourceRoot: "/source",
    browserDescriptorPath: path.join(coreHome, "runtime", "launcher-browser.json"),
    codexHome,
    launchAgentsDir,
    platform: "darwin",
    supervisor,
  });
  host.run = async (_name, args) => {
    calls.push(args.join(" "));
    if (args.includes("--preflight-only")) return { code: 0, stdout: "", stderr: "" };
    if (args[0] === "setup") {
      fs.writeFileSync(configPath, `${JSON.stringify({ ...oldConfig, browserHost: "launcher", releaseVersion: "0.2.0" })}\n`);
      fs.rmSync(daemonPlist);
      fs.rmSync(tunnelPlist);
    }
    return { code: 0, stdout: args[0] === "doctor" ? '{"ok":true}' : "", stderr: "" };
  };

  try {
    await assert.rejects(
      host.runSetup("core-setup", ["setup", "--full"], { ownershipPolicy: directTransactionPolicy("setup-core") }),
      /synthetic launcher startup failure$/,
    );
    assert.equal(startAttempts, 1);
    assert.deepEqual(readConfig(), oldConfig);
    assert.equal(fs.readFileSync(daemonPlist, "utf8"), "old daemon plist\n");
    assert.equal(fs.readFileSync(tunnelPlist, "utf8"), "old tunnel plist\n");
    assert.deepEqual(calls, [
      "setup --full --preflight-only",
      "setup --full",
      "service install",
      "tunnel start",
      "doctor --json",
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("macOS passkey capture uses an isolated launcher-controlled transfer", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-passkey-runtime-"));
  const chrome = path.join(root, "Google Chrome");
  fs.writeFileSync(chrome, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  const host = new RuntimeHost({
    app: { getPath: () => root, isPackaged: false },
    logger: { info() {}, warn() {}, error() {} },
    sourceRoot: "/source",
    browserDescriptorPath: path.join(root, "launcher-browser.json"),
    platform: "darwin",
    supervisor: {
      readConfig: () => ({ chromeExecutablePath: chrome }),
      readSetupConfig: () => ({ chromeExecutablePath: chrome }),
    },
  });
  if (process.platform === "win32") {
    host.passkeyChromeExecutable = () => chrome;
  }
  host.launcherControlEnvironment = () => ({ CODEX_WEB_GPT_LAUNCHER_CONTROL_TOKEN: "token" });
  let invocation;
  host.run = async (name, args, options) => {
    invocation = { name, args, options };
    const statePath = args[args.indexOf("--storage-state") + 1];
    fs.writeFileSync(statePath, `${JSON.stringify({ cookies: [], origins: [] })}\n`, { mode: 0o600 });
    fs.writeFileSync(`${statePath}.verified.json`, `${JSON.stringify({
      version: 1,
      captureComplete: true,
      source: "isolated-normal-browser-profile",
      capturedAt: new Date().toISOString(),
    })}\n`, { mode: 0o600 });
    return { code: 0, stdout: "", stderr: "" };
  };
  try {
    const transfer = await host.capturePasskeyLogin();
    assert.deepEqual(transfer.storageState, { cookies: [], origins: [] });
    assert.equal(invocation.name, "passkey-login");
    assert.deepEqual(invocation.args.slice(0, 4), ["login", "--launcher-control", "--chrome", chrome]);
    assert.equal(invocation.options.embedded, true);
    assert.equal(invocation.options.controlStdin, true);
    assert.equal(invocation.options.timeoutMs, 10 * 60_000);
    const transferRoot = path.dirname(invocation.args[invocation.args.indexOf("--storage-state") + 1]);
    assert.equal(fs.existsSync(transferRoot), true);
    await transfer.cleanup();
    assert.equal(fs.existsSync(transferRoot), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("passkey Continue is delivered only to the active owned login child", async () => {
  const fixture = hostFor(null).host;
  let written = "";
  fixture.active = "passkey-login";
  fixture.activeChild = {
    exitCode: null,
    signalCode: null,
    stdin: {
      writable: true,
      write(value, callback) {
        written += value;
        callback();
      },
    },
  };
  assert.equal(await fixture.continuePasskeyLogin(), true);
  assert.deepEqual(JSON.parse(written), { version: 1, type: "passkey-login-continue" });
  assert.throws(() => fixture.continuePasskeyLogin(), /No passkey sign-in is waiting/);
});

test("passkey sign-in is rejected outside macOS even if IPC is invoked directly", () => {
  const fixture = hostFor(null).host;
  fixture.platform = "win32";
  assert.throws(() => fixture.passkeyChromeExecutable(), /supported only on macOS/);
});

test("skill file experiment uses the setup transaction in production and DEV, and rejects manual mode", async () => {
  const production = hostFor({ mode: "full", browserInteractionMode: "automatic" });
  assert.equal((await production.host.setSkillAttachments(true)).enabled, true);
  assert.equal(production.invocation().args.includes("--skill-attachments"), true);
  assert.equal(production.invocation().args.includes("--restart-service"), true);
  const dev = devHostFor({ mode: "full", browserInteractionMode: "automatic" });
  assert.equal((await dev.host.setSkillAttachments(false)).enabled, false);
  assert.equal(dev.invocation().args.includes("--inline-skills"), true);
  assert.equal(dev.invocation().args.includes("--replace-codex-route"), false);
  const manual = hostFor({ mode: "full", browserInteractionMode: "manual" }, "manual");
  await assert.rejects(() => manual.host.setSkillAttachments(true), /Zero Risk/);
  assert.equal(manual.invocation(), undefined);
});

// G1 (PR #2): routing-ownership validation boundaries. Validation only; CLI
// semantics are unchanged until G2, so matching or omitted modes must still
// reach the previous code path while mismatches reject before any mutation.

test("G1.23 setup-core rejects a malformed integrationMode before any mutation", async () => {
  const fixture = hostFor(null);
  await assert.rejects(fixture.host.setupCore({ integrationMode: "opencodex" }), /Integration mode must be direct or external-provider/);
  assert.equal(fixture.invocation(), undefined);
});

test("G1.24 setup-mcp rejects a malformed integrationMode before any mutation", async () => {
  const fixture = hostFor(null);
  await assert.rejects(
    Promise.resolve().then(() => fixture.host.setupMcp({ replace: true, integrationMode: "DIRECT" })),
    /Integration mode must be direct or external-provider/,
  );
  assert.equal(fixture.invocation(), undefined);
});

test("G1.25 existing external install rejects direct setup-core before spawn or stop", async () => {
  const fixture = hostFor({ mode: "browser-only", browserHost: "launcher", integrationMode: "external-provider" });
  let stopped = false;
  const stop = fixture.host.supervisor.stopForSetup;
  fixture.host.supervisor.stopForSetup = async () => {
    stopped = true;
    return stop();
  };
  await assert.rejects(fixture.host.setupCore({ integrationMode: "direct" }), /ownership mismatch/);
  assert.equal(fixture.invocation(), undefined);
  assert.equal(stopped, false);
});

test("G1.26 existing external install rejects direct setup-mcp before any mutation", async () => {
  const fixture = hostFor({ mode: "full", browserHost: "launcher", integrationMode: "external-provider" });
  await assert.rejects(
    Promise.resolve().then(() => fixture.host.setupMcp({
      replace: true,
      tunnelId: "tunnel_0123456789abcdef0123456789abcdef",
      runtimeKey: "new-private-runtime-key-0123456789",
      integrationMode: "direct",
    })),
    /ownership mismatch/,
  );
  assert.equal(fixture.invocation(), undefined);
});

test("G1.27 existing external install rejects direct feature changes before any mutation", async () => {
  const external = () => hostFor({ mode: "browser-only", browserHost: "launcher", integrationMode: "external-provider" });
  const bigger = external();
  await assert.rejects(bigger.host.setBiggerContext(true, { integrationMode: "direct" }), /ownership mismatch/);
  assert.equal(bigger.invocation(), undefined);
  const skills = external();
  await assert.rejects(skills.host.setSkillAttachments(true, { integrationMode: "direct" }), /ownership mismatch/);
  assert.equal(skills.invocation(), undefined);
  const pro = hostFor({ mode: "full", browserHost: "launcher", browserInteractionMode: "manual", integrationMode: "external-provider" }, "manual");
  await assert.rejects(pro.host.setZeroRiskPro(true, { integrationMode: "direct" }), /ownership mismatch/);
  assert.equal(pro.invocation(), undefined);
  const interaction = external();
  await assert.rejects(
    interaction.host.setBrowserInteractionMode("automatic", undefined, { integrationMode: "direct" }),
    /ownership mismatch/,
  );
  assert.equal(interaction.invocation(), undefined);
});

test("G1.28 canonical external install with omitted renderer mode still reaches setup", async () => {
  const fixture = hostFor({ mode: "browser-only", browserHost: "launcher", integrationMode: "external-provider" });
  const result = await fixture.host.setupCore();
  assert.equal(result.mode, "browser-only");
  assert.notEqual(fixture.invocation(), undefined);
});

test("G1.28 existing external install with matching renderer mode still reaches setup", async () => {
  const fixture = hostFor({ mode: "browser-only", browserHost: "launcher", integrationMode: "external-provider" });
  const result = await fixture.host.setupCore({ integrationMode: "external-provider" });
  assert.equal(result.mode, "browser-only");
  assert.notEqual(fixture.invocation(), undefined);
});

test("existing direct install rejects an external request as CLI-only migration", async () => {
  const fixture = hostFor({ mode: "browser-only", browserHost: "launcher" });
  await assert.rejects(fixture.host.setupCore({ integrationMode: "external-provider" }), /CLI-only/);
  assert.equal(fixture.invocation(), undefined);
});

test("G1.29 launcher-state-like fields cannot override canonical runtime ownership", async () => {
  const fixture = hostFor({
    mode: "browser-only",
    browserHost: "launcher",
    integrationMode: "external-provider",
    coreSetupComplete: false,
    bridgeEnabled: true,
  });
  await assert.rejects(fixture.host.setupCore({ integrationMode: "direct" }), /ownership mismatch/);
  assert.equal(fixture.invocation(), undefined);
});

test("G1.30-31 legacy install without integrationMode resolves direct and reaches setup", async () => {
  const fixture = hostFor({ mode: "full", appName: "Codex Native2" });
  const result = await fixture.host.setupCore();
  assert.equal(result.mode, "full");
  assert.notEqual(fixture.invocation(), undefined);
});

test("G1.13 damaged runtime config fails closed instead of looking like a new install", async () => {
  const unreadable = hostFor(null);
  unreadable.host.supervisor.readSetupConfig = () => {
    throw new Error("Unexpected token in JSON");
  };
  await assert.rejects(unreadable.host.setupCore(), /damaged/);
  assert.equal(unreadable.invocation(), undefined);
  const malformed = hostFor({ mode: "browser-only", browserHost: "launcher", integrationMode: "opencodex" });
  await assert.rejects(malformed.host.setupCore(), /damaged/);
  assert.equal(malformed.invocation(), undefined);
});

// G2 command policy matrix: explicit integration-mode emission per operation
// with Direct replace-route preserved and External replace-route forbidden.
// Numbers map to the G2 test plan (section 22).

function ownershipArgPair(args) {
  const at = args.indexOf("--integration-mode");
  return at < 0 ? null : args.slice(at, at + 2);
}

function externalHostFor(config, interactionMode) {
  return hostFor({ browserHost: "launcher", ...config, integrationMode: "external-provider" }, interactionMode);
}

test("G2.2 setupCore External emits explicit mode without replace-route", async () => {
  for (const mode of ["browser-only", "full"]) {
    const fixture = externalHostFor({ mode });
    const result = await fixture.host.setupCore({ integrationMode: "external-provider" });
    assert.equal(result.mode, mode);
    assert.deepEqual(ownershipArgPair(fixture.invocation().args), ["--integration-mode", "external-provider"]);
    assert.equal(fixture.invocation().args.includes("--replace-codex-route"), false);
  }
});

test("G2.4 setupMcp External emits explicit mode without replace-route", async () => {
  const fixture = externalHostFor({ mode: "full" });
  await fixture.host.setupMcp({
    replace: true,
    tunnelId: "tunnel_0123456789abcdef0123456789abcdef",
    runtimeKey: "new-private-runtime-key-0123456789",
    integrationMode: "external-provider",
  });
  assert.deepEqual(ownershipArgPair(fixture.invocation().args), ["--integration-mode", "external-provider"]);
  assert.equal(fixture.invocation().args.includes("--replace-codex-route"), false);
});

test("G2.6 Bigger Context External emits explicit mode without replace-route", async () => {
  const fixture = externalHostFor({ mode: "browser-only" });
  await fixture.host.setBiggerContext(true, { integrationMode: "external-provider" });
  assert.deepEqual(ownershipArgPair(fixture.invocation().args), ["--integration-mode", "external-provider"]);
  assert.equal(fixture.invocation().args.includes("--replace-codex-route"), false);
});

test("G2.7-8 Skill Attachments Direct keeps replace while External omits it", async () => {
  const direct = hostFor({ mode: "browser-only", browserHost: "launcher" });
  await direct.host.setSkillAttachments(true);
  assert.deepEqual(ownershipArgPair(direct.invocation().args), ["--integration-mode", "direct"]);
  assert.equal(direct.invocation().args.includes("--replace-codex-route"), true);
  const external = externalHostFor({ mode: "browser-only" });
  await external.host.setSkillAttachments(true, { integrationMode: "external-provider" });
  assert.deepEqual(ownershipArgPair(external.invocation().args), ["--integration-mode", "external-provider"]);
  assert.equal(external.invocation().args.includes("--replace-codex-route"), false);
});

test("G2.10 Zero Risk Pro External emits explicit mode without replace-route", async () => {
  const fixture = externalHostFor({ mode: "full", browserInteractionMode: "manual" }, "manual");
  await fixture.host.setZeroRiskPro(true, { integrationMode: "external-provider" });
  assert.deepEqual(ownershipArgPair(fixture.invocation().args), ["--integration-mode", "external-provider"]);
  assert.equal(fixture.invocation().args.includes("--replace-codex-route"), false);
});

test("G2.11-12 Browser Interaction Direct keeps replace while External omits it", async () => {
  const direct = hostFor({ mode: "full", browserHost: "launcher", appName: "Codex Native2" });
  await direct.host.setBrowserInteractionMode("manual");
  assert.deepEqual(ownershipArgPair(direct.invocation().args), ["--integration-mode", "direct"]);
  assert.equal(direct.invocation().args.includes("--replace-codex-route"), true);
  const external = externalHostFor({ mode: "full", appName: "Codex Native2" });
  await external.host.setBrowserInteractionMode("manual", undefined, { integrationMode: "external-provider" });
  assert.deepEqual(ownershipArgPair(external.invocation().args), ["--integration-mode", "external-provider"]);
  assert.equal(external.invocation().args.includes("--replace-codex-route"), false);
});

test("G2.14 runtime-upgrade External emits explicit mode without replace-route", async () => {
  const fixture = externalHostFor({
    mode: "full",
    appName: "Codex Native2",
    releaseVersion: "1.1.1",
    solAvailable: true,
    extraHighAvailable: false,
    proAvailable: false,
  });
  fixture.host.bridgeStatus = async () => ({ installed: true, active: true, errors: [] });
  const result = await fixture.host.upgradeManagedRuntime();
  assert.equal(result.updated, true);
  assert.deepEqual(ownershipArgPair(fixture.invocation().args), ["--integration-mode", "external-provider"]);
  assert.equal(fixture.invocation().args.includes("--replace-codex-route"), false);
});

test("G2 runSetup requires a trusted ownership policy before mutation", async () => {
  const host = new RuntimeHost({
    app: {
      getPath: () => path.join(os.tmpdir(), "codex-web-gpt-runtime-host-test"),
      getVersion: () => "1.1.3",
    },
    logger: { info() {}, warn() {}, error() {} },
    sourceRoot: "/source",
    browserDescriptorPath: "/runtime/launcher-browser.json",
    supervisor: {},
  });
  let spawns = 0;
  host.run = async () => {
    spawns += 1;
    return { code: 0, stdout: "", stderr: "" };
  };
  await assert.rejects(
    host.runSetup("core-setup", ["setup", "--browser-only"], {}),
    /requires an ownership policy/,
  );
  assert.equal(spawns, 0);
});

test("G2 ownership flags live only in the centralized policy helper", () => {
  const runtimeSource = fs.readFileSync(path.join(__dirname, "..", "electron", "runtime.cjs"), "utf8");
  assert.equal(runtimeSource.includes("--replace-codex-route"), false);
  assert.equal(runtimeSource.includes("--integration-mode"), false);
  const policySource = fs.readFileSync(path.join(__dirname, "..", "electron", "setup-policy.cjs"), "utf8");
  assert.ok(policySource.includes("--replace-codex-route"));
  assert.ok(policySource.includes("--integration-mode"));
});

// G2 checkpoint/rollback tests: ownership-aware scope with real filesystem
// fixtures. Route artifacts are bridge-owned in Direct and external/user-owned
// in External; bridge-owned tunnel state is protected in both.

function transactionHost(initialConfig) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-g2-"));
  const coreHome = path.join(root, "core");
  const codexHome = path.join(root, "codex");
  fs.mkdirSync(path.join(coreHome, "codex"), { recursive: true });
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(path.join(coreHome, "secrets"), { recursive: true });
  fs.mkdirSync(path.join(coreHome, "tunnel", "profiles"), { recursive: true });
  const configPath = path.join(coreHome, "config.json");
  if (initialConfig !== null) fs.writeFileSync(configPath, JSON.stringify(initialConfig));
  let stops = 0;
  let cleared = 0;
  const readConfigFile = () => {
    if (!fs.existsSync(configPath)) return null;
    return JSON.parse(fs.readFileSync(configPath, "utf8"));
  };
  const host = new RuntimeHost({
    app: {
      getPath: () => path.join(root, "userdata"),
      getVersion: () => "1.1.3",
    },
    logger: { info() {}, warn() {}, error() {} },
    sourceRoot: "/source",
    browserDescriptorPath: path.join(coreHome, "launcher-browser.json"),
    codexHome,
    launchAgentsDir: path.join(root, "launchagents"),
    supervisor: {
      coreHome,
      configPath,
      readSetupConfig: readConfigFile,
      readConfig: readConfigFile,
      stopForSetup: async () => {
        stops += 1;
        return { status: "stopped" };
      },
      startIfConfigured: async () => ({ status: "ready" }),
      clearState: () => {
        cleared += 1;
      },
    },
  });
  return {
    host,
    root,
    coreHome,
    codexHome,
    configPath,
    stops: () => stops,
    cleared: () => cleared,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

function routeArtifactPaths(fixture) {
  return {
    bridgeConfig: fixture.configPath,
    journal: path.join(fixture.coreHome, "codex", "integration-journal.json"),
    recovery: path.join(fixture.coreHome, "codex", "integration-journal.recovery.json"),
    codexConfig: path.join(fixture.codexHome, "config.toml"),
    modelsCache: path.join(fixture.codexHome, "models_cache.json"),
    tunnelKey: path.join(fixture.coreHome, "secrets", "tunnel-runtime-automatic.key"),
  };
}

function checkpointPaths(checkpoint) {
  return new Set(checkpoint.map((entry) => entry.path));
}

test("G2.19-22 Direct checkpoint includes all Codex routing artifacts", () => {
  const fixture = transactionHost({ mode: "browser-only", browserHost: "launcher" });
  try {
    const paths = checkpointPaths(
      fixture.host.captureSetupCheckpoint({ owner: "launcher", config: null }, "direct-integration"),
    );
    const artifacts = routeArtifactPaths(fixture);
    assert.equal(paths.has(artifacts.bridgeConfig), true);
    assert.equal(paths.has(artifacts.journal), true);
    assert.equal(paths.has(artifacts.recovery), true);
    assert.equal(paths.has(artifacts.codexConfig), true);
    assert.equal(paths.has(artifacts.modelsCache), true);
    assert.equal(paths.has(artifacts.tunnelKey), true);
  } finally {
    fixture.cleanup();
  }
});

test("G2.23-28 External checkpoint excludes routing artifacts but keeps bridge state", () => {
  const fixture = transactionHost({ mode: "full", browserHost: "launcher", integrationMode: "external-provider" });
  try {
    const paths = checkpointPaths(
      fixture.host.captureSetupCheckpoint({ owner: "launcher", config: null }, "bridge-only"),
    );
    const artifacts = routeArtifactPaths(fixture);
    assert.equal(paths.has(artifacts.bridgeConfig), true);
    assert.equal(paths.has(artifacts.tunnelKey), true);
    assert.equal(paths.has(artifacts.journal), false);
    assert.equal(paths.has(artifacts.recovery), false);
    assert.equal(paths.has(artifacts.codexConfig), false);
    assert.equal(paths.has(artifacts.modelsCache), false);
  } finally {
    fixture.cleanup();
  }
});

test("G2 checkpoint scope follows routing mode, not process ownership", () => {
  const fixture = transactionHost({ mode: "browser-only", browserHost: "launcher" });
  try {
    const artifacts = routeArtifactPaths(fixture);
    const externalOwnerDirectScope = checkpointPaths(
      fixture.host.captureSetupCheckpoint({ owner: "external", config: null }, "direct-integration"),
    );
    assert.equal(externalOwnerDirectScope.has(artifacts.codexConfig), true);
    const launcherOwnerBridgeScope = checkpointPaths(
      fixture.host.captureSetupCheckpoint({ owner: "launcher", config: null }, "bridge-only"),
    );
    assert.equal(launcherOwnerBridgeScope.has(artifacts.codexConfig), false);
    assert.equal(launcherOwnerBridgeScope.has(artifacts.bridgeConfig), true);
  } finally {
    fixture.cleanup();
  }
});

test("G2.28 External Full checkpoint keeps referenced bridge-owned tunnel files", () => {
  const fixture = transactionHost({ mode: "full", browserHost: "launcher", integrationMode: "external-provider" });
  try {
    const customKey = path.join(fixture.coreHome, "custom-runtime.key");
    const customProfile = path.join(fixture.coreHome, "tunnel", "profiles", "custom-external.yaml");
    fs.writeFileSync(customKey, "key");
    fs.writeFileSync(customProfile, "profile");
    const snapshot = {
      owner: "launcher",
      config: {
        automaticTunnel: {
          tunnelId: "tunnel_0123456789abcdef0123456789abcdef",
          runtimeKeyFile: customKey,
          profileDir: path.join(fixture.coreHome, "tunnel", "profiles"),
          profileName: "custom-external",
        },
      },
    };
    const paths = checkpointPaths(fixture.host.captureSetupCheckpoint(snapshot, "bridge-only"));
    assert.equal(paths.has(customKey), true);
    assert.equal(paths.has(customProfile), true);
    assert.equal(paths.has(path.join(fixture.codexHome, "config.toml")), false);
  } finally {
    fixture.cleanup();
  }
});

test("G2.32 setupCheckpointChanged respects the selected scope", () => {
  const fixture = transactionHost({ mode: "browser-only", browserHost: "launcher" });
  try {
    const artifacts = routeArtifactPaths(fixture);
    fs.writeFileSync(artifacts.bridgeConfig, JSON.stringify({ mode: "browser-only", browserHost: "launcher" }));
    fs.writeFileSync(artifacts.codexConfig, "route");
    const direct = fixture.host.captureSetupCheckpoint({ owner: "launcher", config: null }, "direct-integration");
    const bridgeOnly = fixture.host.captureSetupCheckpoint({ owner: "launcher", config: null }, "bridge-only");
    assert.equal(fixture.host.setupCheckpointChanged(direct), false);
    assert.equal(fixture.host.setupCheckpointChanged(bridgeOnly), false);
    fs.writeFileSync(artifacts.codexConfig, "route changed concurrently");
    assert.equal(fixture.host.setupCheckpointChanged(direct), true);
    assert.equal(fixture.host.setupCheckpointChanged(bridgeOnly), false);
    fs.writeFileSync(artifacts.bridgeConfig, JSON.stringify({ mode: "full", browserHost: "launcher" }));
    assert.equal(fixture.host.setupCheckpointChanged(bridgeOnly), true);
  } finally {
    fixture.cleanup();
  }
});

test("G2.16 preflight and real setup use identical ownership args", async () => {
  for (const integrationMode of ["direct", "external-provider"]) {
    const fixture = transactionHost({ mode: "browser-only", browserHost: "launcher", integrationMode });
    const invocations = [];
    fixture.host.run = async (name, args) => {
      invocations.push({ name, args: [...args] });
      return { code: 0, stdout: "", stderr: "" };
    };
    try {
      await fixture.host.setupCore(integrationMode === "direct" ? undefined : { integrationMode });
      assert.equal(invocations.length, 2);
      const [preflight, real] = invocations;
      assert.deepEqual(preflight.args.slice(0, -1), real.args);
      assert.equal(preflight.args[preflight.args.length - 1], "--preflight-only");
      const at = real.args.indexOf("--integration-mode");
      assert.deepEqual(real.args.slice(at, at + 2), ["--integration-mode", integrationMode]);
      assert.equal(real.args.includes("--replace-codex-route"), integrationMode === "direct");
    } finally {
      fixture.cleanup();
    }
  }
});

test("G2.29 failed Direct transaction restores Direct-owned files exactly", async () => {
  const fixture = transactionHost({ mode: "browser-only", browserHost: "launcher" });
  const artifacts = routeArtifactPaths(fixture);
  const before = {
    bridge: JSON.stringify({ mode: "browser-only", browserHost: "launcher" }),
    journal: "old journal\n",
    recovery: "old recovery\n",
    codex: "original codex config\n",
    cache: "original models cache\n",
  };
  fs.writeFileSync(artifacts.journal, before.journal);
  fs.writeFileSync(artifacts.recovery, before.recovery);
  fs.writeFileSync(artifacts.codexConfig, before.codex);
  fs.writeFileSync(artifacts.modelsCache, before.cache);
  fixture.host.run = async (name, args) => {
    if (args.includes("--preflight-only")) return { code: 0, stdout: "", stderr: "" };
    fs.writeFileSync(fixture.configPath, JSON.stringify({ mode: "full", browserHost: "launcher" }));
    fs.writeFileSync(artifacts.journal, "mutated\n");
    fs.writeFileSync(artifacts.recovery, "mutated\n");
    fs.writeFileSync(artifacts.codexConfig, "mutated\n");
    fs.writeFileSync(artifacts.modelsCache, "mutated\n");
    throw new Error("synthetic Direct setup failure");
  };
  try {
    await assert.rejects(fixture.host.setupCore(), /synthetic Direct setup failure/);
    assert.equal(fs.readFileSync(fixture.configPath, "utf8"), before.bridge);
    assert.equal(fs.readFileSync(artifacts.journal, "utf8"), before.journal);
    assert.equal(fs.readFileSync(artifacts.recovery, "utf8"), before.recovery);
    assert.equal(fs.readFileSync(artifacts.codexConfig, "utf8"), before.codex);
    assert.equal(fs.readFileSync(artifacts.modelsCache, "utf8"), before.cache);
  } finally {
    fixture.cleanup();
  }
});

test("G2.30 failed External transaction leaves concurrently changed Codex files alone", async () => {
  const fixture = transactionHost({ mode: "browser-only", browserHost: "launcher", integrationMode: "external-provider" });
  const artifacts = routeArtifactPaths(fixture);
  const bridgeBefore = JSON.stringify({ mode: "browser-only", browserHost: "launcher", integrationMode: "external-provider" });
  fs.writeFileSync(artifacts.codexConfig, "router-owned route\n");
  fs.writeFileSync(artifacts.journal, "router-owned journal\n");
  fixture.host.run = async (name, args) => {
    if (args.includes("--preflight-only")) return { code: 0, stdout: "", stderr: "" };
    fs.writeFileSync(fixture.configPath, JSON.stringify({ mode: "full", browserHost: "launcher" }));
    fs.writeFileSync(artifacts.codexConfig, "router changed route concurrently\n");
    fs.writeFileSync(artifacts.journal, "router changed journal concurrently\n");
    fs.writeFileSync(artifacts.modelsCache, "router cache\n");
    throw new Error("synthetic External setup failure");
  };
  try {
    await assert.rejects(
      fixture.host.setupCore({ integrationMode: "external-provider" }),
      /synthetic External setup failure/,
    );
    assert.equal(fs.readFileSync(fixture.configPath, "utf8"), bridgeBefore);
    assert.equal(fs.readFileSync(artifacts.codexConfig, "utf8"), "router changed route concurrently\n");
    assert.equal(fs.readFileSync(artifacts.journal, "utf8"), "router changed journal concurrently\n");
    assert.equal(fs.readFileSync(artifacts.modelsCache, "utf8"), "router cache\n");
  } finally {
    fixture.cleanup();
  }
});

test("G2.31 failed External transaction neither recreates nor deletes the external journal", async () => {
  const fixture = transactionHost({ mode: "browser-only", browserHost: "launcher", integrationMode: "external-provider" });
  const artifacts = routeArtifactPaths(fixture);
  assert.equal(fs.existsSync(artifacts.journal), false);
  fixture.host.run = async (name, args) => {
    if (args.includes("--preflight-only")) return { code: 0, stdout: "", stderr: "" };
    fs.writeFileSync(artifacts.journal, "external router journal\n");
    throw new Error("synthetic External journal failure");
  };
  try {
    await assert.rejects(
      fixture.host.setupCore({ integrationMode: "external-provider" }),
      /synthetic External journal failure/,
    );
    assert.equal(fs.readFileSync(artifacts.journal, "utf8"), "external router journal\n");
  } finally {
    fixture.cleanup();
  }
});

test("G2.33 first-time External rollback stays bridge-only", async () => {
  const fixture = transactionHost(null);
  const artifacts = routeArtifactPaths(fixture);
  fs.writeFileSync(artifacts.codexConfig, "pre-existing router route\n");
  let cleared = 0;
  fixture.host.supervisor.clearState = () => {
    cleared += 1;
  };
  fixture.host.run = async (name, args) => {
    if (args.includes("--preflight-only")) return { code: 0, stdout: "", stderr: "" };
    fs.writeFileSync(fixture.configPath, JSON.stringify({ mode: "browser-only", browserHost: "launcher" }));
    throw new Error("synthetic first-time External failure");
  };
  try {
    await assert.rejects(
      fixture.host.setupCore({ integrationMode: "external-provider" }),
      /synthetic first-time External failure/,
    );
    assert.equal(fs.existsSync(fixture.configPath), false);
    assert.equal(fs.readFileSync(artifacts.codexConfig, "utf8"), "pre-existing router route\n");
    assert.equal(cleared, 1);
  } finally {
    fixture.cleanup();
  }
});

// G1 blocker-fix regression tests: provenance revalidation, pre-mutation
// ordering with spies, and DEV Direct-only enforcement at runtime level.

function provenanceHost(reads, options) {
  const settings = options || {};
  const launcherProfile = settings.launcherProfile || "production";
  let readCalls = 0;
  let stops = 0;
  const host = new RuntimeHost({
    app: {
      getPath: () => path.join(os.tmpdir(), "codex-web-gpt-runtime-host-test"),
      getVersion: () => "1.1.3",
    },
    logger: { info() {}, warn() {}, error() {} },
    sourceRoot: "/source",
    browserDescriptorPath: "/runtime/launcher-browser.json",
    ...(launcherProfile === "development"
      ? { coreHome: "/dev-test", launcherProfile: "development" }
      : {}),
    supervisor: {
      readConfig: () => (typeof reads[0] === "object" && reads[0] !== null && !(reads[0] instanceof Error) ? reads[0] : null),
      readSetupConfig: () => {
        const next = reads[Math.min(readCalls, reads.length - 1)];
        readCalls += 1;
        if (next instanceof Error) throw next;
        return next;
      },
      stopForSetup: async () => {
        stops += 1;
        return { status: "stopped" };
      },
      startIfConfigured: async () => ({ status: "ready" }),
    },
    getBrowserInteractionMode: () => settings.interactionMode || "automatic",
  });
  let invocation;
  const record = async (name, args, options) => {
    invocation = { name, args };
    await options.afterRuntimeReady?.();
    return { code: 0, stdout: "", stderr: "" };
  };
  host.runSetup = record;
  host.runDevSetup = record;
  return {
    host,
    invocation: () => invocation,
    reads: () => readCalls,
    stops: () => stops,
  };
}

test("C10 configured external deleted before runtime mutation rejects without setup", async () => {
  const external = { mode: "browser-only", browserHost: "launcher", integrationMode: "external-provider" };
  const fixture = provenanceHost([external, null]);
  const main = fixture.host.validateSetupOwnership(undefined, undefined, "setup-core");
  assert.equal(main.integrationMode, "external-provider");
  await assert.rejects(fixture.host.setupCore(undefined, main.expectation), /changed while preparing setup-core/);
  assert.equal(fixture.invocation(), undefined);
  assert.equal(fixture.stops(), 0);
  assert.ok(fixture.reads() >= 2);
});

test("C11 expected missing with config appearing before runtime mutation rejects", async () => {
  const direct = { mode: "browser-only", browserHost: "launcher" };
  const fixture = provenanceHost([null, direct]);
  const main = fixture.host.validateSetupOwnership(undefined, undefined, "setup-core");
  assert.equal(main.newInstallation, true);
  await assert.rejects(fixture.host.setupCore(undefined, main.expectation), /changed while preparing setup-core/);
  assert.equal(fixture.invocation(), undefined);
  assert.equal(fixture.stops(), 0);
});

test("C12 direct RuntimeHost caller with existing external and requested direct rejects", async () => {
  const fixture = provenanceHost([{ mode: "browser-only", browserHost: "launcher", integrationMode: "external-provider" }]);
  await assert.rejects(fixture.host.setupCore({ integrationMode: "direct" }), /ownership mismatch/);
  assert.equal(fixture.invocation(), undefined);
  assert.equal(fixture.stops(), 0);
});

test("D13 setupDevCore rejects canonical external-provider", async () => {
  const fixture = provenanceHost(
    [{ mode: "browser-only", browserHost: "launcher", integrationMode: "external-provider" }],
    { launcherProfile: "development" },
  );
  await assert.rejects(fixture.host.setupDevCore(), /unavailable in the isolated DEV/);
  assert.equal(fixture.invocation(), undefined);
});

test("D13 setupDevCore rejects requested external-provider on a fresh DEV home", async () => {
  const fixture = provenanceHost([null], { launcherProfile: "development" });
  await assert.rejects(
    fixture.host.setupDevCore({ integrationMode: "external-provider" }),
    /unavailable in the isolated DEV/,
  );
  assert.equal(fixture.invocation(), undefined);
});

test("D14 setupDevMcp rejects canonical external-provider", async () => {
  const fixture = provenanceHost(
    [{ mode: "full", browserHost: "launcher", integrationMode: "external-provider" }],
    { launcherProfile: "development" },
  );
  await assert.rejects(
    Promise.resolve().then(() => fixture.host.setupDevMcp({
      replace: true,
      tunnelId: "tunnel_0123456789abcdef0123456789abcdef",
      runtimeKey: "new-private-runtime-key-0123456789",
    })),
    /unavailable in the isolated DEV/,
  );
  assert.equal(fixture.invocation(), undefined);
});

test("D15 DEV feature setter rejects canonical external-provider before setup", async () => {
  const fixture = provenanceHost(
    [{ mode: "browser-only", browserHost: "launcher", integrationMode: "external-provider" }],
    { launcherProfile: "development" },
  );
  await assert.rejects(fixture.host.setBiggerContext(true), /unavailable in the isolated DEV/);
  assert.equal(fixture.invocation(), undefined);
});

test("D16 DEV missing home remains Direct and reaches setup", async () => {
  const fixture = provenanceHost([null], { launcherProfile: "development" });
  const result = await fixture.host.setupDevCore();
  assert.equal(result.mode, "browser-only");
  assert.notEqual(fixture.invocation(), undefined);
});

test("D17 DEV configured Direct remains allowed", async () => {
  const fixture = provenanceHost(
    [{ mode: "browser-only", browserHost: "launcher" }],
    { launcherProfile: "development" },
  );
  const result = await fixture.host.setupDevCore();
  assert.equal(result.mode, "browser-only");
  assert.notEqual(fixture.invocation(), undefined);
});
