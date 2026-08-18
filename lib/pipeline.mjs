/**
 * Shared scoring pipeline.
 *
 * Both the heavy daily sweep and the light hourly refresh end with the same
 * step: take whatever short/price/macro data is currently in the store and
 * re-derive signals, extremes and the watchlist from it. That logic lives here
 * so the two schedules cannot drift apart.
 */
import { scoreSqueeze, scoreShort, detectExtremes, bucketOf } from './signals.mjs';

/**
 * Build the row shape the scorers expect.
 */
export function makeRowBuilder({ shortByCode, prices, hist, seriesByCode, ownHist, annsByCode, universe }) {
  return (code) => {
    const s = shortByCode[code];
    if (!s) return null;
    const p = prices[code];
    const meta = (universe && universe.meta && universe.meta[code]) || null;
    return {
      code,
      name: (meta && meta.name) || s.name,
      sector: (p && p.sector) || (meta && meta.sector) || 'Unknown',
      shortPct: s.shortPct,
      shortShares: s.shortShares,
      issued: s.issued,
      shortHist: hist[code] || [],
      priceSeries: (seriesByCode && seriesByCode[code]) || (ownHist && ownHist[code]) || [],
      price: p || null,
      avgVolume: p ? p.volume : null,
      announcements: (annsByCode && annsByCode[code]) || [],
    };
  };
}

const pack = (x) => ({
  code: x.row.code,
  name: x.row.name,
  sector: x.row.sector,
  bucket: bucketOf(x.row),
  price: x.row.price,
  shortPct: x.row.shortPct,
  ...x.sig,
});

/**
 * Score candidates, detect extremes, build the watchlist, and persist all three.
 * Returns a small summary for the health record.
 */
export async function scoreAndStore(store, {
  buildRow, candidateCodes, heldCodes, universeCodes, shortByCode, hist, macro, tradeDate,
}) {
  const candidateRows = candidateCodes.map(buildRow).filter(Boolean);

  const longs = candidateRows
    .map((r) => ({ row: r, sig: scoreSqueeze(r, macro) }))
    .filter((x) => x.sig && x.sig.score >= 30)
    .sort((a, b) => b.sig.score - a.sig.score);

  const shorts = candidateRows
    .map((r) => ({ row: r, sig: scoreShort(r, macro) }))
    .filter((x) => x.sig)
    .sort((a, b) => b.sig.score - a.sig.score);

  // The top 5 are what the dashboard leads with, but the full ranked lists are
  // published too so nothing is hidden — the UI puts the rest behind a
  // "show all" rather than dropping them.
  const signals = {
    asOf: new Date().toISOString(),
    shortDataDate: tradeDate,
    longs: longs.slice(0, 5).map(pack),
    shorts: shorts.slice(0, 5).map(pack),
    allLongs: longs.map(pack),
    allShorts: shorts.map(pack),
  };
  await store.setJSON('signals/latest', signals);

  const heldRows = (heldCodes || []).map(buildRow).filter(Boolean);
  const extremes = detectExtremes(heldRows);
  await store.setJSON('extremes/latest', { asOf: new Date().toISOString(), extremes });

  const universeRows = (universeCodes || [])
    .map((c) => {
      const s = shortByCode[c];
      if (!s) return null;
      return { code: c, shortPct: s.shortPct, shortHist: hist[c] || [] };
    })
    .filter(Boolean);
  // The watchlist is about *movement*, not levels. "X is heavily shorted" is
  // already the whole of tab 1's ranked chart — repeating it here would be
  // forty rows of the same sentence. What earns a place is a position that
  // built or unwound, because that is new information.
  const watch = detectExtremes(universeRows)
    .filter((e) => e.kind !== 'level')
    .sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'high' ? -1 : 1));
  await store.setJSON('watch/latest', { asOf: new Date().toISOString(), watch });

  return { longs: signals.longs.length, shorts: signals.shorts.length,
           extremes: extremes.length, watch: watch.length };
}

/**
 * Is the ASX open, or has it closed within the last hour?
 *
 * Normal session is 10:00-16:00 Sydney. Sydney is UTC+10 (AEST) or UTC+11
 * (AEDT); we use the wider UTC window 23:00-07:00 so the check stays correct
 * across the daylight-saving switch without needing a timezone database.
 * Saturday and Sunday Sydney time are excluded.
 */
export function asxSessionish(now = new Date()) {
  const h = now.getUTCHours();
  const inWindow = h >= 23 || h < 7;
  if (!inWindow) return false;
  // Map to the Sydney calendar day (UTC+10 is enough to get the weekday right).
  const syd = new Date(now.getTime() + 10 * 3600 * 1000);
  const dow = syd.getUTCDay();
  return dow >= 1 && dow <= 5;
}

export async function safeGet(store, key) {
  try {
    return await store.get(key, { type: 'json' });
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * Internal indices
 *
 * The price sweep already fetches ~300 stocks with a market cap and a daily
 * percentage change on each. That is everything needed to build cap-weighted
 * sector indices for free — no extra request, nothing that can block us, and
 * for "is the mining complex moving?" it is arguably a better read than an
 * iron ore futures print, because it is the actual ASX miners Roy trades.
 * ------------------------------------------------------------------ */

const INTERNAL_INDICES = {
  asx300idx: { label: 'ASX 300 (own index)', test: () => true },
  materialsIdx: { label: 'ASX materials', test: (p) => p.sector === 'Materials' },
  energyIdx: { label: 'ASX energy', test: (p) => p.sector === 'Energy' },
  techIdx: { label: 'ASX tech', test: (p) => p.sector === 'Information Technology' },
};

/** Cap-weighted average daily % change for each bucket. */
export function sectorReturns(prices) {
  const out = {};
  const list = Object.values(prices || {});
  for (const [key, { label, test }] of Object.entries(INTERNAL_INDICES)) {
    let wSum = 0, w = 0, n = 0;
    for (const p of list) {
      if (!p || !test(p)) continue;
      const cap = Number(p.marketCap);
      const chg = Number(p.changePct);
      if (!Number.isFinite(cap) || cap <= 0 || !Number.isFinite(chg)) continue;
      wSum += cap * chg;
      w += cap;
      n++;
    }
    if (n >= 3 && w > 0) out[key] = { label, ret: wSum / w, members: n };
  }
  return out;
}

/**
 * Chain today's returns onto stored level series (base 100) and return the
 * macro-shaped objects. Also folds in the ASX proxy-ETF quotes the same way.
 */
export async function buildIndexSeries(store, prices, proxyQuotes = {}, isoToday) {
  const hist = (await safeGet(store, 'indices/history')) || {};
  const today = isoToday || new Date().toISOString().slice(0, 10);
  const out = {};

  const advance = (key, label, ret, source, extra = {}) => {
    const arr = (hist[key] = hist[key] || []);
    const isNewDay = !arr.length || arr[arr.length - 1][0] !== today;
    // The base for today is always yesterday's level, so re-running intraday
    // updates today's point instead of compounding it repeatedly.
    const base = arr.length
      ? (isNewDay ? arr[arr.length - 1][1] : (arr.length > 1 ? arr[arr.length - 2][1] : 100))
      : 100;
    const level = base * (1 + (Number(ret) || 0) / 100);
    if (isNewDay) arr.push([today, Number(level.toFixed(4))]);
    else arr[arr.length - 1][1] = Number(level.toFixed(4));
    if (arr.length > 260) arr.splice(0, arr.length - 260);

    const series = arr.map((r) => [r[0], r[1]]);
    const last = series[series.length - 1][1];
    const ago20 = series.length > 20 ? series[series.length - 21][1] : series[0][1];
    out[key] = {
      label, source,
      last: extra.displayLast ?? Number(last.toFixed(2)),
      changePct: Number(ret) || 0,
      trend20Pct: ago20 ? ((last - ago20) / ago20) * 100 : 0,
      series,
      ...extra,
    };
  };

  for (const [key, v] of Object.entries(sectorReturns(prices))) {
    advance(key, v.label, v.ret, 'internal', { members: v.members });
  }
  for (const [key, q] of Object.entries(proxyQuotes)) {
    advance(key, q.label, q.changePct, 'asx-proxy', { displayLast: q.last, code: q.code });
  }

  await store.setJSON('indices/history', hist);
  return out;
}
