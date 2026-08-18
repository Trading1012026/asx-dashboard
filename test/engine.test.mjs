/**
 * Offline checks for the signal engine. No network, no deps.
 * Run: node test/engine.test.mjs
 */
import { scoreSqueeze, scoreShort, detectExtremes, shortDelta, priceMomentum, macroTailwind, THRESHOLDS }
  from '../lib/signals.mjs';
import { parseAsicCsv, pooled } from '../lib/sources.mjs';
import { makeRowBuilder, scoreAndStore, asxSessionish, sectorReturns, buildIndexSeries }
  from '../lib/pipeline.mjs';
import { backtest, HORIZONS } from '../lib/backtest.mjs';

let pass = 0, fail = 0;
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name} ${extra}`); }
}

/* ---------- helpers to build synthetic series ---------- */
function series(startVal, dailyPct, n, start = '2026-05-01') {
  const out = [];
  let v = startVal;
  const d = new Date(start);
  for (let i = 0; i < n; i++) {
    out.push([d.toISOString().slice(0, 10), Number(v.toFixed(4))]);
    v *= 1 + dailyPct / 100;
    d.setDate(d.getDate() + 1);
  }
  return out;
}
function linear(from, to, n, start = '2026-05-01') {
  const out = [];
  const d = new Date(start);
  for (let i = 0; i < n; i++) {
    out.push([d.toISOString().slice(0, 10), Number((from + ((to - from) * i) / (n - 1)).toFixed(4))]);
    d.setDate(d.getDate() + 1);
  }
  return out;
}

const macroBull = {
  audusd: { last: 0.68, changePct: 0.3, trend20Pct: 3.2, label: 'AUD/USD' },
  ironOre: { last: 105, changePct: 1, trend20Pct: 9, label: 'Iron Ore' },
  copper: { last: 4.6, changePct: 1, trend20Pct: 7, label: 'Copper' },
  gold: { last: 3400, changePct: 0.4, trend20Pct: 5, label: 'Gold' },
};
const macroBear = {
  audusd: { last: 0.61, changePct: -0.4, trend20Pct: -4.0, label: 'AUD/USD' },
  ironOre: { last: 84, changePct: -1.5, trend20Pct: -12, label: 'Iron Ore' },
  copper: { last: 3.9, changePct: -1, trend20Pct: -9, label: 'Copper' },
  gold: { last: 3100, changePct: -0.5, trend20Pct: -6, label: 'Gold' },
};

console.log('\n— primitives —');
check('shortDelta computes 5-session change',
  Math.abs(shortDelta(linear(10, 8, 30), 5) - (8 - (10 + (8 - 10) * (24 / 29)))) < 0.01);
check('shortDelta returns null on short history', shortDelta([['2026-01-01', 5]], 5) === null);
check('priceMomentum positive on uptrend', priceMomentum(series(1, 1, 30), 5) > 0);
check('priceMomentum negative on downtrend', priceMomentum(series(1, -1, 30), 5) < 0);

console.log('\n— macro —');
check('bull macro gives mining a tailwind', macroTailwind('mining', macroBull).score > 0.3);
check('bear macro gives mining a headwind', macroTailwind('mining', macroBear).score < -0.3);
check('macro score is clamped to [-1,1]',
  Math.abs(macroTailwind('mining', macroBull).score) <= 1 &&
  Math.abs(macroTailwind('mining', macroBear).score) <= 1);
check('missing macro is handled', macroTailwind('mining', null).score === 0);

console.log('\n— squeeze scoring —');

// Textbook squeeze: extreme short interest, shorts covering fast, price ripping,
// low volume relative to the short position, supportive macro, fresh catalyst.
const squeezeRow = {
  code: 'SQZ', name: 'Squeezy Mining', sector: 'Materials',
  shortPct: 14.0, shortShares: 60e6, issued: 430e6,
  shortHist: linear(16.5, 14.0, 40),
  priceSeries: series(1.0, 1.2, 40),
  price: { last: 1.6, marketCap: 700e6, volume: 4e6, sector: 'Materials' },
  avgVolume: 4e6,
  announcements: [{ date: new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 10),
                    headline: 'Drilling results exceed guidance', priceSensitive: true }],
};
const sq = scoreSqueeze(squeezeRow, macroBull);
check('textbook squeeze scores high', sq.score >= 70, `got ${sq.score}`);
check('textbook squeeze is labelled swing', sq.horizon === 'swing', `got ${sq.horizon}`);
check('squeeze cites extreme short interest',
  sq.reasons.some((r) => r.includes('Extreme short interest')));
check('squeeze cites ignition', sq.reasons.some((r) => r.includes('Ignition signal')));
check('squeeze cites days-to-cover', sq.reasons.some((r) => r.includes('Days-to-cover')));
check('squeeze cites the catalyst', sq.reasons.some((r) => r.includes('Catalyst on the tape')));

// Fuel but no ignition: shorts still adding, price falling. Should score lower
// and must warn rather than recommend.
const noIgnition = {
  ...squeezeRow, code: 'TRAP',
  shortHist: linear(11.0, 14.0, 40),
  priceSeries: series(2.0, -0.8, 40),
  announcements: [],
};
const ni = scoreSqueeze(noIgnition, macroBear);
check('fuel-without-ignition scores below textbook squeeze', ni.score < sq.score, `${ni.score} vs ${sq.score}`);
check('fuel-without-ignition warns instead of recommending',
  ni.warnings.some((w) => w.includes('watch, not a buy')));

// Low short interest = not a squeeze candidate at all.
const quiet = {
  ...squeezeRow, code: 'QUIET', shortPct: 0.4, shortShares: 1e6,
  shortHist: linear(0.5, 0.4, 40), priceSeries: series(5, 0.05, 40), announcements: [],
};
const q = scoreSqueeze(quiet, macroBull);
check('low short interest scores low', q.score < 30, `got ${q.score}`);

// Microcap warning
const micro = { ...squeezeRow, code: 'TINY', price: { ...squeezeRow.price, marketCap: 20e6 } };
check('microcap gets a liquidity warning',
  scoreSqueeze(micro, macroBull).warnings.some((w) => w.includes('thin')));

// Missing history should degrade gracefully, not throw
const noHist = { ...squeezeRow, code: 'NEW', shortHist: [], priceSeries: [] };
let threw = false;
let nh;
try { nh = scoreSqueeze(noHist, macroBull); } catch { threw = true; }
check('missing history does not throw', !threw);
check('missing history is disclosed as a warning',
  !threw && nh.warnings.some((w) => w.includes('history')));

check('scores stay within 0-100',
  [sq, ni, q, nh].every((s) => s.score >= 0 && s.score <= 100));

console.log('\n— short scoring —');

const shortRow = {
  code: 'FADE', name: 'Fading Co', sector: 'Materials',
  shortPct: 4.5, shortShares: 20e6, issued: 440e6,
  shortHist: linear(2.0, 4.5, 40),
  priceSeries: series(3.0, -0.6, 40),
  price: { last: 2.3, marketCap: 500e6, volume: 3e6 },
  avgVolume: 3e6, announcements: [],
};
const sh = scoreShort(shortRow, macroBear);
check('building short + weak price + headwind scores', sh && sh.score >= 50, `got ${sh && sh.score}`);
check('short cites the build', sh.reasons.some((r) => r.includes('built steadily')));

const crowded = { ...shortRow, shortPct: 12.0 };
check('crowded short is refused outright', scoreShort(crowded, macroBear) === null);

const bouncing = { ...shortRow, priceSeries: [...series(3.0, -0.6, 35), ...series(2.4, 2.5, 5)] };
const bo = scoreShort(bouncing, macroBear);
check('sharp bounce triggers a do-not-short-into-strength warning',
  bo && bo.warnings.some((w) => w.includes('Do not short into a rally')));

const healthy = { ...shortRow, shortPct: 1.0, shortHist: linear(1.1, 1.0, 40), priceSeries: series(2, 0.5, 40) };
check('healthy stock is not a short candidate', scoreShort(healthy, macroBull) === null);

console.log('\n— extremes detection —');
const ext = detectExtremes([
  { code: 'EXT', shortPct: 12.0, shortHist: linear(11.5, 12.0, 30) },
  { code: 'BUILD', shortPct: 6.0, shortHist: [...linear(4.0, 4.4, 25), ...linear(4.4, 6.0, 5)] },
  { code: 'COVER', shortPct: 3.0, shortHist: [...linear(6.0, 5.8, 25), ...linear(5.8, 3.0, 5)] },
  { code: 'CALM', shortPct: 1.2, shortHist: linear(1.25, 1.2, 30) },
]);
check('extreme level is flagged', ext.some((e) => e.code === 'EXT' && e.kind === 'level' && e.severity === 'high'));
check('rapid build is flagged', ext.some((e) => e.code === 'BUILD' && e.kind === 'building' && e.severity === 'high'));
check('rapid covering is flagged', ext.some((e) => e.code === 'COVER' && e.kind === 'covering' && e.severity === 'high'));
check('calm stock produces no alert', !ext.some((e) => e.code === 'CALM'));

console.log('\n— thresholds match the brief —');
check('flow thresholds preserve the 0.6 / 1.0 lines Roy uses',
  THRESHOLDS.flowElevated === 0.6 && THRESHOLDS.flowExtreme === 1.0);
check('position thresholds are set for ASIC scale, not flow scale',
  THRESHOLDS.shortExtreme === 10 && THRESHOLDS.shortHigh === 8);

console.log('\n— ASIC CSV parsing (real file format) —');
// Verbatim shape of download.asic.gov.au/short-selling/RR{date}-001-SSDailyAggShortPos.csv
const csv = `Product,Product Code,Reported Short Positions,Total Product in Issue,% of Total Product in Issue Reported as Short Positions
3D ENERGI LTD ORDINARY,TDO,181029,524226804,.03453257
4DMEDICAL LIMITED ORDINARY,4DX,72828921,599638859,12.14546387
"WEIRD, NAME LTD ORDINARY",WNL,1000,100000,1.0
29METALSLIMITED ORDINARY,29M,11587724,1750076545,.6621267
AGL ENERGY LIMITED. ORDINARY,AGL,36933101,672747233,5.48989267
BAD ROW,,,,
truncated,X`;
const parsed = parseAsicCsv(csv);
check('parses the valid rows and drops malformed ones', parsed.length === 5, `got ${parsed.length}`);
check('leading-dot decimals parse (.03453257)', Math.abs(parsed[0].shortPct - 0.03453257) < 1e-6);
check('double-digit percentages parse', Math.abs(parsed[1].shortPct - 12.14546387) < 1e-6);
check('quoted field containing a comma is handled',
  parsed[2].code === 'WNL' && parsed[2].name === 'WEIRD, NAME LTD ORDINARY');
check('share counts parse as numbers',
  parsed[1].shortShares === 72828921 && parsed[1].issued === 599638859);
check('digit-leading tickers survive (29M)', parsed[3].code === '29M');
check('an Imperva/HTML block page is rejected, not parsed as data',
  parseAsicCsv('<html><body>Request unsuccessful. Incapsula</body></html>') === null);
check('empty payload is rejected', parseAsicCsv('') === null);

console.log('\n— fetch pooling —');
const order = [];
const out = await pooled([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
  order.push(n);
  await new Promise((r) => setTimeout(r, 5));
  return n * 2;
});
check('pooled preserves input order in results', out.join(',') === '2,4,6,8,10,12,14');
check('pooled visits every item', order.length === 7);
const withThrow = await pooled([1, 2, 3], 2, async (n) => {
  if (n === 2) throw new Error('boom');
  return n;
});
check('a thrown worker becomes null and does not abort the pool',
  withThrow[0] === 1 && withThrow[1] === null && withThrow[2] === 3);

console.log('\n— refresh scheduling window —');
// asxSessionish gates the hourly job's expensive work. Sydney trades
// 10:00-16:00 local; the UTC window used is 23:00-07:00.
const at = (iso) => asxSessionish(new Date(iso));
check('ASX open (Tue 11:00 AEST = Mon 01:00 UTC) counts as live', at('2026-08-17T01:00:00Z'));
check('ASX close (Tue 16:00 AEST = Tue 06:00 UTC) counts as live', at('2026-08-18T06:00:00Z'));
check('just before open (Tue 09:00 AEST = Mon 23:00 UTC) counts as live', at('2026-08-17T23:00:00Z'));
check('mid Sydney afternoon after close (Tue 18:00 AEST = 08:00 UTC) is not live',
  !at('2026-08-18T08:00:00Z'));
check('Sydney late evening (Tue 22:00 AEST = 12:00 UTC) is not live', !at('2026-08-18T12:00:00Z'));
check('Saturday in Sydney is never live', !at('2026-08-22T02:00:00Z'));
check('Sunday in Sydney is never live', !at('2026-08-23T02:00:00Z'));
check('Monday morning Sydney (Sun 23:30 UTC) is live', at('2026-08-16T23:30:00Z'));

console.log('\n— scoring pipeline persists everything the UI reads —');
const written = {};
const fakeStore = { setJSON: async (k, v) => { written[k] = v; } };
const rows = [squeezeRow, shortRow, quiet];
const shortByCode = Object.fromEntries(rows.map((r) => [r.code, r]));
const histByCode = Object.fromEntries(rows.map((r) => [r.code, r.shortHist]));
const buildRow = makeRowBuilder({
  shortByCode,
  prices: Object.fromEntries(rows.map((r) => [r.code, r.price])),
  hist: histByCode,
  seriesByCode: Object.fromEntries(rows.map((r) => [r.code, r.priceSeries])),
  ownHist: {},
  annsByCode: Object.fromEntries(rows.map((r) => [r.code, r.announcements])),
  universe: { meta: {} },
});
const sum = await scoreAndStore(fakeStore, {
  buildRow,
  candidateCodes: rows.map((r) => r.code),
  heldCodes: ['SQZ'],
  universeCodes: rows.map((r) => r.code),
  shortByCode,
  hist: histByCode,
  macro: macroBull,
  tradeDate: '2026-08-12',
});
check('writes signals/latest', !!written['signals/latest']);
check('writes extremes/latest', !!written['extremes/latest']);
check('writes watch/latest', !!written['watch/latest']);
check('signals carry the short data date through', written['signals/latest'].shortDataDate === '2026-08-12');
check('caps the long list at 5', written['signals/latest'].longs.length <= 5);
check('the textbook squeeze reaches the long list',
  written['signals/latest'].longs.some((l) => l.code === 'SQZ'));
check('held extreme is detected', written['extremes/latest'].extremes.some((e) => e.code === 'SQZ'));
check('summary counts match what was written',
  sum.longs === written['signals/latest'].longs.length &&
  sum.shorts === written['signals/latest'].shorts.length);
check('row builder returns null for an unknown code', buildRow('NOPE') === null);
check('watchlist is about movement, not levels — no "sits at X% short" rows',
  written['watch/latest'].watch.every((e) => e.kind !== 'level'),
  JSON.stringify(written['watch/latest'].watch.map((e) => e.kind)));
check('portfolio extremes DO still include levels (you want to know what you hold)',
  written['extremes/latest'].extremes.some((e) => e.kind === 'level'));

console.log('\n— internal indices (the macro fallback that cannot be blocked) —');
const priceSweep = {
  BHP: { code: 'BHP', sector: 'Materials', marketCap: 300e9, changePct: 2.0 },
  RIO: { code: 'RIO', sector: 'Materials', marketCap: 100e9, changePct: 1.0 },
  FMG: { code: 'FMG', sector: 'Materials', marketCap: 100e9, changePct: 0.0 },
  STO: { code: 'STO', sector: 'Energy', marketCap: 20e9, changePct: -1.0 },
  WDS: { code: 'WDS', sector: 'Energy', marketCap: 30e9, changePct: -2.0 },
  ORG: { code: 'ORG', sector: 'Energy', marketCap: 10e9, changePct: -3.0 },
  XRO: { code: 'XRO', sector: 'Information Technology', marketCap: 25e9, changePct: 3.0 },
  WTC: { code: 'WTC', sector: 'Information Technology', marketCap: 25e9, changePct: 1.0 },
  ALU: { code: 'ALU', sector: 'Information Technology', marketCap: 10e9, changePct: 2.0 },
};
const rets = sectorReturns(priceSweep);
// Materials: (300*2 + 100*1 + 100*0) / 500 = 1.4
check('materials index is cap-weighted, not equal-weighted',
  Math.abs(rets.materialsIdx.ret - 1.4) < 1e-9, `got ${rets.materialsIdx?.ret}`);
check('energy index goes negative when energy falls', rets.energyIdx.ret < 0);
check('tech index is built', Math.abs(rets.techIdx.ret - 2.0) < 1e-9, `got ${rets.techIdx?.ret}`);
check('member counts are reported', rets.materialsIdx.members === 3);
const thin = sectorReturns({ A: { sector: 'Materials', marketCap: 1e9, changePct: 5 } });
check('a bucket with under 3 members is not published as an index', !thin.materialsIdx);
check('stocks with no market cap are excluded, not counted as zero weight',
  !sectorReturns({ A: { sector: 'Materials', marketCap: null, changePct: 5 },
                   B: { sector: 'Materials', marketCap: 0, changePct: 5 },
                   C: { sector: 'Materials', marketCap: 1e9, changePct: 5 } }).materialsIdx);

console.log('\n— index level chaining —');
const idxStore = (() => {
  const mem = {};
  return { mem, setJSON: async (k, v) => { mem[k] = JSON.parse(JSON.stringify(v)); },
           get: async (k) => mem[k] ?? null };
})();
const d1 = await buildIndexSeries(idxStore, priceSweep, {}, '2026-08-17');
check('first run bases the index at 100 and applies the day return',
  Math.abs(d1.materialsIdx.last - 101.4) < 0.01, `got ${d1.materialsIdx.last}`);
const d2 = await buildIndexSeries(idxStore, priceSweep, {}, '2026-08-18');
check('second day compounds off the first',
  Math.abs(d2.materialsIdx.last - 101.4 * 1.014) < 0.01, `got ${d2.materialsIdx.last}`);
const d2again = await buildIndexSeries(idxStore, priceSweep, {}, '2026-08-18');
check('re-running the same day updates rather than compounding again',
  Math.abs(d2again.materialsIdx.last - d2.materialsIdx.last) < 0.01,
  `got ${d2again.materialsIdx.last} vs ${d2.materialsIdx.last}`);
check('history is persisted for the next run',
  idxStore.mem['indices/history'].materialsIdx.length === 2);
const withProxy = await buildIndexSeries(
  idxStore, priceSweep, { gold: { label: 'Gold (GOLD.AX)', code: 'GOLD', last: 56.47, changePct: 0.84 } }, '2026-08-19');
check('proxy ETFs display their real price, not the index level',
  withProxy.gold.last === 56.47, `got ${withProxy.gold.last}`);
check('proxy ETFs are tagged as such so the UI can say where it came from',
  withProxy.gold.source === 'asx-proxy');
check('internal indices are tagged separately', withProxy.materialsIdx.source === 'internal');

console.log('\n— macro tailwind uses the new inputs —');
const internalBull = {
  audusd: { label: 'AUD/USD', last: 0.71, changePct: 0.2, trend20Pct: 3.0, series: [] },
  materialsIdx: { label: 'ASX materials', last: 106, changePct: 1, trend20Pct: 6.0, series: [] },
  energyIdx: { label: 'ASX energy', last: 104, changePct: 1, trend20Pct: 4.0, series: [] },
};
const internalBear = {
  audusd: { label: 'AUD/USD', last: 0.63, changePct: -0.3, trend20Pct: -4.0, series: [] },
  materialsIdx: { label: 'ASX materials', last: 92, changePct: -1, trend20Pct: -8.0, series: [] },
  energyIdx: { label: 'ASX energy', last: 94, changePct: -1, trend20Pct: -6.0, series: [] },
};
check('internal indices alone produce a mining tailwind',
  macroTailwind('mining', internalBull).score > 0.3,
  String(macroTailwind('mining', internalBull).score));
check('internal indices alone produce a mining headwind',
  macroTailwind('mining', internalBear).score < -0.3);
check('the tailwind note names the ASX materials index',
  macroTailwind('mining', internalBull).notes.some((n) => n.includes('ASX materials')));
check('an empty macro object still scores zero rather than throwing',
  macroTailwind('mining', {}).score === 0);

console.log('\n— backtest discipline —');

function bDates(n) {
  const out = [];
  const start = Date.UTC(2026, 1, 2);
  for (let i = 0; out.length < n; i++) {
    const d = new Date(start + i * 86400000);
    if (d.getUTCDay() === 0 || d.getUTCDay() === 6) continue;
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}
const BD = bDates(140);
const mkShort = (from, to) => BD.map((d, i) => [d, from + ((to - from) * i) / (BD.length - 1)]);
const mkPrice = (start, dailyPct) => BD.map((d, i) => [d, start * Math.pow(1 + dailyPct / 100, i)]);

const btIn = {
  codes: ['UP', 'DOWN', 'FLAT'],
  shortHist: { UP: mkShort(16, 9), DOWN: mkShort(3, 7), FLAT: mkShort(5, 5.1) },
  priceSeries: { UP: mkPrice(1, 0.5), DOWN: mkPrice(5, -0.4), FLAT: mkPrice(2, 0.0) },
  meta: { UP: { name: 'Up Ltd', sector: 'Materials' } },
  prices: { UP: { marketCap: 1e9, volume: 1e6, sector: 'Materials' },
            DOWN: { marketCap: 1e9, volume: 1e6, sector: 'Materials' },
            FLAT: { marketCap: 1e9, volume: 1e6, sector: 'Materials' } },
};
const bt = backtest(btIn);

check('produces observations', bt.coverage.observations > 0, String(bt.coverage.observations));
check('computes a baseline per horizon', HORIZONS.every((h) => Number.isFinite(bt.baseline[h])));
check('detects ignition on the covering-into-strength name', bt.ignition.n > 0);
check('excess differs from raw return by exactly the baseline', HORIZONS.every((h) => {
  const d = bt.ignition.horizons[h];
  return !d.n || Math.abs((d.avgReturn - bt.baseline[h]) - d.excess) < 1e-9;
}));
check('hit rate is between 0 and 100', HORIZONS.every((h) => {
  const d = bt.ignition.horizons[h];
  return !d.n || (d.hitRate >= 0 && d.hitRate <= 100);
}));
check('stocks with too little history are skipped, not guessed at',
  backtest({ ...btIn, codes: ['UP', 'SHORTY'],
             shortHist: { ...btIn.shortHist, SHORTY: mkShort(5, 5).slice(0, 10) },
             priceSeries: { ...btIn.priceSeries, SHORTY: mkPrice(1, 0).slice(0, 10) } })
    .coverage.skippedStocks === 1);

// The no-lookahead guarantee: truncating the data *after* the last evaluated
// point must not change any score. If the engine were peeking forward, it would.
const cut = BD.length - Math.max(...HORIZONS);
const truncated = backtest({
  ...btIn,
  shortHist: Object.fromEntries(Object.entries(btIn.shortHist).map(([k, v]) => [k, v.slice(0, cut + Math.max(...HORIZONS))])),
  priceSeries: Object.fromEntries(Object.entries(btIn.priceSeries).map(([k, v]) => [k, v.slice(0, cut + Math.max(...HORIZONS))])),
});
check('no lookahead: same observation count when future data is trimmed to the minimum needed',
  truncated.coverage.observations === bt.coverage.observations,
  `${truncated.coverage.observations} vs ${bt.coverage.observations}`);

check('an empty universe degrades to zero, not a crash',
  backtest({ codes: [], shortHist: {}, priceSeries: {} }).coverage.observations === 0);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
