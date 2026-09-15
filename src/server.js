import { fileURLToPath } from "node:url";
import express from "express";
import { declareDiscoveryExtension } from "@x402/extensions/bazaar";
import { scrapeUrl } from "./scrape.js";
import { facilitatorConfig } from "./cdp-auth.js";

const PORT = Number(process.env.PORT || 4030);
const HOST = process.env.HOST || "127.0.0.1";
const PRICE = "$0.005";
export const READER_SERVICE_NAME = "x402 Reader";
export const READER_TAGS = ["web", "scrape", "markdown", "agents", "x402"];
const EVM_NET = "eip155:8453";
const SVM_NET = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const LEGACY_NET = { [EVM_NET]: "base", [SVM_NET]: "solana" };
export const CAIP_NET = Object.fromEntries(Object.entries(LEGACY_NET).map(([k, v]) => [v, k]));
const wireQuotes = new Map();
export const app = express();
app.set("trust proxy", 1);

const SCRAPE_INPUT = { type: "http", method: "GET", queryParams: { url: "https://example.com/article" } };
const SCRAPE_OUTPUT = { ok: true, title: "Example article", content: "# Example article", markdown: "# Example article", word_count: 2 };

export function scrapeDiscovery() {
  return {
    extensions: declareDiscoveryExtension({
      method: "GET",
      input: SCRAPE_INPUT.queryParams,
      inputSchema: {
        properties: { url: { type: "string", format: "uri", description: "Public http(s) URL to convert to markdown" } },
        required: ["url"], additionalProperties: false,
      },
      output: { example: SCRAPE_OUTPUT },
    }),
    outputSchema: { input: SCRAPE_INPUT, output: SCRAPE_OUTPUT },
  };
}

export function quoteKey(req) {
  return `${req.ip || ""}:${req.originalUrl || req.url || req.path || ""}`;
}

/** Rewrite inbound payment so accepted matches advertised v2 CAIP accepts; keep extra.memo. */
export function upgradePaymentHeader(raw, advertised) {
  if (!raw) return raw;
  let p;
  try { p = JSON.parse(Buffer.from(String(raw), "base64").toString()); } catch { return raw; }
  const acc = p.accepted || p;
  const payTo = acc.payTo;
  const scheme = acc.scheme || p.scheme || "exact";
  const match = (advertised || []).find((a) => a && a.payTo === payTo && a.scheme === scheme);
  if (!match) return raw;
  const extra = { ...(match.extra || {}) };
  if (acc.extra && typeof acc.extra.memo === "string") extra.memo = acc.extra.memo;
  const accepted = { ...match, extra };
  const out = p.payload
    ? { x402Version: 2, accepted, payload: p.payload }
    : { ...p, x402Version: 2, accepted };
  return Buffer.from(JSON.stringify(out)).toString("base64");
}

export function v1Invoice(hdrB64, resource, outputSchema) {
  const dec = JSON.parse(Buffer.from(String(hdrB64), "base64").toString());
  const pub = (process.env.PUBLIC_BASE_URL || "").replace(/\/+$/, "");
  const resUrl = pub && String(resource || "").startsWith("/") ? pub + resource : (dec.resource?.url || resource);
  return {
    x402Version: 1,
    error: dec.error || "Payment required",
    accepts: (dec.accepts || []).map((a) => ({
      scheme: a.scheme,
      network: LEGACY_NET[a.network] || a.network,
      maxAmountRequired: a.amount,
      resource: resUrl,
      description: dec.resource?.description || "",
      mimeType: dec.resource?.mimeType || "application/json",
      payTo: a.payTo,
      maxTimeoutSeconds: a.maxTimeoutSeconds,
      asset: a.asset,
      extra: a.extra,
      ...(outputSchema ? { outputSchema } : {}),
    })),
  };
}

export function sendErr(res, err) {
  if (err.code === "BAD_URL" || err.code === "SSRF") return res.status(400).json({ ok: false, error: err.message });
  if (err.code === "NEEDS_BROWSER") return res.status(422).json({ ok: false, reason: "needs_browser" });
  if (err.code === "TIMEOUT") return res.status(504).json({ ok: false, error: "upstream timeout" });
  return res.status(502).json({ ok: false, error: err.code === "TOO_LARGE" ? "upstream too large" : "upstream failed" });
}

export async function handleScrape(req, res, scrape = scrapeUrl) {
  try {
    const out = await scrape(String(req.query.url || ""));
    res.json({ ok: true, title: out.title, content: out.markdown, markdown: out.markdown, word_count: out.word_count });
  } catch (err) { sendErr(res, err); }
}

export async function mount(env = process.env) {
  const accepts = [];
  if (env.EVM_ADDRESS) accepts.push({ scheme: "exact", network: env.EVM_NETWORK || EVM_NET, payTo: env.EVM_ADDRESS, price: PRICE });
  if (env.SVM_ADDRESS) {
    const svm = { scheme: "exact", network: env.SVM_NETWORK || SVM_NET, payTo: env.SVM_ADDRESS, price: PRICE };
    if (env.SVM_FEE_PAYER) svm.extra = { feePayer: env.SVM_FEE_PAYER };
    accepts.push(svm);
  }
  if (accepts.length) {
    app.use((req, res, next) => {
      if (req.path !== "/scrape" && req.path !== "/content/extract") return next();
      const orig = res.json.bind(res);
      res.json = (body) => {
        if (res.statusCode === 402 && (!body || !body.accepts)) {
          const hdr = res.get("PAYMENT-REQUIRED");
          if (hdr) {
            try { body = v1Invoice(hdr, req.originalUrl, scrapeDiscovery().outputSchema); } catch { /* keep {} */ }
            try {
              const dec = JSON.parse(Buffer.from(String(hdr), "base64").toString());
              wireQuotes.set(quoteKey(req), dec.accepts || []);
            } catch { /* ignore */ }
          }
        }
        return orig(body);
      };
      next();
    });
    app.use((req, _res, next) => {
      if (req.path !== "/scrape" && req.path !== "/content/extract") return next();
      const raw = req.headers["payment-signature"] || req.headers["x-payment"];
      if (!raw) return next();
      try {
        const upgraded = upgradePaymentHeader(raw, wireQuotes.get(quoteKey(req)) || []);
        if (upgraded !== raw) {
          req.headers["payment-signature"] = upgraded;
          delete req.headers["x-payment"];
        }
      } catch { /* malformed: let middleware reject */ }
      next();
    });
    const [{ paymentMiddleware, x402ResourceServer }, { HTTPFacilitatorClient }, { ExactEvmScheme }, { ExactSvmScheme }] = await Promise.all([
      import("@x402/express"), import("@x402/core/server"), import("@x402/evm/exact/server"), import("@x402/svm/exact/server"),
    ]);
    const rs = new x402ResourceServer(new HTTPFacilitatorClient(facilitatorConfig(env)));
    if (env.EVM_ADDRESS) rs.register(env.EVM_NETWORK || EVM_NET, new ExactEvmScheme());
    if (env.SVM_ADDRESS) rs.register(env.SVM_NETWORK || SVM_NET, new ExactSvmScheme());
    const spec = {
      accepts,
      mimeType: "application/json",
      description: "HTML to markdown. $0.005 USDC.",
      serviceName: READER_SERVICE_NAME,
      tags: READER_TAGS,
      ...scrapeDiscovery(),
    };
    app.use(paymentMiddleware({ "GET /scrape": spec, "GET /content/extract": spec }, rs));
  }
  app.get("/health", (_req, res) => res.json({ ok: true, service: "x402-reader", paywall: accepts.length > 0 }));
  for (const p of ["/scrape", "/content/extract"]) app.get(p, (req, res) => handleScrape(req, res));
  return app;
}

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  await mount();
  app.listen(PORT, HOST, () => console.log(`x402-reader http://${HOST}:${PORT}`));
}
