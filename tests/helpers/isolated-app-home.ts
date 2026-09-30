// S4D test-home isolation (area C): provider-token ensure, setup/serve config
// resolution, DEV driver startup, and the provider harness must never resolve to
// the real user app home. Files that trigger those paths call isolateTestAppHome()
// at module scope (after imports) and restoreTestAppHome() in afterAll.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const roots: string[] = [];
const previousHome = process.env.CODEX_CHATGPT_WEB_HOME;

export function isolateTestAppHome(prefix = "s4d-test-home-"): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  process.env.CODEX_CHATGPT_WEB_HOME = join(root, "app");
  return root;
}

export function restoreTestAppHome(): void {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  if (previousHome === undefined) delete process.env.CODEX_CHATGPT_WEB_HOME;
  else process.env.CODEX_CHATGPT_WEB_HOME = previousHome;
}
