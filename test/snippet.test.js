import assert from "node:assert/strict";
import { test } from "node:test";
import { FAT_HTML_BYTES, paidFetch } from "../snippets/paid-fetch.js";
import { v1Invoice } from "../src/server.js";

test("paidFetch: small HTML stays origin; fat HTML hits reader JSON", async () => {
  const calls = [];
  const paid = async (u) => {
    calls.push(String(u));
    if (String(u).includes("/scrape?")) {
      return new Response(JSON.stringify({ ok: true, markdown: "# md", content: "# md", title: "t", word_count: 1 }), { headers: { "content-type": "application/json" } });
    }
    const html = String(u).includes("fat") ? "x".repeat(FAT_HTML_BYTES + 1) : "<html>hi</html>";
    return new Response(html, { headers: { "content-type": "text/html", "content-length": String(html.length) } });
  };
  const f = paidFetch(null, "http://127.0.0.1:4030/scrape", paid);
  const small = await f("https://example.com/small");
  assert.equal(calls.length, 1);
  assert.equal(await small.text(), "<html>hi</html>");
  const fat = await f("https://example.com/fat");
  assert.equal(calls.some((c) => c.startsWith("http://127.0.0.1:4030/scrape?url=")), true);
  const j = await fat.json();
  assert.equal(j.ok, true);
  assert.equal(typeof j.markdown, "string");
});

test("paidFetch: on_fail uses outbid /route url + forward_headers", async () => {
  const paid = async (u, init) => {
    if (String(u).includes("dead")) throw new Error("timeout");
    if (String(u).includes("/route")) {
      return new Response(JSON.stringify({ ok: true, rank: 1, url: "https://hop.example/", forward_headers: { "X-Outbid-Rank": "1" } }));
    }
    return new Response("hop", { headers: { "x-got": init.headers["X-Outbid-Rank"] } });
  };
  const r = await paidFetch(null, "http://127.0.0.1:4030/scrape", paid)("https://dead.example/");
  assert.equal(await r.text(), "hop");
  assert.equal(r.headers.get("x-got"), "1");
});

test("v1Invoice mirrors header accepts (legacy network names)", () => {
  const hdr = Buffer.from(JSON.stringify({
    error: "Payment required",
    resource: { url: "http://127.0.0.1:4030/scrape", description: "HTML to markdown. $0.005 USDC.", mimeType: "application/json" },
    accepts: [{ scheme: "exact", network: "eip155:8453", amount: "5000", payTo: "0x14df772BD496bBb7f49Bc3E992Ce13B2c441177F", maxTimeoutSeconds: 300, asset: "0x833" }],
  })).toString("base64");
  const body = v1Invoice(hdr, "/scrape");
  assert.equal(body.x402Version, 1);
  assert.equal(body.accepts[0].network, "base");
  assert.equal(body.accepts[0].maxAmountRequired, "5000");
  assert.equal(body.accepts[0].payTo, "0x14df772BD496bBb7f49Bc3E992Ce13B2c441177F");
});
