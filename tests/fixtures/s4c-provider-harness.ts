/** Isolated live E2E provider. Reuses the signed-in DEV launcher's tunnel and connector,
 * while owning an independent Responses listener and broker in its TEMP bridge home. */
import { isAbsolute } from "node:path";
import { defaultConfig } from "../../src/config";
import { startServer } from "../../src/server";
import { createChatGptWebAdapter } from "../../src/adapters/chatgpt-web";
import { namespacedToolName } from "../../src/types";

const descriptor = process.env.S4C_LAUNCHER_DESCRIPTOR;
const brokerSocketPath = process.env.S4C_BROKER_SOCKET;
const port = Number(process.env.S4C_PROVIDER_PORT || "17914");
if (!descriptor || !isAbsolute(descriptor) || !brokerSocketPath || !Number.isInteger(port) || port < 1024 || port > 65535) {
  throw new Error("S4C E2E requires a launcher descriptor, broker socket, and valid port");
}
// S4D area C: never resolve the app home (provider-token file) to the real user
// home. E2E startup must export an isolated TEMP CODEX_CHATGPT_WEB_HOME.
if (!process.env.CODEX_CHATGPT_WEB_HOME || !isAbsolute(process.env.CODEX_CHATGPT_WEB_HOME)) {
  throw new Error("S4C E2E requires an isolated TEMP CODEX_CHATGPT_WEB_HOME");
}
const config = defaultConfig("full");
config.integrationMode = "external-provider";
config.browserHost = "launcher";
config.browserHostDescriptorPath = descriptor;
config.brokerSocketPath = brokerSocketPath;
config.automaticAppName = "Codex Native2 DEV";
config.appName = "Codex Native2 DEV";
config.port = port;
config.solAvailable = true;
config.extraHighAvailable = true;
config.proAvailable = true;
let requestCount = 0;
const server = startServer(config, {
  adapterFactory: provider => {
    const adapter = createChatGptWebAdapter(provider);
    return {
      ...adapter,
      runTurn: async (parsed, incoming, emit) => {
        requestCount += 1;
        console.info(`[s4c] provider request=${requestCount} tools=${JSON.stringify(parsed.context.tools?.map(tool => namespacedToolName(tool.namespace, tool.name)) ?? [])} replay=${parsed.context.messages.filter(message => message.role === "toolResult").length}`);
        await adapter.runTurn!(parsed, incoming, emit);
      },
    };
  },
});
console.info(`[s4c] provider listening on ${server.hostname}:${server.port}`);
