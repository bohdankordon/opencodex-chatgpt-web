import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildExternalExecutionContract,
  buildExternalRequestIdentity,
  externalRequestKey,
  externalTraceId,
  EXTERNAL_EXECUTION_CONTRACT_VERSION,
} from "../src/adapters/chatgpt-web/external-identity";
import type { ExternalExecutionContractV1 } from "../src/adapters/chatgpt-web/external-identity";
import { parseRequest } from "../src/responses/parser";
import type { CodexRequestOptions, CodexTool } from "../src/types";

const NEWLINE = String.fromCharCode(10);

function isLowerHex(value: string, length: number): boolean {
  if (value.length !== length) {
    return false;
  }
  for (const ch of value) {
    const digit = ch >= "0" && ch <= "9";
    const lower = ch >= "a" && ch <= "f";
    if (!digit && !lower) {
      return false;
    }
  }
  return true;
}

interface BaseOverrides {
  clientId?: string;
  routeSlug?: string;
  adapterEffort?: string;
  hideThinkingSummary?: boolean;
  verbosity?: "low" | "medium" | "high";
  outputFormat?: CodexRequestOptions["outputFormat"];
  systemPrompt?: string[];
  tools?: readonly CodexTool[] | undefined;
  expandedInput?: unknown;
}

function baseInput(overrides: BaseOverrides = {}) {
  return {
    clientId: "hermes-local",
    routeSlug: "chatgpt-web/medium",
    adapterEffort: "medium",
    hideThinkingSummary: false,
    systemPrompt: ["You are helpful."],
    tools: undefined as readonly CodexTool[] | undefined,
    expandedInput: [{ text: "Hello" }],
    ...overrides,
  };
}

function baseTool(overrides: Partial<CodexTool> = {}): CodexTool {
  return {
    name: "get_weather",
    description: "Look up the weather.",
    parameters: { type: "object", properties: {} },
    ...overrides,
  };
}

function jsonSchemaFormat(schema: unknown) {
  return {
    type: "json_schema" as const,
    name: "answer",
    strict: true,
    schema,
  };
}

function wireBody(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    model: "chatgpt-web/medium",
    stream: false,
    input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: "Hello" }] },
    ],
    ...extra,
  };
}

function contractFromWire(
  body: Record<string, unknown>,
  overrides: { clientId?: string; routeSlug?: string; adapterEffort?: string } = {},
) {
  const parsed = parseRequest(body);
  const messages = parsed.context.messages as unknown as Array<Record<string, unknown>>;
  const expandedInput = messages.map((message) => ({ ...(message as object), timestamp: 0 }));
  const contract = buildExternalExecutionContract({
    clientId: overrides.clientId ?? "hermes-local",
    routeSlug: overrides.routeSlug ?? "chatgpt-web/medium",
    adapterEffort: overrides.adapterEffort ?? "medium",
    hideThinkingSummary: parsed.options.hideThinkingSummary === true,
    verbosity: parsed.options.verbosity,
    outputFormat: parsed.options.outputFormat,
    systemPrompt: parsed.context.systemPrompt ?? [],
    tools: parsed.context.tools,
    expandedInput,
  });
  return { parsed, contract, key: externalRequestKey(contract) };
}

test("contract version literal is the frozen V1 namespace", () => {
  expect(EXTERNAL_EXECUTION_CONTRACT_VERSION).toBe("external-exec-v1");
  const contract = buildExternalExecutionContract(baseInput());
  expect(contract.v).toBe("external-exec-v1");
});

test("1 - same inputs built twice give equal contracts and the same request key", () => {
  const first = buildExternalExecutionContract(baseInput());
  const second = buildExternalExecutionContract(structuredClone(baseInput()));
  expect(second).toEqual(first);
  expect(externalRequestKey(second)).toBe(externalRequestKey(first));
  expect(isLowerHex(externalRequestKey(first), 64)).toBe(true);
});

test("2 - different clientId gives a different key", () => {
  const a = buildExternalExecutionContract(baseInput({ clientId: "hermes-local" }));
  const b = buildExternalExecutionContract(baseInput({ clientId: "hermes-second" }));
  expect(externalRequestKey(a)).not.toBe(externalRequestKey(b));
});

test("3 - different routeSlug gives a different key", () => {
  const a = buildExternalExecutionContract(baseInput({ routeSlug: "chatgpt-web/medium" }));
  const b = buildExternalExecutionContract(baseInput({ routeSlug: "chatgpt-web/high" }));
  expect(externalRequestKey(a)).not.toBe(externalRequestKey(b));
});

test("4 - different resolved adapterEffort gives a different key", () => {
  const a = buildExternalExecutionContract(baseInput({ adapterEffort: "medium" }));
  const b = buildExternalExecutionContract(baseInput({ adapterEffort: "high" }));
  expect(externalRequestKey(a)).not.toBe(externalRequestKey(b));
});

test("5 - different expanded input gives a different inputDigest and key", () => {
  const a = buildExternalExecutionContract(baseInput({ expandedInput: [{ text: "Hello" }] }));
  const b = buildExternalExecutionContract(baseInput({ expandedInput: [{ text: "Goodbye" }] }));
  expect(a.inputDigest).not.toBe(b.inputDigest);
  expect(externalRequestKey(a)).not.toBe(externalRequestKey(b));
  expect(isLowerHex(a.inputDigest, 64)).toBe(true);
});

test("6 - different instructions give a different instructionsDigest and key", () => {
  const a = buildExternalExecutionContract(baseInput({ systemPrompt: ["You are helpful."] }));
  const b = buildExternalExecutionContract(baseInput({ systemPrompt: ["You are strict."] }));
  expect(a.instructionsDigest).not.toBe(b.instructionsDigest);
  expect(externalRequestKey(a)).not.toBe(externalRequestKey(b));
});

test("7 - instruction boundary collision guard", () => {
  const joined = "a" + NEWLINE + "b";
  const a = buildExternalExecutionContract(baseInput({ systemPrompt: ["a", "b"] }));
  const b = buildExternalExecutionContract(baseInput({ systemPrompt: [joined] }));
  expect(a.instructionsDigest).not.toBe(b.instructionsDigest);
  expect(externalRequestKey(a)).not.toBe(externalRequestKey(b));
});

test("8 - different tools give a different toolsDigest and key", () => {
  const a = buildExternalExecutionContract(baseInput({ tools: [baseTool()] }));
  const b = buildExternalExecutionContract(baseInput({ tools: [baseTool({ name: "other_tool" })] }));
  expect(a.toolsDigest).not.toBe(b.toolsDigest);
  expect(externalRequestKey(a)).not.toBe(externalRequestKey(b));
});

test("9 - same tools in different array order give the same digest and key", () => {
  const first = [baseTool(), baseTool({ name: "second_tool", description: "Second." })];
  const reordered = [first[1], first[0]];
  const a = buildExternalExecutionContract(baseInput({ tools: first }));
  const b = buildExternalExecutionContract(baseInput({ tools: reordered }));
  expect(b.toolsDigest).toBe(a.toolsDigest);
  expect(externalRequestKey(b)).toBe(externalRequestKey(a));
  expect(first[0].name).toBe("get_weather");
});

test("10 - namespaced versus plain tool with the same name differ", () => {
  const plain = buildExternalExecutionContract(baseInput({ tools: [baseTool()] }));
  const namespaced = buildExternalExecutionContract(
    baseInput({ tools: [baseTool({ namespace: "mcp__context7" })] }),
  );
  expect(namespaced.toolsDigest).not.toBe(plain.toolsDigest);
  expect(externalRequestKey(namespaced)).not.toBe(externalRequestKey(plain));
});

test("11 - freeform false versus true differs", () => {
  const plain = buildExternalExecutionContract(baseInput({ tools: [baseTool()] }));
  const freeform = buildExternalExecutionContract(baseInput({ tools: [baseTool({ freeform: true })] }));
  expect(freeform.toolsDigest).not.toBe(plain.toolsDigest);
  expect(externalRequestKey(freeform)).not.toBe(externalRequestKey(plain));
});

test("12 - toolSearch false versus true differs", () => {
  const plain = buildExternalExecutionContract(
    baseInput({ tools: [baseTool({ name: "tool_search" })] }),
  );
  const search = buildExternalExecutionContract(
    baseInput({ tools: [baseTool({ name: "tool_search", toolSearch: true })] }),
  );
  expect(search.toolsDigest).not.toBe(plain.toolsDigest);
  expect(externalRequestKey(search)).not.toBe(externalRequestKey(plain));
});

test("13 - strict, description, and parameters changes each differ", () => {
  const loose = buildExternalExecutionContract(baseInput({ tools: [baseTool()] }));
  const strict = buildExternalExecutionContract(baseInput({ tools: [baseTool({ strict: true })] }));
  expect(strict.toolsDigest).not.toBe(loose.toolsDigest);
  const renamed = buildExternalExecutionContract(
    baseInput({ tools: [baseTool({ description: "Another description." })] }),
  );
  expect(renamed.toolsDigest).not.toBe(loose.toolsDigest);
  const reshaped = buildExternalExecutionContract(
    baseInput({ tools: [baseTool({ parameters: { type: "object", properties: { city: { type: "string" } } } })] }),
  );
  expect(reshaped.toolsDigest).not.toBe(loose.toolsDigest);
});

test("14 - same parameters with reordered keys give the same digest", () => {
  const firstParams = {
    type: "object",
    properties: {
      alpha: { type: "string", description: "First." },
      beta: { type: "number", description: "Second." },
    },
    required: ["alpha", "beta"],
  };
  const secondParams = {
    required: ["alpha", "beta"],
    properties: {
      beta: { description: "Second.", type: "number" },
      alpha: { description: "First.", type: "string" },
    },
    type: "object",
  };
  const a = buildExternalExecutionContract(baseInput({ tools: [baseTool({ parameters: firstParams })] }));
  const b = buildExternalExecutionContract(baseInput({ tools: [baseTool({ parameters: secondParams })] }));
  expect(b.toolsDigest).toBe(a.toolsDigest);
  expect(externalRequestKey(b)).toBe(externalRequestKey(a));
});

test("15 - absent output format digests to null", () => {
  const contract = buildExternalExecutionContract(baseInput({ outputFormat: undefined }));
  expect(contract.outputFormatDigest).toBeNull();
});

test("16 - output schema semantic change gives a different digest and key", () => {
  const firstSchema = { type: "object", properties: { city: { type: "string" } }, required: ["city"] };
  const secondSchema = { type: "object", properties: { city: { type: "number" } }, required: ["city"] };
  const a = buildExternalExecutionContract(baseInput({ outputFormat: jsonSchemaFormat(firstSchema) }));
  const b = buildExternalExecutionContract(baseInput({ outputFormat: jsonSchemaFormat(secondSchema) }));
  expect(a.outputFormatDigest).not.toBeNull();
  expect(b.outputFormatDigest).not.toBe(a.outputFormatDigest);
  expect(externalRequestKey(a)).not.toBe(externalRequestKey(b));
});

test("17 - same schema with reordered properties gives the same digest", () => {
  const firstSchema = {
    type: "object",
    properties: {
      alpha: { type: "string" },
      beta: { type: "number" },
    },
    required: ["alpha"],
  };
  const secondSchema = {
    required: ["alpha"],
    properties: {
      beta: { type: "number" },
      alpha: { type: "string" },
    },
    type: "object",
  };
  const a = buildExternalExecutionContract(baseInput({ outputFormat: jsonSchemaFormat(firstSchema) }));
  const b = buildExternalExecutionContract(baseInput({ outputFormat: jsonSchemaFormat(secondSchema) }));
  expect(b.outputFormatDigest).toBe(a.outputFormatDigest);
  expect(externalRequestKey(b)).toBe(externalRequestKey(a));
});

test("18 - hideThinkingSummary true versus false differs", () => {
  const shown = buildExternalExecutionContract(baseInput({ hideThinkingSummary: false }));
  const hidden = buildExternalExecutionContract(baseInput({ hideThinkingSummary: true }));
  expect(externalRequestKey(shown)).not.toBe(externalRequestKey(hidden));
});

test("19 - verbosity null, low, medium, and high each differ", () => {
  const none = buildExternalExecutionContract(baseInput({}));
  const low = buildExternalExecutionContract(baseInput({ verbosity: "low" }));
  const medium = buildExternalExecutionContract(baseInput({ verbosity: "medium" }));
  const high = buildExternalExecutionContract(baseInput({ verbosity: "high" }));
  expect(none.verbosity).toBeNull();
  expect(low.verbosity).toBe("low");
  expect(externalRequestKey(low)).not.toBe(externalRequestKey(none));
  expect(externalRequestKey(medium)).not.toBe(externalRequestKey(low));
  expect(externalRequestKey(high)).not.toBe(externalRequestKey(medium));
  const lowAgain = buildExternalExecutionContract(baseInput({ verbosity: "low" }));
  expect(externalRequestKey(lowAgain)).toBe(externalRequestKey(low));
});

test("C1 - wire input change gives a different key", () => {
  const a = contractFromWire(wireBody());
  const b = contractFromWire(
    wireBody({ input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Another question" }] }] }),
  );
  expect(b.key).not.toBe(a.key);
});

test("C2 - wire instructions change gives a different key", () => {
  const a = contractFromWire(wireBody({ instructions: "You are helpful." }));
  const b = contractFromWire(wireBody({ instructions: "You are strict." }));
  expect(b.key).not.toBe(a.key);
});

test("C3 - wire tools change gives a different key", () => {
  const tool = { type: "function", name: "get_weather", description: "Weather.", parameters: {} };
  const a = contractFromWire(wireBody());
  const b = contractFromWire(wireBody({ tools: [tool] }));
  expect(b.key).not.toBe(a.key);
});

test("C4 - reasoning summary auto versus none gives a different key", () => {
  const a = contractFromWire(wireBody({ reasoning: { effort: "medium", summary: "auto" } }));
  const b = contractFromWire(wireBody({ reasoning: { effort: "medium", summary: "none" } }));
  expect(a.contract.hideThinkingSummary).toBe(false);
  expect(b.contract.hideThinkingSummary).toBe(true);
  expect(b.key).not.toBe(a.key);
});

test("C5 - text verbosity change gives a different key", () => {
  const a = contractFromWire(wireBody({ text: { verbosity: "low" } }));
  const b = contractFromWire(wireBody({ text: { verbosity: "high" } }));
  expect(b.key).not.toBe(a.key);
});

test("C6 - text format change gives a different key", () => {
  const firstFormat = { type: "json_schema", name: "answer", strict: true, schema: { type: "object" } };
  const secondFormat = { type: "json_schema", name: "answer", strict: true, schema: { type: "string" } };
  const a = contractFromWire(wireBody({ text: { format: firstFormat } }));
  const b = contractFromWire(wireBody({ text: { format: secondFormat } }));
  expect(b.key).not.toBe(a.key);
});

test("C7 - model resolving to a different route gives a different key", () => {
  const a = contractFromWire(wireBody({ model: "chatgpt-web/medium" }), { routeSlug: "chatgpt-web/medium", adapterEffort: "medium" });
  const b = contractFromWire(wireBody({ model: "chatgpt-web/high" }), { routeSlug: "chatgpt-web/high", adapterEffort: "high" });
  expect(b.key).not.toBe(a.key);
});

test("C8 - clientId change gives a different key", () => {
  const a = contractFromWire(wireBody(), { clientId: "hermes-local" });
  const b = contractFromWire(wireBody(), { clientId: "hermes-second" });
  expect(b.key).not.toBe(a.key);
});

test("C9 - incoming reasoning effort medium versus max on one route gives the same key", () => {
  const a = contractFromWire(wireBody({ reasoning: { effort: "medium", summary: "auto" } }));
  const b = contractFromWire(wireBody({ reasoning: { effort: "max", summary: "auto" } }));
  expect(b.key).toBe(a.key);
});

test("C10 - tool_choice change gives the same key", () => {
  const a = contractFromWire(wireBody({ tool_choice: "auto" }));
  const b = contractFromWire(wireBody({ tool_choice: "required" }));
  expect(b.key).toBe(a.key);
});

test("C11 - parallel_tool_calls change gives the same key", () => {
  const a = contractFromWire(wireBody({ parallel_tool_calls: true }));
  const b = contractFromWire(wireBody({ parallel_tool_calls: false }));
  expect(b.key).toBe(a.key);
});

test("C12 - temperature, top_p, stop, and max_output_tokens changes give the same key", () => {
  const a = contractFromWire(wireBody());
  const b = contractFromWire(
    wireBody({ temperature: 0.7, top_p: 0.9, stop: ["done"], max_output_tokens: 512 }),
  );
  expect(b.key).toBe(a.key);
});

test("C13 - presence_penalty, frequency_penalty, and service_tier changes give the same key", () => {
  const a = contractFromWire(wireBody());
  const b = contractFromWire(
    wireBody({ presence_penalty: 0.5, frequency_penalty: 0.5, service_tier: "flex" }),
  );
  expect(b.key).toBe(a.key);
});

test("C14 - stream true versus false gives the same key", () => {
  const a = contractFromWire(wireBody({ stream: false }));
  const b = contractFromWire(wireBody({ stream: true }));
  expect(b.key).toBe(a.key);
});

test("C15 - store, include, metadata, user, truncation, background, and prompt changes give the same key", () => {
  const a = contractFromWire(wireBody());
  const b = contractFromWire(
    wireBody({
      store: true,
      include: ["reasoning.encrypted_content"],
      metadata: { team: "hermes" },
      user: "operator",
      truncation: "auto",
      background: false,
      prompt: { id: "prompt-1" },
    }),
  );
  expect(b.key).toBe(a.key);
});

test("C16 - prompt_cache_key change gives the same key", () => {
  const a = contractFromWire(wireBody({ prompt_cache_key: "cache-a" }));
  const b = contractFromWire(wireBody({ prompt_cache_key: "cache-b" }));
  expect(b.key).toBe(a.key);
});

test("C17 - client_metadata and turn metadata changes give the same key", () => {
  const a = contractFromWire(wireBody());
  const b = contractFromWire(
    wireBody({
      client_metadata: { session: "one" },
      "x-codex-turn-metadata": { thread_id: "thread-1", turn_id: "turn-1" },
    }),
  );
  expect(b.key).toBe(a.key);
});

test("tool continuation changes inputDigest and request key", () => {
  const tool = { type: "function", name: "get_weather", description: "Weather.", parameters: {} };
  const before = contractFromWire(
    wireBody({
      tools: [tool],
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Weather in Paris?" }] }],
    }),
  );
  const after = contractFromWire(
    wireBody({
      tools: [tool],
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "Weather in Paris?" }] },
        { type: "function_call", call_id: "call-1", name: "get_weather", arguments: "{}" },
        { type: "function_call_output", call_id: "call-1", output: "sunny" },
      ],
    }),
  );
  expect(after.contract.inputDigest).not.toBe(before.contract.inputDigest);
  expect(after.key).not.toBe(before.key);
});

test("later top-level turn with fuller history changes the key", () => {
  const first = contractFromWire(
    wireBody({ input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Hello" }] }] }),
  );
  const second = contractFromWire(
    wireBody({
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "Hello" }] },
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "Hi there." }] },
        { type: "message", role: "user", content: [{ type: "input_text", text: "Follow-up question" }] },
      ],
    }),
  );
  expect(second.key).not.toBe(first.key);
});

test("exact retry preserves every key and trace", () => {
  const namespace = "hermes-adapter";
  const firstInput = baseInput({ tools: [baseTool()], verbosity: "low" });
  const secondInput = structuredClone(firstInput);
  const firstContract = buildExternalExecutionContract(firstInput);
  const secondContract = buildExternalExecutionContract(secondInput);
  expect(secondContract).toEqual(firstContract);
  const firstIdentity = buildExternalRequestIdentity(namespace, firstContract);
  const secondIdentity = buildExternalRequestIdentity(namespace, secondContract);
  expect(secondIdentity).toEqual(firstIdentity);
});

test("request-scoped relationships separate semantic identity from namespace", () => {
  const namespace = "hermes-adapter";
  const other = "other-adapter";
  const contract = buildExternalExecutionContract(baseInput());
  const identity = buildExternalRequestIdentity(namespace, contract);
  const renamed = buildExternalRequestIdentity(other, contract);
  expect(identity.executionKey).toBe(identity.retryKey);
  expect(identity.executionKey).toBe(identity.ownerKey);
  expect(identity.roundKey).toBe(identity.requestKey);
  expect(identity.executionKey).toBe(namespace + ":" + identity.requestKey);
  expect(renamed.requestKey).toBe(identity.requestKey);
  expect(renamed.roundKey).toBe(identity.roundKey);
  expect(renamed.executionKey).not.toBe(identity.executionKey);
  expect(renamed.retryKey).not.toBe(identity.retryKey);
  expect(renamed.ownerKey).not.toBe(identity.ownerKey);
  expect(renamed.traceId).not.toBe(identity.traceId);
  for (const key of [identity.requestKey, identity.executionKey, identity.retryKey, identity.ownerKey]) {
    expect(key.includes("Bearer")).toBe(false);
  }
});

test("trace id is a stable 12-char lowercase hex with namespace and request scope", () => {
  const contract = buildExternalExecutionContract(baseInput());
  const key = externalRequestKey(contract);
  const first = externalTraceId("hermes-adapter", key);
  const second = externalTraceId("hermes-adapter", key);
  expect(first).toBe(second);
  expect(isLowerHex(first, 12)).toBe(true);
  expect(externalTraceId("other-adapter", key)).not.toBe(first);
  const otherContract = buildExternalExecutionContract(baseInput({ clientId: "hermes-second" }));
  expect(externalTraceId("hermes-adapter", externalRequestKey(otherContract))).not.toBe(first);
});

test("empty namespace is rejected without exposing request contents", () => {
  const contract = buildExternalExecutionContract(baseInput());
  let message = "";
  try {
    buildExternalRequestIdentity("", contract);
  } catch (error) {
    message = error instanceof Error ? error.message : "";
  }
  expect(message.length > 0).toBe(true);
  expect(message.includes("hermes-local")).toBe(false);
});

test("builder does not mutate its inputs", () => {
  const schema = { type: "object", properties: { city: { type: "string" } } };
  const params = { type: "object", properties: { city: { type: "string" } } };
  const input = baseInput({
    systemPrompt: ["First.", "Second."],
    tools: [baseTool({ parameters: params })],
    outputFormat: jsonSchemaFormat(schema),
    expandedInput: [{ role: "user", text: "Hello" }],
  });
  const snapshot = structuredClone(input);
  buildExternalExecutionContract(input);
  expect(input).toEqual(snapshot);
});

test("version literal participates in request-key material", () => {
  const contract = buildExternalExecutionContract(baseInput());
  const reshaped = { ...contract, v: "external-exec-v2" } as unknown as ExternalExecutionContractV1;
  expect(externalRequestKey(reshaped)).not.toBe(externalRequestKey(contract));
});

test("module stays clear of native authority, server, and secret-store dependencies", () => {
  const source = readFileSync(join(import.meta.dir, "..", "src", "adapters", "chatgpt-web", "external-identity.ts"), "utf8");
  const forbidden = [
    "extractCodexTurnIdentityFromBody",
    "extractChatGptTurnIdentity",
    "chatGptTurnExecutionKey",
    "chatGptTurnRoundKey",
    "chatGptTurnRetryKey",
    "chatGptThreadOwnershipKey",
    "chatGptConversationKey",
    "turn-execution",
    "chatgpt-web/environment",
    "native-passthrough",
    "native-network",
    "external-client",
    "from ../config",
    "from ../server",
    "conversationKey",
    "sessionAffinityKey",
    "HermesSessionKey",
    "retainedConversationKey",
  ];
  for (const token of forbidden) {
    expect(source.includes(token)).toBe(false);
  }
});

test("canonicalizer rejects cyclic input with a generic error", () => {
  const marker = "cyclic-marker-secret";
  const params: Record<string, unknown> = { label: marker };
  (params as Record<string, unknown>).self = params;
  let message = "";
  try {
    buildExternalExecutionContract(baseInput({ tools: [baseTool({ parameters: params })] }));
  } catch (error) {
    message = error instanceof Error ? error.message : "";
  }
  expect(message.length > 0).toBe(true);
  expect(message.includes(marker)).toBe(false);
});

test("canonicalizer rejects Date and non-plain objects without leaking contents", () => {
  const marker = "date-marker-secret";
  const params = { created: new Date(0), label: marker };
  let message = "";
  try {
    buildExternalExecutionContract(baseInput({ tools: [baseTool({ parameters: params })] }));
  } catch (error) {
    message = error instanceof Error ? error.message : "";
  }
  expect(message.length > 0).toBe(true);
  expect(message.includes(marker)).toBe(false);
});

test("canonicalizer rejects non-finite numbers and undefined members generically", () => {
  for (const params of [{ value: Number.POSITIVE_INFINITY }, { value: undefined }]) {
    let message = "";
    try {
      buildExternalExecutionContract(baseInput({ tools: [baseTool({ parameters: params })] }));
    } catch (error) {
      message = error instanceof Error ? error.message : "";
    }
    expect(message.length > 0).toBe(true);
  }
});
