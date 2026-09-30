import { afterAll, expect, test } from "bun:test";
import { defaultConfig } from "../src/config";
import { ensureOpencodexProviderTokenFile, readOpencodexProviderTokenFile } from "../src/opencodex-provider-auth";
import { responseRequest } from "../src/server";
import { isolateTestAppHome, restoreTestAppHome } from "./helpers/isolated-app-home";

// S4D area C: resolve the provider-token file under an isolated temp home so test
// runs never create or touch the real user app home.
isolateTestAppHome("s4d-server-subagents-");
afterAll(() => restoreTestAppHome());

test("rejects encrypted cross-backend delegation before constructing the browser adapter", async () => {
  const config = defaultConfig("browser-only");
  config.solAvailable = false;
  config.proAvailable = false;
  ensureOpencodexProviderTokenFile(config.providerTokenFile, config.controlToken);
  const providerAuth = { authorization: "Bearer " + readOpencodexProviderTokenFile(config.providerTokenFile) };
  let adapterConstructions = 0;
  const response = await responseRequest(new Request("http://127.0.0.1:17841/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json", ...providerAuth },
    body: JSON.stringify({
      model: "chatgpt-web/luna",
      stream: true,
      client_metadata: { "x-codex-turn-metadata": JSON.stringify({ thread_id: "thread_subagent", turn_id: "turn_subagent" }) },
      input: [{
        type: "agent_message",
        author: "parent",
        recipient: "child",
        content: [{ type: "encrypted_content", encrypted_content: "gAAAAABopaque-native-v2-payload" }],
      }],
    }),
  }), config, () => {
    adapterConstructions += 1;
    throw new Error("browser adapter must not be constructed");
  });

  expect(response.status).toBe(400);
  expect(response.headers.get("content-type")).toContain("application/json");
  expect(await response.json()).toMatchObject({
    error: {
      type: "invalid_request_error",
      message: expect.stringContaining("encrypted cross-backend subagent payload"),
    },
  });
  expect(adapterConstructions).toBe(0);
});
