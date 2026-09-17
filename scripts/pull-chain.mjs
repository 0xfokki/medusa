// What the chain is actually trading: [CHAIN=arc|robinhood] node scripts/pull-chain.mjs
//
// The ten biggest tokens by market cap, with the real buy and sell counts behind them. This
// is the "does" side of say vs do, and unlike everything before it, it is not simulated.
//
// Two steps, because only one of them is open:
//   1. the ranking — dexscreener.com/<chain> sorted by market cap. Their ranking API is
//      refused to us (403, Cloudflare), so we open the screener the way a person would and
//      take the pair addresses in the order it lists them. A browser window appears briefly.
//   2. the numbers — api.dexscreener.com, public and keyless, queried by pair address.
//
// Several pairs can share a token (one token can trade against two quotes); the deepest pair
// wins, so a token is never counted twice.

import { chromium } from "playwright";
import { writeFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { CHAIN } from "./chains.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PROFILE = join(HERE, "..", ".st-profile");
const OUT = join(HERE, "..", "chain-data.js");
// Two views of the same chain: what is trading hardest and what is trading most. Between
// them they cover everything with a pulse; the ranking below is ours, off real numbers.
const SCREENER = [
  `https://dexscreener.com/${CHAIN.dexscreener}?rankBy=trendingScoreH24&order=desc`,
  `https://dexscreener.com/${CHAIN.dexscreener}?rankBy=volume&order=desc`
];
const KEEP = 10;

// Bridged majors and stables ride on this chain but were not born here. The board is for
// tokens this chain made.
const NOT_OURS = CHAIN.notOurs;
// A token minted minutes ago can report a market cap in the quadrillions; that is a broken
// supply, not a valuation.
const SANE = t => t.mcap > 100_000 && t.mcap < 1e12 && t.liquidity >= 25_000 && t.vol24h >= 2_000;

/* ---- 1. the ranking, read off the screener ---- */
const ctx = await chromium.launchPersistentContext(PROFILE, {
  headless: false,                         // headless is turned away by the same check
  viewport: { width: 1400, height: 1000 },
  locale: "en-US", timezoneId: "America/New_York",
  args: ["--disable-blink-features=AutomationControlled"]
});
const page = ctx.pages()[0] ?? await ctx.newPage();
const ranked = [];
for (const url of SCREENER) {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90_000 });
  await page.waitForSelector("a.ds-dex-table-row", { timeout: 60_000 });
  await page.waitForTimeout(3000);         // let the list settle
  // Only the table's own rows: other links on the page (trending strips, ads, the sidebar)
  // point at pairs too and would poison the list.
  const rows = await page.$$eval("a.ds-dex-table-row",
    els => els.map(e => e.getAttribute("href").split("/")[2]).filter(Boolean));
  ranked.push(...rows.slice(0, 60));
}
await ctx.close();
const candidates = [...new Set(ranked)];
if (!candidates.length) { console.error("screener gave no pairs"); process.exit(1); }
console.log(`${candidates.length} pairs to price`);

/* ---- 2. the numbers, from the public API ---- */
const pairs = [];
for (let i = 0; i < candidates.length; i += 30) {
  const url = `https://api.dexscreener.com/latest/dex/pairs/${CHAIN.dexscreener}/` + candidates.slice(i, i + 30).join(",");
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) { console.error("dexscreener:", res.status); continue; }
  pairs.push(...((await res.json()).pairs ?? []));
}

// One row per token: the deepest pair behind it.
const byToken = new Map();
for (const p of pairs) {
  const a = p.baseToken?.address; if (!a) continue;
  const prev = byToken.get(a);
  if (!prev || (p.liquidity?.usd ?? 0) > (prev.liquidity?.usd ?? 0)) byToken.set(a, p);
}

const tokens = [...byToken.values()]
  .map(p => ({
    symbol: p.baseToken.symbol,
    name: p.baseToken.name,
    address: p.baseToken.address,
    pair: p.pairAddress,
    url: p.url,
    price: Number(p.priceUsd ?? 0),
    mcap: p.marketCap ?? 0,
    liquidity: Math.round(p.liquidity?.usd ?? 0),
    vol24h: Math.round(p.volume?.h24 ?? 0),
    buys: p.txns?.h24?.buys ?? 0,
    sells: p.txns?.h24?.sells ?? 0,
    change24h: p.priceChange?.h24 ?? 0,
    ageDays: p.pairCreatedAt ? +((Date.now() - p.pairCreatedAt) / 86_400_000).toFixed(1) : null
  }))
  .filter(t => !NOT_OURS.test(t.symbol) && SANE(t))
  .sort((a, b) => b.mcap - a.mcap)
  .slice(0, KEEP);

// Everything with a pulse, kept for the reader: the board is what the page shows, the universe
// is what the chain reader walks when it goes looking for the day's tops.
const universe = [...byToken.values()]
  .map(p => ({
    symbol: p.baseToken.symbol, address: p.baseToken.address, pair: p.pairAddress,
    dex: p.dexId, version: (p.labels || [])[0] || null,
    mcap: Math.round(p.marketCap ?? 0), liquidity: Math.round(p.liquidity?.usd ?? 0),
    vol24h: Math.round(p.volume?.h24 ?? 0)
  }))
  .filter(t => !NOT_OURS.test(t.symbol) && t.liquidity >= 3_000)
  .sort((a, b) => b.liquidity - a.liquidity)
  .slice(0, 25);          // mini core: fewer tokens means fewer RPC calls in read-chain.mjs,
                           // which is what was timing out and dropping half its data at 90

writeFileSync(OUT,
  `// Written by scripts/pull-chain.mjs — ${CHAIN.name}, via DexScreener's public API.\n` +
  "window.CHAIN_READ = " + JSON.stringify({ updated: new Date().toISOString(), chain: CHAIN.key, chainName: CHAIN.name, explorer: CHAIN.explorer, tokens, universe }, null, 1) + ";\n");

console.log(`${CHAIN.name} · top ${tokens.length} by market cap`);
for (const t of tokens) {
  const net = t.buys + t.sells ? ((t.buys - t.sells) / (t.buys + t.sells) * 100).toFixed(0) : "0";
  console.log("  " + t.symbol.padEnd(10) +
    ("$" + Math.round(t.mcap).toLocaleString("en-US")).padStart(13) +
    ("$" + t.vol24h.toLocaleString("en-US")).padStart(12) +
    (t.buys + "/" + t.sells).padStart(14) + String(net + "% net").padStart(10) + "   " + t.name);
}
