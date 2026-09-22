import { createHash } from "node:crypto";
import { namespacedToolName } from "../../types";
import type { CodexRequestOptions, CodexTool } from "../../types";

export const EXTERNAL_EXECUTION_CONTRACT_VERSION = "external-exec-v1" as const;

export interface ExternalExecutionContractV1 {
  readonly v: typeof EXTERNAL_EXECUTION_CONTRACT_VERSION;
  readonly clientId: string;
  readonly routeSlug: string;
  readonly adapterEffort: string;
  readonly hideThinkingSummary: boolean;
  readonly verbosity: "low" | "medium" | "high" | null;
  readonly outputFormatDigest: string | null;
  readonly inputDigest: string;
  readonly instructionsDigest: string;
  readonly toolsDigest: string;
}

export interface ExternalRequestIdentity {
  readonly requestKey: string;
  readonly executionKey: string;
  readonly roundKey: string;
  readonly retryKey: string;
  readonly ownerKey: string;
  readonly traceId: string;
}

function sha256Hex(payload: string): string {
  return createHash("sha256").update(payload, "utf8").digest("hex");
}

function toJsonString(value: unknown): string {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new Error("External execution contract value is not JSON-serializable");
  }
  if (serialized === undefined) {
    return "null";
  }
  return serialized;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
function canonicalizeValue(value: unknown, seen: Set<object>): unknown {
  if (value === null) {
    return null;
  }
  const kind: string = typeof value;
  if (kind === "string" || kind === "boolean") {
    return value;
  }
  if (kind === "number") {
    if (!Number.isFinite(value as number)) {
      throw new Error("External execution contract value is not JSON-serializable");
    }
    return value;
  }
  if (kind === "undefined" || kind === "function" || kind === "symbol" || kind === "bigint") {
    throw new Error("External execution contract value is not JSON-serializable");
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) {
      throw new Error("External execution contract value is not JSON-serializable");
    }
    seen.add(value);
    try {
      const out: unknown[] = [];
      for (const entry of value) {
        out.push(canonicalizeValue(entry, seen));
      }
      return out;
    } finally {
      seen.delete(value);
    }
  }
  if (isPlainRecord(value)) {
    if (seen.has(value)) {
      throw new Error("External execution contract value is not JSON-serializable");
    }
    seen.add(value);
    try {
      const keys: string[] = Object.keys(value).sort();
      const out: Record<string, unknown> = {};
      for (const key of keys) {
        const entry: unknown = (value as Record<string, unknown>)[key];
        if (entry === undefined || typeof entry === "function" || typeof entry === "symbol" || typeof entry === "bigint") {
          throw new Error("External execution contract value is not JSON-serializable");
        }
        out[key] = canonicalizeValue(entry, seen);
      }
      return out;
    } finally {
      seen.delete(value);
    }
  }
  throw new Error("External execution contract value is not JSON-serializable");
}

function canonicalizeJson(value: unknown): unknown {
  return canonicalizeValue(value, new Set());
}
interface CanonicalToolEntry {
  readonly wireName: string;
  readonly name: string;
  readonly namespace: string | null;
  readonly description: string;
  readonly strict: boolean | null;
  readonly freeform: boolean;
  readonly toolSearch: boolean;
  readonly parameters: unknown;
}

function toCanonicalTool(tool: CodexTool): CanonicalToolEntry {
  return {
    wireName: namespacedToolName(tool.namespace, tool.name),
    name: tool.name,
    namespace: tool.namespace ?? null,
    description: tool.description,
    strict: tool.strict ?? null,
    freeform: tool.freeform === true,
    toolSearch: tool.toolSearch === true,
    parameters: canonicalizeJson(tool.parameters ?? {}),
  };
}
function buildToolsDigest(tools: readonly CodexTool[] | undefined): string {
  if (!tools || tools.length === 0) {
    return sha256Hex("[]");
  }
  const canonical: CanonicalToolEntry[] = tools.map((tool) => toCanonicalTool(tool));
  canonical.sort((a, b) => {
    if (a.wireName < b.wireName) {
      return -1;
    }
    if (a.wireName > b.wireName) {
      return 1;
    }
    const aText: string = toJsonString(a);
    const bText: string = toJsonString(b);
    if (aText < bText) {
      return -1;
    }
    if (aText > bText) {
      return 1;
    }
    return 0;
  });
  return sha256Hex(toJsonString(canonical));
}

function buildOutputFormatDigest(outputFormat: CodexRequestOptions["outputFormat"]): string | null {
  if (!outputFormat) {
    return null;
  }
  const canonical = {
    name: outputFormat.name,
    schema: canonicalizeJson(outputFormat.schema),
    strict: outputFormat.strict,
    type: outputFormat.type,
  };
  return sha256Hex(toJsonString(canonical));
}
export function buildExternalExecutionContract(input: {
  clientId: string;
  routeSlug: string;
  adapterEffort: string;
  hideThinkingSummary: boolean;
  verbosity?: "low" | "medium" | "high";
  outputFormat?: CodexRequestOptions["outputFormat"];
  systemPrompt: readonly string[];
  tools: readonly CodexTool[] | undefined;
  expandedInput: unknown;
}): ExternalExecutionContractV1 {
  return {
    v: EXTERNAL_EXECUTION_CONTRACT_VERSION,
    clientId: input.clientId,
    routeSlug: input.routeSlug,
    adapterEffort: input.adapterEffort,
    hideThinkingSummary: input.hideThinkingSummary,
    verbosity: input.verbosity ?? null,
    outputFormatDigest: buildOutputFormatDigest(input.outputFormat),
    inputDigest: sha256Hex(toJsonString(input.expandedInput)),
    instructionsDigest: sha256Hex(toJsonString(input.systemPrompt)),
    toolsDigest: buildToolsDigest(input.tools),
  };
}
export function externalRequestKey(contract: ExternalExecutionContractV1): string {
  return sha256Hex(
    toJsonString([
      contract.v,
      contract.clientId,
      contract.routeSlug,
      contract.adapterEffort,
      contract.hideThinkingSummary,
      contract.verbosity,
      contract.outputFormatDigest,
      contract.inputDigest,
      contract.instructionsDigest,
      contract.toolsDigest,
    ]),
  );
}

export function externalTraceId(namespace: string, requestKey: string): string {
  if (typeof namespace !== "string" || namespace.length === 0) {
    throw new Error("External request namespace must be non-empty");
  }
  if (typeof requestKey !== "string" || requestKey.length === 0) {
    throw new Error("External request namespace must be non-empty");
  }
  return sha256Hex(toJsonString(["external-trace-v1", namespace, requestKey])).slice(0, 12);
}
export function buildExternalRequestIdentity(
  namespace: string,
  contract: ExternalExecutionContractV1,
): ExternalRequestIdentity {
  if (typeof namespace !== "string" || namespace.length === 0) {
    throw new Error("External request namespace must be non-empty");
  }
  const requestKey: string = externalRequestKey(contract);
  const scoped: string = [namespace, requestKey].join(":");
  return {
    requestKey,
    executionKey: scoped,
    roundKey: requestKey,
    retryKey: scoped,
    ownerKey: scoped,
    traceId: externalTraceId(namespace, requestKey),
  };
}

/**
 * Server wiring notes (no behavior change).
 *
 * expandedInput is the timestamp-free canonical Responses wire input taken directly
 * from the validated raw request body. It is never the parsed Codex message list,
 * because the parser stamps runtime timestamps that must not enter request identity.
 *
 * Identical V1 execution contracts intentionally share one content-addressed request
 * identity. That is exact-retry semantics, not a collision.
 *
 * Any change to key material or canonicalization requires a contract-version bump.
 * V1 semantics must never be reinterpreted in place.
 */
