// The third voice of the daily read: real headlines from crypto-news outlets, read
// straight off their public RSS feeds. Free and keyless — unlike StockTwits, none of
// these feeds block a plain fetch, so this needs no browser.
//
// Scoped to the chain MEDUSA reads (scripts/chains.mjs), not the wider crypto market: general BTC/ETH market news is
// not what this page is about, and a mainstream outlet essentially never writes
// about our tracked memecoins by name (they'd read as noise, not signal). So a
// headline only counts when it names the chain (CHAIN.newsWord) or its home ticker, or
// cashtags a token currently trading there (read live from
// chain-data.js, the same universe scripts/pull-chain.mjs already maintains).
//
// A headline is not a person's stated position, so it is read the same honest way
// X posts are: MEDUSA's own reading, not a label the outlet chose. Ambiguous or
// flat headlines are dropped rather than guessed.

import { readFileSync, existsSync } from "fs";
import { CHAIN } from "./chains.mjs";

const FEEDS = [
  { name: "CoinDesk", slug: "coindesk", url: "https://www.coindesk.com/arc/outboundfeeds/rss/", followers: 900_000 },
  { name: "Cointelegraph", slug: "cointelegraph", url: "https://cointelegraph.com/rss", followers: 700_000 },
  { name: "Decrypt", slug: "decrypt", url: "https://decrypt.co/feed", followers: 400_000 }
];
const HOURS = Number(process.env.NEWS_HOURS || 48);
const WINDOW_MS = HOURS * 60 * 60 * 1000;

const HOME = CHAIN.newsWord;
const CASHTAG = t => new RegExp("\\$" + t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b", "i");

// The live universe, not a fixed guess: whatever scripts/pull-chain.mjs last wrote.
// Missing/unreadable file (e.g. before the first chain pull) just means the chain
// itself is still matched — the news source never depends on the chain pull to work.
function chainSymbols() {
  const f = new URL("../chain-data.js", import.meta.url);
  if (!existsSync(f)) return [];
  try {
    const txt = readFileSync(f, "utf8").replace(/^[\s\S]*?window\.CHAIN_READ\s*=\s*/, "").replace(/;\s*$/, "");
    const d = JSON.parse(txt);
    return [...new Set([...(d.tokens || []), ...(d.universe || [])].map(t => t.symbol))];
  } catch { return []; }
}

// The chain itself always counts; a chain token only counts by explicit cashtag —
// most of these symbols (U, AI, MEME, NOTE...) are ordinary words otherwise.
function firstTicker(text, symbols) {
  if (HOME.test(text) || CASHTAG(CHAIN.homeTicker).test(text)) {
    for (const s of symbols) if (CASHTAG(s).test(text)) return s;
    return CHAIN.homeTicker;
  }
  for (const s of symbols) if (CASHTAG(s).test(text)) return s;
  return null;
}

const decode = s => s.replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
  .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const stripCdata = s => (s.match(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/) || [, s])[1];
const stripTags = s => s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
const field = (block, tag) => {
  const m = block.match(new RegExp("<" + tag + "[^>]*>([\\s\\S]*?)</" + tag + ">"));
  return m ? decode(stripCdata(m[1]).trim()) : "";
};

function parseItems(xml) {
  const items = [];
  for (const m of xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/g)) {
    const block = m[1];
    const title = field(block, "title");
    const link = field(block, "link");
    const pubDate = field(block, "pubDate");
    const description = stripTags(field(block, "description"));
    if (title && link && pubDate) items.push({ title, link, pubDate, description });
  }
  return items;
}

// Press register differs from X's first-person calls: no "I bought", just price action
// and outcomes. Tuned for headlines, not posts.
const NEWS_BULL = /\b(surg\w*|rall(y|ies|ied|ying)|soar\w*|rocket\w*|jump\w*|climb\w*|breakout|(all-time|record) high|\bath\b|rebound\w*|inflow\w*|accumulat\w*|outperform\w*|bullish)\b/gi;
const NEWS_BEAR = /\b(plunge\w*|crash\w*|tumbl\w*|slump\w*|sell-?off\w*|dump\w*|liquidat\w*|outflow\w*|hack\w*|exploit\w*|lawsuit\w*|ban(s|ned)?|crackdown\w*|plummet\w*|collapse\w*|bearish)\b/gi;
const count = (t, re) => (t.match(re) || []).length;

function reading(text) {
  const bull = count(text, NEWS_BULL), bear = count(text, NEWS_BEAR);
  if (bull === bear) return null;                       // flat or tied — dropped, not guessed
  return bull > bear ? "Bullish" : "Bearish";
}

function emotion(text, bullish) {
  const t = text.toLowerCase();
  if (bullish) {
    if (/missed|too late|fomo|chasing|left behind|everyone/.test(t)) return "FOMO";
    if (/recover|bounce|bottom|soon|will come back|undervalued|rebound/.test(t)) return "HOPIUM";
    return "GREED";
  }
  if (/hold(ing)?\b|long term|zoom out|it'?s fine|not selling/.test(t)) return "COPE";
  return "FEAR";
}

export async function pullNews({ feeds = FEEDS } = {}) {
  const cutoff = Date.now() - WINDOW_MS;
  const symbols = chainSymbols();
  const posts = [];
  let counted = 0, readable = 0;
  const failed = [];

  for (const feed of feeds) {
    try {
      const r = await fetch(feed.url);
      if (!r.ok) { failed.push(`${feed.name}: HTTP ${r.status}`); continue; }
      const items = parseItems(await r.text());
      for (const it of items) {
        const at = Date.parse(it.pubDate);
        if (!at || at < cutoff) continue;
        counted++;
        // The match has to be in the title, not just somewhere in the description — a
        // multi-subject article ("Standard Chartered says Arbitrum could outperform
        // Bitcoin... [later] ...also sees Robinhood Chain growing") would otherwise let
        // Robinhood borrow a sentiment that was never about it. Once the title itself is
        // on-topic, the description is the same article continuing, so it's safe to fold
        // in for the sentiment read.
        const ticker = firstTicker(it.title, symbols);
        if (!ticker) continue;                          // has to be about the chain or its tokens
        const text = it.title + ". " + it.description;
        const side = reading(text);
        if (!side) continue;                             // ambiguous — dropped, not guessed
        readable++;
        const bullish = side === "Bullish";
        posts.push({
          id: "news" + Buffer.from(it.link).toString("base64").slice(0, 24),
          src: "news",
          read: true,                                    // MEDUSA's own reading, not the outlet's tag
          url: it.link,
          name: feed.name,
          handle: feed.slug,
          outlet: feed.name,
          followers: feed.followers,
          text: it.title.slice(0, 280),
          sentiment: side,
          emo: emotion(text, bullish),
          ticker,
          likes: 0,
          at: new Date(at).toISOString()
        });
      }
    } catch (e) { failed.push(`${feed.name}: ${e.message}`); }
  }

  return { posts, counted, readable, failed };
}

// Run it on its own to see what a pull looks like: node scripts/pull-news.mjs
if (process.argv[1] && process.argv[1].endsWith("pull-news.mjs")) {
  const r = await pullNews();
  if (!r.posts.length) console.log("nothing kept" + (r.failed.length ? " — failed: " + r.failed.join("; ") : ""));
  else {
    console.log(r.counted + " headlines read, " + r.readable + " with a clear direction" +
      (r.failed.length ? " — failed: " + r.failed.join("; ") : ""));
    for (const p of r.posts.slice(0, 10))
      console.log("  " + p.sentiment.padEnd(8) + p.name.padEnd(16) + p.ticker.padEnd(8) + p.text.slice(0, 90));
  }
}
