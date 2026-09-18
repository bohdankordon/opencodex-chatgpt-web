const test = require("node:test");
const assert = require("node:assert/strict");
const {
  expectedProviderBaseUrl,
  expectedRoutingOwner,
  validateRuntimeOwnershipHealth,
} = require("../electron/runtime-health.cjs");

// G3 health-ownership matrix. Field names and URL construction mirror
// src/server.ts /healthz exactly; no names invented here.

const DIRECT_CONFIG = { host: "127.0.0.1", port: 17841 };
const CUSTOM_CONFIG = { host: "127.0.0.1", port: 19841 };

function directHealth(overrides) {
  return {
    status: "ok",
    integration_mode: "direct",
    routing_owner: "codex-chatgpt-web",
    provider_base_url: "http://127.0.0.1:17841/v1",
    ...overrides,
  };
}

function externalHealth(overrides) {
  return {
    status: "ok",
    integration_mode: "external-provider",
    routing_owner: "external-router",
    provider_base_url: "http://127.0.0.1:17841/v1",
    ...overrides,
  };
}

test("G3.1 Direct canonical with Direct health passes", () => {
  const result = validateRuntimeOwnershipHealth({ config: DIRECT_CONFIG, integrationMode: "direct", health: directHealth() });
  assert.deepEqual(result, {
    integrationMode: "direct",
    routingOwner: "codex-chatgpt-web",
    providerBaseUrl: "http://127.0.0.1:17841/v1",
  });
});

test("G3.2 External canonical with External health passes", () => {
  const result = validateRuntimeOwnershipHealth({ config: DIRECT_CONFIG, integrationMode: "external-provider", health: externalHealth() });
  assert.deepEqual(result, {
    integrationMode: "external-provider",
    routingOwner: "external-router",
    providerBaseUrl: "http://127.0.0.1:17841/v1",
  });
});

test("G3.3 External canonical with Direct health fails", () => {
  assert.throws(
    () => validateRuntimeOwnershipHealth({ config: DIRECT_CONFIG, integrationMode: "external-provider", health: directHealth() }),
    /ownership mismatch.*integration mode/,
  );
});

test("G3.4 Direct canonical with External health fails", () => {
  assert.throws(
    () => validateRuntimeOwnershipHealth({ config: DIRECT_CONFIG, integrationMode: "direct", health: externalHealth() }),
    /ownership mismatch.*integration mode/,
  );
});

test("G3.5 External with wrong routing owner fails", () => {
  assert.throws(
    () => validateRuntimeOwnershipHealth({
      config: DIRECT_CONFIG,
      integrationMode: "external-provider",
      health: externalHealth({ routing_owner: "codex-chatgpt-web" }),
    }),
    /routing owner/,
  );
});

test("G3.6 Direct with wrong routing owner fails", () => {
  assert.throws(
    () => validateRuntimeOwnershipHealth({
      config: DIRECT_CONFIG,
      integrationMode: "direct",
      health: directHealth({ routing_owner: "external-router" }),
    }),
    /routing owner/,
  );
});

test("G3.7 wrong provider base URL fails", () => {
  assert.throws(
    () => validateRuntimeOwnershipHealth({
      config: DIRECT_CONFIG,
      integrationMode: "direct",
      health: directHealth({ provider_base_url: "http://127.0.0.1:19841/v1" }),
    }),
    /provider URL/,
  );
  assert.throws(
    () => validateRuntimeOwnershipHealth({
      config: DIRECT_CONFIG,
      integrationMode: "external-provider",
      health: externalHealth({ provider_base_url: "http://localhost:17841/v1" }),
    }),
    /provider URL/,
  );
});

test("G3.8-10 missing ownership fields fail", () => {
  const base = directHealth();
  for (const missing of ["integration_mode", "routing_owner", "provider_base_url"]) {
    const health = { ...base };
    delete health[missing];
    assert.throws(
      () => validateRuntimeOwnershipHealth({ config: DIRECT_CONFIG, integrationMode: "direct", health }),
      /ownership mismatch/,
    );
  }
});

test("G3.11 malformed health objects fail closed", () => {
  for (const health of [null, undefined, "ok", 42, ["direct"], { integration_mode: "direct" }]) {
    assert.throws(
      () => validateRuntimeOwnershipHealth({ config: DIRECT_CONFIG, integrationMode: "direct", health }),
      /unavailable|mismatch|requires/,
    );
  }
  assert.throws(
    () => validateRuntimeOwnershipHealth({ config: DIRECT_CONFIG, integrationMode: "opencodex", health: directHealth() }),
    /requires direct or external-provider/,
  );
});

test("G3.12 provider URL derives from configured host and port", () => {
  assert.equal(expectedProviderBaseUrl(CUSTOM_CONFIG), "http://127.0.0.1:19841/v1");
  const health = externalHealth({ provider_base_url: "http://127.0.0.1:19841/v1" });
  const result = validateRuntimeOwnershipHealth({ config: CUSTOM_CONFIG, integrationMode: "external-provider", health });
  assert.equal(result.providerBaseUrl, "http://127.0.0.1:19841/v1");
  assert.throws(
    () => validateRuntimeOwnershipHealth({ config: CUSTOM_CONFIG, integrationMode: "external-provider", health: externalHealth() }),
    /provider URL/,
  );
  assert.throws(() => expectedProviderBaseUrl({ host: "127.0.0.1" }), /configured port/);
  assert.throws(() => expectedProviderBaseUrl({ port: 17841 }), /configured host/);
});

test("routing owner derivation matches server semantics", () => {
  assert.equal(expectedRoutingOwner("direct"), "codex-chatgpt-web");
  assert.equal(expectedRoutingOwner("external-provider"), "external-router");
});
