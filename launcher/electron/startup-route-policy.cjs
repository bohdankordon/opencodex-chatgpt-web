"use strict";

// Startup route-lifecycle policy (PR #2, G3).
//
// Derives, from canonical startup routing ownership only, whether Launcher
// startup may connect the Direct Codex route and whether startup failure may
// restore it. Never renderer-supplied, never read from launcher-state, and
// never branched on process ownership (launcher/external/none): route policy
// follows integrationMode alone.

const { EXTERNAL_PROVIDER, isLauncherIntegrationMode } = require("./integration-mode.cjs");

function buildStartupRoutePolicy(integrationMode) {
  // S4D OpenCodex-only: validate old values but always return the provider-only
  // policy. Launcher startup never connects or restores a Direct Codex route.
  if (integrationMode !== undefined && !isLauncherIntegrationMode(integrationMode)) {
    throw new Error("Startup route policy requires direct or external-provider");
  }
  return Object.freeze({
    integrationMode: EXTERNAL_PROVIDER,
    connectDirectRoute: false,
    restoreDirectRouteOnFailure: false,
  });
}

module.exports = {
  buildStartupRoutePolicy,
};
