import { afterEach, beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { defaultConfig } from "../src/config";
import { LAUNCHER_BROWSER_IDLE_URL } from "../src/launcher-browser-host";
import {
  acquireLifecycleLock,
  assertLifecycleOwnershipMatch,
  getLifecycleLockPath,
  LifecycleLockBusyError,
  parseExpectedLifecycleOwnership,
  readActualLifecycleOwnership,
} from "../src/lifecycle-lock";

setDefaultTimeout(30_000);

const CLI = resolve(import.meta.dir, "../src/cli.ts");
const LOCK_MODULE_URL = pathToFileURL(resolve(import.meta.dir, "../src/lifecycle-lock.ts")).href;

interface Fixture {
  root: string;
  appHome: string;
  codexHome: string;
}

const roots: string[] = [];
const holders: Array<{ kill: () => void; exited: Promise<unknown> }> = [];
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of ["CODEX_HOME", "CODEX_CHATGPT_WEB_HOME"] as const) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

async function stopHolders(): Promise<void> {
  for (const holder of holders.splice(0)) {
    try {
      holder.kill();
    } catch {
      // Already exited.
    }
    await holder.exited;
  }
}

afterEach(async () => {
  await stopHolders();
  for (const key of ["CODEX_HOME", "CODEX_CHATGPT_WEB_HOME"] as const) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "codex-chatgpt-web-lifecycle-"));
  const appHome = join(root, "app");
  const codexHome = join(root, "codex");
  mkdirSync(appHome, { recursive: true });
  mkdirSync(codexHome, { recursive: true });
  roots.push(root);
  process.env.CODEX_HOME = codexHome;
  process.env.CODEX_CHATGPT_WEB_HOME = appHome;
  return { root, appHome, codexHome };
}

function writeAppConfig(appHome: string, overrides: Record<string, unknown> = {}): string {
  const config = { ...defaultConfig("browser-only"), ...overrides };
  const configPath = join(appHome, "config.json");
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  return readFileSync(configPath, "utf8");
}

function cliEnv(fx: Fixture): Record<string, string | undefined> {
  return { ...process.env, CODEX_HOME: fx.codexHome, CODEX_CHATGPT_WEB_HOME: fx.appHome };
}

async function runCli(args: string[], env: Record<string, string | undefined>) {
  const child = Bun.spawn([process.execPath, CLI, ...args], {
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

function snapshotTree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) out[relative(dir, full)] = readFileSync(full, "utf8");
    }
  };
  if (existsSync(dir)) walk(dir);
  return out;
}

// A second OS process that acquires the lifecycle lock for a home and holds
// it until killed. Genuine cross-process contention, not an in-memory mutex.
const HOLDER_SCRIPT = `import { acquireLifecycleLock } from ${JSON.stringify(LOCK_MODULE_URL)};
const home = process.argv[2] ?? "";
const lock = acquireLifecycleLock("test-holder", home);
process.stdout.write("HOLDER_READY\\n");
setInterval(() => {}, 1000);
`;

const CONTENDER_SCRIPT = `import { acquireLifecycleLock } from ${JSON.stringify(LOCK_MODULE_URL)};
const home = process.argv[2] ?? "";
try {
  const lock = acquireLifecycleLock("test-contender", home);
  process.stdout.write("CONTENDER_ACQUIRED\\n");
  lock.release();
} catch (error) {
  process.stdout.write("CONTENDER_BUSY " + (error instanceof Error ? error.message : String(error)) + "\\n");
  process.exit(2);
}
`;

async function startHolder(fx: Fixture): Promise<void> {
  const scriptPath = join(fx.root, "hold-lock.ts");
  writeFileSync(scriptPath, HOLDER_SCRIPT);
  const child = Bun.spawn([process.execPath, scriptPath, fx.appHome], {
    env: cliEnv(fx),
    stdout: "pipe",
    stderr: "pipe",
  });
  holders.push(child);
  const lockPath = getLifecycleLockPath(fx.appHome);
  const deadline = Date.now() + 10_000;
  for (;;) {
    if (existsSync(lockPath)) return;
    const exited = await Promise.race([
      child.exited,
      new Promise<null>((wake) => setTimeout(() => wake(null), 50)),
    ]);
    if (exited !== null) {
      const stderr = await new Response(child.stderr).text();
      throw new Error(`lock holder exited early with code ${exited}: ${stderr}`);
    }
    if (Date.now() > deadline) throw new Error("lock holder did not acquire the lock in time");
  }
}

async function runContender(fx: Fixture, home: string): Promise<{ exitCode: number; stdout: string }> {
  const scriptPath = join(fx.root, `contend-${Date.now()}-${Math.random().toString(36).slice(2)}.ts`);
  writeFileSync(scriptPath, CONTENDER_SCRIPT);
  const child = Bun.spawn([process.execPath, scriptPath, home], {
    env: cliEnv(fx),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()]);
  return { exitCode, stdout };
}

test("same-home lifecycle mutations exclude each other across processes", async () => {
  const fx = fixture();
  const before = writeAppConfig(fx.appHome);
  writeFileSync(join(fx.appHome, "sentinel.txt"), "do-not-delete\n");
  await startHolder(fx);
  const busy = await runCli(["uninstall", "--yes"], cliEnv(fx));
  expect(busy.exitCode).toBe(1);
  expect(busy.stderr).toContain("Another codex-chatgpt-web lifecycle operation is active");
  expect(readFileSync(join(fx.appHome, "config.json"), "utf8")).toBe(before);
  expect(existsSync(join(fx.appHome, "sentinel.txt"))).toBe(true);
});

test("different homes do not block each other", async () => {
  const fxA = fixture();
  writeAppConfig(fxA.appHome);
  const fxB = fixture();
  writeAppConfig(fxB.appHome);
  await startHolder(fxA);
  const contender = await runContender(fxB, fxB.appHome);
  expect(contender.exitCode).toBe(0);
  expect(contender.stdout).toContain("CONTENDER_ACQUIRED");
  const removed = await runCli(["uninstall", "--yes"], cliEnv(fxB));
  expect(removed.exitCode).toBe(0);
  expect(existsSync(fxB.appHome)).toBe(false);
  expect(existsSync(join(fxA.appHome, "config.json"))).toBe(true);
});

test("concurrent route mutation cannot enter while the lock is held, then proceeds after release", async () => {
  const fx = fixture();
  await startHolder(fx);
  const route = await runCli(["route", "connect"], cliEnv(fx));
  expect(route.exitCode).toBe(1);
  expect(route.stderr).toContain("Another codex-chatgpt-web lifecycle operation is active");
  // Read-only status never takes the lock, so it still answers while held.
  const status = await runCli(["route", "status"], cliEnv(fx));
  expect(status.exitCode).toBe(0);
  const contender = await runContender(fx, fx.appHome);
  expect(contender.exitCode).toBe(2);
  expect(contender.stdout).toContain("CONTENDER_BUSY");
  expect(contender.stdout).toContain("Another codex-chatgpt-web lifecycle operation is active");
  await stopHolders();
  const after = await runContender(fx, fx.appHome);
  expect(after.exitCode).toBe(0);
  expect(after.stdout).toContain("CONTENDER_ACQUIRED");
});

test("expected-external uninstall aborts before deleting a fresh direct install", async () => {
  const fx = fixture();
  const before = writeAppConfig(fx.appHome);
  writeFileSync(join(fx.appHome, "sentinel.txt"), "do-not-delete\n");
  const codexConfig = join(fx.codexHome, "config.toml");
  writeFileSync(codexConfig, "fresh-direct-route\n");
  const result = await runCli([
    "uninstall",
    "--yes",
    "--expected-installation-kind",
    "configured",
    "--expected-integration-mode",
    "external-provider",
  ], cliEnv(fx));
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toMatch(/expected configured external-provider but found configured direct/);
  expect(readFileSync(join(fx.appHome, "config.json"), "utf8")).toBe(before);
  expect(existsSync(join(fx.appHome, "sentinel.txt"))).toBe(true);
  expect(readFileSync(codexConfig, "utf8")).toBe("fresh-direct-route\n");
});

test("expected-direct uninstall aborts before touching a fresh external install", async () => {
  const fx = fixture();
  const before = writeAppConfig(fx.appHome, { integrationMode: "external-provider" });
  const codexConfig = join(fx.codexHome, "config.toml");
  const modelsCache = join(fx.codexHome, "models_cache.json");
  writeFileSync(codexConfig, "router-owned route\n");
  writeFileSync(modelsCache, '{"router":true}\n');
  const result = await runCli([
    "uninstall",
    "--yes",
    "--expected-installation-kind",
    "configured",
    "--expected-integration-mode",
    "direct",
  ], cliEnv(fx));
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toMatch(/expected configured direct but found configured external-provider/);
  expect(readFileSync(join(fx.appHome, "config.json"), "utf8")).toBe(before);
  expect(readFileSync(codexConfig, "utf8")).toBe("router-owned route\n");
  expect(readFileSync(modelsCache, "utf8")).toBe('{"router":true}\n');
});

test("expected-missing uninstall refuses to delete a configured install", async () => {
  const fx = fixture();
  const before = writeAppConfig(fx.appHome);
  const result = await runCli(["uninstall", "--yes", "--expected-installation-kind", "missing"], cliEnv(fx));
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toMatch(/expected missing but found configured direct/);
  expect(readFileSync(join(fx.appHome, "config.json"), "utf8")).toBe(before);
});

test("expected-configured uninstall refuses an actually-missing install", async () => {
  const fx = fixture();
  const result = await runCli([
    "uninstall",
    "--yes",
    "--expected-installation-kind",
    "configured",
    "--expected-integration-mode",
    "direct",
  ], cliEnv(fx));
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toMatch(/expected configured direct but found missing/);
  expect(existsSync(join(fx.appHome, "config.json"))).toBe(false);
});

test("normal direct remove still succeeds and cannot delete its own lock", async () => {
  const fx = fixture();
  writeAppConfig(fx.appHome);
  const lockPath = getLifecycleLockPath(fx.appHome);
  expect(lockPath).toBe(join(dirname(fx.appHome), `${basename(fx.appHome)}.lifecycle.lock`));
  expect(dirname(lockPath)).toBe(dirname(fx.appHome));
  const result = await runCli(["uninstall", "--yes"], cliEnv(fx));
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("Uninstalled and removed private application data");
  expect(existsSync(fx.appHome)).toBe(false);
  // The lock lives next to the deleted home, so uninstall cannot remove it:
  // the same lock domain stays usable immediately afterwards.
  const lock = acquireLifecycleLock("test-reacquire", fx.appHome);
  expect(existsSync(lock.lockPath)).toBe(true);
  lock.release();
  expect(existsSync(lock.lockPath)).toBe(false);
});

test("normal external remove succeeds with zero route lifecycle", async () => {
  const fx = fixture();
  writeAppConfig(fx.appHome, { integrationMode: "external-provider" });
  // A stale bridge journal is bridge data, deleted with the home; router-owned
  // Codex files must stay byte-identical with no route lifecycle at all.
  const journalDir = join(fx.appHome, "codex");
  mkdirSync(journalDir, { recursive: true });
  writeFileSync(join(journalDir, "integration-journal.json"), '{"stale":true}\n');
  writeFileSync(join(fx.codexHome, "config.toml"), "router-owned route\n");
  writeFileSync(join(fx.codexHome, "models_cache.json"), '{"router":true}\n');
  const codexBefore = snapshotTree(fx.codexHome);
  const result = await runCli(["uninstall", "--yes"], cliEnv(fx));
  expect(result.exitCode).toBe(0);
  expect(result.stderr).toBe("");
  expect(result.stdout).toContain("Uninstalled and removed private application data");
  expect(existsSync(fx.appHome)).toBe(false);
  expect(snapshotTree(fx.codexHome)).toEqual(codexBefore);
  expect(readFileSync(join(fx.codexHome, "config.toml"), "utf8")).toBe("router-owned route\n");
  expect(readFileSync(join(fx.codexHome, "models_cache.json"), "utf8")).toBe('{"router":true}\n');
});

test("launcher-controlled uninstall requires expected ownership from the trusted launcher state", async () => {
  const fx = fixture();
  writeAppConfig(fx.appHome);
  const token = "lifecycle-test-control-token-0123456789abcdef";
  const descriptorPath = join(fx.appHome, "runtime", "launcher-browser.json");
  mkdirSync(join(fx.appHome, "runtime"), { recursive: true });
  writeFileSync(join(fx.root, "helper.cjs"), "module.exports = {};\n");
  writeFileSync(descriptorPath, `${JSON.stringify({
    version: 3,
    kind: "codex-web-gpt-launcher",
    profile: "production",
    pid: process.pid,
    endpoint: "http://127.0.0.1:48111",
    control: { endpoint: "http://127.0.0.1:48112", token },
    helper: { executable: process.execPath, script: join(fx.root, "helper.cjs") },
    partition: "persist:codex-web-gpt-chatgpt",
    idleUrl: LAUNCHER_BROWSER_IDLE_URL,
    surfaceId: "a".repeat(32),
    surfaceTargets: { ["a".repeat(32)]: "native-owned-target" },
    createdAt: new Date().toISOString(),
  })}\n`, { mode: 0o600 });
  const authedEnv = {
    ...cliEnv(fx),
    CODEX_CHATGPT_WEB_BROWSER_HOST_DESCRIPTOR: descriptorPath,
    CODEX_WEB_GPT_LAUNCHER_CONTROL_TOKEN: token,
  };
  const result = await runCli(["uninstall", "--yes", "--launcher-control"], authedEnv);
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("requires --expected-installation-kind");
  expect(existsSync(join(fx.appHome, "config.json"))).toBe(true);
});

test("malformed expected ownership rejects before any mutation", async () => {
  const fx = fixture();
  const before = writeAppConfig(fx.appHome);
  const cases: string[][] = [
    ["--expected-installation-kind", "bogus"],
    ["--expected-integration-mode", "direct"],
    ["--expected-installation-kind", "configured"],
    ["--expected-installation-kind", "missing", "--expected-integration-mode", "direct"],
    ["--expected-installation-kind", "configured", "--expected-integration-mode", "bogus"],
  ];
  for (const extra of cases) {
    const result = await runCli(["uninstall", "--yes", ...extra], cliEnv(fx));
    expect(result.exitCode).toBe(1);
    expect(readFileSync(join(fx.appHome, "config.json"), "utf8")).toBe(before);
  }
  const kind = await runCli(["uninstall", "--yes", "--expected-installation-kind", "bogus"], cliEnv(fx));
  expect(kind.stderr).toContain("--expected-installation-kind must be configured or missing");
  const modeOnly = await runCli(["uninstall", "--yes", "--expected-integration-mode", "direct"], cliEnv(fx));
  expect(modeOnly.stderr).toContain("--expected-installation-kind must be configured or missing");
  const needMode = await runCli(["uninstall", "--yes", "--expected-installation-kind", "configured"], cliEnv(fx));
  expect(needMode.stderr).toContain("--expected-integration-mode is required");
  const noMode = await runCli(
    ["uninstall", "--yes", "--expected-installation-kind", "missing", "--expected-integration-mode", "direct"],
    cliEnv(fx),
  );
  expect(noMode.stderr).toContain("cannot accompany");
});

test("expected-ownership parsing and matching are allowlisted and exact", () => {
  expect(parseExpectedLifecycleOwnership({})).toBeUndefined();
  expect(parseExpectedLifecycleOwnership({ kind: "configured", mode: "direct" })).toEqual({
    kind: "configured",
    integrationMode: "direct",
  });
  expect(parseExpectedLifecycleOwnership({ kind: "configured", mode: "external-provider" })).toEqual({
    kind: "configured",
    integrationMode: "external-provider",
  });
  expect(parseExpectedLifecycleOwnership({ kind: "missing" })).toEqual({ kind: "missing" });
  expect(() => parseExpectedLifecycleOwnership({ kind: "bogus" })).toThrow(
    "--expected-installation-kind must be configured or missing",
  );
  expect(() => parseExpectedLifecycleOwnership({ kind: "configured" })).toThrow(
    "--expected-integration-mode is required",
  );
  const directConfig = defaultConfig("browser-only");
  const externalConfig = { ...defaultConfig("browser-only"), integrationMode: "external-provider" as const };
  assertLifecycleOwnershipMatch(
    { kind: "configured", integrationMode: "direct" },
    { kind: "configured", integrationMode: "direct", config: directConfig },
    "uninstall",
  );
  expect(() =>
    assertLifecycleOwnershipMatch(
      { kind: "configured", integrationMode: "direct" },
      { kind: "configured", integrationMode: "external-provider", config: externalConfig },
      "uninstall",
    ),
  ).toThrow("expected configured direct but found configured external-provider");
  expect(() =>
    assertLifecycleOwnershipMatch(
      { kind: "missing" },
      { kind: "configured", integrationMode: "direct", config: directConfig },
      "uninstall",
    ),
  ).toThrow("expected missing but found configured direct");
  expect(() =>
    assertLifecycleOwnershipMatch(
      { kind: "configured", integrationMode: "direct" },
      { kind: "missing" },
      "uninstall",
    ),
  ).toThrow("expected configured direct but found missing");
});

test("actual ownership reads canonical state and fails closed on damage", () => {
  const fx = fixture();
  expect(readActualLifecycleOwnership()).toEqual({ kind: "missing" });
  writeAppConfig(fx.appHome);
  expect(readActualLifecycleOwnership()).toEqual({
    kind: "configured",
    integrationMode: "direct",
    config: expect.anything(),
  });
  writeAppConfig(fx.appHome, { integrationMode: "external-provider" });
  expect(readActualLifecycleOwnership()).toEqual({
    kind: "configured",
    integrationMode: "external-provider",
    config: expect.anything(),
  });
  writeFileSync(join(fx.appHome, "config.json"), "{invalid json");
  expect(() => readActualLifecycleOwnership()).toThrow("damaged");
});

test("stale, malformed, and nested locks fail in the safe direction", async () => {
  const fx = fixture();
  const lockPath = getLifecycleLockPath(fx.appHome);
  // A definitely-dead owner may be reclaimed.
  const shortLived = Bun.spawn([process.execPath, "-e", ""]);
  const deadPid = shortLived.pid;
  await shortLived.exited;
  writeFileSync(
    lockPath,
    JSON.stringify({
      pid: deadPid,
      token: "stale-token",
      command: "crashed",
      since: new Date(0).toISOString(),
      home: fx.appHome,
    }),
  );
  const reclaimed = acquireLifecycleLock("test-reclaim", fx.appHome);
  reclaimed.release();
  expect(existsSync(lockPath)).toBe(false);
  // Malformed metadata fails closed: never steal an unverifiable lock.
  writeFileSync(lockPath, "not json{{{");
  let malformed: unknown = null;
  try {
    acquireLifecycleLock("test-malformed", fx.appHome);
  } catch (error) {
    malformed = error;
  }
  expect(malformed).toBeInstanceOf(LifecycleLockBusyError);
  expect(String((malformed as Error).message)).toContain("missing or malformed");
  rmSync(lockPath, { force: true });
  // Nested acquisition in one process throws instead of self-deadlocking.
  const outer = acquireLifecycleLock("test-outer", fx.appHome);
  try {
    expect(() => acquireLifecycleLock("test-inner", fx.appHome)).toThrow("already held by this process");
  } finally {
    outer.release();
    outer.release();
  }
  expect(existsSync(lockPath)).toBe(false);
});
