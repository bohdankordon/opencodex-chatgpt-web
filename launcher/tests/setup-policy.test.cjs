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
    /must never replace the Codex route/,
  );
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
  assert.throws(
    () => assertSetupOwnershipPolicy({
      integrationMode: "direct",
      operation: "setup-core",
      profile: "production",
      integrationArgs: ["--integration-mode", "direct"],
      replaceCodexRoute: true,
      checkpointScope: "everything",
    }),
    /checkpoint scope/,
  );
  assert.throws(
    () => assertSetupOwnershipPolicy({
      integrationMode: "direct",
      operation: "setup-core",
      profile: "development",
      integrationArgs: ["--integration-mode", "direct"],
      replaceCodexRoute: false,
      checkpointScope: DIRECT_INTEGRATION_SCOPE,
    }),
    /must not emit routing ownership flags/,
  );
});

test("policies are frozen", () => {
  const policy = buildSetupOwnershipPolicy({ integrationMode: "direct", operation: "setup-core", profile: "production" });
  assert.ok(Object.isFrozen(policy));
  assert.ok(Object.isFrozen(policy.integrationArgs));
});
