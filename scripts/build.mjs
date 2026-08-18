/**
 * The whole data pipeline, as one script.
 *
 * GitHub Actions runs this on a schedule. It fetches, scores, writes state
 * into `data/` and publishes a single `docs/data.json` that the dashboard
 * reads. There is no server anywhere in this design — GitHub's cron is the
 * scheduler and GitHub Pages is the host, so nothing has to stay awake and
 * nothing has to be paid for.
 *
 *   node scripts/build.mjs --mode=full    # daily: ASIC, universe, history
 *   node scripts/build.mjs --mode=light   # intraday: prices, macro, re-score
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

import {
  fetchAsicShortPositions, backfillAsicHistory, fetchAsxHeader, fetchAnnouncements,
  fetchStockHistory, fetchMacro, fetchMacroProxies, pooled, isoDate,
} from '../lib/sources.mjs';
import { makeRowBuilder, scoreAndStore, buildIndexSeries, asxSessionish } from '../lib/pipeline.mjs';
import { backtest } from '../lib/backtest.mjs';
import { createStore } from '../lib/filestore.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const store = createStore(join(ROOT, 'data'));

const UNIVERSE_SIZE = 300;
const UNIVERSE_TTL_DAYS = 7;
// Deep dive = the names we pull announcements for and score as candidates.
// Covering the whole universe means no stock is silently excluded from the
// signal screen just because it sits low on the short-interest table.
const DEEP_DIVE_COUNT = 300;
const SHORT_HIST_DAYS = 180;
// Publish short history for the entire universe. This is the main driver of
// data.json size, and the file is committed on every run — see the size guard
// at the end of the build, which fails loudly rather than quietly bloating the
// repository forever.
const PUBLISH_HIST_CODES = UNIVERSE_SIZE;
const MAX_DATA_JSON_MB = 8;

function parseArgs(argv) {
  return Object.fromEntries(
    argv.slice(2).map((a) => {
      const [k, v] = a.replace(/^--/, '').split('=');
      return [k, v ?? true];
    }),
  );
}

const log = [];
const say = (m) => { log.push(m); console.log(m); };

/**
 * @param {{mode?: 'full'|'light'}} [opts] overrides the command line, so the
 *   test suite can run both modes in one process.
 */
export async function main(opts = {}) {
  const t0 = Date.now();
  log.length = 0;
  const health = (await store.get('health', { type: 'json' })) || {};
  const today = isoDate(new Date());

  // Read the arguments per call rather than once at module load — otherwise a
  // second invocation in the same process silently reuses the first mode.
  let mode = opts.mode || parseArgs(process.argv).mode || 'full';
  const existingShorts = await store.get('shorts/latest', { type: 'json' });
  if (mode === 'light' && !existingShorts) {
    say('No base data yet — promoting this run to a full build.');
    mode = 'full';
  }
  say(`Mode: ${mode}`);

  /* ---------------------------------------------------------------- *
   * 1. Short positions (full mode only — ASIC publishes once a day)
   * ---------------------------------------------------------------- */
  let asic = existingShorts;
  let hist = (await store.get('shorts/history', { type: 'json' })) || {};

  if (mode === 'full') {
    const fresh = await fetchAsicShortPositions(new Date());
    if (!fresh) {
      health.asic = { ok: false, error: 'No ASIC report found in the last 14 days' };
      if (!asic) {
        await store.setJSON('health', { ...health, checkedAt: new Date().toISOString() });
        throw new Error('ASIC fetch failed and there is no previous data to fall back on');
      }
      say('ASIC fetch failed; keeping the previous report.');
    } else {
      asic = fresh;
      await store.setJSON('shorts/latest', asic);
      health.asic = { ok: true, tradeDate: asic.tradeDate, rows: asic.rows.length, sourceUrl: asic.sourceUrl };
      say(`ASIC ${asic.tradeDate}: ${asic.rows.length} rows`);
    }

    // Backfill on first run, so the short panel is readable immediately
    // instead of taking months to fill in.
    const deepest = Object.values(hist).reduce((m, a) => Math.max(m, a.length), 0);
    if (deepest < 20) {
      say(`History is ${deepest} sessions deep — backfilling from the ASIC archive...`);
      const byDay = new Map();
      const bf = await backfillAsicHistory(SHORT_HIST_DAYS, async ({ tradeDate, rows }) => {
        byDay.set(tradeDate, rows);
      });
      for (const day of [...byDay.keys()].sort()) {
        for (const r of byDay.get(day)) {
          const arr = (hist[r.code] = hist[r.code] || []);
          if (!arr.length || arr[arr.length - 1][0] < day) arr.push([day, Number(r.shortPct.toFixed(4))]);
        }
      }
      health.backfill = { days: bf.days, missing: bf.missing };
      say(`Backfilled ${bf.days} trading days (${bf.missing} dates had no file)`);
    }

    for (const r of asic.rows) {
      const arr = (hist[r.code] = hist[r.code] || []);
      if (!arr.length || arr[arr.length - 1][0] !== asic.tradeDate) {
        arr.push([asic.tradeDate, Number(r.shortPct.toFixed(4))]);
      }
    }
  }

  /* ---------------------------------------------------------------- *
   * 2. Universe — top N by market cap, rebuilt weekly
   * ---------------------------------------------------------------- */
  let universe = await store.get('universe', { type: 'json' });
  const stale = !universe?.builtAt ||
    (Date.now() - new Date(universe.builtAt).getTime()) / 86400000 > UNIVERSE_TTL_DAYS;

  if (mode === 'full' && stale) {
    say(`Rebuilding universe from ${asic.rows.length} candidates...`);
    const headers = await pooled(asic.rows.map((r) => r.code), 12, (c) => fetchAsxHeader(c));
    const withCap = headers
      .filter((h) => h && Number.isFinite(h.marketCap) && h.marketCap > 0)
      .sort((a, b) => b.marketCap - a.marketCap)
      .slice(0, UNIVERSE_SIZE);
    universe = {
      builtAt: new Date().toISOString(),
      codes: withCap.map((h) => h.code),
      meta: Object.fromEntries(withCap.map((h) =>
        [h.code, { name: h.name, sector: h.sector, industryGroup: h.industryGroup }])),
    };
    await store.setJSON('universe', universe);
    say(`Universe rebuilt: ${universe.codes.length} stocks`);
  }
  if (!universe) throw new Error('No universe and could not build one');
  health.universe = { ok: true, size: universe.codes.length, builtAt: universe.builtAt };

  // Prune stored history to the universe. Without this the file grows to
  // every stock ASIC has ever reported and is committed daily forever.
  const inUniverse = new Set(universe.codes);
  for (const code of Object.keys(hist)) {
    if (!inUniverse.has(code)) { delete hist[code]; continue; }
    if (hist[code].length > SHORT_HIST_DAYS) {
      hist[code].splice(0, hist[code].length - SHORT_HIST_DAYS);
    }
  }
  await store.setJSON('shorts/history', hist);
  health.history = {
    ok: true,
    deepest: Object.values(hist).reduce((m, a) => Math.max(m, a.length), 0),
    stocks: Object.keys(hist).length,
  };

  /* ---------------------------------------------------------------- *
   * 3. Prices
   * ---------------------------------------------------------------- */
  const live = asxSessionish();
  let prices = (await store.get('prices/latest', { type: 'json' }))?.prices || {};
  const ownHist = (await store.get('prices/history', { type: 'json' })) || {};

  if (mode === 'full' || live) {
    const arr = await pooled(universe.codes, 12, (c) => fetchAsxHeader(c));
    const fresh = {};
    for (const p of arr) if (p) fresh[p.code] = p;
    if (Object.keys(fresh).length) {
      prices = fresh;
      await store.setJSON('prices/latest', { asOf: new Date().toISOString(), prices });
      for (const [code, p] of Object.entries(prices)) {
        const a = (ownHist[code] = ownHist[code] || []);
        if (!a.length || a[a.length - 1][0] !== today) a.push([today, p.last]);
        else a[a.length - 1][1] = p.last;
        if (a.length > SHORT_HIST_DAYS) a.splice(0, a.length - SHORT_HIST_DAYS);
      }
      for (const code of Object.keys(ownHist)) if (!inUniverse.has(code)) delete ownHist[code];
      await store.setJSON('prices/history', ownHist);
    }
  }
  health.prices = { ok: Object.keys(prices).length > 0, count: Object.keys(prices).length };
  say(`Prices: ${Object.keys(prices).length}`);

  /* ---------------------------------------------------------------- *
   * 4. Macro
   * ---------------------------------------------------------------- */
  const proxyQuotes = (mode === 'full' || live) ? await fetchMacroProxies() : {};
  const indexSeries = await buildIndexSeries(store, prices, proxyQuotes, today);
  const { macro, diag: macroDiag } = await fetchMacro(indexSeries);

  // When the market is shut we don't re-quote the ASX proxy ETFs, but they
  // shouldn't disappear from the strip — carry the last known value forward
  // and mark it stale so the UI can say so rather than implying it's current.
  const prevMacro = (await store.get('macro/latest', { type: 'json' }))?.macro || {};
  for (const [k, v] of Object.entries(prevMacro)) {
    if (!macro[k] && v) macro[k] = { ...v, stale: true };
  }
  await store.setJSON('macro/latest', { asOf: new Date().toISOString(), macro });
  health.macro = { ok: Object.keys(macro).length > 0, keys: Object.keys(macro), detail: macroDiag };
  say(`Macro: ${Object.keys(macro).join(', ') || 'none'}`);

  /* ---------------------------------------------------------------- *
   * 5. Deep dive — price series + announcements for the most shorted
   * ---------------------------------------------------------------- */
  const shortByCode = Object.fromEntries((asic.rows || []).map((r) => [r.code, r]));
  const ranked = (asic.rows || [])
    .filter((r) => inUniverse.has(r.code))
    .sort((a, b) => b.shortPct - a.shortPct);

  const candidates = ranked.slice(0, DEEP_DIVE_COUNT).map((r) => r.code);

  let seriesByCode = (await store.get('series/latest', { type: 'json' }))?.series || {};
  let annsByCode = (await store.get('announcements/latest', { type: 'json' }))?.announcements || {};

  const annTargets = mode === 'full' ? candidates : candidates.slice(0, 60);
  const deep = await pooled(annTargets, 6, async (code) => {
    const [series, anns] = await Promise.all([
      mode === 'full' ? fetchStockHistory(code, '6mo') : Promise.resolve(null),
      fetchAnnouncements(code, 8),
    ]);
    return { code, series, anns };
  });

  let externalHistory = false;
  const historySources = {};
  for (const d of deep) {
    if (!d) continue;
    if (d.series && d.series.series && d.series.series.length > 5) {
      seriesByCode[d.code] = d.series.series;
      historySources[d.series.source] = (historySources[d.series.source] || 0) + 1;
      externalHistory = true;
    }
    if (d.anns && d.anns.length) annsByCode[d.code] = d.anns;
  }
  // Fall back to the closes we have been accumulating ourselves.
  for (const code of candidates) {
    if (!seriesByCode[code] || seriesByCode[code].length < 2) {
      seriesByCode[code] = ownHist[code] || [];
    }
  }
  for (const code of Object.keys(seriesByCode)) if (!inUniverse.has(code)) delete seriesByCode[code];
  for (const code of Object.keys(annsByCode)) if (!inUniverse.has(code)) delete annsByCode[code];

  await store.setJSON('series/latest', { asOf: new Date().toISOString(), series: seriesByCode });
  await store.setJSON('announcements/latest', { asOf: new Date().toISOString(), announcements: annsByCode });
  // A light build never attempts external history, so it must not report the
  // absence of something it didn't ask for — carry the last full build's
  // verdict forward instead of downgrading it every hour.
  const prevSeriesHealth = health.series || {};
  health.series = {
    ok: true,
    count: Object.keys(seriesByCode).length,
    withHistory: Object.values(seriesByCode).filter((s) => s && s.length > 5).length,
    external: mode === 'full' ? externalHistory : (prevSeriesHealth.external ?? false),
    sources: mode === 'full' ? historySources : (prevSeriesHealth.sources || {}),
  };

  /* ---------------------------------------------------------------- *
   * 6. Score
   * ---------------------------------------------------------------- */
  const buildRow = makeRowBuilder({
    shortByCode, prices, hist, seriesByCode, ownHist, annsByCode, universe,
  });
  const summary = await scoreAndStore(store, {
    buildRow,
    candidateCodes: candidates,
    // Holdings live in the browser, not here — see docs/index.html. Nothing
    // personal is ever committed to a public repository.
    heldCodes: [],
    universeCodes: universe.codes,
    shortByCode,
    hist,
    macro,
    tradeDate: asic.tradeDate,
  });
  say(`Signals: ${summary.longs} long, ${summary.shorts} short`);

  /* ---------------------------------------------------------------- *
   * 6b. Track record — replay the engine over stored history
   * ---------------------------------------------------------------- */
  let track = await store.get('backtest', { type: 'json' });
  if (mode === 'full') {
    try {
      track = backtest({
        codes: universe.codes,
        shortHist: hist,
        priceSeries: seriesByCode,
        meta: universe.meta,
        prices,
      });
      await store.setJSON('backtest', track);
      say(`Backtest: ${track.coverage.observations} observations across ` +
          `${track.coverage.evaluatedStocks} stocks`);
    } catch (err) {
      say(`Backtest failed (non-fatal): ${err.message}`);
    }
  }
  health.backtest = track
    ? { ok: track.coverage.observations > 0, observations: track.coverage.observations,
        stocks: track.coverage.evaluatedStocks }
    : { ok: false, observations: 0 };

  /* ---------------------------------------------------------------- *
   * 7. Publish one file for the dashboard
   * ---------------------------------------------------------------- */
  health.checkedAt = new Date().toISOString();
  health.mode = mode;
  health.marketOpen = live;
  if (mode === 'full') health.lastFull = health.checkedAt;
  health.durationMs = Date.now() - t0;
  health.log = log;
  await store.setJSON('health', health);

  // Publish short history only for the names the dashboard can actually chart.
  const publishCodes = new Set(ranked.slice(0, PUBLISH_HIST_CODES).map((r) => r.code));
  const publishedHist = {};
  for (const code of publishCodes) if (hist[code]) publishedHist[code] = hist[code];

  const payload = {
    generatedAt: new Date().toISOString(),
    shorts: { tradeDate: asic.tradeDate, sourceUrl: asic.sourceUrl,
              rows: (asic.rows || []).filter((r) => inUniverse.has(r.code)) },
    history: publishedHist,
    prices: { asOf: new Date().toISOString(), prices },
    priceHistory: Object.fromEntries(
      [...publishCodes].filter((c) => ownHist[c]).map((c) => [c, ownHist[c]])),
    series: { asOf: new Date().toISOString(), series: seriesByCode },
    macro: { asOf: new Date().toISOString(), macro },
    signals: await store.get('signals/latest', { type: 'json' }),
    announcements: { asOf: new Date().toISOString(), announcements: annsByCode },
    watch: await store.get('watch/latest', { type: 'json' }),
    backtest: track,
    universe,
    health,
  };

  await mkdir(join(ROOT, 'docs'), { recursive: true });
  const out = join(ROOT, 'docs', 'data.json');
  await writeFile(out, JSON.stringify(payload), 'utf8');

  const kb = Buffer.byteLength(JSON.stringify(payload)) / 1024;
  say(`Wrote docs/data.json (${kb.toFixed(0)} KB) in ${((Date.now() - t0) / 1000).toFixed(0)}s`);

  // data.json is committed on every run. If it ever grows past this, the
  // repository will bloat a little more every weekday forever, so say so
  // loudly rather than letting it creep.
  if (kb / 1024 > MAX_DATA_JSON_MB) {
    console.warn(
      `WARNING: data.json is ${(kb / 1024).toFixed(1)} MB, above the ${MAX_DATA_JSON_MB} MB ` +
      `guideline. It is committed daily, so consider trimming PUBLISH_HIST_CODES or ` +
      `SHORT_HIST_DAYS in scripts/build.mjs.`,
    );
  }
}

// Only self-run when invoked directly (`node scripts/build.mjs`). Tests import
// main() and await it, which an auto-running module would not let them do.
const invokedDirectly = process.argv[1] &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (invokedDirectly) {
  main().catch((err) => {
    console.error('Build failed:', err);
    process.exit(1);
  });
}
