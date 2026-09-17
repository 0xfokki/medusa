// What the chain traded in the last hour — read off the chain itself.
//
//   [CHAIN=arc|robinhood] node scripts/read-chain.mjs [minutes]
//
// Every v4 pool lives inside one Uniswap PoolManager contract, so a trade is a token moving
// to or from that address. A v3 pool is its own contract, so a v3-listed token is also
// scanned against its pair address. Asking for all of it across the whole chain at once
// would be ideal and is not allowed: without an address filter the node refuses the response
// as too large. So the scan is per token and per pool, two calls per range each — cheap,
// because the pool-side filter leaves only trades behind.
//
// What the raw logs are not:
//   · most of the traffic is dust — airdrops and spam that never touch a pool. Filtered by the
//     counterparty rule above.
//   · one swap emits several transfers, and a bot can enter and leave inside a single
//     transaction. So a fill is not a transfer: it is what one wallet ended up with, net, in
//     one transaction. Net to nothing and it was nobody's trade.
//   · routers and settlement contracts receive tokens on the way through and would otherwise
//     count as buyers. Counterparties with code are dropped; only wallets count.
//
// The counterparty rule and the warning about dust come from the fomo-robinhood-radar README
// (MIT). The implementation here is our own and reads tokens rather than traders.

import { createPublicClient, http, parseAbiItem, formatUnits } from "viem";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { CHAIN } from "./chains.mjs";

const RPC = CHAIN.rpc;
const POOL = CHAIN.poolManager;
const OUT = new URL("../chain-live.js", import.meta.url);
// wallet-vs-contract answers are per chain; robinhood keeps its original file name
const CACHE = new URL(CHAIN.key === "robinhood" ? "../.eoa-cache.json" : `../.eoa-cache-${CHAIN.key}.json`, import.meta.url);
const MINUTES = Number(process.argv[2] || 60);
const CHUNK = 34_000n;         // the node answers 40k blocks of pool-side logs at once,
                               // so an hour is one call per token per direction
const TRANSFER = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");
const pad = a => "0x" + a.toLowerCase().replace(/^0x/, "").padStart(64, "0");
const client = createPublicClient({ transport: http(RPC, { retryCount: 3, timeout: 40_000 }) });
// A range one provider refuses (too many logs, a rate limit) is usually fine on another,
// so each log read walks the fallback list before it counts as failed.
const clients = [client, ...(CHAIN.rpcFallbacks || []).map(u => createPublicClient({ transport: http(u, { retryCount: 1, timeout: 40_000 }) }))];
async function getLogsAnywhere(args) {
  let last;
  for (const c of clients) { try { return await c.getLogs(args); } catch (e) { last = e; } }
  throw last;
}

// Stablecoins and wrapped majors are the other half of every trade on this chain; counting
// them as tokens people are buying puts the stablecoin at the top of every feed.
const QUOTE = new Set(CHAIN.quote.map(s => s.toLowerCase()));

/* ---------- 1. the fills ---------- */
const head = await client.getBlockNumber();
const t0 = await client.getBlock({ blockNumber: head });
const t1 = await client.getBlock({ blockNumber: head - 5000n });
const sec = Number(t0.timestamp - t1.timestamp) / 5000 || 0.1;
const span = BigInt(Math.round(MINUTES * 60 / sec));
console.log(`head ${head} · ${sec.toFixed(2)}s per block · reading ${MINUTES} min (${span} blocks)`);

const net = new Map();                       // token|tx|wallet -> signed amount
const add = (k, v) => net.set(k, (net.get(k) ?? 0) + v);
let calls = 0, failed = 0, raw = 0;

// Everything on the chain with liquidity behind it, deepest first — a top drawn from ten
// tokens is not a top.
const READ = JSON.parse(readFileSync(new URL("../chain-data.js", import.meta.url), "utf8")
  .replace(/^[\s\S]*?window\.CHAIN_READ\s*=\s*/, "").replace(/;\s*$/, ""));
const LIMIT = Number(process.argv[3] || 80);
const BOARD = (READ.universe ?? READ.tokens).slice(0, LIMIT);
console.log(`walking ${BOARD.length} tokens`);

// A v3 pair address is a 20-byte contract; a v4 pair "address" is a 32-byte pool id that
// lives inside the PoolManager, so it adds nothing to scan.
const isContract = a => typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a);
const POOLS = new Set([POOL.toLowerCase(), ...BOARD.map(t => t.pair).filter(isContract).map(a => a.toLowerCase())]);

for (const token of BOARD) {
  const pools = [POOL, ...(isContract(token.pair) && token.pair.toLowerCase() !== POOL.toLowerCase() ? [token.pair] : [])];
  for (const pool of pools) {
    for (let b = head - span; b < head; b += CHUNK) {
      const to = b + CHUNK - 1n > head ? head : b + CHUNK - 1n;
      for (const dir of ["out", "in"]) {
        try {
          const logs = await getLogsAnywhere({
            address: token.address, event: TRANSFER, fromBlock: b, toBlock: to,
            args: dir === "out" ? { from: pool } : { to: pool }
          });
          calls++; raw += logs.length;
          for (const l of logs) {
            const who = (dir === "out" ? l.args.to : l.args.from).toLowerCase();
            if (POOLS.has(who)) continue;                          // pool to pool: routing, not a trade
            const v = Number(formatUnits(l.args.value, 18)) * (dir === "out" ? 1 : -1);
            add(l.address.toLowerCase() + "|" + l.transactionHash + "|" + who, v);
          }
        } catch { failed++; }
      }
    }
  }
}
console.log(`${calls} calls, ${failed} failed · ${raw} pool-side transfers`);

/* ---------- 2. wallets only ---------- */
const codeCache = existsSync(CACHE) ? JSON.parse(readFileSync(CACHE, "utf8")) : {};
const wallets = new Set([...net.keys()].map(k => k.split("|")[2]));
let looked = 0;
for (const w of wallets) {
  if (w in codeCache) continue;
  try { codeCache[w] = ((await client.getBytecode({ address: w })) ?? "0x") === "0x"; looked++; }
  catch { codeCache[w] = true; }
}
writeFileSync(CACHE, JSON.stringify(codeCache));
console.log(`${wallets.size} counterparties · ${looked} newly checked · ${[...wallets].filter(w => !codeCache[w]).length} are contracts`);

/* ---------- 3. per token ---------- */
const byToken = new Map();
for (const [key, amount] of net) {
  const [token, tx, who] = key.split("|");
  if (Math.abs(amount) < 1e-9) continue;                          // in and out again
  if (!codeCache[who]) continue;                                  // a router is not a buyer
  const t = byToken.get(token) ?? { buys:0, sells:0, buyers:new Set(), sellers:new Set(), prints:[], buySizes:[] };
  if (amount > 0) { t.buys++; t.buyers.add(who); t.buySizes.push(amount); }
  else { t.sells++; t.sellers.add(who); }
  t.prints.push({ amount: Math.abs(amount), side: amount > 0 ? "buy" : "sell", who, tx });
  byToken.set(token, t);
}
console.log(`${byToken.size} tokens traded by a wallet in the window`);

/* ---------- 4. names and prices ---------- */
const addrs = [...byToken.keys()];
const meta = {};
for (let i = 0; i < addrs.length; i += 30) {
  try {
    const r = await fetch(`https://api.dexscreener.com/tokens/v1/${CHAIN.dexscreener}/` + addrs.slice(i, i+30).join(","),
      { headers: { accept: "application/json" } });
    const arr = await r.json();
    for (const p of (Array.isArray(arr) ? arr : arr.pairs ?? [])) {
      const a = p.baseToken?.address?.toLowerCase(); if (!a) continue;
      const prev = meta[a];
      if (!prev || (p.liquidity?.usd ?? 0) > prev.liq)
        meta[a] = { symbol: p.baseToken.symbol, name: p.baseToken.name, price: Number(p.priceUsd || 0),
                    mcap: p.marketCap ?? 0, liq: p.liquidity?.usd ?? 0, url: p.url };
    }
  } catch {}
}

const tokens = [...byToken.entries()].map(([addr, t]) => {
  const m = meta[addr] ?? {};
  const usd = v => (m.price ? v * m.price : 0);
  // A wallet that buys and sells the same size within the hour was working the spread, not
  // taking a position; showing both halves fills the board with one bot's round trip.
  const sorted = t.prints.sort((a,b) => b.amount - a.amount);
  const kept = [];
  for (const p of sorted) {
    const mirrored = kept.some(k => k.who === p.who && k.side !== p.side &&
      Math.abs(k.amount - p.amount) / Math.max(k.amount, p.amount) < 0.02);
    if (!mirrored) kept.push(p);
    if (kept.length >= 2) break;
  }
  const prints = kept.map(p => ({ ...p, usd: Math.round(usd(p.amount)) }));
  return {
    address: addr, symbol: m.symbol ?? "?", name: m.name ?? "", price: m.price ?? 0,
    mcap: Math.round(m.mcap ?? 0), liquidity: Math.round(m.liq ?? 0), url: m.url,
    buys: t.buys, sells: t.sells, buyers: t.buyers.size, sellers: t.sellers.size,
    // the middle buy of the hour: a few dollars across hundreds of wallets is a giveaway
    // being handed out, not a token being bought
    medianBuyUsd: (() => {
      if (!t.buySizes.length) return 0;
      const v = t.buySizes.slice().sort((a,b) => a-b);
      return Math.round(usd(v[Math.floor(v.length/2)]) * 100) / 100;
    })(),
    volume: Math.round(usd(t.prints.reduce((s,p) => s + p.amount, 0))),
    prints
  };
})
.filter(t => t.symbol !== "?" && !QUOTE.has(t.symbol.toLowerCase()) && t.liquidity >= 5_000)
.sort((a,b) => b.volume - a.volume);

writeFileSync(OUT,
  `// Written by scripts/read-chain.mjs — read off ${CHAIN.name}, not from an aggregator.\n` +
  "window.CHAIN_LIVE = " + JSON.stringify({
    updated: new Date().toISOString(), chain: CHAIN.key, chainName: CHAIN.name, explorer: CHAIN.explorer,
    windowMinutes: MINUTES, head: Number(head),
    scanned: BOARD.length,
    // one wallet can trade five tokens in an hour; summing the per-token counts would count
    // it five times, so the headline figure is the distinct set
    wallets: new Set([...net.keys()].map(k => k.split("|")[2]).filter(w => codeCache[w])).size,
    tokens: tokens.slice(0, 40)
  }, null, 1) + ";\n");

console.log(`\nthe last ${MINUTES} minutes, by money moved`);
for (const t of tokens.slice(0, 12)) {
  const big = t.prints[0];
  console.log("  " + t.symbol.padEnd(11) +
    ("$" + t.volume.toLocaleString("en-US")).padStart(11) +
    ("  " + t.buyers + " bought / " + t.sellers + " sold").padEnd(24) +
    (big ? " biggest: " + big.side + " $" + big.usd.toLocaleString("en-US") : ""));
}
