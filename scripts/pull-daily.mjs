// Daily read: pull what retail is saying on StockTwits and X, plus what the crypto press
// is saying about Robinhood itself (see scripts/pull-news.mjs), and write daily-data.js.
//
// Free and keyless: StockTwits serves messages for a symbol without auth, and many carry
// the author's own Bullish/Bearish tag. Each coin is paged back only as far as a day, plus the
// curated "suggested" stream — a few dozen requests a day. The page loads the result as a
// plain script, so it works from a static host and from file://.
//
// Requests go through scripts/st-fetch.mjs, which opens a real browser window when Cloudflare
// refuses plain fetch. See that file for why.
//
// Posts are kept word for word and linked to the original. They are never paired with
// on-chain numbers until a real chain reader exists: a real person's words next to
// invented money would be a fabrication.

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from "fs";
import { getJSON, getBinary, closeBrowser } from "./st-fetch.mjs";
import { pullX, pullXTickers } from "./pull-x.mjs";
import { pullNews } from "./pull-news.mjs";
import { CHAIN } from "./chains.mjs";

// Five majors and five of the loud small ones — shitcoins included, because that is where
// retail actually lives. Chosen by measured posting volume: a coin with two tagged posts a day
// (ADA, LINK, POPCAT, PNUT) would draw a bar out of nothing. StockTwits calls them BTC.X and
// so on; the page shows the bare symbol.
const TICKERS = ["BTC.X", "ETH.X", "SOL.X", "DOGE.X", "CASHCAT.X", "PONS.X", "PEPE.X"];
const label = sym => sym.replace(/\.X$/, "");
// The board is the loud small ones only — majors already have all the volume and would
// otherwise fill it with the same five names every day.
const BOARD_TICKERS = new Set(TICKERS.map(label).filter(t => !["BTC", "ETH", "SOL", "XRP", "LTC"].includes(t)));

// The live universe, not a fixed guess: whatever scripts/pull-chain.mjs last wrote —
// the tokenized stocks (NVDA, SPY, ...) and memecoins actually trading on Robinhood
// Chain right now. Same helper as scripts/pull-news.mjs.
function chainUniverseSymbols() {
  const f = new URL("../chain-data.js", import.meta.url);
  if (!existsSync(f)) return [];
  try {
    const txt = readFileSync(f, "utf8").replace(/^[\s\S]*?window\.CHAIN_READ\s*=\s*/, "").replace(/;\s*$/, "");
    const d = JSON.parse(txt);
    return [...new Set([...(d.tokens || []), ...(d.universe || [])].map(t => t.symbol))];
  } catch { return []; }
}
// Everything "within Robinhood Chain" for the loudest-six board: the majors people
// actually trade (bitcoin included, even though it only bridges through), plus every
// tokenized stock and memecoin the chain reader currently sees.
const LOUDEST_TICKERS = new Set([...TICKERS.map(label), ...chainUniverseSymbols()]);
const DAY_MS = 86_400_000;
const OUT = new URL("../daily-data.js", import.meta.url);
const KEEP_DAYS = 7, PAGES = 10;                 // quiet coins need deeper paging to cover a day
const BOARD = 10;                                // cards on the board — a tape, not a fixed grid, so
                                                  // more fits without crowding; most days won't fill it

// X is read through a reseller that charges per post, but pull-x.mjs now reads only the
// user's curated accounts rather than searching the market, so the cost is small and
// predictable. On by default; X_PULL=0 skips it for a run (e.g. to save credit).
const USE_X = process.env.X_PULL !== "0";
const sleep = ms => new Promise(r => setTimeout(r, ms));

const get = async url => (await getJSON(url)).messages ?? [];

// StockTwits bodies arrive HTML-escaped; store plain text and let the page escape it.
const decode = s => s.replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
  .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
// A public page quotes these verbatim, so anything abusive is skipped rather than edited.
const ABUSE = /\b(fuck\w*|shit\w*|bitch\w*|retard\w*|cunt\w*|nigg\w*|fag\w*|whore\w*)\b/i;
// {1,10} not {1,6}: CASHCAT is 7 letters — the old 6-letter cap silently meant a
// $CASHCAT cashtag could never match at all, so CASHCAT posts never qualified for
// anything. Found while the loudest-six board came back suspiciously CASHCAT-free.
const firstTag = body => (body.match(/\$([A-Z]{1,10})\b/) || [])[1];

// The author's tag gives the direction; the words narrow it to one of the brain's lobes.
function emotion(text, bullish) {
  const t = text.toLowerCase();
  if (bullish) {
    if (/missed|too late|fomo|chasing|left behind|everyone/.test(t)) return "FOMO";
    if (/recover|bounce|bottom|soon|will come back|undervalued/.test(t)) return "HOPIUM";
    return "GREED";
  }
  if (/hold(ing)?\b|long term|zoom out|it'?s fine|not selling|diamond/.test(t)) return "COPE";
  return "FEAR";
}

/* ---- any chain but Robinhood: X by ticker, no StockTwits ---------------------------------
   A new chain's memecoins have no StockTwits streams, so the crowd side comes from X,
   searched token by token (scripts/pull-x.mjs pullXTickers). Days from another chain are
   dropped from the file rather than mixed in — the Robinhood history lives at the
   robinhood-backup tag. */
if (CHAIN.key !== "robinhood") {
  let tokens = [];
  try {
    const d = JSON.parse(readFileSync(new URL("../chain-data.js", import.meta.url), "utf8")
      .replace(/^[\s\S]*?window\.CHAIN_READ\s*=\s*/, "").replace(/;\s*$/, ""));
    const bySym = new Map();
    for (const t of [...(d.tokens || []), ...(d.universe || [])]) if (!bySym.has(t.symbol)) bySym.set(t.symbol, t);
    tokens = [...bySym.values()];
  } catch (e) { console.error("no chain-data.js — run scripts/pull-chain.mjs first"); process.exit(1); }

  const x = await pullXTickers({ tokens, chainWord: CHAIN.chainWord });
  let news = { posts: [], counted: 0, readable: 0 };
  try { news = await pullNews(); } catch (e) { x.failed.push("news: " + e.message); }
  if (!x.posts.length) { console.error("X gave nothing readable:", (x.note || x.failed.join("; "))); process.exit(1); }

  const today = new Date().toISOString().slice(0, 10);
  const entry = {
    date: today, pulledAt: new Date().toISOString(), chain: CHAIN.key, source: "X",
    mood: { bull: x.mood.bull, bear: x.mood.bear, messages: x.counted },
    sources: { x: x.counted, xReadable: x.readable, news: news.counted, newsReadable: news.readable },
    tickers: x.tickers,
    posts: balanced(x.posts, BOARD, p => p.sentiment, p => p.handle),
    loudest: x.posts.slice(0, 6)
  };

  let days = [];
  if (existsSync(OUT)) {
    try { days = JSON.parse(readFileSync(OUT, "utf8").replace(/^[\s\S]*?window\.DAILY_READ\s*=\s*/, "").replace(/;\s*$/, "")).days ?? []; }
    catch { days = []; }
  }
  days = [entry, ...days.filter(d => d.date !== today && d.chain === CHAIN.key)].slice(0, KEEP_DAYS);
  writeFileSync(OUT,
    `// Written by scripts/pull-daily.mjs — ${CHAIN.name}: posts via X, quoted as written.\n` +
    "window.DAILY_READ = " + JSON.stringify({ updated: entry.pulledAt, chain: CHAIN.key, days }, null, 1) + ";\n");

  const avaDir = new URL("../avatars/", import.meta.url);
  const inUse = new Set(days.flatMap(d => [...d.posts, ...(d.loudest || [])]).map(p => p.avatar).filter(Boolean).map(a => a.split("/").pop()));
  if (existsSync(avaDir)) for (const f of readdirSync(avaDir)) if (!inUse.has(f)) unlinkSync(new URL(f, avaDir));

  const withSocial = Object.values(x.tickers).filter(v => v.bull + v.bear >= 2).length;
  console.log(`${today} · ${CHAIN.name}: ${x.counted} posts on X, ${x.readable} with a clear direction ` +
    `(${x.mood.bull} bullish / ${x.mood.bear} bearish) · ${withSocial}/${tokens.length} tokens with a social read · ` +
    `loudest: ${entry.loudest.length} · ~$${x.cost}` + (x.failed.length ? ` — failed: ${x.failed.join("; ")}` : ""));
  process.exit(0);
}

const seen = new Map(), perTicker = {}, failed = [];
const take = (m, t) => { if (!seen.has(m.id)) seen.set(m.id, { m, t }); };

const cutoff = Date.now() - DAY_MS;
for (const sym of TICKERS) {
  const t = label(sym);
  perTicker[t] = { bull: 0, bear: 0, messages: 0 };
  let max = null;
  for (let p = 0; p < PAGES; p++) {
    let oldest = Infinity;
    try {
      const msgs = await get(`https://api.stocktwits.com/api/2/streams/symbol/${sym}.json` + (max ? `?max=${max}` : ""));
      if (!msgs.length) break;
      for (const m of msgs) {
        const at = Date.parse(m.created_at);
        oldest = Math.min(oldest, at);
        if (at < cutoff) continue;                    // a day's worth, no more
        take(m, t);
        perTicker[t].messages++;
        const s = m.entities?.sentiment?.basic;
        if (s === "Bullish") perTicker[t].bull++;
        if (s === "Bearish") perTicker[t].bear++;
      }
      max = Math.min(...msgs.map(m => m.id)) - 1;
    } catch (e) { failed.push(`${sym}: ${e.message}`); break; }
    if (oldest < cutoff) break;                       // the stream has left the last 24 hours
    await sleep(1100);
  }
}
// The rest of the live chain universe (tokenized stocks, other memecoins) — one page
// each rather than the full day-deep pagination above: real stocks like NVDA or SPY
// already have enough StockTwits volume that a single page is plenty, and a quiet
// memecoin name isn't worth ten requests to confirm it's quiet.
for (const t of LOUDEST_TICKERS) {
  if (TICKERS.some(s => label(s) === t)) continue;    // already covered above
  try {
    for (const m of await get(`https://api.stocktwits.com/api/2/streams/symbol/${t}.json`)) {
      if (Date.parse(m.created_at) >= cutoff) take(m, t);
    }
  } catch (e) { failed.push(`${t}: ${e.message}`); }
  await sleep(600);
}
// The curated stream is where the big accounts are; keep only posts about a ticker we track.
try {
  for (const m of await get("https://api.stocktwits.com/api/2/streams/suggested.json")) {
    const t = firstTag(decode(m.body || ""));
    if (LOUDEST_TICKERS.has(t)) take(m, t);
  }
} catch (e) { failed.push("suggested: " + e.message); }

const all = [...seen.values()];
if (!all.length) { console.error("nothing pulled:", failed.join("; ")); process.exit(1); }
for (const x of all) x.m.body = decode(x.m.body || "");

// The loud ones: the biggest accounts, bulls and bears alike. A post qualifies if its
// author tagged it, it is about the ticker itself (its cashtag comes first), and it has
// some substance. One post per author; split evenly bull/bear, topped up from the other
// side only when a day runs short of one.
//
// "Substance" is measured after the noise is taken out: a post that is mostly cashtags,
// emoji, prices and arrows reads as a call to the author and as gibberish to everyone else
// ("$BTC.X $ETH.X $SPY Day 193 of bullposting"), so what is left has to be real sentences.
const PROSE = body => body
  .replace(/\$[A-Za-z]{1,6}(\.X)?\b/g, " ")                   // cashtags
  .replace(/#\w+/g, " ").replace(/@\w+/g, " ")                // tags and mentions
  .replace(/[\p{Extended_Pictographic}←-⇿☀-➿]/gu, " ")
  .replace(/[+-]?[\d.,]+%?/g, " ")                            // prices, percentages, dates
  .replace(/\s+/g, " ").trim();
const words = body => PROSE(body).split(" ").filter(w => w.length > 2).length;

const qualifies = ({ m, t }) => m.entities?.sentiment?.basic && !/https?:\/\//.test(m.body)
  && !ABUSE.test(m.body) && firstTag(m.body) === t && BOARD_TICKERS.has(t)
  && PROSE(m.body).length >= 60 && words(m.body) >= 10;       // it has to say something
const byReach = (a, b) => (b.m.user?.followers ?? 0) - (a.m.user?.followers ?? 0);
const pool = all.filter(qualifies).sort(byReach);

// The loudest six drop the "long enough to be an essay" bar — CASHCAT and PONS don't
// post often enough for it, and short-but-real ("I love this coin", "back in here at
// .1530 🚀") is exactly the loud, low-effort conviction this board is for. Still has to
// be tagged, on-topic and clean.
const loudQualifies = ({ m, t }) => m.entities?.sentiment?.basic && !/https?:\/\//.test(m.body)
  && !ABUSE.test(m.body) && firstTag(m.body) === t && LOUDEST_TICKERS.has(t) && words(m.body) >= 2;
const loudPool = all.filter(loudQualifies).sort(byReach);

// Split evenly, and the loudest bull and the loudest bear are always among them where
// the day has both. Taking the biggest accounts outright regardless of side would hand a
// bullish morning the whole board and read as a verdict we never measured.
function balanced(list, n, sideOf, idOf) {
  const out = [], seen = new Set();
  const best = side => list.find(v => sideOf(v) === side && !seen.has(idOf(v)));
  let want = "Bullish";
  while (out.length < n) {
    const other = want === "Bullish" ? "Bearish" : "Bullish";
    const x = best(want) || best(other);          // a one-sided day still fills the board
    if (!x) break;
    seen.add(idOf(x)); out.push(x);
    want = other;
  }
  return out;
}
// Enough for the whole board: how many actually survive depends on what the other network
// brings, and that is not known until after the faces are fetched.
const chosen = balanced(pool, BOARD, x => x.m.entities.sentiment.basic, x => x.m.user.id);
chosen.sort(byReach);                            // the biggest account leads the board

// The faces, kept as our own files. Hotlinking stopped working — the CDN answers 403 and
// marks the images same-origin — so each one is fetched once and written next to the page.
const AVA = new URL("../avatars/", import.meta.url);
mkdirSync(AVA, { recursive: true });
async function avatarOf(user) {
  const src = user.avatar_url_ssl || user.avatar_url || "";
  if (!src.includes("/production/")) return null;          // the default placeholder: show initials instead
  const url = src.replace("/thumb-", "/medium-");
  const file = `${user.username.replace(/[^\w.-]/g, "_")}.${(url.split(".").pop() || "png").slice(0, 4)}`;
  const dest = new URL(file, AVA);
  if (!existsSync(dest)) {
    try { writeFileSync(dest, await getBinary(url)); }
    catch (e) { failed.push(`avatar ${user.username}: ${e.message}`); return null; }
  }
  return "avatars/" + file;
}

async function toPost({ m, t }) {
  const bullish = m.entities.sentiment.basic === "Bullish";
  return {
    id: m.id,
    src: "stocktwits",
    read: false,                                       // the author tagged this one themselves
    url: `https://stocktwits.com/${m.user.username}/message/${m.id}`,
    name: m.user.name || m.user.username,
    handle: m.user.username,
    avatar: await avatarOf(m.user),
    followers: m.user.followers ?? 0,
    text: m.body.trim().slice(0, 280),
    sentiment: m.entities.sentiment.basic,
    emo: emotion(m.body, bullish),
    ticker: t,
    likes: m.likes?.total ?? 0,
    at: m.created_at
  };
}
const posts = [];
for (const c of chosen) posts.push(await toPost(c));

// The loudest six: no bull/bear balancing, no chain cross-check — just the biggest
// accounts talking about Robinhood Chain's own coins, straight off loudPool (already
// reach-sorted above). One post per author, same rule as everywhere else on this page —
// otherwise a single loud regular could fill the whole board themselves.
const loudSeen = new Set();
const loudChosen = loudPool.filter(c => !loudSeen.has(c.m.user.id) && loudSeen.add(c.m.user.id)).slice(0, 6);
const loudest = [];
for (const c of loudChosen) loudest.push(await toPost(c));

await closeBrowser();                                    // the faces were the last thing it was needed for

// The other voices. Both pay a cost per call (X per post, news in request count against
// keyless rate limits) or can simply be offline, so neither failing may ever cost the
// day's read: if both are down, the board is StockTwits alone.
let x = { posts: [], counted: 0, readable: 0 };
if (USE_X) {
  try { x = await pullX(); }
  catch (e) { failed.push("x: " + e.message); }
}
let news = { posts: [], counted: 0, readable: 0 };
try { news = await pullNews(); }
catch (e) { failed.push("news: " + e.message); }

// X and news are both MEDUSA's own reading rather than a self-tag, so they compete for
// the board together — sorted by the same reach field (real followers for X, a fixed
// per-outlet weight for news) so one doesn't just steamroll the other by list order.
// StockTwits only steps in if this combined pool came back completely empty (X down, no
// news in the window) — the page must never go blank over a quiet day.
const otherPool = [...x.posts, ...news.posts].sort((a, b) => (b.followers || 0) - (a.followers || 0));
const otherPicked = balanced(otherPool, BOARD, p => p.sentiment, p => p.handle);
const stPicked = otherPicked.length ? [] : posts.slice(0, BOARD);

// Interleaved rather than ranked: follower counts do not compare across networks — two
// thousand followers is a large account on StockTwits and nobody on X — so ordering the
// board by raw reach would be a ranking of nothing.
const board = [];
for (let i = 0; i < BOARD; i++) {
  if (stPicked[i]) board.push(stPicked[i]);
  if (otherPicked[i]) board.push(otherPicked[i]);
}

const bull = Object.values(perTicker).reduce((s, x) => s + x.bull, 0);
const bear = Object.values(perTicker).reduce((s, x) => s + x.bear, 0);
const today = new Date().toISOString().slice(0, 10);
const boardSrcs = new Set(board.map(p => p.src));
const srcNames = ["stocktwits", "x", "news"]
  .filter(s => boardSrcs.has(s))
  .map(s => s === "stocktwits" ? "StockTwits" : s === "x" ? "X" : "crypto press");
// "A", "A and B", "A, B and C" — never a blank read even when the board came back
// StockTwits-only (source label still needs one clean word, not a join of one).
const source = srcNames.length > 1
  ? srcNames.slice(0, -1).join(", ") + " and " + srcNames.at(-1)
  : (srcNames[0] || "StockTwits");
const entry = {
  date: today, pulledAt: new Date().toISOString(),
  source,
  mood: { bull, bear, messages: all.length + x.counted },
  sources: { stocktwits: all.length, x: x.counted, xReadable: x.readable, news: news.counted, newsReadable: news.readable },
  tickers: perTicker, posts: board, loudest
};

let days = [];
if (existsSync(OUT)) {
  const prev = readFileSync(OUT, "utf8").replace(/^[\s\S]*?window\.DAILY_READ\s*=\s*/, "").replace(/;\s*$/, "");
  try { days = JSON.parse(prev).days ?? []; } catch { days = []; }
}
days = [entry, ...days.filter(d => d.date !== today)].slice(0, KEEP_DAYS);

writeFileSync(OUT,
  "// Written by scripts/pull-daily.mjs — posts via StockTwits, X and crypto-news outlets, quoted as written.\n" +
  "window.DAILY_READ = " + JSON.stringify({ updated: entry.pulledAt, days }, null, 1) + ";\n");

// Faces are kept only while the post they belong to is still on the page.
const inUse = new Set(days.flatMap(d => [...d.posts, ...(d.loudest || [])]).map(p => p.avatar).filter(Boolean).map(a => a.split("/").pop()));
for (const f of readdirSync(AVA)) if (!inUse.has(f)) unlinkSync(new URL(f, AVA));

const sides = board.reduce((s, p) => (s[p.sentiment] = (s[p.sentiment] || 0) + 1, s), {});
console.log(`${today}: ${all.length} StockTwits messages (${bull} bullish / ${bear} bearish tags) ` +
  `+ ${x.counted} posts on X (${x.readable} with a clear position) ` +
  `+ ${news.counted} headlines read (${news.readable} on Robinhood/its chain); board: ` +
  `${sides.Bullish || 0} bulls, ${sides.Bearish || 0} bears from ` +
  `${board.filter(p => p.src === "stocktwits").length} StockTwits / ${board.filter(p => p.src === "x").length} X / ` +
  `${board.filter(p => p.src === "news").length} press; loudest: ${loudest.length} CASHCAT/PONS posts` +
  (failed.length ? ` — failed: ${failed.join("; ")}` : ""));
