"use strict";

// Bridge runtime health-ownership validation (PR #2, G3).
//
// Composes with the existing supervisor liveness checks (service, status,
// mode, version, pid, accepting state): those prove a bridge process is
// alive, this proves the live bridge reports the SAME routing ownership the
// canonical config requires. Reuses the exact /healthz fields from
// src/server.ts; no field names invented here.

const { EXTERNAL_PROVIDER, isLauncherIntegrationMode } = require("./integration-mode.cjs");

// Mirrors the provider_base_url construction in src/server.ts exactly:
// `http://${config.host}:${config.port}/v1` with no normalization. A
// localhost-vs-127.0.0.1 difference is a mismatch unless core normalizes it.
function expectedProviderBaseUrl(config) {
  if (!config || typeof config !== "object") {
    throw new Error("Bridge ownership health requires a runtime configuration");
  }
  if (typeof config.host !== "string" || !config.host) {
    throw new Error("Bridge ownership health requires a configured host");
  }
  if (!Number.isInteger(config.port)) {
    throw new Error("Bridge ownership health requires a configured port");
  }
  return "http://" + config.host + ":" + config.port + "/v1";
}

function expectedRoutingOwner(integrationMode) {
  return integrationMode === EXTERNAL_PROVIDER ? "external-router" : "codex-chatgpt-web";
}

// Validates that a live bridge health payload reports the trusted canonical
// ownership. integrationMode is the G1-trusted startup mode, never renderer
// input; config supplies host/port for the expected provider URL. Throws on
// missing, malformed, or mismatched ownership fields. Never probes or claims
// anything about the external router itself: external-router health stays
// unknown by design.
function validateRuntimeOwnershipHealth(options) {
  const settings = options || {};
  if (!isLauncherIntegrationMode(settings.integrationMode)) {
    throw new Error("Bridge ownership health requires direct or external-provider");
  }
  const health = settings.health;
  if (!health || typeof health !== "object" || Array.isArray(health)) {
    throw new Error("Bridge ownership health is unavailable");
  }
  if (health.integration_mode !== settings.integrationMode) {
    throw new Error(
      "Bridge ownership mismatch: canonical integration mode is "
      + settings.integrationMode
      + " but the running bridge reports "
      + String(health.integration_mode),
    );
  }
  const routingOwner = expectedRoutingOwner(settings.integrationMode);
  if (health.routing_owner !== routingOwner) {
    throw new Error(
      "Bridge ownership mismatch: expected routing owner "
      + routingOwner
      + " but the running bridge reports "
      + String(health.routing_owner),
    );
  }
  const providerBaseUrl = expectedProviderBaseUrl(settings.config);
  if (health.provider_base_url !== providerBaseUrl) {
    throw new Error(
      "Bridge ownership mismatch: expected provider URL "
      + providerBaseUrl
      + " but the running bridge reports "
      + String(health.provider_base_url),
    );
  }
  return {
    integrationMode: settings.integrationMode,
    routingOwner: routingOwner,
    providerBaseUrl: providerBaseUrl,
  };
}

module.exports = {
  expectedProviderBaseUrl,
  expectedRoutingOwner,
  validateRuntimeOwnershipHealth,
};
