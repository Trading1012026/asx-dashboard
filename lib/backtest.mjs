/**
 * Track record.
 *
 * Replays the signal engine over the stored history and measures what actually
 * happened next. This is the honest version of "does this thing work" — not a
 * model that quietly retunes itself, but a scoreboard you can read and argue
 * with.
 *
 * Two design decisions matter more than anything else here:
 *
 * 1. **Everything is measured against a baseline.** In a rising market every
 *    signal looks brilliant. So each bucket reports *excess* return — its
 *    average forward return minus the average forward return of every stock in
 *    the universe over the same windows. A bucket that beats zero raw but
 *    trails the baseline is a losing signal, and it is shown as one.
 *
 * 2. **No lookahead.** At each historical point the score is computed from data
 *    up to and including that day only. The forward return is measured after
 *    it. Getting this wrong is the single easiest way to produce a backtest
 *    that looks wonderful and means nothing.
 *
 * What it deliberately does NOT do is tune the weights to fit these results.
 * With ~180 sessions and one market regime, that would fit noise and produce
 * confident nonsense. The weights stay where reasoning put them; this measures
 * them.
 */
import { scoreSqueeze } from './signals.mjs';

export const HORIZONS = [5, 10, 20];

const BANDS = [
  { key: '70+', min: 70, max: 101, label: 'Score 70+' },
  { key: '50-69', min: 50, max: 70, label: 'Score 50-69' },
  { key: '30-49', min: 30, max: 50, label: 'Score 30-49' },
];

/** Align a [date, value] series to a date list, forward-filling gaps. */
function alignTo(dates, series) {
  const m = new Map(series.map((r) => [r[0], r[1]]));
  let last = null;
  return dates.map((d) => {
    if (m.has(d)) last = m.get(d);
    return last;
  });
}

function mean(a) {
  return a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
}

function median(a) {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  const i = Math.floor(s.length / 2);
  return s.length % 2 ? s[i] : (s[i - 1] + s[i]) / 2;
}

/**
 * @param {object} opts
 * @param {string[]} opts.codes            universe
 * @param {object}   opts.shortHist        { CODE: [[date, pct], ...] }
 * @param {object}   opts.priceSeries      { CODE: [[date, close], ...] }
 * @param {object}   opts.meta             { CODE: {name, sector} }
 * @param {object}   opts.prices           latest quotes, for shares/volume
 * @param {number}   [opts.minSessions]    how much history a stock needs
 */
export function backtest({ codes, shortHist, priceSeries, meta = {}, prices = {}, minSessions = 45 }) {
  const samples = [];       // every scored point
  const baseline = [];      // every forward return, regardless of score

  let evaluated = 0;
  let skipped = 0;

  for (const code of codes) {
    const sh = shortHist[code];
    const ps = priceSeries[code];
    if (!sh || !ps || sh.length < minSessions || ps.length < minSessions) { skipped++; continue; }

    // One shared date axis per stock, so short interest and price line up.
    const dates = Array.from(new Set([...sh.map((r) => r[0]), ...ps.map((r) => r[0])])).sort();
    const shortAt = alignTo(dates, sh);
    const priceAt = alignTo(dates, ps);

    const p = prices[code] || null;
    const m = meta[code] || {};
    const maxH = Math.max(...HORIZONS);

    // Start far enough in to have a 20-session lookback, stop far enough out
    // to have a 20-session lookahead.
    for (let i = 25; i < dates.length - maxH; i++) {
      const px = priceAt[i];
      if (!Number.isFinite(px) || px <= 0) continue;
      if (!Number.isFinite(shortAt[i])) continue;

      const fwd = {};
      let usable = true;
      for (const h of HORIZONS) {
        const later = priceAt[i + h];
        if (!Number.isFinite(later) || later <= 0) { usable = false; break; }
        fwd[h] = ((later - px) / px) * 100;
      }
      if (!usable) continue;

      baseline.push(fwd);

      // Only data up to i — no lookahead.
      const row = {
        code,
        name: m.name || code,
        sector: m.sector || (p && p.sector) || 'Unknown',
        shortPct: shortAt[i],
        shortShares: p && p.marketCap && px ? (shortAt[i] / 100) * (p.marketCap / px) : null,
        issued: null,
        shortHist: dates.slice(0, i + 1).map((d, j) => [d, shortAt[j]]).filter((r) => Number.isFinite(r[1])),
        priceSeries: dates.slice(0, i + 1).map((d, j) => [d, priceAt[j]]).filter((r) => Number.isFinite(r[1])),
        price: p,
        avgVolume: p ? p.volume : null,
        announcements: [],   // not stored historically; excluded from the replay
      };

      // Macro is deliberately omitted: we have no historical macro series, and
      // feeding today's macro into a past date would be lookahead.
      const sig = scoreSqueeze(row, null);
      if (!sig) continue;

      evaluated++;
      samples.push({
        code, date: dates[i], score: sig.score, horizon: sig.horizon,
        ignition: /Ignition signal/.test(sig.reasons.join(' ')),
        shortPct: shortAt[i], fwd,
      });
    }
  }

  const base = {};
  for (const h of HORIZONS) base[h] = mean(baseline.map((f) => f[h]));

  const summarise = (rows, label) => {
    if (!rows.length) return { label, n: 0 };
    const out = { label, n: rows.length, horizons: {} };
    for (const h of HORIZONS) {
      const rs = rows.map((r) => r.fwd[h]).filter(Number.isFinite);
      const avg = mean(rs);
      out.horizons[h] = {
        n: rs.length,
        avgReturn: avg,
        medianReturn: median(rs),
        hitRate: rs.length ? (rs.filter((x) => x > 0).length / rs.length) * 100 : null,
        excess: avg !== null && base[h] !== null ? avg - base[h] : null,
      };
    }
    return out;
  };

  const bands = BANDS.map((b) =>
    ({ key: b.key, ...summarise(samples.filter((s) => s.score >= b.min && s.score < b.max), b.label) }));

  const ignition = summarise(samples.filter((s) => s.ignition), 'Ignition (shorts covering into strength)');
  const noIgnition = summarise(samples.filter((s) => !s.ignition && s.score >= 30),
    'Scored 30+ without ignition');
  const crowded = summarise(samples.filter((s) => s.shortPct >= 10), 'Short interest above 10%');

  return {
    computedAt: new Date().toISOString(),
    coverage: {
      stocks: codes.length,
      evaluatedStocks: codes.length - skipped,
      skippedStocks: skipped,
      observations: evaluated,
      minSessions,
    },
    baseline: Object.fromEntries(HORIZONS.map((h) => [h, base[h]])),
    bands,
    ignition,
    noIgnition,
    crowded,
    horizons: HORIZONS,
  };
}
