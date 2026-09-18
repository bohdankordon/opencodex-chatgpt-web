"use strict";

// Central ownership policy for Launcher setup transactions (PR #2, G2).
//
// Answers, from TRUSTED canonical ownership only: which --integration-mode
// argument to emit, whether --replace-codex-route is permitted, and which
// checkpoint scope the transaction rollback may touch. Driven exclusively by
// the integrationMode produced through G1 validation (validateSetupOwnership
// / trusted expectation); it never parses renderer input and never reads
// launcher-state.json.
//
// DEV profile keeps its isolated-harness command contract: it is routing-
// Direct-only (enforced in RuntimeHost), emits no --integration-mode flag and
// never replaces the Codex route. This is a deliberate preservation of DEV
// semantics, not an omission: explicit Direct adds no safety to a harness
// that G1 already constrains to Direct.

const { DIRECT, EXTERNAL_PROVIDER, isLauncherIntegrationMode } = require("./integration-mode.cjs");

// Closed internal operation set. Not user-controlled: callers pass one of
// these literals for the setup path they implement.
const SETUP_OPERATIONS = Object.freeze([
  "setup-core",
  "setup-mcp",
  "bigger-context",
  "skill-attachments",
  "zero-risk-pro",
  "browser-interaction-mode",
  "runtime-upgrade",
]);

// Direct production replace-route behavior, preserved exactly from the
// pre-PR-#2 command construction. In particular runtime-upgrade intentionally
// omits --replace-codex-route: upgrade swaps the runtime, startup reconciles
// the route afterwards. Do not "fix" this for symmetry.
const DIRECT_REPLACE_BY_OPERATION = Object.freeze({
  "setup-core": true,
  "setup-mcp": true,
  "bigger-context": true,
  "skill-attachments": true,
  "zero-risk-pro": true,
  "browser-interaction-mode": true,
  "runtime-upgrade": false,
});

const DIRECT_INTEGRATION_SCOPE = "direct-integration";
const BRIDGE_ONLY_SCOPE = "bridge-only";

function normalizeSetupOperation(operation) {
  if (typeof operation !== "string" || !Object.hasOwn(DIRECT_REPLACE_BY_OPERATION, operation)) {
    throw new Error("Setup ownership policy operation must be one of: " + SETUP_OPERATIONS.join(", "));
  }
  return operation;
}

function buildSetupOwnershipPolicy(options) {
  const settings = options || {};
  const operation = normalizeSetupOperation(settings.operation);
  if (settings.profile === "development") {
    return Object.freeze({
      integrationMode: DIRECT,
      operation,
      profile: "development",
      integrationArgs: Object.freeze([]),
      replaceCodexRoute: false,
      checkpointScope: DIRECT_INTEGRATION_SCOPE,
    });
  }
  if (settings.profile !== undefined && settings.profile !== "production") {
    throw new Error("Setup ownership policy profile must be production or development");
  }
  if (!isLauncherIntegrationMode(settings.integrationMode)) {
    throw new Error("Setup ownership policy requires direct or external-provider");
  }
  const replaceCodexRoute = settings.integrationMode === DIRECT
    && DIRECT_REPLACE_BY_OPERATION[operation] === true;
  if (settings.integrationMode === EXTERNAL_PROVIDER && replaceCodexRoute) {
    throw new Error("External-provider setup must never replace the Codex route");
  }
  return Object.freeze({
    integrationMode: settings.integrationMode,
    operation,
    profile: "production",
    integrationArgs: Object.freeze(["--integration-mode", settings.integrationMode]),
    replaceCodexRoute,
    checkpointScope: settings.integrationMode === EXTERNAL_PROVIDER ? BRIDGE_ONLY_SCOPE : DIRECT_INTEGRATION_SCOPE,
  });
}

// Ownership-specific CLI fragment. Unrelated setup args (mode, descriptor,
// interaction, tunnel, feature flags) stay with their operation builders.
function ownershipArgs(policy) {
  const checked = assertSetupOwnershipPolicy(policy);
  return [...checked.integrationArgs, ...(checked.replaceCodexRoute ? ["--replace-codex-route"] : [])];
}

// Structural gate for transaction entry: rejects forged, partial, or
// self-contradictory policies (notably external-provider + replace).
function assertSetupOwnershipPolicy(policy) {
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) {
    throw new Error("Setup transaction requires an ownership policy");
  }
  normalizeSetupOperation(policy.operation);
  if (!isLauncherIntegrationMode(policy.integrationMode)) {
    throw new Error("Setup transaction requires direct or external-provider");
  }
  if (policy.checkpointScope !== DIRECT_INTEGRATION_SCOPE && policy.checkpointScope !== BRIDGE_ONLY_SCOPE) {
    throw new Error("Setup transaction requires a direct-integration or bridge-only checkpoint scope");
  }
  if (!Array.isArray(policy.integrationArgs)) {
    throw new Error("Setup transaction requires explicit integration-mode args");
  }
  if (policy.integrationMode === EXTERNAL_PROVIDER && policy.replaceCodexRoute === true) {
    throw new Error("External-provider setup must never replace the Codex route");
  }
  if (policy.profile === "development" && (policy.integrationArgs.length > 0 || policy.replaceCodexRoute === true)) {
    throw new Error("DEV setup must not emit routing ownership flags");
  }
  return policy;
}

module.exports = {
  BRIDGE_ONLY_SCOPE,
  DIRECT_INTEGRATION_SCOPE,
  DIRECT_REPLACE_BY_OPERATION,
  SETUP_OPERATIONS,
  assertSetupOwnershipPolicy,
  buildSetupOwnershipPolicy,
  normalizeSetupOperation,
  ownershipArgs,
};
