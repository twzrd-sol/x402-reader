import { createPrivateKey, randomBytes, sign } from "node:crypto";

const CDP_HOST = "api.cdp.coinbase.com";
export const CDP_FACILITATOR_URL = `https://${CDP_HOST}/platform/v2/x402`;

function firstEnv(env, ...names) {
  for (const name of names) {
    const value = String(env[name] || "").trim();
    if (value) return value;
  }
  return "";
}

function base64url(value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value));
  return bytes.toString("base64url");
}

function privateKeyFromSecret(secret) {
  const raw = Buffer.from(String(secret).trim(), "base64");
  if (raw.length !== 32 && raw.length !== 64) {
    throw new Error("CDP API key secret must decode to a 32-byte seed or 64-byte seed+public key");
  }
  const prefix = Buffer.from("302e020100300506032b657004220420", "hex");
  return createPrivateKey({ key: Buffer.concat([prefix, raw.subarray(0, 32)]), format: "der", type: "pkcs8" });
}

export function createCdpJwt(keyId, keySecret, uri, { now = () => Math.floor(Date.now() / 1000), nonce = () => randomBytes(16).toString("hex") } = {}) {
  const issuedAt = now();
  const header = { alg: "EdDSA", kid: keyId, nonce: nonce() };
  const claims = { sub: keyId, iss: "cdp", uris: [uri], nbf: issuedAt, exp: issuedAt + 120 };
  const signingInput = `${base64url(header)}.${base64url(claims)}`;
  const signature = sign(null, Buffer.from(signingInput), privateKeyFromSecret(keySecret));
  return `${signingInput}.${base64url(signature)}`;
}

export function cdpAuthHeaders(env = process.env, options = {}) {
  const keyId = firstEnv(env, "COINBASE_API_KEY", "CDP_API_KEY_ID");
  const keySecret = firstEnv(env, "COINBASE_API_KEY_SECRET", "CDP_API_KEY_SECRET");
  if (!keyId || !keySecret) return null;
  const auth = (method, path) => ({
    Authorization: `Bearer ${createCdpJwt(keyId, keySecret, `${method} ${CDP_HOST}/platform/v2/x402/${path}`, options)}`,
  });
  return async () => ({
    verify: auth("POST", "verify"),
    settle: auth("POST", "settle"),
    supported: auth("GET", "supported"),
    bazaar: auth("GET", "discovery/resources"),
  });
}

export function facilitatorConfig(env = process.env) {
  const url = env.FACILITATOR_URL || "https://facilitator.payai.network";
  const config = { url };
  if (new URL(url).hostname === CDP_HOST) {
    const createAuthHeaders = cdpAuthHeaders(env);
    if (!createAuthHeaders) {
      throw new Error("CDP facilitator requires COINBASE_API_KEY + COINBASE_API_KEY_SECRET (or CDP aliases)");
    }
    config.createAuthHeaders = createAuthHeaders;
  }
  return config;
}
