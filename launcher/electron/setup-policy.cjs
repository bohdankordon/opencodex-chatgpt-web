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
  "fresh-conversation-per-turn",
  "use-saved-chats",
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
  "fresh-conversation-per-turn": true,
  "use-saved-chats": true,
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
  // Validate ALL inputs before any profile branching: malformed, missing, or
  // external modes, operations, or profiles must never silently become policy.
  if (!isLauncherIntegrationMode(settings.integrationMode)) {
    throw new Error("Setup ownership policy requires direct or external-provider");
  }
  const operation = normalizeSetupOperation(settings.operation);
  if (settings.profile !== "production" && settings.profile !== "development") {
    throw new Error("Setup ownership policy profile must be production or development");
  }
  if (settings.profile === "development") {
    if (settings.integrationMode !== DIRECT) {
      throw new Error("DEV setup ownership is Direct-only; external-provider is unavailable in the isolated DEV launcher profile");
    }
    return brandPolicy({
      integrationMode: DIRECT,
      operation: operation,
      profile: "development",
      integrationArgs: [],
      replaceCodexRoute: false,
      checkpointScope: DIRECT_INTEGRATION_SCOPE,
    });
  }
  const replaceCodexRoute = settings.integrationMode === DIRECT
    && DIRECT_REPLACE_BY_OPERATION[operation] === true;
  if (settings.integrationMode === EXTERNAL_PROVIDER && replaceCodexRoute) {
    throw new Error("External-provider setup must never replace the Codex route");
  }
  return brandPolicy({
    integrationMode: settings.integrationMode,
    operation: operation,
    profile: "production",
    integrationArgs: ["--integration-mode", settings.integrationMode],
    replaceCodexRoute: replaceCodexRoute,
    checkpointScope: settings.integrationMode === EXTERNAL_PROVIDER ? BRIDGE_ONLY_SCOPE : DIRECT_INTEGRATION_SCOPE,
  });
}

// Ownership-specific CLI fragment. Unrelated setup args (mode, descriptor,
// interaction, tunnel, feature flags) stay with their operation builders.
function ownershipArgs(policy) {
  const checked = assertSetupOwnershipPolicy(policy);
  return [...checked.integrationArgs, ...(checked.replaceCodexRoute ? ["--replace-codex-route"] : [])];
}

// Canonical-policy provenance. Only the builder may create a trusted policy:
// the module-private brand cannot be forged through IPC, renderer input, JSON
// round-trips (symbols do not survive serialization), or object spread into an
// unfrozen object. The brand is deliberately not exported.
const SETUP_POLICY_BRAND = Symbol("launcherSetupOwnershipPolicy");

function brandPolicy(fields) {
  return Object.freeze({
    integrationMode: fields.integrationMode,
    operation: fields.operation,
    profile: fields.profile,
    integrationArgs: Object.freeze([...fields.integrationArgs]),
    replaceCodexRoute: fields.replaceCodexRoute,
    checkpointScope: fields.checkpointScope,
    [SETUP_POLICY_BRAND]: true,
  });
}

// Canonical gate for transaction entry: requires a branded, frozen policy
// whose stored derived fields exactly match a fresh re-derivation from its
// own mode, operation and profile. Hand-built lookalikes fail on the brand;
// frozen tampered clones fail on re-derivation (notably external-provider
// paired with a direct-integration scope or Direct args).
function assertSetupOwnershipPolicy(policy) {
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) {
    throw new Error("Setup transaction requires a canonical ownership policy");
  }
  if (policy[SETUP_POLICY_BRAND] !== true) {
    throw new Error("Setup transaction requires a canonical ownership policy");
  }
  if (!Object.isFrozen(policy) || !Array.isArray(policy.integrationArgs) || !Object.isFrozen(policy.integrationArgs)) {
    throw new Error("Setup transaction ownership policy is not canonical");
  }
  const expected = buildSetupOwnershipPolicy({
    integrationMode: policy.integrationMode,
    operation: policy.operation,
    profile: policy.profile,
  });
  if (expected.integrationMode !== policy.integrationMode
      || expected.operation !== policy.operation
      || expected.profile !== policy.profile
      || expected.replaceCodexRoute !== policy.replaceCodexRoute
      || expected.checkpointScope !== policy.checkpointScope
      || expected.integrationArgs.length !== policy.integrationArgs.length
      || expected.integrationArgs.some((arg, index) => arg !== policy.integrationArgs[index])) {
    throw new Error("Setup transaction ownership policy is not canonical");
  }
  return policy;
}

// Exact ownership-flag scan over a final setup arg array. Counts literal
// occurrences anywhere in the array, so duplicated, missing, misplaced, or
// trailing flags without values all fail the binding check below.
function scanOwnershipFlags(args) {
  if (!Array.isArray(args)) {
    throw new Error("Setup transaction requires a command argument array");
  }
  let modeFlags = 0;
  let modeValue;
  let replaceFlags = 0;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--integration-mode") {
      modeFlags += 1;
      modeValue = args[index + 1];
    } else if (args[index] === "--replace-codex-route") {
      replaceFlags += 1;
    }
  }
  return { modeFlags: modeFlags, modeValue: modeValue, replaceFlags: replaceFlags };
}

// Binds the actual setup command to its canonical policy: the ownership
// flags present in the final args must match the policy derivation exactly.
// Production requires exactly one mode flag with the policy value;
// replace-codex-route must be present exactly when the policy requires it.
// DEV requires zero ownership flags. Call before preflight, checkpoint,
// supervisor stop and real setup.
function assertArgsMatchPolicy(policy, args, action) {
  const checked = assertSetupOwnershipPolicy(policy);
  const found = scanOwnershipFlags(args);
  const where = action ? " for " + action : "";
  const fail = (detail) => {
    throw new Error("Setup command ownership flags do not match the canonical policy" + where + ": " + detail);
  };
  if (checked.profile === "development") {
    if (found.modeFlags !== 0) fail("DEV setup must not emit --integration-mode");
    if (found.replaceFlags !== 0) fail("DEV setup must not emit --replace-codex-route");
    return checked;
  }
  if (found.modeFlags !== 1) fail("expected exactly one --integration-mode flag");
  if (found.modeValue !== checked.integrationMode) fail("expected --integration-mode " + checked.integrationMode);
  if (checked.replaceCodexRoute && found.replaceFlags !== 1) fail("expected exactly one --replace-codex-route flag");
  if (!checked.replaceCodexRoute && found.replaceFlags !== 0) fail("unexpected --replace-codex-route flag");
  return checked;
}

module.exports = {
  BRIDGE_ONLY_SCOPE,
  DIRECT_INTEGRATION_SCOPE,
  DIRECT_REPLACE_BY_OPERATION,
  SETUP_OPERATIONS,
  assertArgsMatchPolicy,
  assertSetupOwnershipPolicy,
  buildSetupOwnershipPolicy,
  normalizeSetupOperation,
  ownershipArgs,
};
