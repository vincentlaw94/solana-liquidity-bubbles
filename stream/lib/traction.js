// The Traction list: coins that are gaining traders right now.
//
// Trending rewards volume; this rewards acceleration. A coin makes the list when more wallets are trading it in
// the last 5 minutes than in the 25 before, and more is being bought than sold. Rows come from lib/market.js,
// which measures each pool's last 5 minutes against its earlier per-5-minute average (trG, volG) and its net
// flow (net5).
//
// Gates: 8+ wallets and $300+ volume in 5 minutes, $1K+ liquidity, net buying, at least as many buys as 80% of
// sells, price not down over 15% in 5 minutes, and (once the earlier minutes are known) traders up 25% or more.
// Score: log10(1 + traders) x sqrt(trader growth, up to 10x) x sqrt(volume growth, up to 10x)
//        x (0.5 + net buying's share of volume) x (1 + 5m price rise / 100, up to 1.5x).
// A coin whose earlier minutes aren't known (see Market.traction) counts as growth 1: listed, never boosted.
export const TRACTION = { minTraders: 8, minVol5: 300, minLiq: 1000, minGrowth: 1.25, maxGrowth: 10, maxDrop5: -15 };

export function tractionScore(r) {
  const g = Math.min(TRACTION.maxGrowth, Math.max(0.1, r.trG ?? 1)), vg = Math.min(TRACTION.maxGrowth, Math.max(0.1, r.volG ?? 1));
  const netShare = r.vol5 > 0 ? Math.max(0, Math.min(1, r.net5 / r.vol5)) : 0;
  return Math.log10(1 + r.traders5) * Math.sqrt(g) * Math.sqrt(vg) * (0.5 + netShare) * (1 + Math.max(0, Math.min(0.5, r.chg5 / 100)));
}

export function tractionEligible(r) {
  return r.traders5 >= TRACTION.minTraders && r.vol5 >= TRACTION.minVol5 && r.liq >= TRACTION.minLiq && r.net5 > 0 &&
    r.buys5 >= r.sells5 * 0.8 && r.chg5 > TRACTION.maxDrop5 && (r.trG == null || r.trG >= TRACTION.minGrowth);
}

// rows -> the ranked list (copies carrying `trac`, the traction score)
export function rankTraction(rows, limit) {
  const out = [];
  for (const r of rows) if (tractionEligible(r)) out.push({ ...r, trac: +tractionScore(r).toFixed(2) });
  return out.sort((a, b) => b.trac - a.trac).slice(0, limit);
}
