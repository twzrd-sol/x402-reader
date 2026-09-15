import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import { test } from "node:test";
import { MAX_BYTES, scrapeUrl, toMarkdown } from "../src/scrape.js";
import { assertPublicHttpUrl } from "../src/ssrf.js";
import { app, handleScrape, mount, sendErr, upgradePaymentHeader, CAIP_NET, scrapeDiscovery, READER_SERVICE_NAME, READER_TAGS } from "../src/server.js";

const words = Array.from({ length: 60 }, (_, i) => `word${i}`).join(" ");
const ARTICLE = `<!doctype html><html><head><title>Doc</title></head><body><article><h1>Doc</h1><p>${words}</p></article></body></html>`;
const SPA = `<!doctype html><html><body><div id="root"></div><script src="/a.js"></script></body></html>`;
const res = () => ({ statusCode: 0, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } });

test("pipeline: article markdown; SPA 422 needs_browser; size/timeout; SSRF; HTTP loopback 400", async () => {
  const out = toMarkdown(ARTICLE);
  assert.ok(out.markdown.includes("word0") && out.word_count >= 50);
  assert.throws(() => toMarkdown(SPA), (e) => e.code === "NEEDS_BROWSER");
  assert.ok((await scrapeUrl("https://example.com/p", { fetchImpl: async () => new Response(ARTICLE) })).markdown.includes("word0"));
  await assert.rejects(() => scrapeUrl("https://example.com/p", { fetchImpl: async () => new Response("x".repeat(MAX_BYTES + 1)) }), (e) => e.code === "TOO_LARGE");
  await assert.rejects(() => scrapeUrl("https://example.com/p", { fetchImpl: async () => { const e = new Error("a"); e.name = "AbortError"; throw e; } }), (e) => e.code === "TIMEOUT");
  await assert.rejects(() => assertPublicHttpUrl("http://127.0.0.1/"), (e) => e.code === "SSRF");
  await assert.rejects(() => scrapeUrl("https://example.com/p", {
    fetchImpl: async () => new Response(null, { status: 302, headers: { location: "http://127.0.0.1:8001/" } }),
  }), (e) => e.code === "SSRF");
  const spa = res();
  await handleScrape({ query: { url: "https://example.com/" } }, spa, async () => { throw Object.assign(new Error("x"), { code: "NEEDS_BROWSER" }); });
  assert.equal(spa.statusCode, 422);
  assert.equal(spa.body.reason, "needs_browser");
  const ssrf = res();
  sendErr(ssrf, Object.assign(new Error("private target"), { code: "SSRF" }));
  assert.equal(ssrf.statusCode, 400);
  const src = fs.readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  assert.equal(src.includes("outbid") || src.includes("4024"), false);
  await mount({});
  const srv = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  const { port } = srv.address();
  const get = (p) => new Promise((resolve, reject) => {
    http.get({ host: "127.0.0.1", port, path: p }, (x) => { let b = ""; x.on("data", (c) => (b += c)); x.on("end", () => resolve({ status: x.statusCode, body: JSON.parse(b) })); }).on("error", reject);
  });
  assert.equal((await get("/health")).body.service, "x402-reader");
  assert.equal((await get("/scrape?url=http://127.0.0.1/")).status, 400);
  await new Promise((r) => srv.close(r));
});

test("Coinbase Bazaar metadata describes the paid scrape", () => {
  const discovery = scrapeDiscovery();
  assert.equal(READER_SERVICE_NAME, "x402 Reader");
  assert.deepEqual(READER_TAGS, ["web", "scrape", "markdown", "agents", "x402"]);
  assert.deepEqual(discovery.outputSchema.input, {
    type: "http", method: "GET", queryParams: { url: "https://example.com/article" },
  });
  assert.equal(discovery.extensions.bazaar.info.input.queryParams.url, "https://example.com/article");
});

test("upgradePaymentHeader: v1 solana + extra.memo becomes v2 CAIP accepted", () => {
  const advertised = [{
    scheme: "exact",
    network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
    payTo: "F1AbWuXJcBT9arW9wc6Xr2vom5NBtngWsz6Ht16jRBLM",
    asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    amount: "5000",
    extra: { feePayer: "CjNFTjvBhbJJd2B5ePPMHRLx1ELZpa8dwQgGL727eKww" },
    resource: { url: "https://reader.outbid.sh/scrape?url=https://example.com/" },
  }];
  const v1 = {
    x402Version: 1, scheme: "exact", network: "solana",
    payload: { transaction: "dGVzdA==" },
    accepted: {
      scheme: "exact", network: "solana",
      payTo: advertised[0].payTo, amount: "5000",
      resource: advertised[0].resource.url,
      extra: { feePayer: "ATTACKER", memo: "rb1:abc" },
    },
  };
  const raw = Buffer.from(JSON.stringify(v1)).toString("base64");
  const out = JSON.parse(Buffer.from(upgradePaymentHeader(raw, advertised), "base64").toString());
  assert.equal(out.x402Version, 2);
  assert.equal(out.accepted.network, advertised[0].network);
  assert.deepEqual(out.accepted.resource, advertised[0].resource);
  assert.equal(out.accepted.extra.memo, "rb1:abc");
  assert.equal(out.accepted.extra.feePayer, advertised[0].extra.feePayer);
  assert.equal(out.payload.transaction, "dGVzdA==");
  assert.equal(CAIP_NET.solana, advertised[0].network);
});

test("upgradePaymentHeader preserves a native v2 Bazaar payment byte-for-byte", () => {
  const advertised = [{
    scheme: "exact",
    network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
    payTo: "F1AbWuXJcBT9arW9wc6Xr2vom5NBtngWsz6Ht16jRBLM",
    asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    amount: "5000",
    extra: { feePayer: "fee-payer" },
  }];
  const payment = {
    x402Version: 2,
    resource: {
      url: "https://reader.outbid.sh/scrape?url=https%3A%2F%2Fexample.com",
      serviceName: "x402 Reader",
      tags: ["web", "scrape", "markdown", "agents", "x402"],
    },
    accepted: advertised[0],
    payload: { transaction: "dGVzdA==" },
    extensions: { bazaar: { info: { input: { type: "http", method: "GET" } } } },
  };
  const raw = Buffer.from(JSON.stringify(payment)).toString("base64");

  assert.equal(upgradePaymentHeader(raw, advertised), raw);
  const decoded = JSON.parse(Buffer.from(upgradePaymentHeader(raw, advertised), "base64").toString());
  assert.deepEqual(decoded.resource, payment.resource);
  assert.deepEqual(decoded.extensions, payment.extensions);
});
