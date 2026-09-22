import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * External-client credentials for the PR #4 authenticated-external boundary.
 *
 * Primitives only: this module validates, generates, looks up, and compares external client
 * credentials. It never reads a request context, decides admission, or mutates configuration.
 * The admission rule that consumes these helpers — including the requirement that an unknown id
 * and a known id with a wrong token produce the same response — is implemented in a later stage.
 */

/** Header naming the external client a caller claims to be. */
export const EXTERNAL_CLIENT_ID_HEADER = "X-Codex-ChatGpt-Web-Client";

/**
 * Canonical external client id. Ids are matched verbatim, so a value that is not already in
 * canonical form is rejected instead of being lowercased, trimmed, or otherwise repaired.
 */
const EXTERNAL_CLIENT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{2,63}$/;

/**
 * High-entropy base64url secret shape. Generated tokens are 32 random bytes, which encode to 43
 * base64url characters; the accepted floor stays below that so a compliant secret is never
 * rejected only because it is shorter than the current generator output.
 */
const EXTERNAL_CLIENT_TOKEN_PATTERN = /^[A-Za-z0-9_-]{40,}$/;

/** Randomness behind a generated token. */
const EXTERNAL_CLIENT_TOKEN_BYTES = 32;

/** Fixed-size digest used only to give the unknown-client path comparable work to do. */
const DUMMY_EXTERNAL_CLIENT_DIGEST = createHash("sha256")
  .update("codex-chatgpt-web/external-client/decoy")
  .digest();

/** One persisted external client credential. The token is a secret: never log or echo it. */
export interface ExternalClientRecord {
  id: string;
  token: string;
  label?: string;
}

/** Returns the id when it is already canonical and `undefined` otherwise. */
export function validateExternalClientId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return EXTERNAL_CLIENT_ID_PATTERN.test(value) ? value : undefined;
}

/** Returns the token when it has the accepted secret shape and `undefined` otherwise. */
export function validateExternalClientToken(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return EXTERNAL_CLIENT_TOKEN_PATTERN.test(value) ? value : undefined;
}

/** A new secret: 32 random bytes as base64url. Storage and redaction stay with the caller. */
export function generateExternalClientToken(): string {
  return randomBytes(EXTERNAL_CLIENT_TOKEN_BYTES).toString("base64url");
}

/**
 * Reads the caller-asserted external client id.
 *
 * Only an already-canonical value is returned, so a missing, malformed, or repeated header is
 * indistinguishable from an absent one and can never select a client on its own. A header that
 * arrived as several joined values fails the canonical check as well.
 */
export function readExternalClientId(headers: Headers): string | undefined {
  const raw = headers.get(EXTERNAL_CLIENT_ID_HEADER);
  if (typeof raw !== "string") return undefined;
  return validateExternalClientId(raw.trim());
}

/**
 * Extracts the secret from an `Authorization: Bearer <token>` header.
 *
 * A parser, not a gate: the token is returned verbatim so it can be compared byte-for-byte with
 * a stored credential, and it is never trimmed or otherwise transformed. Callers that need the
 * secret shape checked use {@link validateExternalClientToken}.
 */
export function parseBearerToken(header: string | null): string | undefined {
  if (typeof header !== "string") return undefined;
  const match = /^Bearer +(\S+)$/i.exec(header.trim());
  return match?.[1];
}

/** Exact, non-normalizing lookup by canonical id. */
export function findExternalClient(
  records: readonly ExternalClientRecord[],
  id: string,
): ExternalClientRecord | undefined {
  return records.find(record => record.id === id);
}

/**
 * Constant-time comparison of a presented secret against a stored credential.
 *
 * Both sides must already be in the accepted shape, and byte lengths must match, before the
 * comparison runs; every other case returns `false` without a comparison. No input makes this
 * throw. Client-id lookup itself is not constant-time - the observable security invariant is
 * that an unknown id and a known id with a wrong token are answered identically.
 */
export function verifyExternalClientToken(record: ExternalClientRecord, presented: string): boolean {
  const expected = validateExternalClientToken(record?.token);
  const candidate = validateExternalClientToken(presented);
  if (expected === undefined || candidate === undefined) return false;
  const expectedBytes = Buffer.from(expected, "utf8");
  const candidateBytes = Buffer.from(candidate, "utf8");
  if (expectedBytes.length !== candidateBytes.length) return false;
  return timingSafeEqual(expectedBytes, candidateBytes);
}

/**
 * Best-effort timing uniformity for the unknown-client path: one fixed-size hash and compare so
 * an unknown id does comparable work to a known id presented with a wrong token.
 *
 * This is deliberately not a claim that client-id lookup is constant-time. It is not. The
 * invariant that matters is the observable HTTP result, which is enforced at admission.
 */
export function dummyTimingSafeCompare(presented: string): void {
  const digest = createHash("sha256")
    .update(typeof presented === "string" ? presented : "")
    .digest();
  timingSafeEqual(DUMMY_EXTERNAL_CLIENT_DIGEST, digest);
}

/**
 * Validates the `externalClients` configuration value into runtime records.
 *
 * Absent means no external clients. Anything else must be an array of well-formed records:
 * duplicate ids and duplicate tokens are configuration errors rather than values to
 * deduplicate, and no id, token, or label is normalized along the way. A record becomes runtime
 * state with exactly the declared credential fields. Error text never contains a token.
 */
export function validateExternalClients(value: unknown): ExternalClientRecord[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("externalClients must be an array");
  const records: ExternalClientRecord[] = [];
  const ids = new Set<string>();
  const tokens = new Set<string>();
  for (let index = 0; index < value.length; index += 1) {
    const item = value[index];
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`externalClients[${index}] must be an object`);
    }
    const entry = item as Record<string, unknown>;
    const id = validateExternalClientId(entry.id);
    if (id === undefined) throw new Error(`external client id is invalid in externalClients[${index}]`);
    const token = validateExternalClientToken(entry.token);
    if (token === undefined) throw new Error(`external client token is invalid in externalClients[${index}]`);
    if (entry.label !== undefined && typeof entry.label !== "string") {
      throw new Error(`external client label is invalid in externalClients[${index}]`);
    }
    if (ids.has(id)) throw new Error(`duplicate external client id ${JSON.stringify(id)}`);
    if (tokens.has(token)) throw new Error(`duplicate external client token in externalClients[${index}]`);
    ids.add(id);
    tokens.add(token);
    records.push(entry.label === undefined ? { id, token } : { id, token, label: entry.label });
  }
  return records;
}
