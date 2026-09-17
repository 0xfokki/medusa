// Getting JSON out of StockTwits.
//
// The keyless API is open, but Cloudflare now answers 403 to plain fetch from here, and to a
// headless browser as well — the interstitial never clears. A normal windowed Chromium with a
// kept profile passes it, so that is the fallback: try fetch first, and only if it is refused
// open one browser, reuse it for every request, and read the JSON out of the page.
//
// The window appears for a few seconds during the daily pull. That is the price of free data.

import { chromium } from "playwright";
import { mkdirSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const PROFILE = join(dirname(fileURLToPath(import.meta.url)), "..", ".st-profile");
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

let ctx = null, page = null;

async function browser() {
  if (page) return page;
  mkdirSync(PROFILE, { recursive: true });
  ctx = await chromium.launchPersistentContext(PROFILE, {
    headless: false,                      // headless is blocked outright; this is not a preference
    viewport: { width: 1100, height: 800 },
    locale: "en-US",
    timezoneId: "America/New_York",
    args: ["--disable-blink-features=AutomationControlled"]
  });
  page = ctx.pages()[0] ?? await ctx.newPage();
  return page;
}

export async function closeBrowser() {
  if (ctx) await ctx.close().catch(() => {});
  ctx = page = null;
}

async function viaBrowser(url) {
  const p = await browser();
  await p.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
  const text = () => p.evaluate(() => (document.body?.innerText ?? "").trim());
  let body = await text();
  if (!body.startsWith("{")) {            // sitting on the security check; give it time to clear
    await p.waitForFunction(() => (document.body?.innerText ?? "").trim().startsWith("{"), null, { timeout: 30_000 })
      .catch(() => {});
    body = await text();
  }
  if (!body.startsWith("{")) throw new Error("blocked: " + body.slice(0, 60).replace(/\s+/g, " "));
  return JSON.parse(body);
}

// Images, same story: StockTwits serves avatars only to itself now — 403 to us, and
// cross-origin-resource-policy: same-origin, so a browser on our own site would refuse to
// paint them even if it got the bytes. Navigating to one in a real browser still works, so
// that is how the faces are collected; the site then serves its own copies.
export async function getBinary(url) {
  const p = await browser();
  const res = await p.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
  if (!res || !res.ok()) throw new Error("HTTP " + (res ? res.status() : "?"));
  return await res.body();
}

// Every caller goes through here: plain fetch while it works, the browser when it does not.
export async function getJSON(url) {
  if (!page) {
    try {
      const res = await fetch(url, { headers: { "user-agent": UA, accept: "application/json" } });
      if (res.ok) return await res.json();
    } catch { /* fall through to the browser */ }
  }
  return viaBrowser(url);
}
