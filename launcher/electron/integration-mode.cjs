"use strict";

// Launcher-side routing-ownership contract (PR #2, stage G1).
//
// Routing ownership (integrationMode = direct | external-provider) is a
// DIFFERENT axis from process ownership (owner = launcher | external | none).
// Do not conflate them: this helper only resolves routing ownership.
//
// Canonical truth always comes from the runtime config file. Renderer input
// is never authority; launcher-state.json is never authority. Semantics mirror
// src/config.ts resolveIntegrationMode so the CJS Electron host and the core
// runtime cannot drift apart (see launcher/tests/integration-mode.test.cjs).

const DIRECT = "direct";
const EXTERNAL_PROVIDER = "external-provider";

function isLauncherIntegrationMode(value) {
  return value === DIRECT || value === EXTERNAL_PROVIDER;
}

// Validate a renderer-supplied requested mode. undefined means omitted.
// Anything else must be exactly one of the two allowlisted enum values.
// Never coerces; malformed input throws.
function normalizeRequestedIntegrationMode(value) {
  if (value === undefined) return undefined;
  if (isLauncherIntegrationMode(value)) return value;
  throw new Error("Integration mode must be direct or external-provider");
}

// Resolve routing ownership from a raw runtime config object.
// Honors the legacy codexIntegrationMode alias. Missing fields default to
// direct. Conflicting aliases resolve conservatively to external-provider so
// an explicit external intent is never silently demoted. Malformed values
// throw instead of falling back to direct.
function resolveIntegrationModeFromRaw(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Invalid integrationMode; expected direct or external-provider");
  }
  const primary = raw.integrationMode;
  const legacy = raw.codexIntegrationMode;
  const valid = function (candidate) { return candidate === DIRECT || candidate === EXTERNAL_PROVIDER; };
  if (primary !== undefined && !valid(primary)) {
    throw new Error("Invalid integrationMode; expected direct or external-provider");
  }
  if (legacy !== undefined && !valid(legacy)) {
    throw new Error("Invalid codexIntegrationMode; expected direct or external-provider");
  }
  if (valid(primary) && valid(legacy) && primary !== legacy) {
    if (primary === EXTERNAL_PROVIDER || legacy === EXTERNAL_PROVIDER) return EXTERNAL_PROVIDER;
    throw new Error("Conflicting integrationMode and codexIntegrationMode");
  }
  if (valid(primary)) return primary;
  if (valid(legacy)) return legacy;
  return DIRECT;
}

// User-facing damaged-config errors stay bounded: the raw parser/fs detail is
// kept on error.detail for internal diagnostics only and never shown to the
// renderer. kind is a safe coarse classification.
function damagedConfigError(kind, detail) {
  const error = new Error(
    "Runtime configuration is damaged and cannot prove routing ownership (" + kind + ")."
  );
  error.code = "LAUNCHER_CONFIG_DAMAGED";
  error.detail = detail;
  return error;
}

function classifyReadFailure(message) {
  if (/json|unexpected token|parse/i.test(String(message))) return "invalid JSON";
  return "invalid configuration";
}

// Tri-state canonical read over the lenient setup-config path.
// Uses supervisor.readSetupConfig(), not readConfig(), so a damaged file
// yields a fail-closed damaged error instead of an unrelated assertion.
// Returns { kind: "missing" } when no config file exists and
// { kind: "configured", integrationMode, config } when valid. A damaged
// config is NEVER reported as a new installation.
function readCanonicalIntegrationState(supervisor) {
  if (!supervisor || typeof supervisor.readSetupConfig !== "function") {
    throw new Error("Launcher runtime supervisor has no configuration reader for ownership resolution");
  }
  let raw;
  try {
    raw = supervisor.readSetupConfig();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw damagedConfigError(classifyReadFailure(detail), detail);
  }
  // Only an explicit null proves absence. An undefined or otherwise unexpected
  // reader result fails closed instead of looking like a new installation.
  if (raw === null) return { kind: "missing" };
  if (raw === undefined) {
    throw damagedConfigError("invalid configuration", "Runtime configuration reader returned undefined.");
  }
  let integrationMode;
  try {
    integrationMode = resolveIntegrationModeFromRaw(raw);
  } catch (error) {
    throw damagedConfigError("invalid integration mode", error instanceof Error ? error.message : String(error));
  }
  return { kind: "configured", integrationMode: integrationMode, config: raw };
}

// Resolve requested vs canonical ownership.
// NEW INSTALL (canonical.kind === "missing"): omitted defaults to direct;
// explicit direct/external-provider accepted; malformed throws.
// EXISTING INSTALL: canonical always wins; omitted preserves it; equal
// accepts; different throws BEFORE any lifecycle mutation. Ownership
// migration is CLI-only, so a mismatch is a hard error, not a switch.
function resolveLauncherIntegrationMode(options) {
  const settings = options || {};
  const canonical = settings.canonical;
  const action = settings.action || "operation";
  const requested = normalizeRequestedIntegrationMode(settings.requestedMode);
  if (!canonical || typeof canonical !== "object") {
    throw new Error("Launcher routing ownership state is invalid");
  }
  if (canonical.kind === "missing") return requested !== undefined ? requested : DIRECT;
  if (canonical.kind !== "configured") {
    throw new Error("Launcher routing ownership state is invalid");
  }
  if (requested === undefined) return canonical.integrationMode;
  if (requested === canonical.integrationMode) return requested;
  throw new Error("Integration ownership mismatch: installation is " + canonical.integrationMode + " but " + requested + " was requested; ownership migration is CLI-only (action: " + action + ").");
}

// Convenience for main-process handlers and RuntimeHost methods: read
// canonical state once, then resolve. G2 derives replaceCodexRoute,
// checkpointScope and routeLifecyclePolicy from the returned context without
// re-reading renderer input.
function resolveOwnershipContext(options) {
  const settings = options || {};
  const canonical = readCanonicalIntegrationState(settings.supervisor);
  const integrationMode = resolveLauncherIntegrationMode({
    requestedMode: settings.requestedMode,
    canonical: canonical,
    action: settings.action || "operation",
  });
  return {
    integrationMode: integrationMode,
    newInstallation: canonical.kind === "missing",
    canonical: canonical,
    expectation: createOwnershipExpectation(canonical, integrationMode),
  };
}

// Trusted ownership provenance (G1 blocker fix). The expectation records what
// the first trusted canonical read observed. It is created only by this
// module, branded with a module-private symbol, and frozen. Renderer input,
// preload payloads and plain hand-built objects can never satisfy
// assertTrustedExpectation, so installation provenance cannot be invented or
// downgraded across the pre-browser and runtime validation boundaries.
const OWNERSHIP_PROVENANCE = Symbol("launcherOwnershipProvenance");

function createOwnershipExpectation(canonical, integrationMode) {
  return Object.freeze({
    expectedKind: canonical.kind,
    integrationMode: integrationMode,
    [OWNERSHIP_PROVENANCE]: true,
  });
}

function assertTrustedExpectation(expectation) {
  if (!expectation || typeof expectation !== "object" ||
      (expectation.expectedKind !== "missing" && expectation.expectedKind !== "configured") ||
      !isLauncherIntegrationMode(expectation.integrationMode) ||
      expectation[OWNERSHIP_PROVENANCE] !== true) {
    throw new Error("Launcher ownership expectation is invalid; retry the operation.");
  }
  return expectation;
}

function installationChangedError(action) {
  return new Error(
    "Runtime installation state changed while preparing " + action + "; retry the operation."
  );
}

// Startup ownership continuity (G3 fix). Compares two trusted branded
// expectations, typically the pre-upgrade capture and the post-upgrade
// capture, and requires the same installation ownership identity: same
// canonical kind and same integration mode. Full config is deliberately NOT
// compared: managed setup may legitimately rewrite releaseVersion, ports,
// bundle references and other bridge-owned metadata. Any ownership drift
// (including configured-to-missing and missing-to-configured) fails closed
// with the established state-drift error; drift is never migration.
function assertOwnershipContinuity(options) {
  const settings = options || {};
  const action = settings.action || "operation";
  const before = assertTrustedExpectation(settings.before);
  const after = assertTrustedExpectation(settings.after);
  if (before.expectedKind !== after.expectedKind || before.integrationMode !== after.integrationMode) {
    throw installationChangedError(action);
  }
  return after;
}

// Revalidate a trusted expectation against a fresh canonical read. Configured
// expects configured with the same mode; missing expects missing. Every other
// transition, including configured-to-missing, missing-to-configured, mode
// flips and damaged reads, fails closed so an installation can never silently
// become new (or change mode) mid-transaction.
function assertOwnershipExpectationCurrent(options) {
  const settings = options || {};
  const action = settings.action || "operation";
  const expectation = assertTrustedExpectation(settings.expectation);
  const actual = readCanonicalIntegrationState(settings.supervisor);
  if (expectation.expectedKind === "configured") {
    if (actual.kind !== "configured" || actual.integrationMode !== expectation.integrationMode) {
      throw installationChangedError(action);
    }
    return { kind: "configured", integrationMode: actual.integrationMode, config: actual.config };
  }
  if (actual.kind !== "missing") {
    throw installationChangedError(action);
  }
  return { kind: "missing", integrationMode: expectation.integrationMode };
}

// Pull integrationMode out of flexible IPC payloads. Only undefined counts as
// omitted (legacy callers that send no payload). An object with an optional
// integrationMode key is the contract shape. Any other shape, including null,
// strings, numbers and arrays, throws. Never returns an unvalidated string.
function extractRequestedIntegrationMode(input) {
  if (input === undefined) return undefined;
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("Integration mode payload is invalid; expected an object with an optional integrationMode field");
  }
  return normalizeRequestedIntegrationMode(input.integrationMode);
}

// Canonical read-only installation existence for the renderer snapshot
// (FINAL-A blocker fix). Returns "missing" | "configured" | "damaged"
// without exposing routing mode. Reuses readCanonicalIntegrationState so
// canonical parsing/validation is never duplicated: missing/configured map
// directly, any LAUNCHER_CONFIG_DAMAGED error maps to "damaged". Unexpected
// internal errors (for example a missing supervisor reader) propagate so they
// are never mistaken for damaged config. Never reads launcher-state.json,
// readiness flags, or renderer input.
function readIntegrationInstallationState(supervisor) {
  try {
    const canonical = readCanonicalIntegrationState(supervisor);
    if (canonical.kind === "missing") return "missing";
    return "configured";
  } catch (error) {
    if (error && error.code === "LAUNCHER_CONFIG_DAMAGED") return "damaged";
    throw error;
  }
}

module.exports = {
  DIRECT: DIRECT,
  EXTERNAL_PROVIDER: EXTERNAL_PROVIDER,
  assertOwnershipExpectationCurrent: assertOwnershipExpectationCurrent,
  assertOwnershipContinuity: assertOwnershipContinuity,
  damagedConfigError: damagedConfigError,
  extractRequestedIntegrationMode: extractRequestedIntegrationMode,
  isLauncherIntegrationMode: isLauncherIntegrationMode,
  normalizeRequestedIntegrationMode: normalizeRequestedIntegrationMode,
  readCanonicalIntegrationState: readCanonicalIntegrationState,
  readIntegrationInstallationState: readIntegrationInstallationState,
  resolveIntegrationModeFromRaw: resolveIntegrationModeFromRaw,
  resolveLauncherIntegrationMode: resolveLauncherIntegrationMode,
  resolveOwnershipContext: resolveOwnershipContext,
};
