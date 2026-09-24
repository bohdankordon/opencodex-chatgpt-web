import { afterEach, expect, test } from "bun:test";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CHATGPT_WEB_HELPER_OBSERVABILITY_ENV,
  recordHelperReasoning,
  resetHelperObservabilityForTests,
  resolveHelperObservabilitySink,
} from "../src/adapters/chatgpt-web/helper-observability";
import { LauncherBrowserHelperClient } from "../src/adapters/chatgpt-web/launcher-helper-client";
import type { ResolvedBrowserConfig } from "../src/adapters/chatgpt-web/browser-worker";
import { LAUNCHER_BROWSER_HOST_KIND, LAUNCHER_BROWSER_IDLE_URL } from "../src/launcher-browser-host";

const OBS_ENV = CHATGPT_WEB_HELPER_OBSERVABILITY_ENV;
const HELPER_PROCESS_ENV = "CODEX_CHATGPT_WEB_BROWSER_HELPER_PROCESS";

const roots: string[] = [];
const savedObsEnv = Object.hasOwn(process.env, OBS_ENV) ? process.env[OBS_ENV] : undefined;
const savedObsEnvPresent = Object.hasOwn(process.env, OBS_ENV);
const savedHelperEnv = Object.hasOwn(process.env, HELPER_PROCESS_ENV)
  ? process.env[HELPER_PROCESS_ENV]
  : undefined;
const savedHelperEnvPresent = Object.hasOwn(process.env, HELPER_PROCESS_ENV);

function makeRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function setObsEnv(value: string | undefined): void {
  resetHelperObservabilityForTests();
  if (value === undefined) delete process.env[OBS_ENV];
  else process.env[OBS_ENV] = value;
}

function setHelperProcessEnv(value: string | undefined): void {
  resetHelperObservabilityForTests();
  if (value === undefined) delete process.env[HELPER_PROCESS_ENV];
  else process.env[HELPER_PROCESS_ENV] = value;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  if (savedObsEnvPresent) process.env[OBS_ENV] = savedObsEnv as string;
  else delete process.env[OBS_ENV];
  if (savedHelperEnvPresent) process.env[HELPER_PROCESS_ENV] = savedHelperEnv as string;
  else delete process.env[HELPER_PROCESS_ENV];
  resetHelperObservabilityForTests();
});
function readReceiptRecords(dir: string, prefix: string): { raw: string; records: any[] } {
  const files = readdirSync(dir).filter(name => name.startsWith(prefix) && name.endsWith(".jsonl"));
  expect(files.length).toBe(1);
  const raw = readFileSync(join(dir, files[0]), "utf8");
  expect(raw.length).toBeGreaterThan(0);
  return { raw, records: raw.trim().split("\n").map(line => JSON.parse(line)) };
}

test("disabled observability resolves to no sink and records nothing", () => {
  setHelperProcessEnv(undefined);
  setObsEnv(undefined);
  expect(resolveHelperObservabilitySink()).toBeUndefined();
  expect(() => recordHelperReasoning("public_reasoning", "trace_disabled_1", "anything", false)).not.toThrow();
  setObsEnv("");
  expect(resolveHelperObservabilitySink()).toBeUndefined();
});

test("relative observability directory is rejected", () => {
  setHelperProcessEnv(undefined);
  setObsEnv(join("relative", "receipts"));
  expect(() => resolveHelperObservabilitySink()).toThrow(/absolute/);
});

test("missing observability directory is rejected", () => {
  setHelperProcessEnv(undefined);
  setObsEnv(join(tmpdir(), "codex-h6d5f-missing-7f3a9c2e"));
  expect(() => resolveHelperObservabilitySink()).toThrow();
});

test("observability path that is not a directory is rejected", () => {
  const root = makeRoot("codex-helper-obs-notdir-");
  const file = join(root, "file.txt");
  writeFileSync(file, "x\n");
  setHelperProcessEnv(undefined);
  setObsEnv(file);
  expect(() => resolveHelperObservabilitySink()).toThrow(/directory/);
});
test("enabled sink records metadata-only reasoning receipts with exact digests", () => {
  const dir = makeRoot("codex-helper-obs-meta-");
  const secretA = "H6D5F-SYNTH-7f3a9c2e-Reading-projekt-offentlich";
  const secretB = "H6D5F-SYNTH-7f3a9c2e-mehr-Text-zwei";
  setHelperProcessEnv(undefined);
  setObsEnv(dir);
  recordHelperReasoning("public_reasoning", "trace_meta_123456", secretA, false);
  recordHelperReasoning("helper_emit", "trace_meta_123456", secretB, true);
  const found = readReceiptRecords(dir, "daemon-");
  expect(found.records.length).toBe(2);
  expect(Object.keys(found.records[0]).sort()).toEqual(
    ["version", "stage", "role", "pid", "traceId", "event", "seq",
      "timestamp", "continuation", "charLength", "byteLength", "sha256"].sort(),
  );
  expect(found.records[0]).toMatchObject({
    version: 1,
    stage: "public_reasoning",
    role: "daemon",
    pid: process.pid,
    traceId: "trace_meta_123456",
    event: "reasoning",
    seq: 1,
    continuation: false,
  });
  expect(found.records[0].sha256).toBe(createHash("sha256").update(secretA, "utf8").digest("hex"));
  expect(found.records[1]).toMatchObject({ stage: "helper_emit", seq: 2, continuation: true });
  expect(found.records[1].sha256).toBe(createHash("sha256").update(secretB, "utf8").digest("hex"));
  expect(found.raw).not.toContain(secretA);
  expect(found.raw).not.toContain(secretB);
});

test("character and byte lengths differ for non-ASCII reasoning text", () => {
  const dir = makeRoot("codex-helper-obs-lengths-");
  const text = "caf\u00e9 \u2713";
  setHelperProcessEnv(undefined);
  setObsEnv(dir);
  recordHelperReasoning("daemon_receive", "trace_lengths_1", text, false);
  const found = readReceiptRecords(dir, "daemon-");
  expect(found.records[0].charLength).toBe(6);
  expect(found.records[0].byteLength).toBe(9);
  expect(found.records[0].byteLength).toBe(Buffer.byteLength(text, "utf8"));
  expect(found.records[0].sha256).toBe(createHash("sha256").update(text, "utf8").digest("hex"));
});

test("identical reasoning text hashes equally at all three boundaries", () => {
  const dir = makeRoot("codex-helper-obs-stages-");
  const secret = "H6D5F-SYNTH-7f3a9c2e-grenzen-text";
  setHelperProcessEnv(undefined);
  setObsEnv(dir);
  recordHelperReasoning("public_reasoning", "trace_stages_1", secret, false);
  recordHelperReasoning("helper_emit", "trace_stages_1", secret, false);
  recordHelperReasoning("daemon_receive", "trace_stages_1", secret, false);
  const found = readReceiptRecords(dir, "daemon-");
  expect(found.records.map(record => record.stage)).toEqual(
    ["public_reasoning", "helper_emit", "daemon_receive"]);
  expect(found.records.map(record => record.seq)).toEqual([1, 2, 3]);
  expect(new Set(found.records.map(record => record.sha256)).size).toBe(1);
  expect(found.raw).not.toContain(secret);
});

test("receipt filenames are internally generated and stale content is truncated", () => {
  const dir = makeRoot("codex-helper-obs-names-");
  setHelperProcessEnv(undefined);
  setObsEnv(dir);
  const stale = join(dir, "daemon-" + process.pid + ".jsonl");
  writeFileSync(stale, "stale\n");
  recordHelperReasoning("daemon_receive", "trace_names_1", "H6D5F-SYNTH-7f3a9c2e-stale", false);
  expect(readdirSync(dir)).toEqual(["daemon-" + process.pid + ".jsonl"]);
  const raw = readFileSync(stale, "utf8");
  expect(raw).not.toContain("stale");
  expect(raw.trim().split("\n").length).toBe(1);
});

test("removing the receipt directory after init fails records explicitly", () => {
  const dir = makeRoot("codex-helper-obs-vanish-");
  setHelperProcessEnv(undefined);
  setObsEnv(dir);
  recordHelperReasoning("daemon_receive", "trace_vanish_1", "H6D5F-SYNTH-7f3a9c2e-first", false);
  rmSync(dir, { recursive: true, force: true });
  expect(() => recordHelperReasoning("daemon_receive", "trace_vanish_1", "H6D5F-SYNTH-7f3a9c2e-second", true))
    .toThrow(/could not be recorded/);
});
const BROWSER_WORKER_URL = new URL("../src/adapters/chatgpt-web/browser-worker.ts", import.meta.url).href;
const BROWSER_HELPER_MAIN_URL = new URL(
  "../src/adapters/chatgpt-web/browser-helper-main.ts",
  import.meta.url,
).href;

function writeDescriptor(root: string, helperScript: string): string {
  const descriptorPath = join(root, "launcher.json");
  writeFileSync(descriptorPath, JSON.stringify({
    version: 3,
    kind: LAUNCHER_BROWSER_HOST_KIND,
    profile: "production",
    pid: process.pid,
    endpoint: "http://127.0.0.1:39001",
    control: {
      endpoint: "http://127.0.0.1:39002",
      token: "launcher-control-token-0123456789abcdefghijklmnop",
    },
    helper: { executable: process.execPath, script: helperScript },
    partition: "persist:codex-web-gpt-chatgpt",
    idleUrl: LAUNCHER_BROWSER_IDLE_URL,
    surfaceId: "launcher_surface_id_0123456789AB",
    surfaceTargets: { ["launcher_surface_id_0123456789AB"]: "native-owned-target" },
    createdAt: new Date().toISOString(),
  }) + "\n", { mode: 0o600 });
  return descriptorPath;
}

function launcherConfig(root: string, descriptorPath: string, helperScript: string): ResolvedBrowserConfig {
  return {
    appName: "Codex Native2",
    browserHost: "launcher",
    browserHostDescriptorPath: descriptorPath,
    browserHelperScriptPath: helperScript,
    storageStatePath: join(root, "unused-state.json"),
    chromeExecutablePath: join(root, "unused-chrome"),
    turnTimeoutMs: 60_000,
    headed: true,
    autoApproveToolCalls: false,
    useSavedChats: true,
  };
}

test("insertion points record before the existing callback or protocol write", () => {
  const worker = readFileSync(
    new URL("../src/adapters/chatgpt-web/browser-worker.ts", import.meta.url), "utf8");
  const helperMain = readFileSync(
    new URL("../src/adapters/chatgpt-web/browser-helper-main.ts", import.meta.url), "utf8");
  const client = readFileSync(
    new URL("../src/adapters/chatgpt-web/launcher-helper-client.ts", import.meta.url), "utf8");
  const workerRecord = worker.indexOf('recordHelperReasoning("public_reasoning"');
  const workerCallback = worker.indexOf("turn.onReasoningSummary?.(trace.text");
  expect(workerRecord).toBeGreaterThan(-1);
  expect(workerCallback).toBeGreaterThan(-1);
  expect(workerRecord).toBeLessThan(workerCallback);
  const helperRecord = helperMain.indexOf('recordHelperReasoning("helper_emit"');
  const helperFrame = helperMain.indexOf('event: "reasoning"');
  expect(helperRecord).toBeGreaterThan(-1);
  expect(helperFrame).toBeGreaterThan(-1);
  expect(helperRecord).toBeLessThan(helperFrame);
  const daemonRecord = client.indexOf('recordHelperReasoning("daemon_receive"');
  const daemonCallback = client.indexOf("pending.turn.onReasoningSummary?.(message.text");
  expect(daemonRecord).toBeGreaterThan(-1);
  expect(daemonCallback).toBeGreaterThan(-1);
  expect(daemonRecord).toBeLessThan(daemonCallback);
  const preflight = helperMain.indexOf("ensureHelperObservabilitySink()");
  const ready = helperMain.indexOf('type: "ready"');
  expect(preflight).toBeGreaterThan(-1);
  expect(ready).toBeGreaterThan(-1);
  expect(preflight).toBeLessThan(ready);
});
test("daemon and helper record matching reasoning digests end to end", async () => {
  const root = makeRoot("codex-helper-obs-e2e-");
  const receipts = makeRoot("codex-helper-obs-receipts-");
  const secretA = "H6D5F-SYNTH-7f3a9c2e-Lesend-Projekt";
  const secretB = "H6D5F-SYNTH-7f3a9c2e-Dateien-weiter";
  const helper = join(root, "helper.ts");
  const script = [
    "import { ChatGptBrowserWorker } from " + JSON.stringify(BROWSER_WORKER_URL) + ";",
    "ChatGptBrowserWorker.prototype.run = async function (turn) {",
    "  turn.onReasoningSummary(" + JSON.stringify(secretA) + ");",
    "  turn.onReasoningSummary(" + JSON.stringify(secretB) + ", true);",
    "  turn.onCommentary(\"H6D5F-SYNTH-7f3a9c2e-commentary\", false);",
    "  turn.onTextDelta(\"H6D5F-SYNTH-7f3a9c2e-text-delta\");",
    "  return \"done\";",
    "};",
    "await import(" + JSON.stringify(BROWSER_HELPER_MAIN_URL) + ");",
    "",
  ].join("\n");
  writeFileSync(helper, script, { mode: 0o700 });
  const descriptorHelper = join(root, "descriptor-helper.cjs");
  writeFileSync(descriptorHelper, "process.exit(99);\n", { mode: 0o700 });
  const descriptorPath = writeDescriptor(root, descriptorHelper);
  setHelperProcessEnv(undefined);
  setObsEnv(receipts);
  const reasoning: Array<{ text: string; continuation: boolean }> = [];
  const client = new LauncherBrowserHelperClient(launcherConfig(root, descriptorPath, helper));
  try {
    const result = await client.run({
      traceId: "abcdef123456",
      modelId: "gpt-5.6-sol",
      reasoning: "high",
      capabilities: { localToolsEnabled: false, solAvailable: true, extraHighAvailable: false, proAvailable: false },
      prepare: async () => ({ text: "unused", images: [], release: () => {} }),
      onReasoningSummary: (text, continuation) => reasoning.push({ text, continuation: continuation === true }),
      onCommentary: () => {},
      onTextDelta: () => {},
    });
    expect(result).toBe("done");
  } finally {
    await client.close();
  }
  expect(reasoning).toEqual([
    { text: secretA, continuation: false },
    { text: secretB, continuation: true },
  ]);
  const helperFound = readReceiptRecords(receipts, "helper-");
  const daemonFound = readReceiptRecords(receipts, "daemon-");
  expect(helperFound.records.length).toBe(2);
  expect(daemonFound.records.length).toBe(2);
  expect(helperFound.records.map(record => record.stage)).toEqual(["helper_emit", "helper_emit"]);
  expect(daemonFound.records.map(record => record.stage)).toEqual(["daemon_receive", "daemon_receive"]);
  expect(helperFound.records[0].sha256).toBe(daemonFound.records[0].sha256);
  expect(helperFound.records[1].sha256).toBe(daemonFound.records[1].sha256);
  expect(helperFound.records[0].sha256).toBe(createHash("sha256").update(secretA, "utf8").digest("hex"));
  expect(helperFound.records[1].continuation).toBe(true);
  expect(helperFound.raw).not.toContain(secretA);
  expect(helperFound.raw).not.toContain(secretB);
  expect(helperFound.raw).not.toContain("commentary");
  expect(helperFound.raw).not.toContain("text-delta");
  expect(daemonFound.raw).not.toContain(secretA);
  expect(daemonFound.raw).not.toContain(secretB);
}, 60_000);
test("helper stdout protocol bytes are identical with observability off and on", async () => {
  const root = makeRoot("codex-helper-obs-proto-");
  const receipts = makeRoot("codex-helper-obs-proto-rcpt-");
  const secret = "H6D5F-SYNTH-7f3a9c2e-Protokoll-text";
  const helper = join(root, "echo-helper.ts");
  const script = [
    "import { ChatGptBrowserWorker } from " + JSON.stringify(BROWSER_WORKER_URL) + ";",
    "ChatGptBrowserWorker.prototype.run = async function (turn) {",
    "  turn.onReasoningSummary(" + JSON.stringify(secret) + ", false);",
    "  turn.onReasoningSummary(\"second fragment\", true);",
    "  turn.onCommentary(\"note\", false);",
    "  turn.onTextDelta(\"delta\");",
    "  return \"done\";",
    "};",
    "await import(" + JSON.stringify(BROWSER_HELPER_MAIN_URL) + ");",
    "",
  ].join("\n");
  writeFileSync(helper, script, { mode: 0o700 });
  const runFrame = JSON.stringify({
    type: "run",
    id: "abcdef123456",
    config: {
      appName: "Codex Native2",
      browserHostDescriptorPath: join(root, "unused.json"),
      turnTimeoutMs: 60_000,
      autoApproveToolCalls: false,
    },
    turn: {
      traceId: "abcdef123456",
      modelId: "gpt-5.6-sol",
      capabilities: { localToolsEnabled: false, solAvailable: true, extraHighAvailable: false, proAvailable: false },
    },
  });
  const runOnce = (extraEnv: Record<string, string>): Promise<{ stdout: string; stderr: string; code: number }> => {
    return new Promise((resolve, reject) => {
      const child: ChildProcessWithoutNullStreams = spawn(process.execPath, [helper], {
        env: { ...process.env, [HELPER_PROCESS_ENV]: "1", ...extraEnv },
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      let sawResult = false;
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error("echo helper timed out"));
      }, 45_000);
      child.stdout.on("data", (chunk: unknown) => {
        stdout += String(chunk);
        if (sawResult) return;
        for (const line of stdout.split("\n")) {
          if (!line.trim()) continue;
          try {
            const message = JSON.parse(line) as { type?: string };
            if (message && message.type === "result") {
              sawResult = true;
              child.stdin.write("{\"type\":\"shutdown\"}\n");
            }
          } catch { /* partial line; wait for more data */ }
        }
      });
      child.stderr.on("data", (chunk: unknown) => { stderr += String(chunk); });
      child.on("error", (error: Error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on("exit", (code: number | null) => {
        clearTimeout(timer);
        resolve({ stdout, stderr, code: code === null ? -1 : code });
      });
      child.stdin.write(runFrame + "\n");
    });
  };
  const off = await runOnce({});
  const on = await runOnce({ [OBS_ENV]: receipts });
  expect(off.code).toBe(0);
  expect(on.code).toBe(0);
  expect(on.stdout).toBe(off.stdout);
  expect(off.stderr).not.toContain(secret);
  expect(on.stderr).not.toContain(secret);
  expect(on.stderr).not.toContain("sha256");
  const found = readReceiptRecords(receipts, "helper-");
  expect(found.records.length).toBe(2);
  expect(found.records.map(record => record.stage)).toEqual(["helper_emit", "helper_emit"]);
}, 120_000);
test("invalid observability directory fails the turn before the helper spawns", async () => {
  const root = makeRoot("codex-helper-obs-presend-");
  const marker = join(root, "spawned.marker");
  const helper = join(root, "helper.ts");
  const script = [
    "import { writeFileSync } from \"node:fs\";",
    "writeFileSync(" + JSON.stringify(marker) + ", \"spawned\\n\");",
    "await import(" + JSON.stringify(BROWSER_HELPER_MAIN_URL) + ");",
    "",
  ].join("\n");
  writeFileSync(helper, script, { mode: 0o700 });
  const descriptorHelper = join(root, "descriptor-helper.cjs");
  writeFileSync(descriptorHelper, "process.exit(99);\n", { mode: 0o700 });
  const descriptorPath = writeDescriptor(root, descriptorHelper);
  setHelperProcessEnv(undefined);
  setObsEnv(join("relative", "receipts"));
  const client = new LauncherBrowserHelperClient(launcherConfig(root, descriptorPath, helper));
  try {
    await expect(client.run({
      traceId: "abcdef123457",
      modelId: "gpt-5.6-sol",
      capabilities: { localToolsEnabled: false, solAvailable: true, extraHighAvailable: false, proAvailable: false },
      prepare: async () => ({ text: "unused", images: [], release: () => {} }),
      onTextDelta: () => {},
    })).rejects.toThrow(/absolute/);
  } finally {
    await client.close();
  }
  let markerExists = false;
  try {
    readFileSync(marker, "utf8");
    markerExists = true;
  } catch { markerExists = false; }
  expect(markerExists).toBe(false);
});
test("real helper refuses readiness when observability is misconfigured", async () => {
  const helperMain = fileURLToPath(BROWSER_HELPER_MAIN_URL);
  const child: ChildProcessWithoutNullStreams = spawn(process.execPath, [helperMain], {
    env: { ...process.env, [HELPER_PROCESS_ENV]: "1", [OBS_ENV]: join("relative", "receipts") },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: unknown) => { stdout += String(chunk); });
  child.stderr.on("data", (chunk: unknown) => { stderr += String(chunk); });
  const code: number = await new Promise(resolve => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve(999);
    }, 60_000);
    child.on("exit", (exitCode: number | null) => {
      clearTimeout(timer);
      resolve(exitCode === null ? -1 : exitCode);
    });
  });
  expect(code).not.toBe(999);
  expect(code).not.toBe(0);
  const readyLines = stdout.split("\n").filter(line => {
    if (!line.trim()) return false;
    try {
      return (JSON.parse(line) as { type?: string }).type === "ready";
    } catch {
      return false;
    }
  });
  expect(readyLines.length).toBe(0);
  expect(stderr).toMatch(/misconfigured|absolute/);
}, 90_000);
test("daemon receipt write failure fails the turn instead of dropping evidence", async () => {
  const root = makeRoot("codex-helper-obs-midturn-");
  const receipts = makeRoot("codex-helper-obs-midturn-rcpt-");
  const fake = join(root, "fake-helper.ts");
  const script = [
    "import { createInterface } from \"node:readline\";",
    "const out = (message: unknown): void => { process.stdout.write(JSON.stringify(message) + \"\\n\"); };",
    "out({ type: \"ready\", features: [] });",
    "const input = createInterface({ input: process.stdin });",
    "input.on(\"line\", line => {",
    "  let message: any;",
    "  try { message = JSON.parse(line); } catch { return; }",
    "  if (message && message.type === \"run\") {",
    "    setTimeout(() => {",
    "      out({ type: \"event\", id: message.id, event: \"reasoning\", text: \"H6D5F-SYNTH-7f3a9c2e-midturn\" });",
    "      out({ type: \"result\", id: message.id, text: \"done\" });",
    "    }, 800);",
    "  }",
    "});",
    "",
  ].join("\n");
  writeFileSync(fake, script, { mode: 0o700 });
  const descriptorHelper = join(root, "descriptor-helper.cjs");
  writeFileSync(descriptorHelper, "process.exit(99);\n", { mode: 0o700 });
  const descriptorPath = writeDescriptor(root, descriptorHelper);
  setHelperProcessEnv(undefined);
  setObsEnv(receipts);
  const seen: string[] = [];
  const client = new LauncherBrowserHelperClient(launcherConfig(root, descriptorPath, fake));
  const runPromise = client.run({
    traceId: "abcdef123458",
    modelId: "gpt-5.6-sol",
    capabilities: { localToolsEnabled: false, solAvailable: true, extraHighAvailable: false, proAvailable: false },
    prepare: async () => ({ text: "unused", images: [], release: () => {} }),
    onReasoningSummary: text => seen.push(text),
    onTextDelta: () => {},
  });
  await new Promise(resolve => setTimeout(resolve, 300));
  rmSync(receipts, { recursive: true, force: true });
  await expect(runPromise).rejects.toThrow(/could not be recorded/);
  expect(seen).toEqual([]);
  await client.close();
}, 60_000);
