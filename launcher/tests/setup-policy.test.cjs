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
    "runtime-upgrade",
    "setup-core",
    "setup-mcp",
    "skill-attachments",
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

test("direct production policy preserves the exact replace-route matrix", () => {
  const expected = {
    "setup-core": true,
    "setup-mcp": true,
    "bigger-context": true,
    "skill-attachments": true,
    "zero-risk-pro": true,
    "browser-interaction-mode": true,
    "runtime-upgrade": false,
  };
  assert.deepEqual({ ...DIRECT_REPLACE_BY_OPERATION }, expected);
  for (const [operation, replaceCodexRoute] of Object.entries(expected)) {
    const policy = buildSetupOwnershipPolicy({ integrationMode: "direct", operation, profile: "production" });
    assert.equal(policy.replaceCodexRoute, replaceCodexRoute);
    assert.equal(policy.checkpointScope, DIRECT_INTEGRATION_SCOPE);
    assert.deepEqual(policy.integrationArgs, ["--integration-mode", "direct"]);
    assert.deepEqual(
      ownershipArgs(policy),
      replaceCodexRoute
        ? ["--integration-mode", "direct", "--replace-codex-route"]
        : ["--integration-mode", "direct"],
    );
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
    assert.equal(policy.checkpointScope, DIRECT_INTEGRATION_SCOPE);
    assert.deepEqual(ownershipArgs(policy), []);
  }
});

test("policy rejects malformed mode, profile and scope", () => {
  assert.throws(
    () => buildSetupOwnershipPolicy({ integrationMode: "opencodex", operation: "setup-core", profile: "production" }),
    /requires direct or external-provider/,
  );
  assert.throws(
    () => buildSetupOwnershipPolicy({ operation: "setup-core", profile: "production" }),
    /requires direct or external-provider/,
  );
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

test("C hand-built Direct policy with a bridge-only scope fails", () => {
  const canonical = buildSetupOwnershipPolicy({ integrationMode: "direct", operation: "setup-core", profile: "production" });
  assert.throws(
    () => assertSetupOwnershipPolicy(tamperedClone(canonical, { checkpointScope: "bridge-only" })),
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

test("DEV builder accepts only explicit direct", () => {
  const dev = buildSetupOwnershipPolicy({ integrationMode: "direct", operation: "setup-core", profile: "development" });
  assert.equal(dev.profile, "development");
  assertSetupOwnershipPolicy(dev);
  assert.throws(
    () => buildSetupOwnershipPolicy({ integrationMode: "external-provider", operation: "setup-core", profile: "development" }),
    /Direct-only/,
  );
  for (const bad of [undefined, null, "direct ", "DIRECT", 42]) {
    assert.throws(
      () => buildSetupOwnershipPolicy({ integrationMode: bad, operation: "setup-core", profile: "development" }),
      /requires direct or external-provider/,
    );
  }
});
