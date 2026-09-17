// The public API is the site's own data files, re-cut as plain JSON and written to disk,
// so nginx can serve them as static files with no process in the way:
//
//   node scripts/build-api.mjs        → api/v1/chain, api/v1/verdicts, api/v1/daily, api/v1/index
//
// Runs right after read-chain.mjs in the cron, so the API is never older than the page.
// The verdict formula here is the same one index.html runs in the browser (convictionScores):
// keep the two in step, or the API will disagree with the page it describes.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { CHAIN } from "./chains.mjs";

const SITE = process.env.SITE || "https://medusa-ai.pro";
const root = new URL("../", import.meta.url);
const OUT = new URL("api/v1/", root);
mkdirSync(OUT, { recursive: true });

const load = (file, key) => {
  const f = new URL(file, root);
  if (!existsSync(f)) return null;
  return JSON.parse(readFileSync(f, "utf8").replace(new RegExp("^[\\s\\S]*?window\\." + key + "\\s*=\\s*"), "").replace(/;\s*$/, ""));
};
const live = load("chain-live.js", "CHAIN_LIVE");
const daily = load("daily-data.js", "DAILY_READ");
const now = new Date().toISOString();
const write = (name, obj) => writeFileSync(new URL(name, OUT), JSON.stringify(obj, null, 1) + "\n");

/* ---------- /api/v1/chain: the last hour, read off the chain ---------- */
const chain = live ? {
  generated: now, updated: live.updated, chain: live.chain || CHAIN.key, chainName: live.chainName || CHAIN.name,
  explorer: live.explorer || CHAIN.explorer, windowMinutes: live.windowMinutes, head: live.head,
  scanned: live.scanned, wallets: live.wallets,
  tokens: (live.tokens || []).map(t => ({
    symbol: t.symbol, name: t.name, address: t.address, url: t.url,
    price: t.price, mcap: t.mcap, liquidity: t.liquidity,
    buys: t.buys, sells: t.sells, buyers: t.buyers, sellers: t.sellers,
    volume: t.volume, medianBuyUsd: t.medianBuyUsd,
    prints: (t.prints || []).map(p => ({ side: p.side, usd: p.usd, amount: p.amount, wallet: p.who, tx: p.tx,
      txUrl: (live.explorer || CHAIN.explorer) + "/tx/" + p.tx }))
  }))
} : { generated: now, error: "no chain read yet" };
write("chain", chain);

/* ---------- /api/v1/daily: today's social read ---------- */
const day = daily && (daily.days || []).find(d => d.posts && d.posts.length);
const abs = p => (p && !/^https?:/.test(p) ? SITE + "/" + p : p);
const post = p => ({ id: p.id, source: p.src, url: p.url, name: p.name, handle: p.handle, avatar: abs(p.avatar),
  followers: p.followers, text: p.text, sentiment: p.sentiment, emotion: p.emo, ticker: p.ticker, likes: p.likes, at: p.at,
  readByMedusa: !!p.read });
const dailyOut = day ? {
  generated: now, updated: daily.updated, date: day.date, pulledAt: day.pulledAt, source: day.source, mood: day.mood,
  sources: day.sources, tickers: day.tickers, posts: (day.posts || []).map(post), loudest: (day.loudest || []).map(post)
} : { generated: now, error: "no social read yet" };
write("daily", dailyOut);

/* ---------- /api/v1/verdicts: chain lean against crowd lean, token by token ---------- */
const social = (day && day.tickers) || {};
const verdicts = [];
for (const t of (live && live.tokens) || []) {
  const wallets = t.buyers + t.sellers;
  if (wallets < 3) continue;
  const chainLean = (t.buyers - t.sellers) / wallets;
  const s = social[t.symbol];
  const messages = s ? s.bull + s.bear : 0;
  const hasSocial = messages >= 2;
  const socialLean = hasSocial ? (s.bull - s.bear) / messages : null;
  let score, tag;
  if (hasSocial) {
    score = Math.round(((chainLean + socialLean) / 2) * 100);
    tag = Math.sign(chainLean) === Math.sign(socialLean) ? "CONFIRMED" : "CONTRADICTED";
  } else {
    score = Math.round(chainLean * 100);
    tag = "CHAIN ONLY";
  }
  const runner = chainLean >= .5 && wallets >= 5 && (!hasSocial || socialLean >= 0);
  verdicts.push({ symbol: t.symbol, address: t.address, url: t.url, score, tag, runner,
    chain: { buyers: t.buyers, sellers: t.sellers, lean: +chainLean.toFixed(3) },
    social: hasSocial ? { bull: s.bull, bear: s.bear, lean: +socialLean.toFixed(3) } : null });
}
verdicts.sort((a, b) => (b.runner - a.runner) || (Math.abs(b.score) - Math.abs(a.score)));
write("verdicts", {
  generated: now, chain: (live && live.chain) || CHAIN.key,
  window: { chainMinutes: live && live.windowMinutes, socialDate: day && day.date },
  method: "score = ((buyers-sellers)/wallets + (bull-bear)/posts) / 2 × 100; chain only when under 2 tagged posts; RUNNER WATCH = chain lean ≥ 0.5, ≥ 5 wallets, social not against",
  count: verdicts.length, verdicts
});

/* ---------- /api/v1/index: what is here ---------- */
write("index", {
  name: "MEDUSA API", version: 1, generated: now, docs: SITE + "/api/", auth: "none", refresh: "every 10 minutes",
  endpoints: {
    chain: SITE + "/api/v1/chain", verdicts: SITE + "/api/v1/verdicts", daily: SITE + "/api/v1/daily", stats: SITE + "/api/v1/stats"
  }
});

console.log(`api/v1 written · ${chain.tokens ? chain.tokens.length : 0} tokens · ${verdicts.length} verdicts · ${dailyOut.posts ? dailyOut.posts.length : 0} posts`);
