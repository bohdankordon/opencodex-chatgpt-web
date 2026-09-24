import { expect, test } from "bun:test";
import {
  estimateChatGptWebInputTokens,
  estimateChatGptWebUsage,
  resolveBiggerContextMultipartParts,
  shouldCaptureLunaCheckpoint,
} from "../src/adapters/chatgpt-web/usage";
import { compileChatGptWebPrompt } from "../src/adapters/chatgpt-web/prompt";
import { compiledChatGptWebMessages, estimateChatGptWebImageTokens, estimateCompiledChatGptWebInputTokens } from "../src/adapters/chatgpt-web/input-tokens";
import { assertChatGptWebMultipartInputWithinLimits, resolveChatGptWebMultipartStagingMode } from "../src/adapters/chatgpt-web/browser-worker";
import { estimateTokens } from "../src/lib/token-estimate";
import { CHATGPT_WEB_LUNA_MODEL_ID } from "../src/adapters/chatgpt-web/model";
import { CHATGPT_LUNA_CHECKPOINT_MARKER } from "../src/adapters/chatgpt-web/rolling-checkpoint";
import type { ExternalRequestIdentity } from "../src/adapters/chatgpt-web/external-identity";
import type { CodexParsedRequest } from "../src/types";

const capabilities = { localToolsEnabled: false, solAvailable: true, extraHighAvailable: true, proAvailable: true };
const lunaCapabilities = { localToolsEnabled: false, solAvailable: false, extraHighAvailable: false, proAvailable: false };

function request(text: string): CodexParsedRequest {
  return {
    modelId: "gpt-5.6-sol",
    stream: false,
    context: { messages: [{ role: "user", content: text, timestamp: 1 }] },
    options: { reasoning: "high" },
  };
}

function externalIdentity(): ExternalRequestIdentity {
  const key = "r".repeat(64);
  return {
    requestKey: key,
    executionKey: "ns:" + key,
    roundKey: key,
    retryKey: "ns:" + key,
    ownerKey: "ns:" + key,
    traceId: "trace-external",
  };
}

function nativeIdentityBody(): Record<string, unknown> {
  return {
    client_metadata: {
      "x-codex-turn-metadata": JSON.stringify({ thread_id: "thread_native", turn_id: "turn_native" }),
    },
  };
}

/**
 * Observe native identity-material reads without mocks: extractChatGptTurnIdentity
 * reaches parsed._rawBody, so a counting getter proves whether the helper ran.
 * Usage estimation otherwise never touches _rawBody, so a zero count is meaningful.
 */
function observableRawBody(parsed: CodexParsedRequest, backing: unknown): () => number {
  let reads = 0;
  let value = backing;
  Object.defineProperty(parsed, "_rawBody", {
    enumerable: true,
    configurable: true,
    get: () => { reads += 1; return value; },
    set: (next: unknown) => { value = next; },
  });
  return () => reads;
}

test("external Sol usage estimation never evaluates native identity material", () => {
  const parsed = request("external sol probe");
  parsed._externalRequestIdentity = externalIdentity();
  const rawBodyReads = observableRawBody(parsed, nativeIdentityBody());
  expect(shouldCaptureLunaCheckpoint(parsed)).toBe(false);
  expect(rawBodyReads()).toBe(0);
  const inputTokens = estimateChatGptWebInputTokens(parsed, capabilities);
  expect(Number.isFinite(inputTokens)).toBe(true);
  expect(rawBodyReads()).toBe(0);
  const usage = estimateChatGptWebUsage(parsed, { answer: "ok" }, capabilities);
  expect(usage.inputTokens).toBe(inputTokens);
  expect(rawBodyReads()).toBe(0);
});

test("impossible external Luna state fails closed before native identity extraction", () => {
  const parsed: CodexParsedRequest = {
    modelId: CHATGPT_WEB_LUNA_MODEL_ID,
    stream: false,
    context: { messages: [{ role: "user", content: "external luna probe", timestamp: 1 }] },
    options: { reasoning: "low" },
    _externalRequestIdentity: externalIdentity(),
  };
  const rawBodyReads = observableRawBody(parsed, nativeIdentityBody());
  expect(shouldCaptureLunaCheckpoint(parsed)).toBe(false);
  expect(rawBodyReads()).toBe(0);
  const inputTokens = estimateChatGptWebInputTokens(parsed, lunaCapabilities);
  expect(Number.isFinite(inputTokens)).toBe(true);
  expect(rawBodyReads()).toBe(0);
});

test("native non-Luna usage estimation skips native identity extraction", () => {
  const parsed = request("native sol probe");
  const rawBodyReads = observableRawBody(parsed, nativeIdentityBody());
  expect(shouldCaptureLunaCheckpoint(parsed)).toBe(false);
  expect(rawBodyReads()).toBe(0);
  expect(Number.isFinite(estimateChatGptWebInputTokens(parsed, capabilities))).toBe(true);
  expect(rawBodyReads()).toBe(0);
});

test("native Luna checkpoint semantics survive lazy identity extraction", () => {
  const normal: CodexParsedRequest = {
    modelId: CHATGPT_WEB_LUNA_MODEL_ID,
    stream: false,
    context: { messages: [{ role: "user", content: "native luna probe", timestamp: 1 }] },
    options: { reasoning: "low" },
  };
  const normalReads = observableRawBody(normal, nativeIdentityBody());
  expect(shouldCaptureLunaCheckpoint(normal)).toBe(true);
  expect(normalReads()).toBeGreaterThan(0);
  const estimated = estimateChatGptWebInputTokens(normal, lunaCapabilities);
  const withCheckpoint = estimateCompiledChatGptWebInputTokens(
    compileChatGptWebPrompt(normal, lunaCapabilities, undefined, { captureLunaCheckpoint: true }),
    CHATGPT_WEB_LUNA_MODEL_ID,
  );
  const withoutCheckpoint = estimateCompiledChatGptWebInputTokens(
    compileChatGptWebPrompt(normal, lunaCapabilities, undefined, { captureLunaCheckpoint: false }),
    CHATGPT_WEB_LUNA_MODEL_ID,
  );
  expect(estimated).toBe(withCheckpoint);
  expect(estimated).not.toBe(withoutCheckpoint);
  expect(compileChatGptWebPrompt(normal, lunaCapabilities, undefined, { captureLunaCheckpoint: true }).text)
    .toContain(CHATGPT_LUNA_CHECKPOINT_MARKER);

  const missing: CodexParsedRequest = {
    modelId: CHATGPT_WEB_LUNA_MODEL_ID,
    stream: false,
    context: { messages: [{ role: "user", content: "native luna probe", timestamp: 1 }] },
    options: { reasoning: "low" },
    _rawBody: {},
  };
  expect(shouldCaptureLunaCheckpoint(missing)).toBe(false);
  expect(compileChatGptWebPrompt(missing, lunaCapabilities, undefined, { captureLunaCheckpoint: false }).text)
    .not.toContain(CHATGPT_LUNA_CHECKPOINT_MARKER);

  const compaction: CodexParsedRequest = {
    modelId: CHATGPT_WEB_LUNA_MODEL_ID,
    stream: false,
    context: { messages: [{ role: "user", content: "native luna probe", timestamp: 1 }] },
    options: { reasoning: "low" },
    _compactionRequest: true,
  };
  const compactionReads = observableRawBody(compaction, nativeIdentityBody());
  expect(shouldCaptureLunaCheckpoint(compaction)).toBe(false);
  expect(compactionReads()).toBe(0);
});

test("native identity extraction in usage.ts lives only behind the Luna/native guard", async () => {
  const source = await Bun.file(new URL("../src/adapters/chatgpt-web/usage.ts", import.meta.url)).text();
  const callSites = source.split("extractChatGptTurnIdentity(").length - 1;
  expect(callSites).toBe(1);
  const guardStart = source.indexOf("export function shouldCaptureLunaCheckpoint");
  expect(guardStart).toBeGreaterThanOrEqual(0);
  const callIndex = source.indexOf("extractChatGptTurnIdentity(");
  expect(callIndex).toBeGreaterThan(guardStart);
  const externalGuard = source.indexOf("_externalRequestIdentity", guardStart);
  const modelGuard = source.indexOf("CHATGPT_WEB_LUNA_MODEL_ID", guardStart);
  const compactionGuard = source.indexOf("_compactionRequest", guardStart);
  expect(externalGuard).toBeGreaterThan(guardStart);
  expect(modelGuard).toBeGreaterThan(guardStart);
  expect(compactionGuard).toBeGreaterThan(guardStart);
  expect(externalGuard).toBeLessThan(callIndex);
  expect(modelGuard).toBeLessThan(callIndex);
  expect(compactionGuard).toBeLessThan(callIndex);
});

test.each([
  ["highly compressible", "a".repeat(480_000)],
  ["ordinary repeated words", `${"word ".repeat(79_999)}word`],
])("%s context uses tokenizer-derived usage without character-pressure inflation", (_label, text) => {
  expect(estimateChatGptWebInputTokens(request(text), capabilities)).toBeLessThan(100_000);
}, 15_000);

test("multipart selection accounts for whole-record and composer fit before submission", () => {
  const plus = { ...capabilities, extraHighAvailable: false, proAvailable: false };
  for (const [contents, expected] of [
    [["small task"], undefined],
    [[50_000, 40_000, 50_000, 5_000].map(n => "word ".repeat(n)), 6],
    [Array.from({ length: 3 }, () => " ".repeat(450_000)), 2],
  ] as const) {
    const parsed = request("");
    parsed.context.messages = contents.map((content, index) => ({ role: "user", content, timestamp: index + 1 }));
    const parts = resolveBiggerContextMultipartParts(parsed, plus);
    expect(parts).toBe(expected);
    const compiled = compileChatGptWebPrompt(parsed, plus, undefined, { experimentalMultipartParts: parts });
    if (parts) {
      expect(compiled.multipart!.parts.flatMap(part => JSON.parse(part).records).map(record => record.message.content))
        .toEqual([...contents]);
    }
  }
  // Low-token text can still exceed the reasoning model's server character ceiling.
  // Stage the complete record instead of sending it inline or dropping its contents.
  const sparsePro = request("x".repeat(600_000));
  expect(resolveBiggerContextMultipartParts(sparsePro, capabilities)).toBe(2);
  const stagedPro = compileChatGptWebPrompt(sparsePro, capabilities, undefined, { experimentalMultipartParts: 2 });
  expect(stagedPro.multipart!.parts.flatMap(part => JSON.parse(part).records).map(record => record.message.content))
    .toEqual([sparsePro.context.messages[0]!.content]);
  const proMessages = compiledChatGptWebMessages(stagedPro);
  expect(proMessages[1]!.length).toBeLessThanOrEqual(500_000);
  expect(resolveChatGptWebMultipartStagingMode(
    "gpt-5.6-sol", capabilities, estimateTokens(proMessages[0]!), proMessages[0]!.length,
  ).effort).toBe("max");
}, 60_000);

test("Bigger Context compaction selects six parts before the legacy inline byte budget", () => {
  const parsed = request("x".repeat(160_000));
  parsed._compactionRequest = true;
  const parts = resolveBiggerContextMultipartParts(parsed, capabilities);
  expect(parts).toBe(6);
  const compiled = compileChatGptWebPrompt(parsed, capabilities, undefined, { experimentalMultipartParts: parts });
  expect(compiled.trimmedCompactionMessages).toBeUndefined();
  expect(compiled.multipart!.parts.flatMap(part => JSON.parse(part).records).map(record => record.message.content))
    .toEqual([parsed.context.messages[0]!.content]);
});

test("multipart planning leaves room for final attachments and execution instructions without losing history", () => {
  for (const scenario of [
    { extraHighAvailable: false, proAvailable: false, images: 3, schema: false },
    { extraHighAvailable: true, proAvailable: true, images: 10, schema: false },
    { extraHighAvailable: false, proAvailable: false, images: 0, schema: true },
  ]) {
    const caps = { ...capabilities, proAvailable: scenario.proAvailable };
    const parsed = request("");
    const texts = Array.from({ length: 36 }, (_, index) => `record ${index}: ${"word ".repeat(5_000)}`);
    parsed.context.messages = texts.map((content, index) => ({ role: "user", content, timestamp: index + 1 }));
    const images = Array.from({ length: scenario.images }, (_, index) => ({
      type: "image" as const, imageUrl: `data:image/png;base64,partition-image-${index}`, detail: "original" as const,
    }));
    if (images.length) parsed.context.messages.push({ role: "user", content: images, timestamp: 37 });
    if (scenario.schema) parsed.options.outputFormat = {
      type: "json_schema", name: "result", strict: true, schema: { type: "string", description: "schema ".repeat(24_000) },
    };
    const compiled = compileChatGptWebPrompt(parsed, caps, undefined, { experimentalMultipartParts: 6 });
    const records = compiled.multipart!.parts.flatMap(part => JSON.parse(part).records);
    expect(records.map(record => record.message_index)).toEqual(parsed.context.messages.map((_, index) => index));
    expect(records.slice(0, texts.length).map(record => record.message.content)).toEqual(texts);
    expect(compiled.images.map(image => ({ imageUrl: image.imageUrl, detail: image.detail })))
      .toEqual(images.map(image => ({ imageUrl: image.imageUrl, detail: image.detail })));
    if (scenario.schema) expect(compiled.multipart!.commit).toContain(JSON.stringify(parsed.options.outputFormat!.schema));
    const messages = compiledChatGptWebMessages(compiled);
    const tokens = messages.map(text => estimateTokens(text));
    const chars = messages.map(text => text.length);
    const maxStageMessageTokens = Math.max(...tokens.slice(0, -1));
    const maxStageChars = Math.max(...chars.slice(0, -1));
    const stage = resolveChatGptWebMultipartStagingMode(parsed.modelId, caps, maxStageMessageTokens, maxStageChars);
    expect(() => assertChatGptWebMultipartInputWithinLimits(
      estimateCompiledChatGptWebInputTokens(compiled, parsed.modelId), Math.max(...tokens),
      parsed.modelId, "high", caps, Math.max(...chars), 6,
      { stagingEffort: stage.effort, maxStageMessageTokens, maxStageChars, finalMessageTokens: tokens.at(-1)!, finalMessageChars: chars.at(-1)!, finalImageTokens: estimateChatGptWebImageTokens(compiled) },
    )).not.toThrow();
  }
}, 30_000);
