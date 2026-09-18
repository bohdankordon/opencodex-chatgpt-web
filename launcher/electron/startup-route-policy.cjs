"use strict";

// Startup route-lifecycle policy (PR #2, G3).
//
// Derives, from canonical startup routing ownership only, whether Launcher
// startup may connect the Direct Codex route and whether startup failure may
// restore it. Never renderer-supplied, never read from launcher-state, and
// never branched on process ownership (launcher/external/none): route policy
// follows integrationMode alone.

const { DIRECT, isLauncherIntegrationMode } = require("./integration-mode.cjs");

function buildStartupRoutePolicy(integrationMode) {
  if (!isLauncherIntegrationMode(integrationMode)) {
    throw new Error("Startup route policy requires direct or external-provider");
  }
  const direct = integrationMode === DIRECT;
  return Object.freeze({
    integrationMode: integrationMode,
    connectDirectRoute: direct,
    restoreDirectRouteOnFailure: direct,
  });
}

module.exports = {
  buildStartupRoutePolicy,
};
