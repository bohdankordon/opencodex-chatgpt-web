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
  if (value === DIRECT || value === EXTERNAL_PROVIDER) return value;
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

function damagedConfigError(detail) {
  return new Error("Runtime configuration is damaged and cannot prove routing ownership: " + detail);
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
    throw damagedConfigError(error instanceof Error ? error.message : String(error));
  }
  if (raw === null || raw === undefined) return { kind: "missing" };
  let integrationMode;
  try {
    integrationMode = resolveIntegrationModeFromRaw(raw);
  } catch (error) {
    throw damagedConfigError(error instanceof Error ? error.message : String(error));
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
  if (!canonical || canonical.kind === "missing") return requested !== undefined ? requested : DIRECT;
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
  };
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

module.exports = {
  DIRECT: DIRECT,
  EXTERNAL_PROVIDER: EXTERNAL_PROVIDER,
  damagedConfigError: damagedConfigError,
  extractRequestedIntegrationMode: extractRequestedIntegrationMode,
  isLauncherIntegrationMode: isLauncherIntegrationMode,
  normalizeRequestedIntegrationMode: normalizeRequestedIntegrationMode,
  readCanonicalIntegrationState: readCanonicalIntegrationState,
  resolveIntegrationModeFromRaw: resolveIntegrationModeFromRaw,
  resolveLauncherIntegrationMode: resolveLauncherIntegrationMode,
  resolveOwnershipContext: resolveOwnershipContext,
};
