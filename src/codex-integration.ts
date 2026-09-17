import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import type { AppConfig, IntegrationMode } from "./config";
import {
  getConfigPath,
  isExternalProviderMode,
  loadConfig,
  preserveUtf8Bom,
  readPersistedIntegrationMode,
  saveConfig,
} from "./config";
import { installCodexInterruptHook, installCodexInterruptHookCommand } from "./codex-interrupt-hook";
import {
  CODEX_REALTIME_WEBRTC_CALL_BASE_URL,
  getCodexConfigPath,
  getCodexJournalPath,
  getCodexJournalRecoveryPath,
  getCodexModelsCachePath,
  restoreFileSnapshot,
  routeUrl,
  sha256,
  snapshotFile,
  writeFilesWithCompensation,
  writeFileSnapshot,
  writeIntegrationState,
} from "./codex-integration-shared";
import type {
  AnyCodexIntegrationJournal,
  CodexIntegrationJournal,
  InstallCodexIntegrationOptions,
  LegacyCodexIntegrationJournalV4,
  LegacyCodexIntegrationJournalV5,
  LegacyCodexIntegrationJournalV6,
  LegacyCodexIntegrationJournalV7,
  LegacyCodexIntegrationJournalV8,
  LegacyCodexIntegrationJournalV9,
  SetCodexIntegrationActiveResult,
  UninstallCodexIntegrationResult,
} from "./codex-integration-shared";
import { assertJournalTargetsConfig, readJournal } from "./codex-integration-journal";
import {
  findTopLevelAssignment,
  installCompatibilityV1Features,
  splitLines,
  textFormat,
} from "./codex-integration-document";
import {
  assertPreservedPreviousAssignments,
  assertPreservedPreviousRealtimeAssignment,
  installRoute,
  managedJournalIsActive,
  replacementBaseline,
  restoreLegacyV2,
  restoreManagedRoute,
  verifyInstalledRoute,
  verifyExternalProviderOwnershipHandoff,
  verifyManagedJournalState,
  verifyRestoredRoute,
} from "./codex-integration-route";

function installConfiguredRoute(
  baseline: string,
  installedUrl: string,
  config: Pick<AppConfig, "subagentProtocol"> & (
    Pick<AppConfig, "runtimeCommand"> | { interruptHookCommand: string }
  ),
  replaceExistingRoute: boolean,
  replaceExistingRealtimeRoute: boolean,
): {
  text: string;
  previous: CodexIntegrationJournal["previous"];
  previousRealtimeWebrtcCallBaseUrl: CodexIntegrationJournal["previousRealtimeWebrtcCallBaseUrl"];
  previousMultiAgent?: CodexIntegrationJournal["previousMultiAgent"];
  previousMultiAgentV2?: CodexIntegrationJournal["previousMultiAgentV2"];
  previousAgentMaxDepth?: CodexIntegrationJournal["previousAgentMaxDepth"];
  installedAgentMaxDepth?: number;
  interruptHook: CodexIntegrationJournal["interruptHook"];
} {
  const route = installRoute(
    baseline,
    installedUrl,
    replaceExistingRoute,
    replaceExistingRealtimeRoute,
  );
  const configured = config.subagentProtocol === "compatibility-v1"
    ? (() => {
        const features = installCompatibilityV1Features(route.text);
        return {
          text: features.text,
          previous: route.previous,
          previousRealtimeWebrtcCallBaseUrl: route.previousRealtimeWebrtcCallBaseUrl,
          previousMultiAgent: features.previousMultiAgent,
          previousMultiAgentV2: features.previousMultiAgentV2,
          previousAgentMaxDepth: features.previousAgentMaxDepth,
          installedAgentMaxDepth: features.installedAgentMaxDepth,
        };
      })()
    : route;
  const hook = "interruptHookCommand" in config
    ? installCodexInterruptHookCommand(configured.text, getCodexConfigPath(), config.interruptHookCommand)
    : installCodexInterruptHook(configured.text, getCodexConfigPath(), config);
  return { ...configured, text: hook.text, interruptHook: hook.installed };
}

function journalProtocol(journal: Exclude<AnyCodexIntegrationJournal, { version: 2 }>): AppConfig["subagentProtocol"] {
  return journal.version === 8 || journal.version === 9 || journal.version === 10
    ? journal.installed.subagent_protocol
    : "native";
}

/**
 * All Codex route mutations pass through this boundary. The external-provider mode intentionally
 * fails closed: a missing or stale external router is an operational problem, not permission for
 * this process to take ownership of the user's Codex configuration.
 */
function configuredIntegrationMode(): IntegrationMode {
  // Ownership guards intentionally parse only the ownership fields. Full runtime validation may
  // reject an otherwise usable Direct config for unrelated reasons (for example a missing tunnel),
  // while malformed ownership itself must still fail closed.
  return readPersistedIntegrationMode();
}

export function assertDirectCodexIntegration(
  config?: Pick<AppConfig, "integrationMode"> | { integrationMode?: unknown; codexIntegrationMode?: unknown },
): void {
  if (isExternalProviderMode(config ?? { integrationMode: configuredIntegrationMode() })) {
    throw new Error(
      "Codex routing is managed by an external provider in external-provider mode; "
      + "route connect, disconnect, install, and restore are disabled",
    );
  }
}

/**
 * Switching ownership is not permission to silently restore or replace a Codex route. A previous
 * Direct installation must already have released its managed route before external-provider setup
 * can persist the new ownership mode. The raw direct URL check also catches an unjournaled manual
 * route that still points Codex straight at this bridge.
 */
export function validateExternalProviderOwnershipHandoff(
  config: AppConfig,
): AnyCodexIntegrationJournal | undefined {
  if (!isExternalProviderMode(config)) return;
  const journal = readJournal({ repair: false });
  if (journal) {
    if (journal.version === 2 || journal.version === 3 || journal.active) {
      throw new Error(
        "Existing codex-chatgpt-web Direct route is still active; run `codex-chatgpt-web route disconnect` before switching to external-provider mode",
      );
    }
  }
  const configPath = getCodexConfigPath();
  if (journal) {
    assertJournalTargetsConfig(journal, configPath);
    if (!existsSync(journal.configPath)) throw new Error(`Codex config is missing: ${journal.configPath}`);
    try {
      verifyExternalProviderOwnershipHandoff(readFileSync(journal.configPath, "utf8"), journal);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(
        "Existing codex-chatgpt-web Direct integration did not cleanly release its non-route state; "
        + `repair or disconnect it in Direct mode before switching to external-provider: ${detail}`,
      );
    }
  }
  if (!existsSync(configPath)) return journal;
  const configuredUrl = findTopLevelAssignment(splitLines(readFileSync(configPath, "utf8")), "openai_base_url").value;
  const directUrls = new Set([
    routeUrl(config),
    ...(journal ? [journal.installed.openai_base_url] : []),
  ].map(url => url.replace(/\/+$/, "")));
  if (typeof configuredUrl === "string" && directUrls.has(configuredUrl.replace(/\/+$/, ""))) {
    throw new Error(
      "Codex still points directly at codex-chatgpt-web; point Codex at OpenCodex before switching to external-provider mode",
    );
  }
  return journal;
}

export function assertExternalProviderCodexRouteReleased(config: AppConfig): void {
  validateExternalProviderOwnershipHandoff(config);
}

/** Persist external ownership and retire only the obsolete Direct ownership records as one write. */
export function commitExternalProviderOwnershipHandoff(config: AppConfig): { retired: boolean } {
  if (!isExternalProviderMode(config)) {
    throw new Error("External-provider ownership handoff requires external-provider mode");
  }
  const journal = validateExternalProviderOwnershipHandoff(config);
  const configPath = getConfigPath();
  const original = existsSync(configPath) ? readFileSync(configPath, "utf8") : "";
  writeFilesWithCompensation([
    {
      path: configPath,
      data: preserveUtf8Bom(`${JSON.stringify(config, null, 2)}\n`, original),
    },
  ], journal ? [getCodexJournalRecoveryPath(), getCodexJournalPath()] : []);
  return { retired: Boolean(journal) };
}

export {
  getCodexConfigPath,
  getCodexHome,
  getCodexJournalPath,
  getCodexJournalRecoveryPath,
  getCodexModelsCachePath,
} from "./codex-integration-shared";
export { readCodexModelContextOverride } from "./codex-integration-document";
export type {
  CodexIntegrationJournal,
  CodexModelContextOverride,
  InstallCodexIntegrationOptions,
  SetCodexIntegrationActiveResult,
  UninstallCodexIntegrationResult,
} from "./codex-integration-shared";

export function readCodexSubagentProtocol(
  fallback: AppConfig["subagentProtocol"] = "compatibility-v1",
  options: { repairJournal?: boolean } = {},
): AppConfig["subagentProtocol"] {
  const journal = readJournal({ repair: options.repairJournal });
  return journal?.version === 8 || journal?.version === 9 || journal?.version === 10
    ? journal.installed.subagent_protocol
    : fallback;
}

export function setCodexSubagentProtocol(
  config: AppConfig,
  protocol: AppConfig["subagentProtocol"],
): CodexIntegrationJournal {
  assertDirectCodexIntegration(config);
  const status = inspectCodexIntegration();
  if (!status.installed) throw new Error("Codex integration is not installed; run setup first");
  if (!status.active) {
    throw new Error("Codex integration is disconnected; reconnect it before changing the subagent protocol");
  }
  const nextConfig = { ...config, subagentProtocol: protocol };
  // The runtime catalog and Codex feature surface are two halves of one protocol selection. If
  // either write fails, restore every participant so the next launcher/Codex restart cannot load a
  // split V1/V2 state.
  const snapshots = [
    getConfigPath(),
    getCodexConfigPath(),
    getCodexModelsCachePath(),
    getCodexJournalPath(),
    getCodexJournalRecoveryPath(),
  ].map(path => snapshotFile(path, { followSymlink: path === getCodexConfigPath() }));
  try {
    const journal = installCodexIntegration(nextConfig);
    saveConfig(nextConfig);
    return journal;
  } catch (error) {
    const rollbackFailures: string[] = [];
    for (const snapshot of [...snapshots].reverse()) {
      try {
        restoreFileSnapshot(snapshot);
      } catch (rollbackError) {
        rollbackFailures.push(
          `${snapshot.path}: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
        );
      }
    }
    const primary = error instanceof Error ? error.message : String(error);
    throw new Error(rollbackFailures.length > 0
      ? `${primary}; subagent protocol rollback also failed: ${rollbackFailures.join("; ")}`
      : primary);
  }
}

export function preflightCodexIntegration(
  config: AppConfig,
  options: InstallCodexIntegrationOptions = {},
): void {
  assertDirectCodexIntegration(config);
  const configPath = getCodexConfigPath();
  const configSnapshot = snapshotFile(configPath, { followSymlink: true });
  const configExists = configSnapshot.exists;
  const currentText = configSnapshot.data?.toString("utf8") ?? "";
  const existing = readJournal();
  const installedUrl = routeUrl(config);
  if (existing) assertJournalTargetsConfig(existing, configPath);
  if (existing && existing.version !== 2) {
    if (!configExists) {
      if (options.replaceExistingRoute !== true) {
        throw new Error(`Codex config is missing: ${configPath}`);
      }
      installConfiguredRoute("", installedUrl, config, true, true);
      return;
    }
    try {
      verifyManagedJournalState(currentText, existing);
    } catch (error) {
      if (options.replaceExistingRoute !== true) throw error;
      installConfiguredRoute(
        replacementBaseline(currentText, configExists, existing),
        installedUrl,
        config,
        true,
        true,
      );
      return;
    }
    if (existing.version === 10) return;
    const baseline = managedJournalIsActive(existing)
      ? restoreManagedRoute(currentText, existing)
      : currentText;
    installConfiguredRoute(
      baseline,
      installedUrl,
      config,
      true,
      options.replaceExistingRoute === true,
    );
    return;
  }
  let baseline = currentText;
  if (existing?.version === 2) {
    if (existsSync(existing.catalogPath) && sha256(readFileSync(existing.catalogPath)) !== existing.catalogSha256) {
      throw new Error(`Managed legacy catalog changed after setup; refusing migration: ${existing.catalogPath}`);
    }
    baseline = restoreLegacyV2(currentText, existing);
  }
  installConfiguredRoute(
    baseline,
    installedUrl,
    config,
    options.replaceExistingRoute === true,
    options.replaceExistingRoute === true,
  );
}

export function installCodexIntegration(
  config: AppConfig,
  options: InstallCodexIntegrationOptions = {},
): CodexIntegrationJournal {
  assertDirectCodexIntegration(config);
  const configPath = getCodexConfigPath();
  mkdirSync(dirname(configPath), { recursive: true, mode: 0o700 });
  const configExists = existsSync(configPath);
  const currentText = configExists ? readFileSync(configPath, "utf8") : "";
  const existing = readJournal();
  const installedUrl = routeUrl(config);
  if (existing) assertJournalTargetsConfig(existing, configPath);

  const hasManagedJournal = Boolean(existing && existing.version !== 2);
  if (hasManagedJournal && !configExists && options.replaceExistingRoute !== true) {
    throw new Error(`Codex config is missing: ${configPath}`);
  }

  if (hasManagedJournal && existing && existing.version !== 2) {
    let baseline: string;
    let preservePrevious = true;
    try {
      verifyManagedJournalState(currentText, existing);
      baseline = managedJournalIsActive(existing)
        ? restoreManagedRoute(currentText, existing)
        : currentText;
    } catch (error) {
      if (options.replaceExistingRoute !== true) throw error;
      baseline = replacementBaseline(currentText, configExists, existing);
      preservePrevious = false;
    }
    const patched = installConfiguredRoute(
      baseline,
      installedUrl,
      config,
      true,
      !preservePrevious || existing.version === 9 || existing.version === 10 || options.replaceExistingRoute === true,
    );
    if (preservePrevious) {
      assertPreservedPreviousAssignments(patched.previous, existing.previous);
      if (existing.version === 9 || existing.version === 10) {
        assertPreservedPreviousRealtimeAssignment(
          patched.previousRealtimeWebrtcCallBaseUrl,
          existing.previousRealtimeWebrtcCallBaseUrl,
        );
      }
    }
    const updated: CodexIntegrationJournal = {
      version: 10,
      active: true,
      configPath,
      installed: {
        openai_base_url: installedUrl,
        experimental_realtime_webrtc_call_base_url: CODEX_REALTIME_WEBRTC_CALL_BASE_URL,
        subagent_protocol: config.subagentProtocol,
        ...(config.subagentProtocol === "compatibility-v1" ? {
          agent_max_depth: patched.installedAgentMaxDepth,
        } : {}),
      },
      previous: preservePrevious ? existing.previous : patched.previous,
      previousRealtimeWebrtcCallBaseUrl: preservePrevious && (existing.version === 9 || existing.version === 10)
        ? existing.previousRealtimeWebrtcCallBaseUrl
        : patched.previousRealtimeWebrtcCallBaseUrl,
      interruptHook: patched.interruptHook,
      ...(config.subagentProtocol === "compatibility-v1" ? {
        previousMultiAgent: patched.previousMultiAgent,
        previousMultiAgentV2: patched.previousMultiAgentV2,
        previousAgentMaxDepth: patched.previousAgentMaxDepth,
      } : {}),
      ...(existing.format ? { format: existing.format } : {}),
    };
    writeIntegrationState(updated, { path: configPath, data: patched.text }, [getCodexModelsCachePath()]);
    return updated;
  }

  let baseline = currentText;
  if (existing?.version === 2) {
    if (existsSync(existing.catalogPath) && sha256(readFileSync(existing.catalogPath)) !== existing.catalogSha256) {
      throw new Error(`Managed legacy catalog changed after setup; refusing migration: ${existing.catalogPath}`);
    }
    baseline = restoreLegacyV2(currentText, existing);
  }
  const patched = installConfiguredRoute(
    baseline,
    installedUrl,
    config,
    options.replaceExistingRoute === true,
    options.replaceExistingRoute === true,
  );
  const journal: CodexIntegrationJournal = {
    version: 10,
    active: true,
    configPath,
    installed: {
      openai_base_url: installedUrl,
      experimental_realtime_webrtc_call_base_url: CODEX_REALTIME_WEBRTC_CALL_BASE_URL,
      subagent_protocol: config.subagentProtocol,
      ...(config.subagentProtocol === "compatibility-v1" ? {
        agent_max_depth: patched.installedAgentMaxDepth,
      } : {}),
    },
    previous: patched.previous,
    previousRealtimeWebrtcCallBaseUrl: patched.previousRealtimeWebrtcCallBaseUrl,
    interruptHook: patched.interruptHook,
    ...(config.subagentProtocol === "compatibility-v1" ? {
      previousMultiAgent: patched.previousMultiAgent,
      previousMultiAgentV2: patched.previousMultiAgentV2,
      previousAgentMaxDepth: patched.previousAgentMaxDepth,
    } : {}),
    format: textFormat(baseline),
  };
  writeIntegrationState(journal, { path: configPath, data: patched.text }, [getCodexModelsCachePath()]);
  if (existing?.version === 2 && existsSync(existing.catalogPath)) rmSync(existing.catalogPath);
  return journal;
}

export function deactivateCodexIntegration(): SetCodexIntegrationActiveResult {
  assertDirectCodexIntegration();
  const existing = readJournal();
  if (!existing) return { changed: false, active: false };
  if (existing.version === 2) {
    throw new Error("Legacy Codex integration must be upgraded by Setup before the bridge can be disconnected");
  }
  assertJournalTargetsConfig(existing, getCodexConfigPath());
  if (!existsSync(existing.configPath)) throw new Error(`Codex config is missing: ${existing.configPath}`);
  const current = readFileSync(existing.configPath, "utf8");
  if ((existing.version === 4 || existing.version === 5 || existing.version === 6 || existing.version === 7 || existing.version === 8 || existing.version === 9 || existing.version === 10) && !existing.active) {
    verifyRestoredRoute(current, existing);
    return { changed: false, active: false };
  }
  const restored = restoreManagedRoute(current, existing);
  const disconnected:
    | CodexIntegrationJournal
    | LegacyCodexIntegrationJournalV9
    | LegacyCodexIntegrationJournalV8
    | LegacyCodexIntegrationJournalV6
    | LegacyCodexIntegrationJournalV7
    | LegacyCodexIntegrationJournalV5
    | LegacyCodexIntegrationJournalV4 = existing.version === 6 || existing.version === 5
      || existing.version === 7 || existing.version === 8 || existing.version === 9 || existing.version === 10
      ? { ...existing, active: false }
      : { ...existing, version: 4, active: false };
  writeIntegrationState(disconnected, { path: existing.configPath, data: restored }, [getCodexModelsCachePath()]);
  return { changed: true, active: false };
}

export function activateCodexIntegration(): SetCodexIntegrationActiveResult {
  assertDirectCodexIntegration();
  const existing = readJournal();
  if (!existing) throw new Error("Codex integration is not installed");
  if (existing.version === 2) {
    throw new Error("Legacy Codex integration must be upgraded by Setup before the bridge can be reconnected");
  }
  assertJournalTargetsConfig(existing, getCodexConfigPath());
  if (!existsSync(existing.configPath)) throw new Error(`Codex config is missing: ${existing.configPath}`);
  const current = readFileSync(existing.configPath, "utf8");
  if (existing.version === 10 && existing.active) {
    verifyInstalledRoute(current, existing);
    return { changed: false, active: true };
  }
  let baseline: string;
  if ((existing.version === 4 || existing.version === 5 || existing.version === 6 || existing.version === 7 || existing.version === 8 || existing.version === 9 || existing.version === 10) && !existing.active) {
    verifyRestoredRoute(current, existing);
    baseline = current;
  } else {
    verifyInstalledRoute(current, existing);
    baseline = restoreManagedRoute(current, existing);
  }
  const protocol = journalProtocol(existing);
  const hookConfig = existing.version === 10
    ? { interruptHookCommand: existing.interruptHook.command }
    : { runtimeCommand: loadConfig().runtimeCommand };
  const route = installConfiguredRoute(
    baseline,
    existing.installed.openai_base_url,
    { subagentProtocol: protocol, ...hookConfig },
    true,
    existing.version === 9 || existing.version === 10,
  );
  assertPreservedPreviousAssignments(route.previous, existing.previous);
  if (existing.version === 9 || existing.version === 10) {
    assertPreservedPreviousRealtimeAssignment(
      route.previousRealtimeWebrtcCallBaseUrl,
      existing.previousRealtimeWebrtcCallBaseUrl,
    );
  }
  const connected: CodexIntegrationJournal = {
    version: 10,
    active: true,
    configPath: existing.configPath,
    installed: {
      openai_base_url: existing.installed.openai_base_url,
      experimental_realtime_webrtc_call_base_url: CODEX_REALTIME_WEBRTC_CALL_BASE_URL,
      subagent_protocol: protocol,
      ...(protocol === "compatibility-v1" ? {
        agent_max_depth: route.installedAgentMaxDepth,
      } : {}),
    },
    previous: existing.previous,
    previousRealtimeWebrtcCallBaseUrl: existing.version === 9 || existing.version === 10
      ? existing.previousRealtimeWebrtcCallBaseUrl
      : route.previousRealtimeWebrtcCallBaseUrl,
    interruptHook: route.interruptHook,
    ...(protocol === "compatibility-v1" ? {
      previousMultiAgent: route.previousMultiAgent,
      previousMultiAgentV2: route.previousMultiAgentV2,
      previousAgentMaxDepth: route.previousAgentMaxDepth,
    } : {}),
    ...(existing.format ? { format: existing.format } : {}),
  };
  writeIntegrationState(connected, { path: existing.configPath, data: route.text }, [getCodexModelsCachePath()]);
  return { changed: true, active: true };
}

export function uninstallCodexIntegration(
  config?: Pick<AppConfig, "integrationMode"> | { integrationMode?: unknown; codexIntegrationMode?: unknown },
): UninstallCodexIntegrationResult {
  if (isExternalProviderMode(config ?? { integrationMode: configuredIntegrationMode() })) {
    return { changed: false };
  }
  const journal = readJournal();
  if (!journal) return { changed: false };
  if (!existsSync(journal.configPath)) throw new Error(`Codex config is missing: ${journal.configPath}`);
  const current = readFileSync(journal.configPath, "utf8");
  let restored: string;
  if (journal.version === 2) {
    if (existsSync(journal.catalogPath) && sha256(readFileSync(journal.catalogPath)) !== journal.catalogSha256) {
      throw new Error(`Managed legacy catalog changed after setup: ${journal.catalogPath}`);
    }
    restored = restoreLegacyV2(current, journal);
  } else if ((journal.version === 4 || journal.version === 5 || journal.version === 6 || journal.version === 7 || journal.version === 8 || journal.version === 9 || journal.version === 10) && !journal.active) {
    verifyRestoredRoute(current, journal);
    restored = current;
  } else {
    restored = restoreManagedRoute(current, journal);
  }
  const configSnapshot = snapshotFile(journal.configPath, { followSymlink: true });
  const catalogSnapshot = journal.version === 2 ? snapshotFile(journal.catalogPath) : undefined;
  const modelsCacheSnapshot = snapshotFile(getCodexModelsCachePath());
  const journalSnapshot = snapshotFile(getCodexJournalPath());
  const recoverySnapshot = snapshotFile(getCodexJournalRecoveryPath());
  try {
    writeFileSnapshot(configSnapshot, restored);
    if (catalogSnapshot?.exists) rmSync(catalogSnapshot.path);
    rmSync(modelsCacheSnapshot.path, { force: true });
    rmSync(getCodexJournalPath(), { force: true });
    rmSync(getCodexJournalRecoveryPath(), { force: true });
  } catch (error) {
    const rollbackFailures: string[] = [];
    for (const snapshot of [recoverySnapshot, journalSnapshot, modelsCacheSnapshot, catalogSnapshot, configSnapshot]) {
      if (!snapshot) continue;
      try {
        restoreFileSnapshot(snapshot);
      } catch (caught) {
        rollbackFailures.push(`${snapshot.path}: ${caught instanceof Error ? caught.message : String(caught)}`);
      }
    }
    const primary = error instanceof Error ? error.message : String(error);
    throw new Error(rollbackFailures.length > 0
      ? `${primary}; Codex integration rollback also failed: ${rollbackFailures.join("; ")}`
      : primary);
  }
  return { changed: true };
}

export function inspectCodexIntegration(): {
  installed: boolean;
  active: boolean;
  configPath: string;
  routeUrl?: string;
  journal?: AnyCodexIntegrationJournal;
  errors: string[];
} {
  const journal = readJournal();
  const errors: string[] = [];
  if (journal) {
    try {
      assertJournalTargetsConfig(journal, getCodexConfigPath());
      const text = readFileSync(journal.configPath, "utf8");
      if ((journal.version === 4 || journal.version === 5 || journal.version === 6 || journal.version === 7 || journal.version === 8 || journal.version === 9 || journal.version === 10) && !journal.active) {
        verifyRestoredRoute(text, journal);
      }
      else if (journal.version === 3 || journal.version === 4 || journal.version === 5 || journal.version === 6 || journal.version === 7 || journal.version === 8 || journal.version === 9 || journal.version === 10) {
        verifyInstalledRoute(text, journal);
      }
      else {
        const lines = splitLines(text);
        for (const key of ["model_provider", "model_catalog_json"] as const) {
          if (findTopLevelAssignment(lines, key).value !== journal.installed[key]) {
            errors.push(`Codex ${key} no longer matches this installation`);
          }
        }
        if (!text.includes(journal.providerBlock)) errors.push("Managed legacy Codex provider block no longer matches this installation");
      }
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  return {
    installed: Boolean(journal),
    active: journal?.version === 4 || journal?.version === 5 || journal?.version === 6 || journal?.version === 7 || journal?.version === 8 || journal?.version === 9 || journal?.version === 10
      ? journal.active
      : Boolean(journal),
    configPath: getCodexConfigPath(),
    ...(journal?.version === 3 || journal?.version === 4 || journal?.version === 5 || journal?.version === 6 || journal?.version === 7 || journal?.version === 8 || journal?.version === 9 || journal?.version === 10
      ? { routeUrl: journal.installed.openai_base_url }
      : {}),
    ...(journal ? { journal } : {}),
    errors,
  };
}
