// The second voice of the daily read: what specific accounts the user follows are saying
// on X — not a market-wide search. A cashtag search across all of X reads thousands of
// posts a day and burned through the account's balance in one run; nine authors read a
// few dozen posts a day between them, so the cost is small and predictable instead of
// tracking however loud the whole platform got that day.
//
// X closed every free door — guest tokens answer 403, nitter is gone, and the syndication
// endpoints rate-limit on the first request and cannot search at all. The official API wants
// $200 a month for ten thousand posts. So this reads through twitterapi.io, a pay-per-use
// reseller: $0.15 per thousand posts, no subscription.
//
// The key lives in .x-key beside the repo (or TWITTERAPI_KEY in the environment) and is never
// committed. Without it this module returns nothing and the daily read falls back to
// StockTwits alone — the site must never depend on a secret being present.
//
// One honest difference from StockTwits, and the page says so: StockTwits authors tag their
// own posts Bullish or Bearish, so we quote a label the person chose. On X there is no such
// tag, so the direction below is MEDUSA's reading of the words. To keep that reading from
// being a guess, a post is kept only when it is plainly one-sided; anything balanced or
// unreadable is dropped rather than labelled.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";

function readKeyFile() {
  const f = new URL("../.x-key", import.meta.url);
  return existsSync(f) ? readFileSync(f, "utf8") : "";
}
const KEY = (process.env.TWITTERAPI_KEY || readKeyFile() || "").trim();

const API = "https://api.twitterapi.io/twitter/tweet/advanced_search";
// Six curated accounts don't all post every day, so the window looks back further than the
// StockTwits side's 24h; X_HOURS overrides it.
const WINDOW_MS = Number(process.env.X_HOURS || 72) * 60 * 60 * 1000;
const MAX_PAGES = Number(process.env.X_PAGES || 5);   // a page is 20 posts
const QPS_WAIT = 5_200;           // the free tier allows one request every five seconds
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Curated by the user rather than discovered by search — accounts they already trust
// the calls of. Add to this list as they hand over more handles.
const ACCOUNTS = ["jessicadoteth", "Psycho10x", "PeekaB0SS", "zenkaixbt", "RoundtableSpace", "fluffycrypt"];

// Replies and retweets are not calls of their own. No min_faves: these are curated authors,
// not a random slice of the firehose, so a quiet post from one of them still counts.
// There is no -filter:links either: on X a t.co link in the text is almost always an
// attached chart, so filtering on it would throw out the traders and leave the talk.
const queryForAccounts = (handles, sinceUnix) =>
  "(" + handles.map(h => "from:" + h).join(" OR ") + ") lang:en " +
  "-filter:replies -filter:retweets since_time:" + sinceUnix;

async function search(query, pages = MAX_PAGES) {
  const out = [];
  let cursor = "";
  for (let page = 0; page < pages; page++) {
    const url = API + "?query=" + encodeURIComponent(query) + "&queryType=Latest" +
      (cursor ? "&cursor=" + encodeURIComponent(cursor) : "");
    const r = await fetch(url, { headers: { "x-api-key": KEY } });
    if (r.status === 429) { await sleep(QPS_WAIT * 2); page--; continue; }
    if (!r.ok) throw new Error("twitterapi " + r.status + ": " + (await r.text()).slice(0, 160));
    const j = await r.json();
    out.push(...(j.tweets || []));
    if (!j.has_next_page || !j.next_cursor) break;
    cursor = j.next_cursor;
    await sleep(QPS_WAIT);
  }
  return out;
}

/* ---- reading the words ------------------------------------------------------------
   Counting market adjectives does not work: "Bitcoin survived the China crash, the COVID
   crash and countless sell-offs" is three bearish words inside an unmistakably bullish post.
   What separates a call from commentary is a stated position — what the person says they did
   or would do. So a stated position is worth three ordinary words, calling yourself bullish
   or bearish is worth two, and the rest are worth one. A post has to win by three, or it is
   commentary and gets dropped rather than labelled. */
const STRONG_BULL = [
  /\b(i|we)('m| am|'ve| have| are)? ?(just )?(bought|buying|long|longing|accumulating|adding|loading)\b/i,
  /\bmax long\b/i, /\bin (a )?long position\b/i, /\blongs? (here|from|open)\b/i,
  /\b(bottom|low)s? (is|are|should be|looks? to be) in\b/i, /\bbottomed\b/i,
  /\btime to buy\b/i, /\bbuy before\b/i, /\bnever bet against\b/i, /\bnot selling\b/i,
  /\bdiamond hands?\b/i, /\bup only\b/i, /\bswept the lows?\b/i,
  // Call-out accounts (the curated ACCOUNTS list) frame conviction as a victory lap over a
  // past call rather than "bullish" or "bought" — that boast is itself the stated position.
  /\bi called\b/i, /\bcalled (it|this)\b/i, /\bmy calls?\b/i, /\d{2,}x\b/
];
const STRONG_BEAR = [
  /\b(i|we)('m| am|'ve| have| are)? ?(just )?(sold|selling|short|shorting|exiting|de-?risking)\b/i,
  /\bshorted\b/i, /\bin (a )?short position\b/i, /\bshorts? (here|from|open)\b/i,
  /\b(top|high)s? (is|are|should be|looks? to be) in\b/i, /\btopped out\b/i,
  /\btook profits?\b/i, /\bt\.?p'?ed\b/i, /\bexit liquidity\b/i, /\btime to sell\b/i,
  /\bprobability is high that\b.{0,40}\b(raid|sweep|lower|drop)\b/i
];
const SELF_BULL = /\bbullish\b/gi, SELF_BEAR = /\bbearish\b/gi;
const SOFT_BULL = /\b(breakout|rally|send(ing)?|pump(ing)?|moon(ing)?|new (ath|high)|undervalued|higher|reclaim(ed|ing)?|bull run|accumulation)\b/gi;
const SOFT_BEAR = /\b(breakdown|dump(ing)?|lower low|capitulat\w+|dead cat|bull ?trap|overvalued|distribution|rekt|liquidated|bagholders?|downside|reject(ed|ion)?)\b/gi;

const count = (t, re) => (t.match(re) || []).length;
const stated = (t, list) => list.filter(re => re.test(t)).length;

function reading(text) {
  const bull = stated(text, STRONG_BULL) * 3 + count(text, SELF_BULL) * 2 + count(text, SOFT_BULL);
  const bear = stated(text, STRONG_BEAR) * 3 + count(text, SELF_BEAR) * 2 + count(text, SOFT_BEAR);
  // Softer bar than the market-wide search used: the ACCOUNTS list is curated, not random,
  // so a lighter, still one-sided signal is trusted rather than dropped.
  if (Math.max(bull, bear) < 2 || Math.abs(bull - bear) < 2) return null;
  return bull > bear ? "Bullish" : "Bearish";
}

// The lobe the post lights up, in the same vocabulary as the StockTwits side.
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

// Substance, measured as on the StockTwits side: with cashtags, emoji, prices and arrows
// taken out, what remains has to be real sentences.
const PROSE = body => body
  .replace(/\$[A-Za-z]{1,6}\b/g, " ").replace(/#\w+/g, " ").replace(/@\w+/g, " ")
  .replace(/https?:\/\/\S+/g, " ")
  .replace(/[\p{Extended_Pictographic}←-⇿☀-➿]/gu, " ")
  .replace(/[+-]?[\d.,]+%?/g, " ").replace(/\s+/g, " ").trim();
const words = body => PROSE(body).split(" ").filter(w => w.length > 2).length;
const ABUSE = /\b(fuck\w*|shit\w*|bitch\w*|retard\w*|cunt\w*|nigg\w*|fag\w*|whore\w*)\b/i;
// Selling something is not saying something: contract addresses, giveaways, and everyone
// who ends a call with an invitation to their group.
const SHILL = /0x[a-fA-F0-9]{40}|\b(airdrop|giveaway|presale|whitelist|link in bio|dm me|100x|1000x|follow me|my (tg|telegram|channel|group)|join (my|the) (tg|telegram|group|channel)|subscribers?|paid group|signals? group|use code|referral)\b/i;
// A t.co stub is an attached image, not a sentence — strip it before anything is measured.
const clean = text => (text || "").replace(/https:\/\/t\.co\/\w+/g, " ").replace(/\s+/g, " ").trim();
// {1,10} not {1,6} — see the same fix in pull-daily.mjs: a 6-letter cap makes a
// 7+ letter cashtag like $CASHCAT unmatchable.
const firstTag = text => (text.match(/\$([A-Za-z]{1,10})\b/) || [])[1]?.toUpperCase();

// The faces, kept as our own files — same reason as StockTwits: other people's CDNs stop
// serving images to other sites without warning.
const AVA = new URL("../avatars/", import.meta.url);
async function avatarOf(user) {
  const src = (user.profilePicture || "").replace("_normal.", "_bigger.");
  if (!src || /default_profile/.test(src)) return null;
  mkdirSync(AVA, { recursive: true });
  const ext = (src.split(".").pop() || "jpg").slice(0, 4);
  const file = "x-" + user.userName.replace(/[^\w.-]/g, "_") + "." + ext;
  const dest = new URL(file, AVA);
  if (!existsSync(dest)) {
    const r = await fetch(src);
    if (!r.ok) return null;
    writeFileSync(dest, Buffer.from(await r.arrayBuffer()));
  }
  return "avatars/" + file;
}

export const hasKey = () => Boolean(KEY);

export async function pullX({ accounts = ACCOUNTS } = {}) {
  if (!KEY) return { posts: [], counted: 0, note: "no .x-key; X skipped" };
  if (!accounts.length) return { posts: [], counted: 0, note: "no accounts configured" };

  const since = Math.floor((Date.now() - WINDOW_MS) / 1000);
  const raw = await search(queryForAccounts(accounts, since));

  const seen = new Set(), authors = new Set(), kept = [];
  for (const t of raw) {
    if (seen.has(t.id)) continue;
    seen.add(t.id);
    const a = t.author || {};
    const text = clean(t.text);
    const tag = firstTag(text);
    if (!tag) continue;                                 // it has to name the coin it's calling
    if (a.isAutomated) continue;                       // a bot is not a person saying something
    if (ABUSE.test(text)) continue;                    // quoted verbatim on a public page
    if (SHILL.test(text)) continue;                    // promotion wearing a call's clothes
    // Softer than the market-wide bar: call-out accounts write short, punchy lines
    // ("I called $CASHCAT first") rather than paragraphs.
    if (PROSE(text).length < 30 || words(text) < 6) continue;
    const side = reading(text);
    if (!side) continue;                               // an unreadable direction is dropped, not guessed
    kept.push({ t, a, text, tag, side });
  }

  kept.sort((x, y) => (y.a.followers || 0) - (x.a.followers || 0));
  const posts = [];
  for (const { t, a, text, tag, side } of kept) {
    if (authors.has(a.id)) continue;                   // one call per account
    authors.add(a.id);
    posts.push({
      id: "x" + t.id,
      src: "x",
      url: t.url || "https://x.com/" + a.userName + "/status/" + t.id,
      name: a.name || a.userName,
      handle: a.userName,
      verified: Boolean(a.isBlueVerified),
      avatar: await avatarOf(a).catch(() => null),
      followers: a.followers ?? 0,
      text: text.slice(0, 280),
      sentiment: side,
      read: true,                                      // our reading, not the author's own tag
      emo: emotion(text, side === "Bullish"),
      ticker: tag,
      likes: t.likeCount ?? 0,
      views: t.viewCount ?? 0,
      at: new Date(t.createdAt).toISOString()
    });
  }

  // What the whole pull says about the mood, counted over every readable post — not only
  // the few that make the page.
  const mood = kept.reduce((m, k) => (k.side === "Bullish" ? m.bull++ : m.bear++, m), { bull: 0, bear: 0 });
  return {
    posts, counted: raw.length, readable: kept.length, mood,
    cost: (raw.length / 1000 * 0.15).toFixed(3)
  };
}

/* ---- by ticker: what X is saying about the chain's own tokens ---------------------------
   The curated-accounts read above suits a chain whose coins are on StockTwits. A brand-new
   chain's memecoins aren't, so here every tracked token is searched by its cashtag instead.
   Each token gets a fixed page budget (X_TICKER_PAGES, 20 posts a page), which keeps the
   cost flat: 25 tokens x 2 pages is ~1,000 posts, about $0.15 a run. */

// Memecoin talk doesn't say "I bought"; it says "LFG" and "load your bags". Added on top of
// the trader lexicon above, never instead of it.
// whole words/phrases get word boundaries on both sides; symbol patterns carry their own
const lexicon = (phrases, symbols = []) => new RegExp(
  [...phrases.map(w => "\\b(?:" + w + ")(?![a-z])"), ...symbols].join("|"), "gi");
const MEME_BULL = lexicon([
  "lfg", "load(?:ing|ed)?(?: up| you| your| my)? bags?", "aped?(?: in(?:to)?)?", "send(?:ing)?(?: it)?", "gem",
  "still (?:early|cheap|free)", "looks? (?:so )?free", "next leg", "buy(?:ing)? (?:more|the dip|some)",
  "holding strong", "we(?:['’]re| are) (?:so )?early", "(?:in|to) my bags?", "(?:my )?best bet",
  "melt(?:ing)? faces", "will (?:hit|reach) \\$?\\d", "see you at \\$?\\d", "\\d{2,}x",
  "mvp", "runner", "worth watching", "lock(?:ed)? in", "positioned", "congrats", "bought", "bout", "grabbed",
  "everyone buy", "moon(?:ing)?", "undervalued", "cooking", "bids?"
], ["\\bbuy \\$[a-z]", "\\+\\d{2,}%"]);
const MEME_BEAR = lexicon([
  "rug(?:ged|pull)?", "scam", "honeypot", "dead (?:chain|coin|project)", "garbage", "dump(?:ed|ing)",
  "sold (?:all|my|everything)", "stay away", "avoid", "bleeding", "cooked", "jeet(?:s|ed)?",
  "manipulat\\w+", "copy ?cat", "(?:won['’]?t|not) (?:last|sustain)", "exit liquidity", "down bad"
], ["-\\d{2,}%"]);
const ADDRESSES = /0x[a-fA-F0-9]{40}/g;

function readingTicker(text) {
  const bull = stated(text, STRONG_BULL) * 3 + count(text, SELF_BULL) * 2 + count(text, SOFT_BULL) + count(text, MEME_BULL) * 2;
  const bear = stated(text, STRONG_BEAR) * 3 + count(text, SELF_BEAR) * 2 + count(text, SOFT_BEAR) + count(text, MEME_BEAR) * 2;
  // One clear word is enough here — these posts are one line long — but a tie is dropped.
  if (Math.max(bull, bear) < 2 || bull === bear) return null;
  return bull > bear ? "Bullish" : "Bearish";
}

// Symbols that are also ordinary words or other people's tickers ($PI is mostly Pi Network,
// $LONG is mostly a trade direction). A post about one of these only counts when it also
// names the chain or quotes the token's contract.
const COLLIDES = new Set(["PI", "LONG", "COOL", "LIFT", "POLL", "CRCL", "ARCH", "BOA", "PEG", "BANCOR",
  "WARP", "AI", "U", "MEME", "NOTE", "USDC", "CREO", "INDEX", "DELTA", "STANDARD", "WALLET", "GOOSE"]);
// A contract address is a relevance signal here, not a shill marker, so it is left out.
const SHILL_NO_CA = /\b(airdrop|giveaway|presale|whitelist|link in bio|dm me|follow me|my (tg|telegram|channel|group)|join (my|the) (tg|telegram|group|channel)|subscribers?|paid group|signals? group|use code|referral)\b/i;

export async function pullXTickers({ tokens, chainWord = /\barc\b/i, hours = 24, pages = Number(process.env.X_TICKER_PAGES || 2) } = {}) {
  if (!KEY) return { posts: [], counted: 0, readable: 0, tickers: {}, note: "no .x-key; X skipped" };
  const bySym = new Map();                                // UPPER -> { symbol, address }
  for (const t of tokens) if (t.symbol) bySym.set(t.symbol.toUpperCase(), { symbol: t.symbol, address: (t.address || "").toLowerCase() });

  const since = Math.floor((Date.now() - hours * 3600e3) / 1000);
  const tickers = {}, kept = [], seen = new Set(), failed = [];
  let counted = 0;
  for (const [UP, { symbol, address }] of bySym) {
    tickers[symbol] = { bull: 0, bear: 0, messages: 0 };
    let raw = [];
    try { raw = await search("$" + symbol + " lang:en -filter:retweets since_time:" + since, pages); }
    catch (e) { failed.push(symbol + ": " + e.message.slice(0, 60)); }
    counted += raw.length;
    for (const t of raw) {
      if (seen.has(t.id)) continue;
      seen.add(t.id);
      const a = t.author || {};
      const text = clean(t.text);
      if (firstTag(text) !== UP) continue;                // it has to be about this token first
      const lower = text.toLowerCase();
      const quoted = (text.match(ADDRESSES) || []).map(x => x.toLowerCase());
      // quoting only other contracts means it's the same ticker on some other chain
      if (address && quoted.length && !quoted.includes(address)) continue;
      if ((COLLIDES.has(UP) || UP.length <= 3) && !chainWord.test(text) && !(address && lower.includes(address))) continue;
      if (a.isAutomated || ABUSE.test(text) || SHILL_NO_CA.test(text)) continue;
      tickers[symbol].messages++;
      const side = readingTicker(text);
      if (!side) continue;
      tickers[symbol][side === "Bullish" ? "bull" : "bear"]++;
      // the board wants something a stranger can read, not "$ARGUS 🚀"
      if (PROSE(text).length >= 25 && words(text) >= 5) kept.push({ t, a, text, tag: symbol, side });
    }
    await sleep(QPS_WAIT);
  }

  kept.sort((x, y) => (y.a.followers || 0) - (x.a.followers || 0));
  const posts = [], authors = new Set();
  for (const { t, a, text, tag, side } of kept) {
    if (authors.has(a.id)) continue;                     // one call per account
    authors.add(a.id);
    posts.push({
      id: "x" + t.id, src: "x",
      url: t.url || "https://x.com/" + a.userName + "/status/" + t.id,
      name: a.name || a.userName, handle: a.userName,
      verified: Boolean(a.isBlueVerified),
      avatar: posts.length < 12 ? await avatarOf(a).catch(() => null) : null,
      followers: a.followers ?? 0,
      text: text.slice(0, 280), sentiment: side, read: true,
      emo: emotion(text, side === "Bullish"), ticker: tag,
      likes: t.likeCount ?? 0, views: t.viewCount ?? 0,
      at: new Date(t.createdAt).toISOString()
    });
  }
  const mood = Object.values(tickers).reduce((m, v) => (m.bull += v.bull, m.bear += v.bear, m), { bull: 0, bear: 0 });
  return { posts, counted, readable: mood.bull + mood.bear, mood, tickers, failed, cost: (counted / 1000 * 0.15).toFixed(3) };
}

// Run it on its own to see what a pull looks like: node scripts/pull-x.mjs
if (process.argv[1] && process.argv[1].endsWith("pull-x.mjs")) {
  const r = await pullX().catch(e => ({ posts: [], note: e.message }));
  if (!r.posts.length) console.log(r.note || "nothing kept");
  else {
    console.log(r.counted + " posts read, " + r.readable + " with a clear direction, " +
      r.mood.bull + " bullish / " + r.mood.bear + " bearish · ~$" + r.cost);
    for (const p of r.posts.slice(0, 8))
      console.log("  " + p.sentiment.padEnd(8) + ("@" + p.handle).padEnd(18) +
        String(p.followers).padStart(8) + "  " + p.ticker.padEnd(8) +
        p.text.replace(/\s+/g, " ").slice(0, 90));
  }
}
