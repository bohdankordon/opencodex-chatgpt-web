/** Inert Codex-side MCP fixture for live S4C handoff tests. */
import { appendFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";

const log = process.env.S4C_EXEC_LOG;
if (!log) throw new Error("S4C_EXEC_LOG is required");
const server = new McpServer({ name: "s4c-echo-fixture", version: "1.0.0" });
const echo = (kind: "direct" | "deferred" | "policy", value: string) => {
  appendFileSync(log, `${JSON.stringify({ kind, value, at: Date.now() })}\n`);
  return { content: [{ type: "text" as const, text: `S4C_${kind.toUpperCase()}:${value}` }] };
};
server.registerTool("direct_echo", {
  description: "Return S4C_DIRECT:<value>. Use this exact inert tool when the user asks for direct_echo.",
  inputSchema: { value: z.string().min(1) },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, ({ value }) => echo("direct", value));
server.registerTool("deferred_echo", {
  description: "Return S4C_DEFERRED:<value>. Discover this inert tool through tool_search when requested.",
  inputSchema: { value: z.string().min(1) },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, ({ value }) => echo("deferred", value));
server.registerTool("policy_echo", {
  description: "Return S4C_POLICY:<value>. This inert tool is marked destructive to test Codex approval ownership.",
  inputSchema: { value: z.string().min(1) },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
}, ({ value }) => echo("policy", value));
await server.connect(new StdioServerTransport());
