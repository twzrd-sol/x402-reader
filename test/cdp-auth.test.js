import assert from "node:assert/strict";
import { generateKeyPairSync, verify } from "node:crypto";
import { test } from "node:test";
import { CDP_FACILITATOR_URL, cdpAuthHeaders, createCdpJwt, facilitatorConfig } from "../src/cdp-auth.js";

function seedAndPublicKey() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const der = privateKey.export({ format: "der", type: "pkcs8" });
  return { seed: der.subarray(-32), publicKey };
}

test("CDP JWT is EdDSA-signed and operation-bound", () => {
  const { seed, publicKey } = seedAndPublicKey();
  const jwt = createCdpJwt("key-id", seed.toString("base64"), "POST api.cdp.coinbase.com/platform/v2/x402/verify", { now: () => 1_700_000_000, nonce: () => "n" });
  const [h, c, s] = jwt.split(".");
  const claims = JSON.parse(Buffer.from(c, "base64url"));
  assert.deepEqual(claims.uris, ["POST api.cdp.coinbase.com/platform/v2/x402/verify"]);
  assert.equal(claims.exp - claims.nbf, 120);
  assert.equal(verify(null, Buffer.from(`${h}.${c}`), publicKey, Buffer.from(s, "base64url")), true);
});

test("CDP facilitator config uses path-keyed auth and fails closed", async () => {
  const { seed } = seedAndPublicKey();
  const env = { COINBASE_API_KEY: "key-id", COINBASE_API_KEY_SECRET: seed.toString("base64") };
  const headers = await cdpAuthHeaders(env, { now: () => 1_700_000_000, nonce: () => "n" })();
  assert.deepEqual(Object.keys(headers), ["verify", "settle", "supported", "bazaar"]);
  assert.throws(() => facilitatorConfig({ FACILITATOR_URL: CDP_FACILITATOR_URL }), /requires COINBASE_API_KEY/);
  assert.equal(facilitatorConfig({ ...env, FACILITATOR_URL: CDP_FACILITATOR_URL }).url, CDP_FACILITATOR_URL);
});
