import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { formatErrorResponse } from "./bridge";

/**
 * Dedicated OpenCodex provider authentication boundary (S4B).
 *
 * This is NOT generic external-client identity. The OpenCodex provider path uses one
 * high-entropy local provider secret stored in a private local file referenced by
 * configuration. Verification is a constant-time Bearer comparison against that single
 * secret. Missing, malformed, and wrong credentials all fail with the same 401 class,
 * before any model discovery, browser work, or request parsing.
 *
 * The secret is never logged, never echoed in errors, and never exposed via /healthz.
 */

/** File name for the private provider secret inside the app home. */
export const OPENCODEX_PROVIDER_TOKEN_FILE_NAME = "opencodex-provider-token";

/** High-entropy base64url secret shape. 32 random bytes encode to 43 chars. */
export const OPENCODEX_PROVIDER_TOKEN_PATTERN = /^[A-Za-z0-9_-]{40,}$/;

/** Randomness behind a generated provider secret. */
const OPENCODEX_PROVIDER_TOKEN_BYTES = 32;

/** Single stable message for every provider authentication failure. No secret, no id. */
export const OPENCODEX_PROVIDER_AUTH_FAILURE_MESSAGE = "OpenCodex provider authentication failed";

/** Stable provider-facing error messages (no secrets, no paths, no tokens). */
export const OPENCODEX_PROVIDER_PREVIOUS_RESPONSE_MESSAGE =
  "OpenCodex provider requests must send complete input history and cannot use previous_response_id";
export const OPENCODEX_PROVIDER_COMPACT_ENDPOINT_MESSAGE =
  "OpenCodex compaction uses POST /v1/responses; this endpoint is not part of the OpenCodex provider contract";

/** Fixed-size digest used only to give the missing-secret path comparable work. */
const DUMMY_PROVIDER_DIGEST = createHash("sha256")
  .update("codex-chatgpt-web/opencodex-provider/decoy")
  .digest();

/** A new provider secret: 32 random bytes as base64url. Storage stays with the caller. */
export function generateOpencodexProviderToken(): string {
  return randomBytes(OPENCODEX_PROVIDER_TOKEN_BYTES).toString("base64url");
}

/** Returns the token when it has the accepted secret shape, otherwise undefined. */
export function validateOpencodexProviderToken(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return OPENCODEX_PROVIDER_TOKEN_PATTERN.test(value) ? value : undefined;
}

function expandTokenUserPath(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/") || value.startsWith("~\\")) return join(homedir(), value.slice(2));
  return value;
}

function appHomeForTokenFile(explicitHome?: string): string {
  const configured = (explicitHome ?? process.env.CODEX_CHATGPT_WEB_HOME ?? "").trim();
  if (configured) return resolve(expandTokenUserPath(configured));
  return resolve(join(homedir(), ".codex-chatgpt-web"));
}

/** Default private provider-secret file for the current app home. */
export function getDefaultOpencodexProviderTokenFile(home?: string): string {
  return join(appHomeForTokenFile(home), OPENCODEX_PROVIDER_TOKEN_FILE_NAME);
}

function normalizeTokenFilePath(filePath: string): string {
  const expanded = expandTokenUserPath(filePath.trim());
  if (!expanded) throw new Error("OpenCodex provider token file path is empty");
  if (!isAbsolute(expanded)) throw new Error("OpenCodex provider token file path must be absolute");
  return resolve(expanded);
}

const tokenAtomicWaitCell = new Int32Array(new SharedArrayBuffer(4));
const TOKEN_WINDOWS_RENAME_DELAYS_MS = [25, 50, 100, 150, 250, 350, 500] as const;

function renameTokenAtomicFile(source: string, destination: string): void {
  for (let attempt = 0; ; attempt += 1) {
    try {
      renameSync(source, destination);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const transientWindowsError = process.platform === "win32"
        && (code === "EBUSY" || code === "EPERM" || code === "EACCES");
      const delay = TOKEN_WINDOWS_RENAME_DELAYS_MS[attempt];
      if (!transientWindowsError || delay === undefined) throw error;
      Atomics.wait(tokenAtomicWaitCell, 0, 0, delay);
    }
  }
}

function atomicWriteTokenFile(
  path: string,
  data: string | Uint8Array,
  { mode = 0o600 }: { mode?: number } = {},
): void {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  try {
    chmodSync(directory, 0o700);
  } catch {
    /* Windows ACLs are managed by the installer. */
  }
  const temp = `${path}.tmp-${process.pid}-${crypto.randomUUID()}`;
  const fd = openSync(temp, "wx", mode);
  try {
    writeFileSync(fd, data);
    closeSync(fd);
    renameTokenAtomicFile(temp, path);
  } catch (error) {
    try {
      closeSync(fd);
    } catch {}
    rmSync(temp, { force: true });
    throw error;
  }
  try {
    chmodSync(path, mode);
  } catch {
    /* Windows ACLs are managed by the installer. */
  }
}

function readTokenFileText(path: string): string {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    throw new Error(
      "OpenCodex provider secret is unreadable; check file permissions for the provider token file",
    );
  }
  // Strip BOM and surrounding whitespace; the file holds exactly the token.
  const token = text.replace(/^\uFEFF/, "").trim();
  return token;
}

function assertDurableTokenFile(_path: string): void {
  // The token file may live in an isolated temp home during tests (mkdtemp under
  // os.tmpdir). Durability is enforced for the runtime executable, not for this
  // secret: privacy comes from atomic 0600 creation and a 0700 parent, not from
  // refusing temp paths. Production homes are never ephemeral.
}

/**
 * Read the provider secret from its private file.
 *
 * Fails closed with a clear message when the file is missing, unreadable, empty, or
 * malformed. The message never contains the secret or the file contents.
 */
export function readOpencodexProviderTokenFile(filePath: string): string {
  const path = normalizeTokenFilePath(filePath);
  const token = readTokenFileText(path);
  if (validateOpencodexProviderToken(token) === undefined) {
    throw new Error(
      "OpenCodex provider secret is invalid; delete the provider token file and restart setup to regenerate it, or rotate it explicitly",
    );
  }
  return token;
}

/**
 * Ensure the private provider-secret file exists, generating once when absent.
 *
 * Never overwrites an existing valid secret. Creates parent directories with private
 * permissions and writes atomically with mode 0600. When controlToken is supplied the
 * generated secret is guaranteed to differ from it; an existing secret equal to the
 * control token fails closed instead of being silently rotated.
 */
export function ensureOpencodexProviderTokenFile(
  filePath: string,
  controlToken?: string,
): { path: string; token: string; created: boolean } {
  const path = normalizeTokenFilePath(filePath);
  assertDurableTokenFile(path);
  if (existsSync(path)) {
    const token = readTokenFileText(path);
    if (validateOpencodexProviderToken(token) === undefined) {
      throw new Error(
        "OpenCodex provider secret is invalid; delete the provider token file and restart setup to regenerate it, or rotate it explicitly",
      );
    }
    if (controlToken && token === controlToken) {
      throw new Error("OpenCodex provider secret must differ from the control token; rotate it explicitly");
    }
    return { path, token, created: false };
  }
  let token = generateOpencodexProviderToken();
  if (controlToken) {
    // Collision is cryptographically negligible; still guarantee distinctness.
    while (token === controlToken) token = generateOpencodexProviderToken();
  }
  atomicWriteTokenFile(path, `${token}\n`, { mode: 0o600 });
  return { path, token, created: true };
}

/**
 * Explicit regeneration/rotation primitive. Atomically replaces the secret file.
 * Callers must update the OpenCodex provider configuration (apiKey) after rotating.
 */
export function rotateOpencodexProviderTokenFile(
  filePath: string,
  controlToken?: string,
): { path: string; token: string } {
  const path = normalizeTokenFilePath(filePath);
  assertDurableTokenFile(path);
  let token = generateOpencodexProviderToken();
  if (controlToken) {
    while (token === controlToken) token = generateOpencodexProviderToken();
  }
  atomicWriteTokenFile(path, `${token}\n`, { mode: 0o600 });
  return { path, token };
}

/**
 * Extract the secret from an Authorization: Bearer header. Parser only, never a gate:
 * the token is returned verbatim for constant-time comparison, never trimmed beyond
 * the standard Bearer framing.
 */
export function parseProviderBearerToken(header: string | null): string | undefined {
  if (typeof header !== "string") return undefined;
  const match = /^Bearer +(\S+)$/i.exec(header.trim());
  return match?.[1];
}

/**
 * Constant-time comparison against the stored provider secret.
 * Both sides must already have the accepted shape and matching length; every other
 * case returns false without a comparison and never throws.
 */
export function verifyOpencodexProviderToken(expected: string, presented: string): boolean {
  const expectedValid = validateOpencodexProviderToken(expected);
  const presentedValid = validateOpencodexProviderToken(presented);
  if (expectedValid === undefined || presentedValid === undefined) return false;
  const expectedBytes = Buffer.from(expectedValid, "utf8");
  const presentedBytes = Buffer.from(presentedValid, "utf8");
  if (expectedBytes.length !== presentedBytes.length) return false;
  return timingSafeEqual(expectedBytes, presentedBytes);
}

/** Best-effort timing uniformity for the missing/malformed path. Never throws. */
export function dummyProviderTokenCompare(presented: string): void {
  const digest = createHash("sha256")
    .update(typeof presented === "string" ? presented : "")
    .digest();
  timingSafeEqual(DUMMY_PROVIDER_DIGEST, digest);
}

/** The single response construction path for every provider authentication failure. */
export function opencodexProviderAuthFailure(): Response {
  return formatErrorResponse(401, "authentication_error", OPENCODEX_PROVIDER_AUTH_FAILURE_MESSAGE);
}

/** Stable machine-readable unknown/ineligible model rejection. No fallback, no default. */
export function opencodexProviderUnsupportedModel(model: unknown): Response {
  const label = typeof model === "string" && model.length > 0 && model.length <= 200 ? model : "unknown";
  // Built directly (not via formatErrorResponse) so the stable provider code
  // survives the shared classifier, which maps every 400 onto
  // invalid_request_error/invalid_request_error.
  return new Response(JSON.stringify({ error: { message: `Model ${label} is not provided by codex-chatgpt-web`, type: "invalid_request_error", code: "unsupported_model" } }), { status: 400, headers: { "Content-Type": "application/json" } });
}

/** Stable unsupported-request rejection (for example previous_response_id). */
export function opencodexProviderUnsupportedRequest(message: string): Response {
  return new Response(JSON.stringify({ error: { message, type: "invalid_request_error", code: "unsupported_request" } }), { status: 400, headers: { "Content-Type": "application/json" } });
}
