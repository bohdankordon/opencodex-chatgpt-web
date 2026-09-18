const test = require("node:test");
const assert = require("node:assert/strict");
const {
  DIRECT,
  EXTERNAL_PROVIDER,
  extractRequestedIntegrationMode,
  isLauncherIntegrationMode,
  normalizeRequestedIntegrationMode,
  readCanonicalIntegrationState,
  resolveIntegrationModeFromRaw,
  resolveLauncherIntegrationMode,
  resolveOwnershipContext,
} = require("../electron/integration-mode.cjs");

// G1 (PR #2) contract tests. Semantics mirror src/config.ts so the Electron
// host cannot drift from core ownership rules. Numbers map to the G1 test plan.

test("G1.1 missing fields resolve to direct", () => {
  assert.equal(resolveIntegrationModeFromRaw({}), "direct");
  assert.equal(resolveIntegrationModeFromRaw({ mode: "full" }), "direct");
  assert.equal(resolveIntegrationModeFromRaw({ integrationMode: undefined }), "direct");
});

test("G1.2 explicit direct resolves to direct", () => {
  assert.equal(resolveIntegrationModeFromRaw({ integrationMode: "direct" }), "direct");
});

test("G1.3 explicit external-provider is preserved", () => {
  assert.equal(resolveIntegrationModeFromRaw({ integrationMode: "external-provider" }), "external-provider");
});

test("G1.4 legacy codexIntegrationMode alias is honored", () => {
  assert.equal(resolveIntegrationModeFromRaw({ codexIntegrationMode: "direct" }), "direct");
  assert.equal(resolveIntegrationModeFromRaw({ codexIntegrationMode: "external-provider" }), "external-provider");
});

test("G1.5 matching aliases are accepted", () => {
  assert.equal(
    resolveIntegrationModeFromRaw({ integrationMode: "direct", codexIntegrationMode: "direct" }),
    "direct",
  );
  assert.equal(
    resolveIntegrationModeFromRaw({ integrationMode: "external-provider", codexIntegrationMode: "external-provider" }),
    "external-provider",
  );
});

test("G1.6 conflicting aliases resolve conservatively to external-provider", () => {
  assert.equal(
    resolveIntegrationModeFromRaw({ integrationMode: "direct", codexIntegrationMode: "external-provider" }),
    "external-provider",
  );
  assert.equal(
    resolveIntegrationModeFromRaw({ integrationMode: "external-provider", codexIntegrationMode: "direct" }),
    "external-provider",
  );
});

test("G1.7 unknown strings are rejected, never coerced to direct", () => {
  for (const bad of ["external", "DIRECT", "Direct", "opencodex", "", "direct "]) {
    assert.throws(() => resolveIntegrationModeFromRaw({ integrationMode: bad }), /Invalid integrationMode/);
  }
  assert.throws(() => resolveIntegrationModeFromRaw({ codexIntegrationMode: "bogus" }), /Invalid codexIntegrationMode/);
});

test("G1.8 null integrationMode is rejected", () => {
  assert.throws(() => resolveIntegrationModeFromRaw({ integrationMode: null }), /Invalid integrationMode/);
  assert.throws(() => normalizeRequestedIntegrationMode(null), /must be direct or external-provider/);
});

test("G1.9 numbers are rejected", () => {
  assert.throws(() => resolveIntegrationModeFromRaw({ integrationMode: 1 }), /Invalid integrationMode/);
  assert.throws(() => normalizeRequestedIntegrationMode(42), /must be direct or external-provider/);
});

test("G1.10 arrays and objects are rejected", () => {
  assert.throws(() => resolveIntegrationModeFromRaw({ integrationMode: ["direct"] }), /Invalid integrationMode/);
  assert.throws(() => resolveIntegrationModeFromRaw({ integrationMode: {} }), /Invalid integrationMode/);
  assert.throws(() => resolveIntegrationModeFromRaw(null), /Invalid integrationMode/);
  assert.throws(() => resolveIntegrationModeFromRaw("direct"), /Invalid integrationMode/);
});

test("requested mode normalizer passes undefined through and allowlists the enum", () => {
  assert.equal(normalizeRequestedIntegrationMode(undefined), undefined);
  assert.equal(normalizeRequestedIntegrationMode("direct"), "direct");
  assert.equal(normalizeRequestedIntegrationMode("external-provider"), "external-provider");
  assert.equal(isLauncherIntegrationMode("direct"), true);
  assert.equal(isLauncherIntegrationMode("external-provider"), true);
  assert.equal(isLauncherIntegrationMode("opencodex"), false);
  assert.equal(DIRECT, "direct");
  assert.equal(EXTERNAL_PROVIDER, "external-provider");
});

test("G1.11 absent config reads as a new installation", () => {
  const state = readCanonicalIntegrationState({ readSetupConfig: () => null });
  assert.deepEqual(state, { kind: "missing" });
});

test("G1.12 valid config reads as configured with its canonical mode", () => {
  const direct = readCanonicalIntegrationState({ readSetupConfig: () => ({ mode: "full" }) });
  assert.equal(direct.kind, "configured");
  assert.equal(direct.integrationMode, "direct");
  const external = readCanonicalIntegrationState({
    readSetupConfig: () => ({ mode: "full", integrationMode: "external-provider" }),
  });
  assert.equal(external.kind, "configured");
  assert.equal(external.integrationMode, "external-provider");
});

test("G1.13 malformed config is damaged, never a new installation", () => {
  assert.throws(
    () => readCanonicalIntegrationState({ readSetupConfig: () => { throw new Error("Unexpected token"); } }),
    /damaged/,
  );
  assert.throws(
    () => readCanonicalIntegrationState({ readSetupConfig: () => ({ integrationMode: "opencodex" }) }),
    /damaged/,
  );
  assert.throws(
    () => readCanonicalIntegrationState(null),
    /no configuration reader/,
  );
});

test("G1.14-16 new installation accepts omitted, direct and external modes", () => {
  const missing = { kind: "missing" };
  assert.equal(resolveLauncherIntegrationMode({ requestedMode: undefined, canonical: missing }), "direct");
  assert.equal(resolveLauncherIntegrationMode({ requestedMode: "direct", canonical: missing }), "direct");
  assert.equal(
    resolveLauncherIntegrationMode({ requestedMode: "external-provider", canonical: missing }),
    "external-provider",
  );
  assert.throws(
    () => resolveLauncherIntegrationMode({ requestedMode: "bogus", canonical: missing }),
    /must be direct or external-provider/,
  );
});

test("G1.17-20 existing installation preserves canonical on omitted or equal modes", () => {
  const direct = { kind: "configured", integrationMode: "direct", config: {} };
  const external = { kind: "configured", integrationMode: "external-provider", config: {} };
  assert.equal(resolveLauncherIntegrationMode({ requestedMode: undefined, canonical: direct }), "direct");
  assert.equal(resolveLauncherIntegrationMode({ requestedMode: undefined, canonical: external }), "external-provider");
  assert.equal(resolveLauncherIntegrationMode({ requestedMode: "direct", canonical: direct }), "direct");
  assert.equal(resolveLauncherIntegrationMode({ requestedMode: "external-provider", canonical: external }), "external-provider");
});

test("G1.21-22 ownership mismatch rejects as CLI-only migration", () => {
  const direct = { kind: "configured", integrationMode: "direct", config: {} };
  const external = { kind: "configured", integrationMode: "external-provider", config: {} };
  assert.throws(
    () => resolveLauncherIntegrationMode({ requestedMode: "direct", canonical: external, action: "setup-core" }),
    /ownership mismatch.*external-provider.*direct.*CLI-only/,
  );
  assert.throws(
    () => resolveLauncherIntegrationMode({ requestedMode: "external-provider", canonical: direct, action: "setup-mcp" }),
    /ownership mismatch.*direct.*external-provider.*CLI-only/,
  );
});

test("ownership context combines the canonical read with request resolution", () => {
  const fresh = resolveOwnershipContext({ requestedMode: undefined, supervisor: { readSetupConfig: () => null } });
  assert.deepEqual({ integrationMode: fresh.integrationMode, newInstallation: fresh.newInstallation }, { integrationMode: "direct", newInstallation: true });
  const kept = resolveOwnershipContext({
    requestedMode: undefined,
    supervisor: { readSetupConfig: () => ({ integrationMode: "external-provider" }) },
  });
  assert.deepEqual({ integrationMode: kept.integrationMode, newInstallation: kept.newInstallation }, { integrationMode: "external-provider", newInstallation: false });
});

test("stale launcher-style fields cannot override canonical runtime ownership", () => {
  assert.equal(
    resolveIntegrationModeFromRaw({ bridgeEnabled: true, codexIntegrationMode: "external-provider" }),
    "external-provider",
  );
  const state = readCanonicalIntegrationState({
    readSetupConfig: () => ({ mode: "full", integrationMode: "external-provider", coreSetupComplete: false }),
  });
  assert.equal(state.integrationMode, "external-provider");
});

test("IPC payload extractor accepts only the structured object shape", () => {
  assert.equal(extractRequestedIntegrationMode(undefined), undefined);
  assert.equal(extractRequestedIntegrationMode({}), undefined);
  assert.equal(extractRequestedIntegrationMode({ integrationMode: "direct" }), "direct");
  assert.equal(extractRequestedIntegrationMode({ integrationMode: "external-provider" }), "external-provider");
  assert.throws(() => extractRequestedIntegrationMode(null), /payload is invalid/);
  assert.throws(() => extractRequestedIntegrationMode("direct"), /payload is invalid/);
  assert.throws(() => extractRequestedIntegrationMode(42), /payload is invalid/);
  assert.throws(() => extractRequestedIntegrationMode(["direct"]), /payload is invalid/);
  assert.throws(() => extractRequestedIntegrationMode({ integrationMode: "bogus" }), /must be direct or external-provider/);
});
