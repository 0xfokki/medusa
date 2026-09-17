# MEDUSA

**An AI lie detector for retail.** People say one thing on social; their wallets do another on
chain. MEDUSA reads the two against each other, token by token, and says where they agree,
where they don't, and where the money is quietly concentrating while nobody talks.

Live at [medusa-ai.pro](https://medusa-ai.pro) · API at [medusa-ai.pro/api](https://medusa-ai.pro/api/) · [@0x_fokki](https://x.com/0x_fokki)

The folder is still called `brain` from an earlier working name.

## What is on the page

| Block | What it shows | Where it comes from |
|---|---|---|
| Hero | A jellyfish made of the crowd: every fill on chain sparks it, every verdict runs down a tentacle | the same rows as blocks 02–04, replayed live in the browser |
| 01 Daily read | The six loudest accounts talking about the chain's coins, quoted as written, bull/bear tagged | `pull-daily.mjs` → `daily-data.js` (StockTwits and X) |
| 02 On-chain read | Unusually large buys in the last hour, each linked to its transaction and wallet | `read-chain.mjs` → `chain-live.js`, read off the chain itself, not an aggregator |
| 03 The verdict | Chain lean vs crowd lean per token: CONFIRMED, CONTRADICTED, CHAIN ONLY, RUNNER WATCH | computed from the two above (`convictionScores()` in the page, `build-api.mjs` on the server) |
| 04 The tape | A console replaying every real row on the page, typed out one at a time | blocks 01–03 |
| API | The same data as JSON, no key | `build-api.mjs` → `api/v1/*` |

Nothing on the page is invented. If a number looks wrong, the transaction it links to is the
place to check. The only simulated thing is the ambient chatter on the jellyfish in the hero,
and it is labelled as such in the code.

## How she scores

```
chain lean  = (buyers - sellers) / wallets        over the last hour, ≥ 3 wallets to count
crowd lean  = (bull - bear) / tagged posts         for today, ≥ 2 posts to count
score       = (chain lean + crowd lean) / 2 × 100  or chain lean alone when the crowd is silent
RUNNER WATCH: chain lean ≥ 0.5, ≥ 5 wallets, crowd not against it — not a price call
```

## Which chain

The chain is a config switch, `scripts/chains.mjs`. Robinhood Chain is the default; Arc is
there as a second config (`CHAIN=arc`). Every chain-bound word on the page (name, chain id,
explorer, the footer line) is filled from the data files, so one `index.html` serves any chain.

## Run it yourself

```bash
npm install
npx playwright install chromium   # pull-chain.mjs and st-fetch.mjs drive a real browser
```

```bash
node scripts/pull-chain.mjs   # the tracked universe, via DexScreener (headful browser)
node scripts/read-chain.mjs   # the last hour, read off the chain (writes chain-live.js)
node scripts/pull-daily.mjs   # today's social read: StockTwits + X (writes daily-data.js)
node scripts/build-api.mjs    # the JSON API from the files above (writes api/v1/*)

npx serve .                   # any static server; the page is one file
```

Optional, and everything degrades without them:

- **X** — `pull-x.mjs` uses the twitterapi.io reseller. Put a key in `.x-key` (gitignored) or
  `TWITTERAPI_KEY`; without it the daily read runs on StockTwits alone.
- **The thought intake** — `server/thoughts.mjs` is the small service behind "Ask MEDUSA"
  (`/api/thought`, `/api/stats`). The page works without it; the counter just stays put.
- **`scripts/publish.mjs`** is this project's own deploy script, tied to its maintainer's
  server. Ignore it.

Two things to know: **StockTwits blocks data-centre IPs**, so `pull-daily.mjs` has to run from a
residential connection, and `st-fetch.mjs` will open a visible Chromium window for a minute when
a plain fetch is refused. **DexScreener needs a real browser** too, for the same reason. The
chain read and the API builder run fine on a server; in production they run from cron every
ten minutes.

## Public API

```
GET /api/v1/chain      the last hour: tokens, buyers/sellers, the biggest fills with tx links
GET /api/v1/verdicts   chain lean vs crowd lean per token, runners first
GET /api/v1/daily      today's posts, the loudest six, bull/bear per ticker
GET /api/v1/stats      statements taken, all time and today
GET /api/v1/index      what is here
```

Open, no key, CORS for any origin, cached 60 seconds, rewritten every ten minutes. Read-only.
The docs page with live samples is `api.html`, served at `/api/`.

## Files

| Path | What it is |
|---|---|
| `index.html` | the whole page: hero, daily read, on-chain read, verdict, tape |
| `api.html` | the API docs page, with live responses |
| `jelly-lite.js` | the bell and tentacles on their own, for pages that want her without the hero |
| `chain-data.js` | the tracked universe, written by `pull-chain.mjs` |
| `chain-live.js` | the last hour, written by `read-chain.mjs` |
| `daily-data.js` | today's social read, written by `pull-daily.mjs` |
| `scripts/chains.mjs` | the chain config: RPC, DexScreener slug, explorer, pool manager, quote tokens |
| `scripts/pull-chain.mjs` | the universe via DexScreener |
| `scripts/read-chain.mjs` | the last hour via `eth_getLogs` against the Uniswap pools |
| `scripts/pull-daily.mjs` | the social read; `pull-x.mjs`, `pull-news.mjs`, `st-fetch.mjs` are its parts |
| `scripts/build-api.mjs` | the JSON API from the data files |
| `server/thoughts.mjs` | the thought intake behind "Ask MEDUSA" |

MEDUSA is independent of Robinhood; Robinhood Chain is used as a public network.
