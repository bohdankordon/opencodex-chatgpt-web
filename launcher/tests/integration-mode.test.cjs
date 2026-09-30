const test = require("node:test");
const assert = require("node:assert/strict");
const {
  DIRECT,
  EXTERNAL_PROVIDER,
  assertOwnershipExpectationCurrent,
  assertOwnershipContinuity,
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

// S4D OpenCodex-only: every valid raw config normalizes to
// external-provider. Legacy "direct" values validate but can never resolve to
// Direct; malformed values still throw.
test("G1.1 missing fields normalize to external-provider", () => {
  assert.equal(resolveIntegrationModeFromRaw({}), "external-provider");
  assert.equal(resolveIntegrationModeFromRaw({ mode: "full" }), "external-provider");
  assert.equal(resolveIntegrationModeFromRaw({ integrationMode: undefined }), "external-provider");
});

test("G1.2 legacy direct value normalizes to external-provider", () => {
  assert.equal(resolveIntegrationModeFromRaw({ integrationMode: "direct" }), "external-provider");
});

test("G1.3 explicit external-provider is preserved", () => {
  assert.equal(resolveIntegrationModeFromRaw({ integrationMode: "external-provider" }), "external-provider");
});

test("G1.4 legacy codexIntegrationMode alias validates but normalizes to provider", () => {
  assert.equal(resolveIntegrationModeFromRaw({ codexIntegrationMode: "direct" }), "external-provider");
  assert.equal(resolveIntegrationModeFromRaw({ codexIntegrationMode: "external-provider" }), "external-provider");
});

test("G1.5 matching aliases normalize to provider", () => {
  assert.equal(
    resolveIntegrationModeFromRaw({ integrationMode: "direct", codexIntegrationMode: "direct" }),
    "external-provider",
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

test("G1.12 valid config reads as configured with provider mode", () => {
  const direct = readCanonicalIntegrationState({ readSetupConfig: () => ({ mode: "full" }) });
  assert.equal(direct.kind, "configured");
  assert.equal(direct.integrationMode, "external-provider");
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

// S4D: every requested mode normalizes to provider; malformed still throws.
test("G1.14-16 new installation resolves omitted, direct and external modes to provider", () => {
  const missing = { kind: "missing" };
  assert.equal(resolveLauncherIntegrationMode({ requestedMode: undefined, canonical: missing }), "external-provider");
  assert.equal(resolveLauncherIntegrationMode({ requestedMode: "direct", canonical: missing }), "external-provider");
  assert.equal(
    resolveLauncherIntegrationMode({ requestedMode: "external-provider", canonical: missing }),
    "external-provider",
  );
  assert.throws(
    () => resolveLauncherIntegrationMode({ requestedMode: "bogus", canonical: missing }),
    /must be direct or external-provider/,
  );
});

test("G1.17-20 existing installation always resolves to provider", () => {
  const direct = { kind: "configured", integrationMode: "direct", config: {} };
  const external = { kind: "configured", integrationMode: "external-provider", config: {} };
  assert.equal(resolveLauncherIntegrationMode({ requestedMode: undefined, canonical: direct }), "external-provider");
  assert.equal(resolveLauncherIntegrationMode({ requestedMode: undefined, canonical: external }), "external-provider");
  assert.equal(resolveLauncherIntegrationMode({ requestedMode: "direct", canonical: direct }), "external-provider");
  assert.equal(resolveLauncherIntegrationMode({ requestedMode: "external-provider", canonical: external }), "external-provider");
});

// S4D: ownership migration no longer exists. Requested modes are accepted and
// ignored; no requested/canonical combination can re-enable Direct.
test("G1.21-22 requested modes are accepted and ignored, never a mismatch", () => {
  const direct = { kind: "configured", integrationMode: "direct", config: {} };
  const external = { kind: "configured", integrationMode: "external-provider", config: {} };
  assert.equal(
    resolveLauncherIntegrationMode({ requestedMode: "direct", canonical: external, action: "setup-core" }),
    "external-provider",
  );
  assert.equal(
    resolveLauncherIntegrationMode({ requestedMode: "external-provider", canonical: direct, action: "setup-mcp" }),
    "external-provider",
  );
});

test("ownership context combines the canonical read with request resolution", () => {
  const fresh = resolveOwnershipContext({ requestedMode: undefined, supervisor: { readSetupConfig: () => null } });
  assert.deepEqual({ integrationMode: fresh.integrationMode, newInstallation: fresh.newInstallation }, { integrationMode: "external-provider", newInstallation: true });
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

// G1 blocker-fix regression tests: provenance, revalidation, sanitization.
// Numbers map to the blocker-fix test plan (A/E sections).

test("E21 unexpected undefined reader result fails closed, never missing", () => {
  assert.throws(
    () => readCanonicalIntegrationState({ readSetupConfig: () => undefined }),
    /damaged/,
  );
  assert.throws(
    () => resolveLauncherIntegrationMode({ requestedMode: "direct", canonical: null }),
    /ownership state is invalid/,
  );
  assert.throws(
    () => resolveLauncherIntegrationMode({ requestedMode: "direct" }),
    /ownership state is invalid/,
  );
});

test("damaged errors stay bounded and keep raw detail internal", () => {
  let malformed;
  try {
    readCanonicalIntegrationState({ readSetupConfig: () => ({ integrationMode: "opencodex" }) });
  } catch (error) {
    malformed = error;
  }
  assert.ok(malformed);
  assert.match(malformed.message, /damaged/);
  assert.match(malformed.message, /invalid integration mode/);
  assert.ok(!malformed.message.includes("opencodex"));
  assert.equal(malformed.code, "LAUNCHER_CONFIG_DAMAGED");
  assert.equal(malformed.detail, "Invalid integrationMode; expected direct or external-provider");
  let unreadable;
  try {
    readCanonicalIntegrationState({ readSetupConfig: () => { throw new SyntaxError("Unexpected token < in JSON"); } });
  } catch (error) {
    unreadable = error;
  }
  assert.ok(unreadable);
  assert.match(unreadable.message, /invalid JSON/);
  assert.ok(!unreadable.message.includes("Unexpected token"));
});

test("E18 malformed canonical with valid legacy is rejected", () => {
  assert.throws(
    () => resolveIntegrationModeFromRaw({ integrationMode: "bogus", codexIntegrationMode: "direct" }),
    /Invalid integrationMode/,
  );
});

test("E19 valid canonical with malformed legacy is rejected", () => {
  assert.throws(
    () => resolveIntegrationModeFromRaw({ integrationMode: "direct", codexIntegrationMode: "bogus" }),
    /Invalid codexIntegrationMode/,
  );
});

test("E20 malformed legacy classes are rejected", () => {
  const bad = [null, 42, ["direct"], { mode: "direct" }, "", "   ", "external-provider "];
  for (const candidate of bad) {
    assert.throws(
      () => resolveIntegrationModeFromRaw({ codexIntegrationMode: candidate }),
      /Invalid codexIntegrationMode/,
    );
  }
});

function scriptedSupervisor(results) {
  let calls = 0;
  return {
    calls: () => calls,
    readSetupConfig: () => {
      const next = results[Math.min(calls, results.length - 1)];
      calls += 1;
      if (next instanceof Error) throw next;
      return next;
    },
  };
}

test("expectations are frozen and branded", () => {
  const supervisor = scriptedSupervisor([null]);
  const context = resolveOwnershipContext({ requestedMode: undefined, supervisor, action: "setup-core" });
  assert.ok(Object.isFrozen(context.expectation));
  assert.deepEqual(
    { expectedKind: context.expectation.expectedKind, integrationMode: context.expectation.integrationMode },
    { expectedKind: "missing", integrationMode: "external-provider" },
  );
});

test("renderer cannot invent ownership provenance", () => {
  const supervisor = scriptedSupervisor([null]);
  const forgedKinds = [
    { expectedKind: "missing", integrationMode: "external-provider" },
    { expectedKind: "configured", integrationMode: "direct" },
    { expectedKind: "configured", integrationMode: "external-provider" },
  ];
  for (const forged of forgedKinds) {
    assert.throws(
      () => assertOwnershipExpectationCurrent({ supervisor, expectation: forged, action: "setup-core" }),
      /expectation is invalid/,
    );
  }
  assert.throws(
    () => assertOwnershipExpectationCurrent({ supervisor, expectation: undefined, action: "setup-core" }),
    /expectation is invalid/,
  );
  assert.equal(supervisor.calls(), 0);
});

test("A1 configured external deleted before revalidation fails closed", () => {
  const supervisor = scriptedSupervisor([{ integrationMode: "external-provider" }, null]);
  const context = resolveOwnershipContext({ requestedMode: undefined, supervisor, action: "setup-core" });
  assert.equal(context.integrationMode, "external-provider");
  assert.throws(
    () => assertOwnershipExpectationCurrent({ supervisor, expectation: context.expectation, action: "setup-core" }),
    /changed while preparing setup-core/,
  );
  assert.equal(supervisor.calls(), 2);
});

test("A2 configured direct deleted before revalidation fails closed", () => {
  const supervisor = scriptedSupervisor([{ mode: "browser-only" }, null]);
  const context = resolveOwnershipContext({ requestedMode: undefined, supervisor, action: "setup-mcp" });
  assert.equal(context.integrationMode, "external-provider");
  assert.throws(
    () => assertOwnershipExpectationCurrent({ supervisor, expectation: context.expectation, action: "setup-mcp" }),
    /changed while preparing setup-mcp/,
  );
});

test("A3 missing with config appearing before revalidation fails closed", () => {
  const supervisor = scriptedSupervisor([null, { mode: "browser-only" }]);
  const context = resolveOwnershipContext({ requestedMode: "direct", supervisor, action: "setup-core" });
  assert.equal(context.newInstallation, true);
  assert.throws(
    () => assertOwnershipExpectationCurrent({ supervisor, expectation: context.expectation, action: "setup-core" }),
    /changed while preparing setup-core/,
  );
});

// S4D: raw mode flips normalize to the same provider ownership, so
// revalidation passes with provider mode instead of failing closed.
test("A4 raw external-to-direct flip revalidates cleanly under provider normalization", () => {
  const supervisor = scriptedSupervisor([{ integrationMode: "external-provider" }, { integrationMode: "direct" }]);
  const context = resolveOwnershipContext({ requestedMode: undefined, supervisor, action: "setup-core" });
  const rechecked = assertOwnershipExpectationCurrent({ supervisor, expectation: context.expectation, action: "setup-core" });
  assert.equal(rechecked.kind, "configured");
  assert.equal(rechecked.integrationMode, "external-provider");
});

test("A5 raw direct-to-external flip revalidates cleanly under provider normalization", () => {
  const supervisor = scriptedSupervisor([{}, { integrationMode: "external-provider" }]);
  const context = resolveOwnershipContext({ requestedMode: undefined, supervisor, action: "setup-core" });
  assert.equal(context.integrationMode, "external-provider");
  const rechecked = assertOwnershipExpectationCurrent({ supervisor, expectation: context.expectation, action: "setup-core" });
  assert.equal(rechecked.kind, "configured");
  assert.equal(rechecked.integrationMode, "external-provider");
});

test("A6 configured valid becoming malformed fails closed", () => {
  const supervisor = scriptedSupervisor([{}, { integrationMode: "opencodex" }]);
  const context = resolveOwnershipContext({ requestedMode: undefined, supervisor, action: "setup-core" });
  assert.throws(
    () => assertOwnershipExpectationCurrent({ supervisor, expectation: context.expectation, action: "setup-core" }),
    /damaged/,
  );
});

test("stable expectation revalidates cleanly in both kinds", () => {
  const external = scriptedSupervisor([{ integrationMode: "external-provider" }, { integrationMode: "external-provider" }]);
  const kept = resolveOwnershipContext({ requestedMode: undefined, supervisor: external, action: "setup-core" });
  const rechecked = assertOwnershipExpectationCurrent({ supervisor: external, expectation: kept.expectation, action: "setup-core" });
  assert.equal(rechecked.integrationMode, "external-provider");
  const fresh = scriptedSupervisor([null, null]);
  const created = resolveOwnershipContext({ requestedMode: "direct", supervisor: fresh, action: "setup-core" });
  const recheckedFresh = assertOwnershipExpectationCurrent({ supervisor: fresh, expectation: created.expectation, action: "setup-core" });
  assert.equal(recheckedFresh.kind, "missing");
});

// Startup ownership continuity (G3 fix): same branded expectations as G1,
// compared across the pre/post upgrade captures. Only kind + mode are
// compared; releaseVersion/ports/metadata may legitimately change.

function continuityContext(supervisor) {
  return resolveOwnershipContext({ requestedMode: undefined, supervisor, action: "runtime-startup" });
}

test("continuity passes for unchanged legacy Direct ownership", () => {
  const supervisor = { readSetupConfig: () => ({ mode: "browser-only" }) };
  const before = continuityContext(supervisor);
  const after = continuityContext(supervisor);
  const kept = assertOwnershipContinuity({ before: before.expectation, after: after.expectation, action: "runtime-startup" });
  assert.equal(kept.integrationMode, "external-provider");
});

test("continuity passes for unchanged External ownership", () => {
  const supervisor = { readSetupConfig: () => ({ mode: "browser-only", integrationMode: "external-provider" }) };
  const before = continuityContext(supervisor);
  const after = continuityContext(supervisor);
  const kept = assertOwnershipContinuity({ before: before.expectation, after: after.expectation, action: "runtime-startup" });
  assert.equal(kept.integrationMode, "external-provider");
});

test("continuity passes when only bridge metadata changes", () => {
  let config = { mode: "browser-only", integrationMode: "external-provider", releaseVersion: "0.0.1", port: 17841 };
  const supervisor = { readSetupConfig: () => ({ ...config }) };
  const before = continuityContext(supervisor);
  config = { mode: "full", integrationMode: "external-provider", releaseVersion: "0.0.2", port: 19841 };
  const after = continuityContext(supervisor);
  const kept = assertOwnershipContinuity({ before: before.expectation, after: after.expectation, action: "runtime-startup" });
  assert.equal(kept.integrationMode, "external-provider");
});

// S4D: raw Direct/External drift normalizes to identical provider ownership,
// so continuity passes instead of rejecting.
test("continuity tolerates raw Direct to External drift under provider normalization", () => {
  let config = { mode: "browser-only" };
  const supervisor = { readSetupConfig: () => ({ ...config }) };
  const before = continuityContext(supervisor);
  config = { mode: "browser-only", integrationMode: "external-provider" };
  const after = continuityContext(supervisor);
  const kept = assertOwnershipContinuity({ before: before.expectation, after: after.expectation, action: "runtime-startup" });
  assert.equal(kept.integrationMode, "external-provider");
});

test("continuity tolerates raw External to Direct drift under provider normalization", () => {
  let config = { mode: "browser-only", integrationMode: "external-provider" };
  const supervisor = { readSetupConfig: () => ({ ...config }) };
  const before = continuityContext(supervisor);
  config = { mode: "browser-only" };
  const after = continuityContext(supervisor);
  const kept = assertOwnershipContinuity({ before: before.expectation, after: after.expectation, action: "runtime-startup" });
  assert.equal(kept.integrationMode, "external-provider");
});

test("continuity rejects missing and configured transitions", () => {
  const present = { readSetupConfig: () => ({ mode: "browser-only" }) };
  const absent = { readSetupConfig: () => null };
  const before = continuityContext(present);
  const afterMissing = continuityContext(absent);
  assert.throws(
    () => assertOwnershipContinuity({ before: before.expectation, after: afterMissing.expectation, action: "runtime-startup" }),
    /changed while preparing runtime-startup/,
  );
  const beforeMissing = continuityContext(absent);
  const afterPresent = continuityContext(present);
  assert.throws(
    () => assertOwnershipContinuity({ before: beforeMissing.expectation, after: afterPresent.expectation, action: "runtime-startup" }),
    /changed while preparing runtime-startup/,
  );
});

test("continuity rejects forged expectations", () => {
  const supervisor = { readSetupConfig: () => ({ mode: "browser-only" }) };
  const trusted = continuityContext(supervisor);
  assert.throws(
    () => assertOwnershipContinuity({
      before: { expectedKind: "configured", integrationMode: "direct" },
      after: trusted.expectation,
      action: "runtime-startup",
    }),
    /expectation is invalid/,
  );
  assert.throws(
    () => assertOwnershipContinuity({ before: trusted.expectation, after: undefined, action: "runtime-startup" }),
    /expectation is invalid/,
  );
});
