/**
 * End-to-end test of scripts/build.mjs with the network stubbed.
 *
 * This exercises the real pipeline — ASIC parsing, backfill, universe build,
 * price sweep, macro tiers, scoring, and the shape of the published
 * docs/data.json — without touching the internet. It also leaves behind a
 * realistic data.json that the UI test renders against.
 *
 * Run: node test/build.test.mjs
 */
import { rm, readFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name} ${extra}`); }
};

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */
const STOCKS = [
  ['DRONESHIELD LIMITED ORDINARY', 'DRO', 15.78, 'Information Technology', 4.35, 1.2e9],
  ['DOMINOS PIZZA ENTERPR ORDINARY', 'DMP', 12.68, 'Consumer Discretionary', 18.4, 1.6e9],
  ['4DMEDICAL LIMITED ORDINARY', '4DX', 12.13, 'Health Care', 0.44, 2.65e8],
  ['LOTUS RESOURCES LTD ORDINARY', 'LOT', 11.89, 'Energy', 0.28, 6.2e8],
  ['PILBARA MIN LTD ORDINARY', 'PLS', 10.42, 'Materials', 2.31, 7.0e9],
  ['MINERAL RESOURCES. ORDINARY', 'MIN', 9.86, 'Materials', 28.4, 5.6e9],
  ['SAYONA MINING LTD ORDINARY', 'SYA', 9.12, 'Materials', 0.031, 3.4e8],
  ['LIONTOWN RESOURCES ORDINARY', 'LTR', 8.41, 'Materials', 0.72, 1.8e9],
  ['THE STAR ENT GRP ORDINARY', 'SGR', 7.95, 'Consumer Discretionary', 0.24, 6.9e8],
  ['CORP TRAVEL LIMITED ORDINARY', 'CTD', 7.20, 'Consumer Discretionary', 13.8, 2.0e9],
  ['BANK OF QUEENSLAND. ORDINARY', 'BOQ', 6.61, 'Financials', 7.05, 4.6e9],
  ['AGL ENERGY LIMITED. ORDINARY', 'AGL', 5.49, 'Utilities', 11.2, 7.5e9],
  ['NICKEL INDUSTRIES ORDINARY', 'NIC', 5.12, 'Materials', 0.66, 2.8e9],
  ['SANDFIRE RESOURCES ORDINARY', 'SFR', 4.30, 'Materials', 11.4, 5.2e9],
  ['CHALICE MINING LTD ORDINARY', 'CHN', 3.88, 'Materials', 1.42, 5.5e8],
  ['WEEBIT NANO LTD ORDINARY', 'WBT', 3.55, 'Information Technology', 2.10, 4.3e8],
  ['BRAINCHIP LTD ORDINARY', 'BRN', 3.10, 'Information Technology', 0.19, 3.8e8],
  ['SOUTH32 LIMITED ORDINARY', 'S32', 2.44, 'Materials', 3.42, 1.53e10],
  ['AERIS RESOURCES LTD ORDINARY', 'AIS', 1.98, 'Materials', 0.29, 4.4e8],
  ['FORTESCUE LTD ORDINARY', 'FMG', 1.62, 'Materials', 17.8, 5.4e10],
  ['"WEIRD, NAME LTD" ORDINARY', 'WNL', 1.20, 'Materials', 1.00, 1.0e8],
  ['ABACUS GROUP FPO/UNITS STAPLED', 'ABG', 1.15, 'Real Estate', 1.05, 9.4e8],
  ['ACCENT GROUP LTD ORDINARY', 'AX1', 0.78, 'Consumer Discretionary', 1.98, 1.2e9],
  ['29METALSLIMITED ORDINARY', '29M', 0.66, 'Materials', 0.21, 3.7e8],
  ['BHP GROUP LIMITED ORDINARY', 'BHP', 0.42, 'Materials', 61.35, 3.22e11],
  ['RIO TINTO LIMITED ORDINARY', 'RIO', 0.31, 'Materials', 118.4, 4.3e10],
  ['NORTHERN STAR ORDINARY', 'NST', 0.88, 'Materials', 22.6, 2.6e10],
  ['WOODSIDE ENERGY ORDINARY', 'WDS', 1.44, 'Energy', 24.1, 4.6e10],
  ['SANTOS LIMITED ORDINARY', 'STO', 1.10, 'Energy', 6.80, 2.2e10],
  ['XERO LIMITED ORDINARY', 'XRO', 0.95, 'Information Technology', 178.2, 2.7e10],
  ['WISETECH GLOBAL ORDINARY', 'WTC', 1.31, 'Information Technology', 92.4, 3.1e10],
  ['GLOBAL X SEMICONDUCTOR ETF', 'SEMI', 0.10, 'Information Technology', 36.80, 1.0e9],
  ['GLOBAL X PHYSICAL GOLD', 'GOLD', 0.05, 'Materials', 56.47, 3.5e9],
  ['ISHARES CORE S&P/ASX 200 ETF', 'IOZ', 0.04, 'Financials', 38.42, 6.0e9],
  ['BETASHARES CRUDE OIL INDEX', 'OOO', 0.03, 'Energy', 18.22, 1.5e8],
];

// Short interest drifts over the backfill window so the ignition/build logic
// has something real to detect: covering names fall, building names rise.
const COVERING = new Set(['DRO', 'PLS', 'LOT', 'SYA']);
const BUILDING = new Set(['DMP', 'SGR', 'CTD', 'BOQ']);

function csvFor(dateStr) {
  // dateStr YYYYMMDD -> how many days back from the newest fixture date
  const y = +dateStr.slice(0, 4), m = +dateStr.slice(4, 6), d = +dateStr.slice(6, 8);
  const age = Math.round((Date.UTC(2026, 7, 18) - Date.UTC(y, m - 1, d)) / 86400000);
  const t = Math.max(0, Math.min(1, 1 - age / 170)); // 0 = oldest, 1 = newest

  const lines = ['Product,Product Code,Reported Short Positions,Total Product in Issue,% of Total Product in Issue Reported as Short Positions'];
  for (const [name, code, pct, , price, cap] of STOCKS) {
    let v = pct;
    if (COVERING.has(code)) v = pct * (1.55 - 0.55 * t);
    else if (BUILDING.has(code)) v = pct * (0.30 + 0.70 * t);
    const issued = Math.round(cap / price);
    const shortShares = Math.round((v / 100) * issued);
    const shown = v < 1 ? String(v.toFixed(8)).replace(/^0/, '') : v.toFixed(8);
    lines.push(`${name},${code},${shortShares},${issued},${shown}`);
  }
  return lines.join('\n');
}

const byCode = Object.fromEntries(STOCKS.map((s) => [s[1], s]));

const calls = { asic: 0, header: 0, anns: 0, fx: 0, yahoo: 0, stooq: 0 };

// Daily closes with a deliberate structure: names whose short interest is
// falling also drift up, names whose short interest is building drift down.
// That gives the backtest a real relationship to find — and if it fails to
// find one, the backtest itself is broken.
function stooqCsv(code, lastPrice) {
  const drift = COVERING.has(code) ? 0.45 : BUILDING.has(code) ? -0.35 : 0.02;
  const rows = ['Date,Open,High,Low,Close,Volume'];
  const n = 170;
  let v = lastPrice / Math.pow(1 + drift / 100, n);
  for (let i = n; i >= 0; i--) {
    const d = new Date(Date.UTC(2026, 7, 18) - i * 86400000);
    if (d.getUTCDay() === 0 || d.getUTCDay() === 6) { continue; }
    // Deterministic wobble, no Math.random, so runs are reproducible.
    const wob = Math.sin(i * 1.7 + code.length) * 0.004;
    const c = v * (1 + wob);
    rows.push(`${d.toISOString().slice(0, 10)},${c.toFixed(4)},${c.toFixed(4)},${c.toFixed(4)},${c.toFixed(4)},100000`);
    v *= 1 + drift / 100;
  }
  return rows.join('\n');
}

globalThis.fetch = async (url) => {
  const u = String(url);
  const ok = (body, type = 'application/json') => new Response(body, {
    status: 200, headers: { 'content-type': type },
  });

  if (u.includes('download.asic.gov.au')) {
    const m = u.match(/RR(\d{8})-(\d{3})-/);
    if (!m || m[2] !== '001') return new Response('', { status: 404 });
    calls.asic++;
    return ok(csvFor(m[1]), 'text/csv');
  }

  if (u.includes('markitdigital') && u.includes('/announcements')) {
    calls.anns++;
    const code = u.match(/companies\/([^/]+)\//)?.[1];
    return ok(JSON.stringify({ data: { items: [
      { documentDate: '2026-08-14T00:00:00', headline: `${code} quarterly activities report`,
        announcementTypeName: 'Quarterly', isPriceSensitive: code === 'DRO' || code === 'PLS' },
    ] } }));
  }

  if (u.includes('markitdigital') && u.includes('/header')) {
    calls.header++;
    const code = u.match(/companies\/([^/]+)\//)?.[1];
    const s = byCode[code];
    if (!s) return new Response('', { status: 404 });
    const [name, , , sector, price, cap] = s;
    return ok(JSON.stringify({ data: {
      symbol: code, displayName: name, priceLast: price,
      priceBid: price * 0.999, priceAsk: price * 1.001,
      priceChange: price * 0.004, priceChangePercent: 0.4,
      volume: 1_500_000, marketCap: cap, sector, industryGroup: sector,
    } }));
  }

  if (u.includes('api.frankfurter.dev')) {
    calls.fx++;
    const rates = {};
    for (let i = 90; i >= 0; i--) {
      const d = new Date(Date.UTC(2026, 7, 17) - i * 86400000);
      if (d.getUTCDay() === 0 || d.getUTCDay() === 6) continue;
      rates[d.toISOString().slice(0, 10)] = { USD: 0.69 + (90 - i) * 0.00025 };
    }
    return ok(JSON.stringify({ amount: 1, base: 'AUD', rates }));
  }

  if (u.includes('finance.yahoo.com')) {
    calls.yahoo++;
    // Reproduce the production reality: Yahoo refuses datacenter IPs.
    return new Response('Too Many Requests', { status: 429 });
  }

  if (u.includes('stooq.com')) {
    calls.stooq++;
    const code = (u.match(/s=([a-z0-9]+)\.au/) || [])[1]?.toUpperCase();
    const s2 = byCode[code];
    if (!s2) return new Response('', { status: 404 });
    return ok(stooqCsv(code, s2[4]), 'text/csv');
  }

  return new Response('', { status: 404 });
};

/* ------------------------------------------------------------------ *
 * Run
 * ------------------------------------------------------------------ */
await rm(join(ROOT, 'data'), { recursive: true, force: true });
await mkdir(join(ROOT, 'data'), { recursive: true });

console.log('\n— full build from a cold start —');
process.argv = ['node', 'build.mjs', '--mode=full'];
const { main } = await import('../scripts/build.mjs');
await main();

const raw = await readFile(join(ROOT, 'docs', 'data.json'), 'utf8');
const data = JSON.parse(raw);

check('writes docs/data.json', raw.length > 0);
check('ASIC report was parsed', data.shorts.rows.length === STOCKS.length,
  `got ${data.shorts.rows.length}`);
check('quoted company name with a comma survived',
  data.shorts.rows.some((r) => r.code === 'WNL'));
check('backfill fetched many days, not just today', calls.asic > 50, `${calls.asic} ASIC fetches`);
check('short history is deep enough to compute a 20-session trend',
  data.health.history.deepest >= 20, `${data.health.history.deepest} sessions`);
check('universe was built from market cap', data.universe.codes.length === STOCKS.length);
check('universe is ordered largest first', data.universe.codes[0] === 'BHP');
check('prices were swept', Object.keys(data.prices.prices).length === STOCKS.length);

console.log('\n— macro tiers —');
check('AUD/USD came from Frankfurter', data.macro.macro.audusd?.source === 'frankfurter/ECB');
check('AUD/USD has real history', (data.macro.macro.audusd?.series.length || 0) > 50);
check('history is attributed to whichever source answered',
  !!data.health.series.sources && Object.keys(data.health.series.sources).length > 0,
  JSON.stringify(data.health.series));
check('the pipeline still completes when Yahoo refuses us', data.health.macro.ok === true);
check('internal cap-weighted indices were built', !!data.macro.macro.materialsIdx);
check('ASX proxy ETFs were picked up', !!data.macro.macro.gold);
check('macro is reported healthy despite Yahoo being down', data.health.macro.ok === true);

console.log('\n— signals —');
check('long signals were produced', data.signals.longs.length > 0,
  `${data.signals.longs.length}`);
check('a covering name reached the long list',
  data.signals.longs.some((l) => COVERING.has(l.code)),
  data.signals.longs.map((l) => l.code).join(','));
check('no more than 5 long ideas', data.signals.longs.length <= 5);
check('every long idea carries written arguments',
  data.signals.longs.every((l) => Array.isArray(l.reasons) && l.reasons.length > 0));
check('every idea is tagged swing or position',
  [...data.signals.longs, ...data.signals.shorts].every((s) => ['swing', 'position'].includes(s.horizon)));
check('watchlist excludes plain level entries',
  (data.watch.watch || []).every((w) => w.kind !== 'level'));

console.log('\n— published payload —');
check('no holdings are published', data.holdings === undefined);
check('no extremes are published (they are computed in the browser)',
  data.extremes === undefined);
check('announcements include the price-sensitive flag',
  Object.values(data.announcements.announcements).flat().some((a) => a.priceSensitive === true));
const kb = Buffer.byteLength(raw) / 1024;
check('data.json stays small enough to commit daily', kb < 3000, `${kb.toFixed(0)} KB`);
console.log(`       (data.json is ${kb.toFixed(0)} KB)`);

console.log('\n— price history falls back to the second source —');
check('Yahoo was tried and refused us', calls.yahoo > 0);
check('Stooq was used as the fallback', calls.stooq > 0);
check('history reports which source answered',
  data.health.series.sources?.stooq > 0, JSON.stringify(data.health.series.sources));
check('external history is now marked available', data.health.series.external === true);

console.log('\n— track record —');
const bt = data.backtest;
check('backtest ran', !!bt && bt.coverage.observations > 0, JSON.stringify(bt?.coverage));
check('backtest evaluated most of the universe', bt.coverage.evaluatedStocks > 20);
check('a market baseline was computed for every horizon',
  bt.horizons.every((h) => Number.isFinite(bt.baseline[h])));
check('score bands are reported', Array.isArray(bt.bands) && bt.bands.length === 3);
check('excess return is baseline-adjusted, not raw', bt.bands.some((b) =>
  b.n > 0 && bt.horizons.some((h) => Number.isFinite(b.horizons[h]?.excess)
    && Math.abs(b.horizons[h].excess - b.horizons[h].avgReturn) > 1e-9)));
check('the ignition bucket has observations', bt.ignition.n > 0, String(bt.ignition.n));
check('ignition beats the market in this fixture, where it is built to',
  bt.ignition.horizons[20].excess > 0,
  `20d excess ${bt.ignition.horizons[20]?.excess?.toFixed(2)}`);
check('hit rates are percentages, not fractions',
  bt.ignition.horizons[20].hitRate > 1 && bt.ignition.horizons[20].hitRate <= 100);

console.log('\n— when no history source answers, say why —');
{
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('stooq.')) return new Response('Exceeded the daily hits limit', { status: 200 });
    return realFetch(url);
  };
  await rm(join(ROOT, 'data', 'series'), { recursive: true, force: true });
  await main({ mode: 'full' });
  globalThis.fetch = realFetch;

  const d3 = JSON.parse(await readFile(join(ROOT, 'docs', 'data.json'), 'utf8'));
  check('external history is reported as unavailable', d3.health.series.external === false);
  check('the number of stocks attempted is recorded',
    d3.health.series.attempted > 0, String(d3.health.series.attempted));
  check('the actual refusal is captured, not just a red dot',
    /daily hits limit/i.test(JSON.stringify(d3.health.series.errors || {})),
    JSON.stringify(d3.health.series.errors));
  check('history requests are capped well below the universe size',
    d3.health.series.attempted <= 80, String(d3.health.series.attempted));
}

// Restore good data for the light-build checks that follow.
await main({ mode: 'full' });

console.log('\n— incremental light build —');
const asicBefore = calls.asic;
await main({ mode: 'light' });
check('light mode does not refetch ASIC', calls.asic === asicBefore,
  `${calls.asic - asicBefore} extra fetches`);
const data2 = JSON.parse(await readFile(join(ROOT, 'docs', 'data.json'), 'utf8'));
check('light mode keeps the short data', data2.shorts.rows.length === STOCKS.length);
check('light mode keeps the history', data2.health.history.deepest >= 20);
check('light mode re-scored signals', data2.signals.longs.length > 0);
check('health records which mode ran', data2.health.mode === 'light');
check('a light build does not downgrade the price-history verdict it never tested',
  data2.health.series.external === true && data2.health.series.sources?.stooq > 0,
  JSON.stringify(data2.health.series));
check('light mode keeps the track record from the last full build',
  data2.backtest?.coverage?.observations > 0);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
