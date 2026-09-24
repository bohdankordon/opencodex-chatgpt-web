import { expect, test } from "bun:test";
import { bridgeToResponsesSSE, buildResponseJSON } from "../src/bridge";
import { decodeReasoningEnvelope, encodeReasoningEnvelope } from "../src/responses/reasoning-envelope";
import { parseRequest } from "../src/responses/parser";
import type { AdapterEvent } from "../src/types";

const model = "chatgpt-web/test";
type ReasoningItem = {
  type: string;
  id?: string;
  summary?: Array<{ type: string; text: string }>;
  content?: Array<{ type: string; text: string }>;
  encrypted_content?: string;
};

function batchItems(events: AdapterEvent[], hideThinkingSummary = false): ReasoningItem[] {
  return buildResponseJSON(events, model, { hideThinkingSummary }).output as ReasoningItem[];
}

async function streamItems(events: AdapterEvent[], hideThinkingSummary = false): Promise<{
  items: ReasoningItem[];
  frames: Array<Record<string, unknown>>;
}> {
  async function* source(): AsyncGenerator<AdapterEvent> {
    yield* events;
  }
  const body = await new Response(bridgeToResponsesSSE(
    source(), model, undefined, undefined, undefined, undefined, 2_000,
    { hideThinkingSummary },
  )).text();
  const frames = body.split("\n\n")
    .flatMap(frame => frame.split("\n").filter(line => line.startsWith("data: {")).map(line =>
      JSON.parse(line.slice(6)) as Record<string, unknown>));
  const items = frames.filter(frame => frame.type === "response.output_item.done")
    .map(frame => frame.item as ReasoningItem);
  return { items, frames };
}

function reasoning(items: ReasoningItem[]): ReasoningItem[] {
  return items.filter(item => item.type === "reasoning");
}

function assertPublicMarker(item: ReasoningItem, summary: string): void {
  expect(item.summary).toEqual([{ type: "summary_text", text: summary }]);
  expect(item.encrypted_content?.startsWith("ocxr1:")).toBe(true);
  expect(decodeReasoningEnvelope(item.encrypted_content!)).toEqual({ sum: true });
  expect(Buffer.from(item.encrypted_content!.slice("ocxr1:".length), "base64").toString("utf8"))
    .toBe('{"sum":true}');
}

test("ocxr1 accepts only a true public-summary marker and preserves old fields", () => {
  const marker = encodeReasoningEnvelope({ sum: true });
  expect(marker.startsWith("ocxr1:")).toBe(true);
  expect(decodeReasoningEnvelope(marker)).toEqual({ sum: true });
  for (const invalid of [false, "true", 1, {}, null]) {
    const encoded = `ocxr1:${Buffer.from(JSON.stringify({ sum: invalid })).toString("base64")}`;
    expect(decodeReasoningEnvelope(encoded)).toBeNull();
  }
  for (const value of [{}, { unknown: true }, { red: [] }, { txt: "" }]) {
    expect(decodeReasoningEnvelope(`ocxr1:${Buffer.from(JSON.stringify(value)).toString("base64")}`)).toBeNull();
  }
  expect(decodeReasoningEnvelope("native-opaque-encrypted-reasoning")).toBeNull();
  expect(decodeReasoningEnvelope("ocxr1:garbage")).toBeNull();
  expect(decodeReasoningEnvelope(encodeReasoningEnvelope({ sig: "signature" }))).toEqual({ sig: "signature" });
  expect(decodeReasoningEnvelope(encodeReasoningEnvelope({ red: ["opaque"] }))).toEqual({ red: ["opaque"] });
  expect(decodeReasoningEnvelope(encodeReasoningEnvelope({ txt: "hidden raw" }))).toEqual({ txt: "hidden raw" });
  expect(decodeReasoningEnvelope(encodeReasoningEnvelope({ sig: "s", red: ["r"], txt: "t", sum: true })))
    .toEqual({ sig: "s", red: ["r"], txt: "t", sum: true });
});

test("Web thinking_delta emits a public-summary marker and replays through Responses parser", async () => {
  const events: AdapterEvent[] = [
    { type: "thinking_delta", thinking: "public summary" },
    { type: "text_delta", text: "answer" },
    { type: "done", endTurn: true },
  ];
  const streamed = await streamItems(events);
  const streamReasoning = reasoning(streamed.items);
  expect(streamReasoning).toHaveLength(1);
  assertPublicMarker(streamReasoning[0]!, "public summary");
  expect(streamed.frames.some(frame => frame.type === "response.reasoning_summary_text.delta"
    && frame.delta === "public summary")).toBe(true);
  const batched = reasoning(batchItems(events));
  expect(batched).toHaveLength(1);
  assertPublicMarker(batched[0]!, "public summary");
  const replay = parseRequest({
    model,
    input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: "first turn" }] },
      streamReasoning[0],
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "answer" }] },
      { type: "message", role: "user", content: [{ type: "input_text", text: "next turn" }] },
    ],
  });
  expect(replay.previousResponseId).toBeUndefined();
  expect(replay.context.tools).toBeUndefined();
  const assistant = replay.context.messages[1];
  expect(assistant?.role).toBe("assistant");
  if (assistant?.role !== "assistant" || !Array.isArray(assistant.content)) throw new Error("assistant history missing");
  expect(assistant.content[0]).toMatchObject({ type: "thinking", thinking: "public summary" });
  expect(assistant.content[1]).toMatchObject({ type: "text", text: "answer" });
  // The parser's existing unsigned fallback remains; no provider signature is created.
  expect((assistant.content[0] as { signature?: string }).signature)
    .toBe(JSON.stringify(streamReasoning[0]));
  expect(replay.context.messages[2]).toMatchObject({ role: "user" });
});

test("signed and redacted summaries retain opaque envelopes without the public marker", async () => {
  const signed: AdapterEvent[] = [
    { type: "thinking_delta", thinking: "visible signed" },
    { type: "thinking_signature", signature: "opaque-signature" },
    { type: "done", endTurn: true },
  ];
  for (const item of [...reasoning((await streamItems(signed)).items), ...reasoning(batchItems(signed))]) {
    expect(item.summary).toEqual([{ type: "summary_text", text: "visible signed" }]);
    expect(decodeReasoningEnvelope(item.encrypted_content!)).toEqual({ sig: "opaque-signature" });
  }
  const redacted: AdapterEvent[] = [
    { type: "thinking_delta", thinking: "visible redacted" },
    { type: "redacted_thinking", data: "opaque-redaction" },
    { type: "done", endTurn: true },
  ];
  for (const item of [...reasoning((await streamItems(redacted)).items), ...reasoning(batchItems(redacted))]) {
    expect(item.summary).toEqual([{ type: "summary_text", text: "visible redacted" }]);
    expect(decodeReasoningEnvelope(item.encrypted_content!)).toEqual({ red: ["opaque-redaction"] });
  }
});

test("hidden unsigned summary emits no reasoning item or marker", async () => {
  const events: AdapterEvent[] = [
    { type: "thinking_delta", thinking: "suppressed public summary" },
    { type: "text_delta", text: "answer" },
    { type: "done", endTurn: true },
  ];
  const streamed = await streamItems(events, true);
  expect(reasoning(streamed.items)).toEqual([]);
  expect(reasoning(batchItems(events, true))).toEqual([]);
  expect(JSON.stringify(streamed.frames)).not.toContain("suppressed public summary");
});

test("hidden signed summary preserves existing opaque metadata and signed text", async () => {
  const events: AdapterEvent[] = [
    { type: "thinking_delta", thinking: "signed hidden text" },
    { type: "thinking_signature", signature: "opaque-signature" },
    { type: "done", endTurn: true },
  ];
  for (const item of [...reasoning((await streamItems(events, true)).items), ...reasoning(batchItems(events, true))]) {
    expect(item.summary).toEqual([]);
    expect(decodeReasoningEnvelope(item.encrypted_content!))
      .toEqual({ sig: "opaque-signature", txt: "signed hidden text" });
  }
  const redacted: AdapterEvent[] = [
    { type: "thinking_delta", thinking: "redacted hidden text" },
    { type: "redacted_thinking", data: "opaque-redaction" },
    { type: "done", endTurn: true },
  ];
  for (const item of [...reasoning((await streamItems(redacted, true)).items), ...reasoning(batchItems(redacted, true))]) {
    expect(item.summary).toEqual([]);
    expect(decodeReasoningEnvelope(item.encrypted_content!))
      .toEqual({ red: ["opaque-redaction"], txt: "redacted hidden text" });
  }
});

test("raw reasoning keeps its existing visible and hidden serialization", async () => {
  const events: AdapterEvent[] = [
    { type: "reasoning_raw_delta", text: "raw reasoning" },
    { type: "done", endTurn: true },
  ];
  for (const item of [...reasoning((await streamItems(events)).items), ...reasoning(batchItems(events))]) {
    expect(item.summary).toEqual([]);
    expect(item.content).toEqual([{ type: "reasoning_text", text: "raw reasoning" }]);
    expect(item.encrypted_content).toBeUndefined();
  }
  for (const item of [...reasoning((await streamItems(events, true)).items), ...reasoning(batchItems(events, true))]) {
    expect(item.summary).toEqual([]);
    expect(decodeReasoningEnvelope(item.encrypted_content!)).toEqual({ txt: "raw reasoning" });
  }
});

test("no reasoning signal remains message-only regardless of requested reasoning or include", async () => {
  const events: AdapterEvent[] = [
    { type: "text_delta", text: "answer only" },
    { type: "done", endTurn: true },
  ];
  expect(reasoning((await streamItems(events)).items)).toEqual([]);
  expect(reasoning(batchItems(events))).toEqual([]);
  const parsed = parseRequest({
    model, reasoning: { effort: "high", summary: "auto" },
    include: ["reasoning.encrypted_content"],
    input: [{ type: "message", role: "user", content: "question" }],
  });
  expect(parsed.options.reasoning).toBe("high");
  expect(reasoning(batchItems(events, parsed.options.hideThinkingSummary))).toEqual([]);
});
