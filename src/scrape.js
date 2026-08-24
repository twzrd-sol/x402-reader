import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";
import Turndown from "turndown";
import { assertPublicHttpUrl } from "./ssrf.js";

export const TIMEOUT_MS = 5_000;
export const MAX_BYTES = 2 * 1024 * 1024;
const fail = (code, msg) => Object.assign(new Error(msg), { code });

export function toMarkdown(html, url = "https://example.com/") {
  const dom = new JSDOM(html, { url });
  const doc = dom.window.document;
  const article = new Readability(doc).parse();
  const text = (article?.textContent || "").trim();
  const spa = doc.querySelector("#root, #app, [data-reactroot]");
  if ((!article || text.length < 80) && (spa || html.length > 1500)) {
    throw fail("NEEDS_BROWSER", "requires_browser_context");
  }
  if (!article || text.length < 40) throw fail("NEEDS_BROWSER", "requires_browser_context");
  const md = new Turndown({ headingStyle: "atx", codeBlockStyle: "fenced" }).turndown(article.content);
  return { title: article.title || doc.title || "", markdown: md, word_count: text.split(/\s+/).filter(Boolean).length };
}

export async function scrapeUrl(raw, { fetchImpl = fetch } = {}) {
  let u = await assertPublicHttpUrl(raw);
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), TIMEOUT_MS);
  let res;
  try {
    // manual redirects: every hop must re-pass the SSRF gate (302->loopback)
    for (let hop = 0; ; hop += 1) {
      res = await fetchImpl(u.href, { signal: ac.signal, redirect: "manual", headers: { accept: "text/html" } });
      if (res.status < 300 || res.status >= 400) break;
      const loc = res.headers.get("location");
      if (!loc || hop >= 5) throw fail("UPSTREAM", `upstream ${res.status}`);
      u = await assertPublicHttpUrl(new URL(loc, u.href).href);
    }
  } catch (e) {
    if (e.code) throw e;
    throw fail(e.name === "AbortError" ? "TIMEOUT" : "UPSTREAM", e.name === "AbortError" ? "timeout" : "fetch failed");
  } finally {
    clearTimeout(t);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_BYTES) throw fail("TOO_LARGE", "too large");
  if (!res.ok) throw fail("UPSTREAM", `upstream ${res.status}`);
  return toMarkdown(buf.toString("utf8"), u.href);
}
