/**
 * Cross-process lifecycle ownership serialization (PR #2, G5 blocker fix).
 *
 * Launcher Remove proves routing ownership in its own process, then spawns
 * `codex-chatgpt-web uninstall`, which re-reads persisted ownership in the
 * child. Without shared exclusion a concurrent `setup` migration can slip
 * between the check and the destructive action in either process. This module
 * provides ONE shared filesystem lock plus the expected-ownership contract
 * that closes both windows:
 *
 * - migration completing before uninstall acquires the lock fails the
 *   under-lock expected-state comparison before any mutation;
 * - migration attempting while uninstall holds the lock fails fast, because
 *   setup requires the same lock before mutating ownership state.
 *
 * The lock is a file created with atomic exclusive-create (`wx`, the same
 * primitive `atomicWriteFile` in config.ts already relies on) holding owner
 * PID metadata. It lives NEXT TO the removable config directory, never
 * inside it, so `rmSync(getConfigDir())` cannot delete a held lock. One lock
 * exists per core home, so different homes never block each other.
 *
 * Fail-fast everywhere: acquisition never waits. Stale locks left by crashed
 * owners are reclaimed only when the recorded PID is definitely gone; a
 * live-or-unknown owner (including EPERM) stays busy, and malformed lock
 * metadata fails closed. A false busy from PID reuse is the safe direction.
 * The lock is NOT reentrant: nested lifecycle mutations in one process throw
 * instead of self-deadlocking (no core call path nests locked commands).
 */
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { getConfigDir, getConfigPath, loadConfig, type AppConfig, type IntegrationMode } from "./config";

export const LIFECYCLE_LOCK_FILE_SUFFIX = ".lifecycle.lock";

/** Stable per-home lock path that uninstall itself cannot delete. */
export function getLifecycleLockPath(home: string = getConfigDir()): string {
  const dir = resolve(home);
  return join(dirname(dir), `${basename(dir)}${LIFECYCLE_LOCK_FILE_SUFFIX}`);
}

export interface LifecycleLockOwner {
  pid: number;
  token: string;
  command: string;
  since: string;
  home: string;
}

export class LifecycleLockBusyError extends Error {
  readonly code = "LIFECYCLE_LOCK_BUSY";
  constructor(
    readonly lockPath: string,
    detail: string,
  ) {
    super(`Another codex-chatgpt-web lifecycle operation is active (${detail}); retry after it completes. Lock: ${lockPath}`);
    this.name = "LifecycleLockBusyError";
  }
}

export interface AcquiredLifecycleLock {
  readonly lockPath: string;
  release(): void;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // ESRCH proves the owner is gone and the lock is stale. EPERM (or any
    // other failure) cannot prove absence, so it stays busy: fail closed.
    return (error as NodeJS.ErrnoException)?.code !== "ESRCH";
  }
}

function validOwnerPid(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function releaseHandle(lockPath: string, token: string): AcquiredLifecycleLock {
  let released = false;
  return {
    lockPath,
    release() {
      if (released) return;
      released = true;
      // Delete only what this acquisition created: a mismatched token means
      // the file was reclaimed or replaced, and must be left alone.
      try {
        const owner = JSON.parse(readFileSync(lockPath, "utf8")) as { token?: unknown };
        if (owner?.token !== token) return;
      } catch {
        return;
      }
      // Best effort: stale-lock recovery covers a failed unlink exactly like
      // a crashed owner (live PID stays busy, dead PID is reclaimed).
      try {
        rmSync(lockPath);
      } catch { /* covered by the stale protocol */ }
    },
  };
}

/**
 * Acquire the per-home lifecycle lock without waiting. Throws
 * LifecycleLockBusyError when another lifecycle mutation owns it, and throws
 * on nested acquisition by this process instead of self-deadlocking.
 */
export function acquireLifecycleLock(command: string, home: string = getConfigDir()): AcquiredLifecycleLock {
  const lockPath = getLifecycleLockPath(home);
  mkdirSync(dirname(lockPath), { recursive: true });
  const token = `${process.pid}:${Date.now().toString(36)}:${randomUUID()}`;
  const payload = JSON.stringify({
    pid: process.pid,
    token,
    command,
    since: new Date().toISOString(),
    home: resolve(home),
  });
  const tryCreate = (): boolean => {
    try {
      const fd = openSync(lockPath, "wx", 0o600);
      try {
        writeSync(fd, payload);
      } finally {
        closeSync(fd);
      }
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "EEXIST") return false;
      throw error;
    }
  };
  if (tryCreate()) return releaseHandle(lockPath, token);
  // Contended: inspect the incumbent without deleting anything yet.
  let raw: string;
  try {
    raw = readFileSync(lockPath, "utf8");
  } catch (error) {
    // Vanished between create and read: exactly one retry, then busy.
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT" && tryCreate()) {
      return releaseHandle(lockPath, token);
    }
    // Direct throw (not a never-returning helper call) so tsc honors
    // definite-assignment, type-guard narrowing, and end-of-function
    // return analysis on every control-flow path below.
    throw new LifecycleLockBusyError(lockPath, "the lock file cannot be read");
  }
  let incumbent: unknown = null;
  try {
    incumbent = JSON.parse(raw!);
  } catch {
    incumbent = null;
  }
  const pid = incumbent !== null && typeof incumbent === "object"
    ? (incumbent as { pid?: unknown }).pid
    : undefined;
  if (!validOwnerPid(pid)) {
    throw new LifecycleLockBusyError(
      lockPath,
      "lock metadata is missing or malformed; remove the lock file manually only if no lifecycle command is running",
    );
  }
  if (pid === process.pid) {
    throw new Error(
      `Lifecycle lock for ${resolve(home)} is already held by this process; nested lifecycle mutations are not supported`,
    );
  }
  if (pidAlive(pid)) {
    const held = incumbent as { command?: unknown; since?: unknown };
    const what = typeof held.command === "string" ? held.command : "unknown operation";
    const when = typeof held.since === "string" ? held.since : "unknown time";
    throw new LifecycleLockBusyError(lockPath, `owner pid ${pid} (${what}) is running since ${when}`);
  }
  // The owner is definitely gone: reclaim once, then a single create retry.
  // A concurrent reclaimer racing here loses the exclusive create below and
  // fails busy instead of sharing ownership, which is the safe direction.
  try {
    rmSync(lockPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
      throw new LifecycleLockBusyError(lockPath, "a stale lock could not be reclaimed");
    }
  }
  if (tryCreate()) return releaseHandle(lockPath, token);
  throw new LifecycleLockBusyError(lockPath, "lost a stale-lock race with another lifecycle process");
}

/** Run task with the lifecycle lock held; the lock releases in `finally`. */
export async function withLifecycleLock<T>(
  command: string,
  task: () => Promise<T> | T,
  home: string = getConfigDir(),
): Promise<T> {
  const lock = acquireLifecycleLock(command, home);
  try {
    return await task();
  } finally {
    lock.release();
  }
}

// ---------------------------------------------------------------------------
// Expected-ownership contract for Launcher-controlled uninstall.
//
// The Launcher proves routing ownership in its own process (G1 canonical
// config authority) and passes that proof as CLI flags. Core validates the
// proof AFTER acquiring the lifecycle lock and BEFORE any destructive
// mutation: read -> compare -> mutate. Manual CLI uninstall without expected
// flags keeps existing usability (lock, read under lock, uninstall that
// state). These values are internal Launcher-control provenance, never
// renderer authority.
// ---------------------------------------------------------------------------

export type ExpectedInstallationKind = "configured" | "missing";
export type ExpectedIntegrationMode = "direct" | "external-provider";

export interface ExpectedLifecycleOwnership {
  kind: ExpectedInstallationKind;
  integrationMode?: ExpectedIntegrationMode;
}

/**
 * Validate raw CLI expected-ownership flags (allowlisted only). Returns
 * undefined when no expectation was supplied (manual CLI). Duplicate flags
 * are rejected by the CLI parser's normal unknown-argument handling, since
 * each occurrence is consumed only once.
 */
export function parseExpectedLifecycleOwnership(options: {
  kind?: string;
  mode?: string;
}): ExpectedLifecycleOwnership | undefined {
  const { kind, mode } = options;
  if (kind === undefined && mode === undefined) return undefined;
  if (kind !== "configured" && kind !== "missing") {
    throw new Error("--expected-installation-kind must be configured or missing");
  }
  if (mode !== undefined && mode !== "direct" && mode !== "external-provider") {
    throw new Error("--expected-integration-mode must be direct or external-provider");
  }
  if (kind === "configured" && mode === undefined) {
    throw new Error("--expected-integration-mode is required with --expected-installation-kind configured");
  }
  if (kind === "missing" && mode !== undefined) {
    throw new Error("--expected-integration-mode cannot accompany --expected-installation-kind missing");
  }
  return mode === undefined ? { kind } : { kind, integrationMode: mode };
}

export type ActualLifecycleOwnership =
  | { kind: "missing" }
  | { kind: "configured"; integrationMode: IntegrationMode; config: AppConfig };

/**
 * Read canonical lifecycle state. Missing is explicit; a present-but-broken
 * config fails closed as damaged (never a silent Direct default).
 * Callers must invoke this AFTER acquiring the lifecycle lock.
 */
export function readActualLifecycleOwnership(): ActualLifecycleOwnership {
  const path = getConfigPath();
  if (!existsSync(path)) return { kind: "missing" };
  let config: AppConfig;
  try {
    config = loadConfig();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Refusing lifecycle mutation: runtime configuration is damaged and cannot prove ownership (${detail})`);
  }
  return { kind: "configured", integrationMode: config.integrationMode, config };
}

function describeExpected(expected: ExpectedLifecycleOwnership): string {
  return expected.kind === "missing" ? "missing" : `configured ${expected.integrationMode}`;
}

function describeActual(actual: ActualLifecycleOwnership): string {
  return actual.kind === "missing" ? "missing" : `configured ${actual.integrationMode}`;
}

/**
 * Require the under-lock canonical state to still match the Launcher-proved
 * expectation. Any drift (including to/from missing) fails closed before
 * mutation; drift is never migration.
 */
export function assertLifecycleOwnershipMatch(
  expected: ExpectedLifecycleOwnership,
  actual: ActualLifecycleOwnership,
  operation: string,
): void {
  const matches = expected.kind === actual.kind
    && (expected.kind === "missing"
      || (actual.kind === "configured" && expected.integrationMode === actual.integrationMode));
  if (!matches) {
    throw new Error(
      `Lifecycle ownership changed during ${operation}: expected ${describeExpected(expected)} but found ${describeActual(actual)}; retry the operation`,
    );
  }
}

