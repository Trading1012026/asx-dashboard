/**
 * Signal engine.
 *
 * Two questions this answers:
 *   1. Which stocks have enough trapped short interest that a squeeze is
 *      plausible, AND are showing ignition (shorts covering into strength)?
 *   2. Which stocks have shorts building into weakness, without the crowding
 *      that makes shorting them dangerous?
 *
 * Everything is scored 0-100 and every contributing factor is returned as a
 * human-readable reason string, because a score you can't argue with is a
 * score you shouldn't trade.
 */

export const THRESHOLDS = {
  // ASIC open short interest, % of issued capital
  shortElevated: 5.0,
  shortHigh: 8.0,
  shortExtreme: 10.0,
  // ASX daily short-sale flow, % of issued capital sold short in one day
  // (Roy's original 0.6 / 1.0 thresholds live here)
  flowElevated: 0.6,
  flowExtreme: 1.0,
  // minimum market cap to be tradeable without slippage pain
  minMarketCap: 50_000_000,
};

const MINING_SECTORS = ['Materials', 'Energy'];
const TECH_SECTORS = ['Information Technology'];

export function bucketOf(row) {
  if (MINING_SECTORS.includes(row.sector)) return 'mining';
  if (TECH_SECTORS.includes(row.sector)) return 'tech';
  return 'other';
}

/** Linear ramp: 0 below lo, 1 above hi. */
function ramp(v, lo, hi) {
  if (!Number.isFinite(v)) return 0;
  if (v <= lo) return 0;
  if (v >= hi) return 1;
  return (v - lo) / (hi - lo);
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

/**
 * Compute the change in short interest over N sessions.
 * history: array of [isoDate, shortPct] ascending.
 */
export function shortDelta(history, sessions) {
  if (!history || history.length < 2) return null;
  const idx = Math.max(0, history.length - 1 - sessions);
  const then = history[idx][1];
  const now = history[history.length - 1][1];
  if (!Number.isFinite(then) || !Number.isFinite(now)) return null;
  return now - then;
}

/**
 * Price momentum over N sessions, in percent.
 * series: array of [isoDate, close] ascending.
 */
export function priceMomentum(series, sessions) {
  if (!series || series.length < 2) return null;
  const idx = Math.max(0, series.length - 1 - sessions);
  const then = series[idx][1];
  const now = series[series.length - 1][1];
  if (!then) return null;
  return ((now - then) / then) * 100;
}

/**
 * Macro tailwind for a bucket, -1 (headwind) .. +1 (tailwind).
 * The "AUD up = market up" relationship Roy described is the base term;
 * miners additionally key off the commodity complex.
 */
export function macroTailwind(bucket, macro) {
  if (!macro) return { score: 0, notes: [] };
  const notes = [];
  let score = 0;

  const aud = macro.audusd;
  if (aud) {
    const t = clamp(aud.trend20Pct / 3, -1, 1); // 3% move over a month = full weight
    score += t * 0.4;
    notes.push(
      `AUD/USD ${aud.trend20Pct >= 0 ? 'up' : 'down'} ${Math.abs(aud.trend20Pct).toFixed(1)}% ` +
        `over 20 sessions (${aud.last.toFixed(4)}) — ${aud.trend20Pct >= 0 ? 'supportive' : 'a drag'} for the broad market`,
    );
  }

  // Sector backdrop. Preference order is deliberate: the cap-weighted index
  // built from our own price sweep first, because it is the actual ASX
  // complex Roy trades and it can never fail to arrive, then the proxy ETFs.
  const SECTOR_INPUTS = {
    mining: [
      ['materialsIdx', 'ASX materials'],
      ['energyIdx', 'ASX energy'],
      ['gold', 'gold'],
    ],
    tech: [
      ['techIdx', 'ASX tech'],
      ['soxx', 'semiconductors'],
    ],
    other: [
      ['asx300idx', 'ASX 300'],
    ],
  };

  const inputs = SECTOR_INPUTS[bucket] || SECTOR_INPUTS.other;
  let sum = 0;
  let n = 0;
  for (const [k, label] of inputs) {
    const c = macro[k];
    if (!c || !Number.isFinite(c.trend20Pct)) continue;
    // Indices and ETFs move less than a futures contract, so 6% over a month
    // is full weight rather than the 8% a commodity print would need.
    sum += clamp(c.trend20Pct / 6, -1, 1);
    n++;
    notes.push(
      `${label} ${c.trend20Pct >= 0 ? '+' : ''}${c.trend20Pct.toFixed(1)}% over 20 sessions`,
    );
  }
  if (n) score += (sum / n) * 0.6;

  return { score: clamp(score, -1, 1), notes };
}

/**
 * Score a single stock for squeeze potential (long side).
 * Returns { score, horizon, reasons[], warnings[] } or null if not a candidate.
 */
export function scoreSqueeze(row, macro) {
  const { shortPct, shortHist, priceSeries, price, announcements } = row;
  if (!Number.isFinite(shortPct)) return null;

  const reasons = [];
  const warnings = [];

  // ---- 1. Fuel: how much short interest has to be bought back ----------
  const fuel = ramp(shortPct, 3, THRESHOLDS.shortExtreme + 4);
  if (shortPct >= THRESHOLDS.shortExtreme) {
    reasons.push(
      `Extreme short interest: ${shortPct.toFixed(2)}% of issued capital is held short ` +
        `(${(row.shortShares / 1e6).toFixed(1)}M shares). Above the ${THRESHOLDS.shortExtreme}% ` +
        `line, covering demand alone can move the price.`,
    );
  } else if (shortPct >= THRESHOLDS.shortHigh) {
    reasons.push(
      `High short interest at ${shortPct.toFixed(2)}% of issued capital — real fuel, ` +
        `though not yet at the extreme tier.`,
    );
  } else if (shortPct >= THRESHOLDS.shortElevated) {
    reasons.push(`Elevated short interest at ${shortPct.toFixed(2)}% of issued capital.`);
  }

  // ---- 2. Days to cover: fuel measured in trading days -----------------
  let dtc = null;
  if (row.avgVolume && row.shortShares) {
    dtc = row.shortShares / row.avgVolume;
    if (dtc >= 5) {
      const weeks = dtc / 5;
      const span =
        weeks >= 4 ? `over ${Math.floor(weeks / 4)} month${weeks >= 8 ? 's' : ''}`
          : weeks >= 2 ? `roughly ${Math.round(weeks)} weeks`
            : 'over a week';
      reasons.push(
        `Days-to-cover is ${dtc.toFixed(1)} — at average volume it would take ${span} ` +
          `of buying for shorts to get out. That is what turns a rally into a squeeze.`,
      );
    }
  }
  const dtcScore = ramp(dtc, 2, 10);

  // ---- 3. Ignition: shorts covering while price firms ------------------
  const d5 = shortDelta(shortHist, 5);
  const d20 = shortDelta(shortHist, 20);
  const mom5 = priceMomentum(priceSeries, 5);
  const mom20 = priceMomentum(priceSeries, 20);

  let ignition = 0;
  if (d5 !== null && mom5 !== null) {
    if (d5 < -0.15 && mom5 > 1) {
      ignition = clamp(Math.abs(d5) / 1.0, 0, 1) * 0.6 + clamp(mom5 / 8, 0, 1) * 0.4;
      reasons.push(
        `Ignition signal: short interest fell ${Math.abs(d5).toFixed(2)} points over the last ` +
          `5 sessions while the price rose ${mom5.toFixed(1)}%. Shorts are covering into strength, ` +
          `not adding.`,
      );
    } else if (d5 > 0.15 && mom5 < -1) {
      warnings.push(
        `Shorts are still adding (+${d5.toFixed(2)} points in 5 sessions) and the price is ` +
          `down ${Math.abs(mom5).toFixed(1)}%. The fuel is there but nothing has lit it — ` +
          `this is a watch, not a buy.`,
      );
    }
  } else {
    warnings.push('Not enough stored short-interest history yet to judge ignition — this builds up over the coming sessions.');
  }

  if (d20 !== null && d20 > 1.5) {
    reasons.push(
      `Short position has built by ${d20.toFixed(2)} points over 20 sessions — a crowded, ` +
        `one-sided trade that unwinds violently if the story changes.`,
    );
  }

  // ---- 4. Macro / sector backdrop -------------------------------------
  const bucket = bucketOf(row);
  const macroRes = macroTailwind(bucket, macro);
  if (macroRes.score > 0.15) reasons.push(...macroRes.notes.slice(0, 2));
  else if (macroRes.score < -0.15) warnings.push(...macroRes.notes.slice(0, 2));

  // ---- 5. Catalyst: recent price-sensitive announcement ----------------
  let catalyst = 0;
  const recentPS = (announcements || []).filter((a) => {
    if (!a.priceSensitive || !a.date) return false;
    const age = (Date.now() - new Date(a.date).getTime()) / 86400000;
    return age <= 10;
  });
  if (recentPS.length) {
    catalyst = 1;
    reasons.push(
      `Catalyst on the tape: "${recentPS[0].headline}" (${recentPS[0].date}, flagged price-sensitive). ` +
        `Announcements are what force a crowded short to make a decision.`,
    );
  }

  // ---- 6. Liquidity sanity check --------------------------------------
  if (price && price.marketCap && price.marketCap < THRESHOLDS.minMarketCap) {
    warnings.push(
      `Market cap is only $${(price.marketCap / 1e6).toFixed(0)}M — thin. ` +
        `Spread and slippage will eat a meaningful part of any move.`,
    );
  }

  const score =
    100 *
    clamp(
      fuel * 0.34 +
        dtcScore * 0.18 +
        ignition * 0.28 +
        clamp(macroRes.score, 0, 1) * 0.10 +
        catalyst * 0.10,
      0,
      1,
    );

  // Horizon label: ignition-driven setups are swing trades, fuel-and-macro
  // driven setups are position trades.
  const horizon =
    ignition > 0.35 || catalyst > 0
      ? 'swing'
      : fuel > 0.5 && Math.abs(macroRes.score) > 0.2
        ? 'position'
        : 'position';

  return {
    side: 'long',
    score: Math.round(score),
    horizon,
    reasons,
    warnings,
    metrics: { shortPct, d5, d20, mom5, mom20, dtc, macro: macroRes.score },
  };
}

/**
 * Score a single stock as a short candidate.
 * Deliberately conservative: we refuse to recommend shorting anything that is
 * already crowded, because that is exactly where you get squeezed.
 */
export function scoreShort(row, macro) {
  const { shortPct, shortHist, priceSeries, price } = row;
  if (!Number.isFinite(shortPct)) return null;

  const reasons = [];
  const warnings = [];

  if (shortPct >= THRESHOLDS.shortHigh) {
    return null; // too crowded to join safely
  }

  const d5 = shortDelta(shortHist, 5);
  const d20 = shortDelta(shortHist, 20);
  const mom20 = priceMomentum(priceSeries, 20);
  const mom5 = priceMomentum(priceSeries, 5);
  const dtc = row.avgVolume && row.shortShares ? row.shortShares / row.avgVolume : null;

  let build = 0;
  if (d20 !== null && d20 > 0.5) {
    build = clamp(d20 / 3, 0, 1);
    reasons.push(
      `Short position has built steadily: +${d20.toFixed(2)} points over 20 sessions, ` +
        `now ${shortPct.toFixed(2)}%. Professional money is leaning on it and is not yet crowded.`,
    );
  }

  let weakness = 0;
  if (mom20 !== null && mom20 < -3) {
    weakness = clamp(Math.abs(mom20) / 20, 0, 1);
    reasons.push(
      `Price is down ${Math.abs(mom20).toFixed(1)}% over 20 sessions — the trend agrees with the shorts.`,
    );
  }

  const bucket = bucketOf(row);
  const macroRes = macroTailwind(bucket, macro);
  let headwind = 0;
  if (macroRes.score < -0.15) {
    headwind = clamp(-macroRes.score, 0, 1);
    reasons.push(...macroRes.notes.slice(0, 2));
  }

  if (mom5 !== null && mom5 > 4) {
    warnings.push(
      `Sharp ${mom5.toFixed(1)}% bounce in the last 5 sessions — wait for it to roll over ` +
        `before entering. Do not short into a rally.`,
    );
  }

  if (price && price.marketCap && price.marketCap < THRESHOLDS.minMarketCap) {
    warnings.push(`Only $${(price.marketCap / 1e6).toFixed(0)}M market cap — borrow may be expensive or unavailable.`);
  }

  const score = 100 * clamp(build * 0.4 + weakness * 0.35 + headwind * 0.25, 0, 1);
  if (score < 25) return null;

  return {
    side: 'short',
    score: Math.round(score),
    horizon: weakness > 0.4 ? 'position' : 'swing',
    reasons,
    warnings,
    metrics: { shortPct, d5, d20, mom20, mom5, dtc, macro: macroRes.score },
  };
}

/**
 * Detect notable changes in short interest for stocks the user holds.
 * Returns an array of { code, kind, severity, message }.
 */
export function detectExtremes(rows) {
  const out = [];
  for (const row of rows) {
    const { code, shortPct, shortHist } = row;
    if (!Number.isFinite(shortPct)) continue;

    const d1 = shortDelta(shortHist, 1);
    const d5 = shortDelta(shortHist, 5);
    const d20 = shortDelta(shortHist, 20);

    if (shortPct >= THRESHOLDS.shortExtreme) {
      out.push({
        code,
        kind: 'level',
        severity: 'high',
        message:
          `${code} sits at ${shortPct.toFixed(2)}% short — above the ${THRESHOLDS.shortExtreme}% ` +
          `extreme line. Cuts both ways: violent upside if it turns, sustained pressure if it doesn't.`,
      });
    } else if (shortPct >= THRESHOLDS.shortHigh) {
      out.push({
        code, kind: 'level', severity: 'medium',
        message: `${code} short interest is high at ${shortPct.toFixed(2)}%.`,
      });
    }

    if (d5 !== null && d5 >= 1.0) {
      out.push({
        code, kind: 'building', severity: 'high',
        message:
          `${code} short interest jumped +${d5.toFixed(2)} points in 5 sessions ` +
          `(now ${shortPct.toFixed(2)}%). Someone with a research budget took a view against this. ` +
          `Worth finding out what they know.`,
      });
    } else if (d5 !== null && d5 <= -1.0) {
      out.push({
        code, kind: 'covering', severity: 'high',
        message:
          `${code} short interest dropped ${Math.abs(d5).toFixed(2)} points in 5 sessions ` +
          `(now ${shortPct.toFixed(2)}%). Shorts are leaving — often the early part of a re-rate.`,
      });
    } else if (d20 !== null && Math.abs(d20) >= 2.0) {
      out.push({
        code, kind: d20 > 0 ? 'building' : 'covering', severity: 'medium',
        message:
          `${code} short interest has ${d20 > 0 ? 'built' : 'unwound'} ` +
          `${Math.abs(d20).toFixed(2)} points over 20 sessions, now ${shortPct.toFixed(2)}%.`,
      });
    }

    if (d1 !== null && Math.abs(d1) >= 0.5) {
      out.push({
        code, kind: 'spike', severity: 'medium',
        message: `${code} moved ${d1 > 0 ? '+' : ''}${d1.toFixed(2)} points of short interest in a single session.`,
      });
    }
  }
  return out;
}
