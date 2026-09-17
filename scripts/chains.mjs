// Which chain MEDUSA reads. Every script that touches a chain takes its RPC, DexScreener
// slug, explorer and pool addresses from here, so switching chains is one variable:
//
//   CHAIN=robinhood node scripts/read-chain.mjs  (default, the main site)
//   CHAIN=arc node scripts/read-chain.mjs        (the Arc build, kept aside)
//
// Both chains run Uniswap v4 behind the same PoolManager address, so a v4 trade is a token
// moving to or from that one contract. Arc also has v3 pairs, where each pool is its own
// contract — read-chain.mjs picks those up from the pair address DexScreener gives.

export const CHAINS = {
  arc: {
    key: "arc",
    name: "Arc",
    rpc: "https://rpc.mainnet.arc.io",
    // same chain, other providers — a log read that one node refuses is retried on the next
    rpcFallbacks: ["https://rpc.blockdaemon.mainnet.arc.io", "https://rpc.quicknode.mainnet.arc.io"],
    dexscreener: "arc",
    explorer: "https://www.arcexplorer.org",
    poolManager: "0x8366a39CC670B4001A1121B8F6A443A643e40951",
    // The other half of every trade — counting these as tokens people buy puts USDC on top.
    quote: ["USDC", "EURC", "USYC", "WUSDC", "WETH", "ETH", "USDT", "WBTC", "CBBTC"],
    // Bridged majors and stables ride on this chain but weren't made here.
    notOurs: /^(USDC|EURC|USYC|WUSDC|USDT|DAI|WETH|ETH|WBTC|cbBTC|cirBTC|cirETH|BTC|SOL|LINK|UNI|AAVE)$/i,
    // "arc" is an ordinary English word; in a post that already carries a cashtag it's the chain
    chainWord: /\barc\b/i,
    // in a news headline it isn't — the headline has to say which Arc
    newsWord: /\b(arc (chain|network|mainnet|blockchain|l1)|circle['’]s arc)\b/i,
    homeTicker: "ARC",
  },
  robinhood: {
    key: "robinhood",
    name: "Robinhood Chain",
    rpc: "https://rpc.mainnet.chain.robinhood.com",
    dexscreener: "robinhood",
    explorer: "https://robinhoodchain.blockscout.com",
    poolManager: "0x8366a39CC670B4001A1121B8F6A443A643e40951",
    quote: ["USDG", "WETH", "ETH", "USDC", "USDT", "USDE", "WBTC", "CBBTC", "USD1", "PYUSD"],
    notOurs: /^(cbBTC|WBTC|BTC|WETH|ETH|USDG|USDC|USDT|USDe|sUSDe|DAI|TAO|PENGU|LINK|UNI|AAVE|stETH|wstETH|rETH|SOL|DOGE|XRP|LTC|SHIB|PEPE|USDS|USD1|PYUSD)$/i,
    chainWord: /\brobinhood\b/i,
    newsWord: /\brobinhood\b/i,
    homeTicker: "HOOD",
  },
};

const key = (process.env.CHAIN || "robinhood").toLowerCase();
if (!CHAINS[key]) throw new Error(`unknown CHAIN "${key}" — expected one of: ${Object.keys(CHAINS).join(", ")}`);
export const CHAIN = CHAINS[key];
