import { expect, test } from "bun:test";
import {
  EXTERNAL_CLIENT_ID_HEADER,
  classifyExternalClientHeaderValue,
  dummyTimingSafeCompare,
  findExternalClient,
  generateExternalClientToken,
  parseBearerToken,
  readExternalClientHeader,
  validateExternalClientId,
  validateExternalClientToken,
  validateExternalClients,
  verifyExternalClientToken,
  type ExternalClientRecord,
} from "../src/external-client";

const CREDENTIAL = generateExternalClientToken();

function errorFrom(run: () => unknown): Error {
  try {
    run();
  } catch (error) {
    if (error instanceof Error) return error;
    throw error;
  }
  throw new Error("Expected the call to fail");
}

function configuredClient(overrides: Partial<ExternalClientRecord> = {}): ExternalClientRecord {
  return { id: "hermes-local", token: CREDENTIAL, ...overrides };
}

test("the external client header name is the frozen wire contract", () => {
  expect(EXTERNAL_CLIENT_ID_HEADER).toBe("X-Codex-ChatGpt-Web-Client");
});

test("external client ids are accepted only in canonical form", () => {
  for (const id of ["hermes-local", "abc", "client-123"]) {
    expect(validateExternalClientId(id)).toBe(id);
  }
});

test("external client ids reject non-canonical values without repairing them", () => {
  const invalid: unknown[] = [
    "Hermes-Local",
    "-hermes-local",
    "hermes-local.",
    "hermes-local!",
    "ab",
    "a".repeat(65),
    "hermes local",
    "",
    42,
    true,
    null,
    undefined,
    {},
    [],
  ];
  for (const value of invalid) {
    expect(validateExternalClientId(value)).toBeUndefined();
  }
});

test("generated tokens are base64url secrets of the documented size", () => {
  const samples = Array.from({ length: 64 }, () => generateExternalClientToken());
  for (const token of samples) {
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(token.length).toBeGreaterThanOrEqual(40);
    expect(validateExternalClientToken(token)).toBe(token);
  }
  expect(new Set(samples).size).toBeGreaterThan(1);
});

test("token validation enforces the accepted secret shape", () => {
  const generated = generateExternalClientToken();
  expect(validateExternalClientToken(generated)).toBe(generated);
  expect(validateExternalClientToken("A".repeat(39))).toBeUndefined();
  expect(validateExternalClientToken("A".repeat(40) + "+")).toBeUndefined();
  expect(validateExternalClientToken("A".repeat(40) + "/")).toBeUndefined();
  expect(validateExternalClientToken("A".repeat(40) + "=")).toBeUndefined();
  expect(validateExternalClientToken(" " + generated)).toBeUndefined();
  for (const value of [42, true, null, undefined, {}, []]) {
    expect(validateExternalClientToken(value)).toBeUndefined();
  }
});

test("an absent header is the only state that reports absence", () => {
  expect(readExternalClientHeader(new Headers())).toEqual({ present: false });
  expect(readExternalClientHeader(new Headers([["X-Other-Client", "hermes-local"]]))).toEqual({ present: false });
  expect(classifyExternalClientHeaderValue(null)).toEqual({ present: false });
});

test("a canonical header value keeps its exact id", () => {
  const headers = new Headers([[EXTERNAL_CLIENT_ID_HEADER, "hermes-local"]]);
  expect(readExternalClientHeader(headers)).toEqual({ present: true, valid: true, clientId: "hermes-local" });
});

test("unusable header values are present-invalid instead of absent", () => {
  const unusable = [
    "",
    "Hermes-Local",
    " hermes-local ",
    " hermes-local",
    "hermes-local ",
    "hermes-local, hermes-2",
    "hermes-local,hermes-2",
    "hermes.local",
    "hermes-local!",
    "-hermes-local",
    "ab",
    "a".repeat(65),
    "hermes local",
  ];
  for (const raw of unusable) {
    expect(classifyExternalClientHeaderValue(raw)).toEqual({ present: true, valid: false });
  }
});

test("a repeated or joined dedicated header is never repaired into one id", () => {
  const combined = new Headers([
    [EXTERNAL_CLIENT_ID_HEADER, "hermes-local"],
    [EXTERNAL_CLIENT_ID_HEADER, "hermes-2"],
  ]);
  const appended = new Headers();
  appended.append(EXTERNAL_CLIENT_ID_HEADER, "hermes-local");
  appended.append(EXTERNAL_CLIENT_ID_HEADER, "hermes-2");
  const fixtures = [
    combined,
    appended,
    new Headers([[EXTERNAL_CLIENT_ID_HEADER, ""]]),
    new Headers([[EXTERNAL_CLIENT_ID_HEADER, "Hermes-Local"]]),
    new Headers([[EXTERNAL_CLIENT_ID_HEADER, "hermes-local!"]]),
  ];
  for (const headers of fixtures) {
    expect(readExternalClientHeader(headers)).toEqual({ present: true, valid: false });
  }
});

test("the HTTP layer resolves optional whitespace without this module repairing values", () => {
  // Field-value whitespace belongs to HTTP parsing: a padded wire value arrives here already
  // stripped, so the no-trim rule is asserted where the raw value is still observable.
  const padded = new Headers([[EXTERNAL_CLIENT_ID_HEADER, "  hermes-local  "]]);
  expect(padded.get(EXTERNAL_CLIENT_ID_HEADER)).toBe("hermes-local");
  expect(readExternalClientHeader(padded)).toEqual({ present: true, valid: true, clientId: "hermes-local" });
});

test("no header that carries a value is ever classified as absent", () => {
  const fixtures = [
    new Headers([[EXTERNAL_CLIENT_ID_HEADER, ""]]),
    new Headers([[EXTERNAL_CLIENT_ID_HEADER, "Hermes-Local"]]),
    new Headers([[EXTERNAL_CLIENT_ID_HEADER, "hermes-local!"]]),
    new Headers([[EXTERNAL_CLIENT_ID_HEADER, "ab"]]),
    new Headers([
      [EXTERNAL_CLIENT_ID_HEADER, "hermes-local"],
      [EXTERNAL_CLIENT_ID_HEADER, "hermes-2"],
    ]),
  ];
  for (const headers of fixtures) {
    const state = readExternalClientHeader(headers);
    // The invariant is the point: a value-carrying header is never reported as absent.
    expect(state.present).toBe(true);
    expect(state).toEqual({ present: true, valid: false });
  }
  for (const raw of ["", "Hermes-Local", " hermes-local ", "hermes-local, hermes-2", "ab"]) {
    expect(classifyExternalClientHeaderValue(raw).present).toBe(true);
  }
  expect(classifyExternalClientHeaderValue(null).present).toBe(false);
});

test("the documented admission shape separates legacy from an external-client attempt", () => {
  const route = (headers: Headers): string => {
    const external = readExternalClientHeader(headers);
    if (!external.present) return "legacy";
    if (!external.valid) return "reject";
    return "external:" + external.clientId;
  };
  expect(route(new Headers())).toBe("legacy");
  expect(route(new Headers([[EXTERNAL_CLIENT_ID_HEADER, "hermes-local"]]))).toBe("external:hermes-local");
  expect(route(new Headers([[EXTERNAL_CLIENT_ID_HEADER, "Hermes-Local"]]))).toBe("reject");
  expect(route(new Headers([[EXTERNAL_CLIENT_ID_HEADER, ""]]))).toBe("reject");
  expect(route(new Headers([
    [EXTERNAL_CLIENT_ID_HEADER, "hermes-local"],
    [EXTERNAL_CLIENT_ID_HEADER, "hermes-2"],
  ]))).toBe("reject");
});

test("bearer parsing extracts the presented secret verbatim", () => {
  const token = generateExternalClientToken();
  expect(parseBearerToken("Bearer " + token)).toBe(token);
  expect(parseBearerToken("bearer " + token)).toBe(token);
  expect(parseBearerToken("Bearer  " + token)).toBe(token);
  expect(parseBearerToken("Bearer short")).toBe("short");
  expect(parseBearerToken("Basic " + token)).toBeUndefined();
  expect(parseBearerToken("Bearer")).toBeUndefined();
  expect(parseBearerToken("Bearer " + token + " " + token)).toBeUndefined();
  expect(parseBearerToken("")).toBeUndefined();
  expect(parseBearerToken(null)).toBeUndefined();
});

test("lookup matches the canonical id exactly", () => {
  const first = configuredClient();
  const second = configuredClient({ id: "client-123", token: generateExternalClientToken(), label: "Secondary" });
  const records = [first, second];
  expect(findExternalClient(records, "hermes-local")).toBe(first);
  expect(findExternalClient(records, "client-123")).toBe(second);
  expect(findExternalClient(records, "Hermes-Local")).toBeUndefined();
  expect(findExternalClient(records, "hermes-local ")).toBeUndefined();
  expect(findExternalClient([], "hermes-local")).toBeUndefined();
});

test("token verification accepts the stored secret and rejects other secrets", () => {
  const record = configuredClient();
  const token = record.token;
  expect(verifyExternalClientToken(record, token)).toBe(true);

  const sameLengthWrong = token.endsWith("A") ? token.slice(0, -1) + "B" : token.slice(0, -1) + "A";
  expect(sameLengthWrong.length).toBe(token.length);
  expect(verifyExternalClientToken(record, sameLengthWrong)).toBe(false);
  expect(verifyExternalClientToken(record, token.slice(1))).toBe(false);
  expect(verifyExternalClientToken(record, token + "AAAA")).toBe(false);
  expect(verifyExternalClientToken(record, "")).toBe(false);
  expect(verifyExternalClientToken(record, "not-a-secret")).toBe(false);
});

test("token verification never throws on hostile input", () => {
  const record = configuredClient();
  for (const value of [undefined, null, 42, {}, [], "A".repeat(43)]) {
    expect(verifyExternalClientToken(record, value as string)).toBe(false);
  }
  expect(verifyExternalClientToken({ id: "hermes-local", token: "broken" }, record.token)).toBe(false);
  expect(verifyExternalClientToken(undefined as unknown as ExternalClientRecord, record.token)).toBe(false);
});

test("the decoy comparison consumes any input without throwing", () => {
  for (const value of ["", "short", CREDENTIAL, "A".repeat(200), undefined as unknown as string]) {
    expect(dummyTimingSafeCompare(value)).toBeUndefined();
  }
});

test("an absent external client list is empty and valid lists keep their order and fields", () => {
  expect(validateExternalClients(undefined)).toEqual([]);
  expect(validateExternalClients([])).toEqual([]);

  const token = generateExternalClientToken();
  const second = generateExternalClientToken();
  expect(validateExternalClients([{ id: "hermes-local", token }])).toEqual([{ id: "hermes-local", token }]);
  expect(validateExternalClients([
    { id: "hermes-local", token },
    { id: "client-123", token: second, label: "Secondary" },
  ])).toEqual([
    { id: "hermes-local", token },
    { id: "client-123", token: second, label: "Secondary" },
  ]);
});

test("a validated record is runtime state with exactly the credential fields", () => {
  const token = generateExternalClientToken();
  const [record] = validateExternalClients([{ id: "hermes-local", token, note: "not part of the credential" }]);
  expect(record).toEqual({ id: "hermes-local", token });
});

test("malformed external client lists are rejected instead of repaired", () => {
  const token = generateExternalClientToken();
  const second = generateExternalClientToken();
  for (const value of [null, {}, "hermes-local", 42, true]) {
    expect(() => validateExternalClients(value)).toThrow();
  }
  expect(() => validateExternalClients([null])).toThrow();
  expect(() => validateExternalClients(["hermes-local"])).toThrow();
  expect(() => validateExternalClients([[{ id: "hermes-local", token }]])).toThrow();
  expect(() => validateExternalClients([{ token }])).toThrow();
  expect(() => validateExternalClients([{ id: "Hermes-Local", token }])).toThrow();
  expect(() => validateExternalClients([{ id: "hermes-local" }])).toThrow();
  expect(() => validateExternalClients([{ id: "hermes-local", token: "short" }])).toThrow();
  expect(() => validateExternalClients([{ id: "hermes-local", token, label: 7 }])).toThrow();
  expect(() => validateExternalClients([
    { id: "hermes-local", token },
    { id: "hermes-local", token: second },
  ])).toThrow();
  expect(() => validateExternalClients([
    { id: "hermes-local", token },
    { id: "client-123", token },
  ])).toThrow();
});

test("validation errors never echo a token", () => {
  const secret = generateExternalClientToken();
  const duplicate = errorFrom(() => validateExternalClients([
    { id: "hermes-local", token: secret },
    { id: "client-123", token: secret },
  ]));
  expect(duplicate.message).toContain("duplicate external client token");
  expect(duplicate.message).not.toContain(secret);

  const malformedSecret = "s3cr3t-not-a-valid-token";
  const malformed = errorFrom(() => validateExternalClients([{ id: "hermes-local", token: malformedSecret }]));
  expect(malformed.message).toContain("external client token is invalid");
  expect(malformed.message).not.toContain(malformedSecret);
});
