import { createHash } from "node:crypto";
import { appendFileSync, closeSync, openSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";

/**
 * Internal metadata-only observability for the launcher browser-helper path.
 *
 * Controlled acceptance needs to prove that public visible reasoning flows from DOM
 * extraction through the helper process boundary intact, without replacing the helper
 * executable or touching the helper protocol. This module is the entire feature: an
 * explicit opt-in side channel that records one metadata receipt per reasoning fragment
 * at three boundaries (public extraction, helper emission, daemon reception).
 *
 * Opt-in is process-local through CODEX_CHATGPT_WEB_HELPER_OBSERVABILITY_DIR. The daemon
 * spawn inherits process.env into the helper, so the exact production serve path picks the
 * opt-in up with no config-schema change. When the variable is unset or empty the module
 * is a strict no-op: no filesystem access, no hashing, no protocol or behavior change.
 *
 * Receipts never persist reasoning text, prompts, answers, credentials, or environment
 * contents; only identity/order metadata plus a SHA-256 digest over the exact UTF-8 bytes
 * received at that boundary. When the opt-in is enabled but unusable, every entry point
 * throws so acceptance fails closed instead of silently observing no reasoning.
 */
export const CHATGPT_WEB_HELPER_OBSERVABILITY_ENV = "CODEX_CHATGPT_WEB_HELPER_OBSERVABILITY_DIR";

const HELPER_PROCESS_ENV = "CODEX_CHATGPT_WEB_BROWSER_HELPER_PROCESS";
const RECEIPT_VERSION = 1;
const RECEIPT_FILE_MODE = 0o600;
const TRACE_ID_PATTERN = /^[A-Za-z0-9_-]{6,128}$/;

export type HelperObservabilityStage = "public_reasoning" | "helper_emit" | "daemon_receive";
export type HelperObservabilityRole = "helper" | "daemon";

export interface HelperObservabilityReceipt {
  version: 1;
  stage: HelperObservabilityStage;
  role: HelperObservabilityRole;
  pid: number;
  traceId: string;
  event: "reasoning";
  seq: number;
  timestamp: string;
  continuation: boolean;
  charLength: number;
  byteLength: number;
  sha256: string;
}

/** Process role follows the same marker the daemon spawn uses to select the helper path. */
export function helperObservabilityRole(): HelperObservabilityRole {
  return process.env[HELPER_PROCESS_ENV] === "1" ? "helper" : "daemon";
}
function resolveDirectory(): string | undefined {
  const raw = process.env[CHATGPT_WEB_HELPER_OBSERVABILITY_ENV];
  if (raw === undefined) return undefined;
  const directory = raw.trim();
  if (!directory) return undefined;
  if (!isAbsolute(directory)) {
    throw new Error(
      "ChatGPT web helper observability directory must be an absolute path " +
        "(" + CHATGPT_WEB_HELPER_OBSERVABILITY_ENV + ")",
    );
  }
  let usable = false;
  try {
    usable = statSync(directory).isDirectory();
  } catch (error) {
    throw new Error(
      "ChatGPT web helper observability directory is not usable: " +
        (error instanceof Error ? error.message : String(error)),
    );
  }
  if (!usable) {
    throw new Error("ChatGPT web helper observability path is not a directory: " + directory);
  }
  return directory;
}

class HelperObservabilitySink {
  private seq = 0;

  constructor(
    readonly role: HelperObservabilityRole,
    private readonly filePath: string,
  ) {}

  record(stage: HelperObservabilityStage, traceId: string, text: string, continuation: boolean): void {
    if (typeof traceId !== "string" || !TRACE_ID_PATTERN.test(traceId)) {
      throw new Error("ChatGPT web helper observability trace identity is invalid");
    }
    if (typeof text !== "string") {
      throw new Error("ChatGPT web helper observability reasoning payload is invalid");
    }
    // Digest over the exact UTF-8 bytes as received: no trim, no normalization, no joining
    // of continuations. Each callback/frame is recorded separately so segmentation stays visible.
    const sha256 = createHash("sha256").update(text, "utf8").digest("hex");
    this.seq += 1;
    const receipt: HelperObservabilityReceipt = {
      version: RECEIPT_VERSION,
      stage,
      role: this.role,
      pid: process.pid,
      traceId,
      event: "reasoning",
      seq: this.seq,
      timestamp: new Date().toISOString(),
      continuation,
      charLength: Array.from(text).length,
      byteLength: Buffer.byteLength(text, "utf8"),
      sha256,
    };
    try {
      appendFileSync(this.filePath, JSON.stringify(receipt) + "\n", { mode: RECEIPT_FILE_MODE });
    } catch (error) {
      throw new Error(
        "ChatGPT web helper observability receipt could not be recorded (" + stage + "): " +
          (error instanceof Error ? error.message : String(error)),
      );
    }
  }
}
const sinks = new Map<HelperObservabilityRole, HelperObservabilitySink | undefined>();

function receiptFileName(role: HelperObservabilityRole): string {
  // Internally generated from the numeric pid only; no caller-controlled path content.
  return role + "-" + String(process.pid) + ".jsonl";
}

/**
 * Resolve (and cache) the process sink. Undefined when the opt-in is disabled; throws
 * when it is enabled but unusable. Resolution truncates any stale file for this process so
 * a fresh process never inherits ambiguous sequence numbers from a previous pid reuse.
 */
export function resolveHelperObservabilitySink(
  role: HelperObservabilityRole = helperObservabilityRole(),
): HelperObservabilitySink | undefined {
  if (sinks.has(role)) return sinks.get(role);
  const directory = resolveDirectory();
  if (directory === undefined) {
    sinks.set(role, undefined);
    return undefined;
  }
  const filePath = join(directory, receiptFileName(role));
  try {
    const fd = openSync(filePath, "w", RECEIPT_FILE_MODE);
    closeSync(fd);
  } catch (error) {
    throw new Error(
      "ChatGPT web helper observability receipt file could not be initialized: " +
        (error instanceof Error ? error.message : String(error)),
    );
  }
  const sink = new HelperObservabilitySink(role, filePath);
  sinks.set(role, sink);
  return sink;
}

/**
 * Fail-closed preflight: call before turn execution (daemon) or readiness (helper) so an
 * explicitly enabled but unusable sink can never degrade into "no reasoning observed".
 */
export function ensureHelperObservabilitySink(): void {
  resolveHelperObservabilitySink();
}

/**
 * Record one metadata-only reasoning receipt. No-op when disabled; throws when enabled
 * but misconfigured or unwritable so the observed turn fails instead of losing evidence.
 */
export function recordHelperReasoning(
  stage: HelperObservabilityStage,
  traceId: string,
  text: string,
  continuation: boolean,
): void {
  const sink = resolveHelperObservabilitySink();
  if (!sink) return;
  sink.record(stage, traceId, text, continuation);
}

/** Test-only: clears cached sinks so tests can reconfigure the opt-in between cases. */
export function resetHelperObservabilityForTests(): void {
  sinks.clear();
}
