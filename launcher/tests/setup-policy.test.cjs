const test = require("node:test");
const assert = require("node:assert/strict");
const {
  BRIDGE_ONLY_SCOPE,
  DIRECT_INTEGRATION_SCOPE,
  DIRECT_REPLACE_BY_OPERATION,
  SETUP_OPERATIONS,
  assertSetupOwnershipPolicy,
  buildSetupOwnershipPolicy,
  normalizeSetupOperation,
  ownershipArgs,
} = require("../electron/setup-policy.cjs");

// G2 central ownership policy tests. The policy is driven only by the trusted
// integrationMode G1 validation produces; it never parses renderer input.

test("operation set is closed and rejects arbitrary strings", () => {
  assert.deepEqual([...SETUP_OPERATIONS].sort(), [
    "bigger-context",
    "browser-interaction-mode",
    "connector-name",
    "fresh-conversation-per-turn",
    "runtime-upgrade",
    "setup-core",
    "setup-mcp",
    "skill-attachments",
    "use-saved-chats",
    "zero-risk-pro",
  ]);
  for (const bad of [undefined, null, "", "setup", "Setup-Core", "uninstall", "route-connect", 42, ["setup-core"]]) {
    assert.throws(() => normalizeSetupOperation(bad), /operation must be one of/);
    assert.throws(
      () => buildSetupOwnershipPolicy({ integrationMode: "direct", operation: bad, profile: "production" }),
      /operation must be one of/,
    );
  }
});

// S4D OpenCodex-only: legacy "direct" input normalizes to the provider-only
// policy. No production operation may replace the Codex route; every
// operation uses the bridge-only checkpoint scope with an explicit
// external-provider mode flag.
test("production policy is provider-only with no replace-route for every operation and mode", () => {
  for (const operation of SETUP_OPERATIONS) {
    for (const integrationMode of ["direct", "external-provider"]) {
      const policy = buildSetupOwnershipPolicy({ integrationMode, operation, profile: "production" });
      assert.equal(policy.integrationMode, "external-provider");
      assert.equal(policy.replaceCodexRoute, false);
      assert.equal(policy.checkpointScope, BRIDGE_ONLY_SCOPE);
      assert.deepEqual(policy.integrationArgs, ["--integration-mode", "external-provider"]);
      assert.deepEqual(ownershipArgs(policy), ["--integration-mode", "external-provider"]);
      assert.equal(ownershipArgs(policy).includes("--replace-codex-route"), false);
    }
  }
});

test("legacy direct replace matrix export stays frozen but no longer drives policy", () => {
  assert.deepEqual(Object.keys({ ...DIRECT_REPLACE_BY_OPERATION }).sort(), [...SETUP_OPERATIONS].sort());
  assert.ok(Object.isFrozen(DIRECT_REPLACE_BY_OPERATION));
  for (const operation of SETUP_OPERATIONS) {
    const policy = buildSetupOwnershipPolicy({ integrationMode: "direct", operation, profile: "production" });
    assert.equal(policy.replaceCodexRoute, false);
  }
});

test("external production policy always emits explicit mode and never replace-route", () => {
  for (const operation of SETUP_OPERATIONS) {
    const policy = buildSetupOwnershipPolicy({ integrationMode: "external-provider", operation, profile: "production" });
    assert.equal(policy.replaceCodexRoute, false);
    assert.equal(policy.checkpointScope, BRIDGE_ONLY_SCOPE);
    assert.deepEqual(policy.integrationArgs, ["--integration-mode", "external-provider"]);
    assert.deepEqual(ownershipArgs(policy), ["--integration-mode", "external-provider"]);
    assert.equal(ownershipArgs(policy).includes("--replace-codex-route"), false);
  }
});

test("no operation and mode combination can construct external with replace-route", () => {
  for (const operation of SETUP_OPERATIONS) {
    for (const integrationMode of ["direct", "external-provider"]) {
      const policy = buildSetupOwnershipPolicy({ integrationMode, operation, profile: "production" });
      if (policy.integrationMode === "external-provider") assert.equal(policy.replaceCodexRoute, false);
    }
  }
  assert.throws(
    () => assertSetupOwnershipPolicy({
      integrationMode: "external-provider",
      operation: "setup-core",
      profile: "production",
      integrationArgs: ["--integration-mode", "external-provider"],
      replaceCodexRoute: true,
      checkpointScope: BRIDGE_ONLY_SCOPE,
    }),
    /canonical ownership policy/,
  );
  const canonicalExternal = buildSetupOwnershipPolicy({ integrationMode: "external-provider", operation: "setup-core", profile: "production" });
  const tamperedReplace = Object.freeze({ ...canonicalExternal, replaceCodexRoute: true });
  assert.throws(() => assertSetupOwnershipPolicy(tamperedReplace), /not canonical/);
});

test("dev policy preserves the isolated-harness contract for every operation", () => {
  for (const operation of SETUP_OPERATIONS) {
    const policy = buildSetupOwnershipPolicy({ integrationMode: "direct", operation, profile: "development" });
    assert.deepEqual(policy.integrationArgs, []);
    assert.equal(policy.replaceCodexRoute, false);
    // S4D: DEV harness has no Codex routing; scope is bridge-only.
    assert.equal(policy.integrationMode, "external-provider");
    assert.equal(policy.checkpointScope, BRIDGE_ONLY_SCOPE);
    assert.deepEqual(ownershipArgs(policy), []);
  }
});

test("policy rejects malformed mode, profile and scope", () => {
  assert.throws(
    () => buildSetupOwnershipPolicy({ integrationMode: "opencodex", operation: "setup-core", profile: "production" }),
    /requires direct or external-provider/,
  );
  // S4D: omitted mode is tolerated and normalizes to provider-only.
  const omitted = buildSetupOwnershipPolicy({ operation: "setup-core", profile: "production" });
  assert.equal(omitted.integrationMode, "external-provider");
  assert.equal(omitted.replaceCodexRoute, false);
  assert.equal(omitted.checkpointScope, BRIDGE_ONLY_SCOPE);
  assertSetupOwnershipPolicy(omitted);
  assert.throws(
    () => buildSetupOwnershipPolicy({ integrationMode: "direct", operation: "setup-core", profile: "qa" }),
    /profile must be production or development/,
  );
  for (const bad of [null, undefined, {}, { operation: "setup-core" }, { integrationMode: "direct" }]) {
    assert.throws(() => assertSetupOwnershipPolicy(bad), /requires|must be one of/);
  }
  const canonicalScope = buildSetupOwnershipPolicy({ integrationMode: "direct", operation: "setup-core", profile: "production" });
  assert.throws(
    () => assertSetupOwnershipPolicy(Object.freeze({ ...canonicalScope, checkpointScope: "everything" })),
    /not canonical/,
  );
  const canonicalDev = buildSetupOwnershipPolicy({ integrationMode: "direct", operation: "setup-core", profile: "development" });
  const tamperedDev = Object.freeze({ ...canonicalDev, integrationArgs: ["--integration-mode", "direct"] });
  assert.throws(() => assertSetupOwnershipPolicy(tamperedDev), /not canonical/);
});

test("policies are frozen", () => {
  const policy = buildSetupOwnershipPolicy({ integrationMode: "direct", operation: "setup-core", profile: "production" });
  assert.ok(Object.isFrozen(policy));
  assert.ok(Object.isFrozen(policy.integrationArgs));
});

// Blocker-fix regression tests: canonical branded policies, re-derivation,
// DEV builder strictness, and mutation resistance.

function tamperedClone(policy, patch) {
  return Object.freeze({ ...policy, ...patch });
}

test("A hand-built External policy with a Direct scope fails", () => {
  const canonical = buildSetupOwnershipPolicy({ integrationMode: "external-provider", operation: "setup-core", profile: "production" });
  assert.throws(
    () => assertSetupOwnershipPolicy(tamperedClone(canonical, { checkpointScope: "direct-integration" })),
    /not canonical/,
  );
});

test("B hand-built External policy with Direct args fails", () => {
  const canonical = buildSetupOwnershipPolicy({ integrationMode: "external-provider", operation: "setup-mcp", profile: "production" });
  assert.throws(
    () => assertSetupOwnershipPolicy(tamperedClone(canonical, { integrationArgs: ["--integration-mode", "direct"] })),
    /not canonical/,
  );
});

// S4D: bridge-only is canonical for every production policy, including legacy
// direct input. A legacy direct request can never produce a
// direct-integration scope or a replace-route policy.
test("C legacy direct input can never produce a direct-integration scope", () => {
  const canonical = buildSetupOwnershipPolicy({ integrationMode: "direct", operation: "setup-core", profile: "production" });
  assert.equal(canonical.checkpointScope, "bridge-only");
  assert.equal(canonical.replaceCodexRoute, false);
  assertSetupOwnershipPolicy(canonical);
  assert.throws(
    () => assertSetupOwnershipPolicy(tamperedClone(canonical, { checkpointScope: "direct-integration" })),
    /not canonical/,
  );
  assert.throws(
    () => assertSetupOwnershipPolicy(tamperedClone(canonical, { replaceCodexRoute: true })),
    /not canonical/,
  );
});

test("D unknown profile fails even on a branded clone", () => {
  const canonical = buildSetupOwnershipPolicy({ integrationMode: "direct", operation: "setup-core", profile: "production" });
  assert.throws(
    () => assertSetupOwnershipPolicy(tamperedClone(canonical, { profile: "qa" })),
    /profile must be production or development/,
  );
});

test("E unknown operation fails even on a branded clone", () => {
  const canonical = buildSetupOwnershipPolicy({ integrationMode: "direct", operation: "setup-core", profile: "production" });
  assert.throws(
    () => assertSetupOwnershipPolicy(tamperedClone(canonical, { operation: "uninstall" })),
    /operation must be one of/,
  );
});

test("F/G truthy non-boolean replaceCodexRoute fails", () => {
  const canonical = buildSetupOwnershipPolicy({ integrationMode: "direct", operation: "setup-core", profile: "production" });
  assert.throws(
    () => assertSetupOwnershipPolicy(tamperedClone(canonical, { replaceCodexRoute: 1 })),
    /not canonical/,
  );
  assert.throws(
    () => assertSetupOwnershipPolicy(tamperedClone(canonical, { replaceCodexRoute: "true" })),
    /not canonical/,
  );
});

test("H mutable lookalike objects fail", () => {
  const canonical = buildSetupOwnershipPolicy({ integrationMode: "direct", operation: "setup-core", profile: "production" });
  assert.throws(
    () => assertSetupOwnershipPolicy({ ...canonical }),
    /canonical/,
  );
});

test("I brand-less shape-identical objects fail", () => {
  const canonical = buildSetupOwnershipPolicy({ integrationMode: "external-provider", operation: "setup-mcp", profile: "production" });
  const roundTripped = JSON.parse(JSON.stringify(canonical));
  assert.deepEqual(roundTripped.integrationArgs, ["--integration-mode", "external-provider"]);
  assert.throws(() => assertSetupOwnershipPolicy(roundTripped), /canonical ownership policy/);
});

test("J policy arg arrays resist post-construction mutation", () => {
  const canonical = buildSetupOwnershipPolicy({ integrationMode: "external-provider", operation: "setup-core", profile: "production" });
  assert.throws(() => canonical.integrationArgs.push("--replace-codex-route"), TypeError);
  assert.deepEqual(canonical.integrationArgs, ["--integration-mode", "external-provider"]);
  assertSetupOwnershipPolicy(canonical);
});

// S4D: DEV harness has no Codex routing. Direct, external-provider, and
// omitted modes all normalize to the same provider-only DEV policy with the
// no-flag command contract; malformed modes still throw.
test("DEV builder normalizes every valid mode to provider-only", () => {
  for (const integrationMode of ["direct", "external-provider", undefined]) {
    const dev = buildSetupOwnershipPolicy({ integrationMode, operation: "setup-core", profile: "development" });
    assert.equal(dev.profile, "development");
    assert.equal(dev.integrationMode, "external-provider");
    assert.equal(dev.replaceCodexRoute, false);
    assert.equal(dev.checkpointScope, BRIDGE_ONLY_SCOPE);
    assert.deepEqual(dev.integrationArgs, []);
    assertSetupOwnershipPolicy(dev);
  }
  for (const bad of [null, "direct ", "DIRECT", 42, "opencodex"]) {
    assert.throws(
      () => buildSetupOwnershipPolicy({ integrationMode: bad, operation: "setup-core", profile: "development" }),
      /requires direct or external-provider/,
    );
  }
});
