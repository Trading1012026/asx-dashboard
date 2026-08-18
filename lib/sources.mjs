/**
 * Data source adapters for the ASX short-squeeze dashboard.
 *
 * Every function here runs inside a Netlify serverless/background function,
 * which has unrestricted outbound internet. Nothing here runs in the browser.
 *
 * Sources:
 *  - ASIC aggregate short positions  (daily, T+4)   download.asic.gov.au
 *  - ASX company prices / sector     (~20min delay) asx.api.markitdigital.com
 *  - ASX company announcements       (near-live)    asx.api.markitdigital.com
 *  - FX + commodities                (~15min delay) query1.finance.yahoo.com
 */

// A real ASIC report lists thousands of stocks. This guard exists to reject
// truncated files and bot-protection HTML pages, not to police the exact
// count, so it sits well below any plausible real value.
export const MIN_ASIC_ROWS = 20;

const ASX_TOKEN = '83ff96335c2d45a094df02a206a39ff4';
const ASX_API = 'https://asx.api.markitdigital.com/asx-research/1.0';

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

/* ------------------------------------------------------------------ *
 * small helpers
 * ------------------------------------------------------------------ */

export function ymd(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}`;
}

export function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

/**
 * Last failure reason per host, so the dashboard can say *why* a source is down
 * instead of just showing a red dot. Populated by safeFetch.
 */
export const lastError = {};

function noteError(url, reason) {
  try { lastError[new URL(url).host] = reason; } catch { lastError[url] = reason; }
}

/** Fetch with timeout + one retry. Returns null on failure rather than throwing. */
export async function safeFetch(url, opts = {}, timeoutMs = 15000, retries = 1) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        ...opts,
        signal: ctrl.signal,
        headers: { 'User-Agent': UA, Accept: '*/*', ...(opts.headers || {}) },
      });
      clearTimeout(timer);
      if (!res.ok) {
        noteError(url, `HTTP ${res.status}${res.status === 429 ? ' (rate limited / IP blocked)' : ''}`);
        if (res.status === 404) return null; // definitive, don't retry
        if (res.status === 401 || res.status === 403) return null; // blocked, retrying won't help
        if (attempt === retries) return null;
        continue;
      }
      return res;
    } catch (err) {
      clearTimeout(timer);
      noteError(url, err?.name === 'AbortError' ? `timeout after ${timeoutMs}ms` : String(err?.message || err));
      if (attempt === retries) return null;
    }
  }
  return null;
}

/** Run an async mapper over items with bounded concurrency. */
export async function pooled(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      try {
        results[i] = await worker(items[i], i);
      } catch {
        results[i] = null;
      }
    }
  });
  await Promise.all(runners);
  return results;
}

/** RFC4180-ish CSV line splitter (handles quoted fields containing commas). */
function splitCsvLine(line) {
  const out = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else { inQuotes = false; }
      } else cur += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

/* ------------------------------------------------------------------ *
 * 1. ASIC aggregate short positions  (the "squeeze fuel" number)
 * ------------------------------------------------------------------ */

/**
 * ASIC publishes one CSV per trade date at
 *   https://download.asic.gov.au/short-selling/RR{YYYYMMDD}-{NNN}-SSDailyAggShortPos.csv
 * The {NNN} sequence is usually 001 but occasionally 002/003/010.
 * Data is released T+4, so we walk backwards from `from` until we find one.
 *
 * @returns {Promise<{tradeDate:string, rows:Array}|null>}
 */
export function parseAsicCsv(text) {
  if (!text || !text.toLowerCase().includes('product code')) return null;
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const c = splitCsvLine(lines[i]);
    if (c.length < 5) continue;
    const code = (c[1] || '').toUpperCase();
    const pct = parseFloat(c[4]);
    if (!code || !Number.isFinite(pct)) continue;
    rows.push({
      code,
      name: c[0],
      shortShares: parseFloat(c[2]) || 0,
      issued: parseFloat(c[3]) || 0,
      shortPct: pct,
    });
  }
  return rows;
}

export async function fetchAsicShortPositions(from = new Date(), maxDaysBack = 14) {
  for (let back = 0; back < maxDaysBack; back++) {
    const d = new Date(from.getTime() - back * 86400000);
    const dow = d.getUTCDay();
    if (dow === 0 || dow === 6) continue; // no reports for weekends

    for (const seq of ['001', '002', '003', '010']) {
      const url =
        `https://download.asic.gov.au/short-selling/RR${ymd(d)}-${seq}-SSDailyAggShortPos.csv`;
      const res = await safeFetch(url, {}, 20000, 0);
      if (!res) continue;

      const text = await res.text();
      if (!text || !text.toLowerCase().includes('product code')) continue;

      const lines = text.split(/\r?\n/).filter((l) => l.trim());
      const rows = [];
      for (let i = 1; i < lines.length; i++) {
        const c = splitCsvLine(lines[i]);
        if (c.length < 5) continue;
        const code = (c[1] || '').toUpperCase();
        const pct = parseFloat(c[4]);
        if (!code || !Number.isFinite(pct)) continue;
        rows.push({
          code,
          name: c[0],
          shortShares: parseFloat(c[2]) || 0,
          issued: parseFloat(c[3]) || 0,
          shortPct: pct,
        });
      }
      if (rows.length >= MIN_ASIC_ROWS) {
        return { tradeDate: isoDate(d), sourceUrl: url, rows };
      }
    }
  }
  return null;
}

/**
 * Backfill short-interest history straight from ASIC's archive.
 *
 * Without this the short panel starts blank and takes months to become
 * readable, which makes the whole "is short interest building or unwinding"
 * question unanswerable on day one. ASIC keeps every daily file, so we can
 * simply go and get them.
 *
 * @param onDay called with ({ tradeDate, rows }) for each day found
 * @returns { days, missing }
 */
export async function backfillAsicHistory(days = 120, onDay, concurrency = 6) {
  const targets = [];
  const cursor = new Date();
  while (targets.length < days) {
    cursor.setUTCDate(cursor.getUTCDate() - 1);
    const dow = cursor.getUTCDay();
    if (dow === 0 || dow === 6) continue;
    targets.push(new Date(cursor));
    if (targets.length > 400) break; // hard stop, should never trigger
  }

  let found = 0, missing = 0;
  await pooled(targets, concurrency, async (d) => {
    for (const seq of ['001', '002', '003']) {
      const url =
        `https://download.asic.gov.au/short-selling/RR${ymd(d)}-${seq}-SSDailyAggShortPos.csv`;
      const res = await safeFetch(url, {}, 20000, 0);
      if (!res) continue;
      const text = await res.text();
      const rows = parseAsicCsv(text);
      if (rows && rows.length >= MIN_ASIC_ROWS) {
        found++;
        await onDay({ tradeDate: isoDate(d), rows });
        return;
      }
    }
    missing++;
  });

  return { days: found, missing };
}

/* ------------------------------------------------------------------ *
 * 2. ASX prices / sector / market cap
 * ------------------------------------------------------------------ */

export async function fetchAsxHeader(code) {
  const res = await safeFetch(
    `${ASX_API}/companies/${encodeURIComponent(code)}/header?access_token=${ASX_TOKEN}`,
    {}, 12000, 1,
  );
  if (!res) return null;
  let json;
  try { json = await res.json(); } catch { return null; }
  const d = json && json.data;
  if (!d || typeof d.priceLast !== 'number') return null;
  return {
    code: (d.symbol || code).toUpperCase(),
    name: d.displayName || '',
    last: d.priceLast,
    bid: d.priceBid ?? null,
    ask: d.priceAsk ?? null,
    change: d.priceChange ?? null,
    changePct: d.priceChangePercent ?? null,
    volume: d.volume ?? null,
    marketCap: d.marketCap ?? null,
    sector: d.sector || 'Unknown',
    industryGroup: d.industryGroup || '',
  };
}

/* ------------------------------------------------------------------ *
 * 3. ASX announcements (price-sensitive flag is the useful bit)
 * ------------------------------------------------------------------ */

export async function fetchAnnouncements(code, count = 8) {
  const res = await safeFetch(
    `${ASX_API}/companies/${encodeURIComponent(code)}/announcements` +
      `?count=${count}&access_token=${ASX_TOKEN}`,
    {}, 12000, 1,
  );
  if (!res) return [];
  let json;
  try { json = await res.json(); } catch { return []; }
  const items = (json && json.data && json.data.items) || [];
  return items.map((a) => ({
    date: (a.documentDate || a.releaseDate || '').slice(0, 10),
    headline: a.headline || a.title || '',
    type: a.announcementTypeName || a.type || '',
    priceSensitive: Boolean(a.isPriceSensitive ?? a.priceSensitive),
    url: a.url || a.documentUrl || null,
  }));
}

/* ------------------------------------------------------------------ *
 * 4. Macro: AUD/USD + commodities  ("AUD up = market up")
 * ------------------------------------------------------------------ */

/**
 * Macro proxies as ASX-listed ETFs.
 *
 * These are fetched through the same markitdigital endpoint that already
 * serves every stock price on the dashboard — a host we know answers from
 * Netlify. Yahoo, which was the original source, blocks datacenter IPs, so
 * every one of its symbols failed in production. An ASX-listed gold ETF is a
 * slightly noisier read on the gold price than the futures contract, but a
 * noisy number that arrives beats a precise one that never does.
 */
const MACRO_PROXIES = {
  gold: { code: 'GOLD', label: 'Gold (GOLD.AX)' },
  soxx: { code: 'SEMI', label: 'Semiconductors (SEMI.AX)' },
  asx200: { code: 'IOZ', label: 'ASX 200 (IOZ.AX)' },
  oil: { code: 'OOO', label: 'Crude Oil (OOO.AX)' },
};

// Yahoo is tried opportunistically for the things with no ASX proxy, but one
// failure trips a breaker so we don't burn a request per symbol on a host that
// has already refused us.
let yahooDead = false;

async function yahooSeries(symbol, range = '3mo') {
  if (yahooDead) return null;
  const url =
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}` +
    `?range=${range}&interval=1d`;
  const res = await safeFetch(url, {}, 12000, 0);
  if (!res) { yahooDead = true; return null; }
  let j;
  try { j = await res.json(); } catch { return null; }
  const r = j?.chart?.result?.[0];
  if (!r) return null;
  const ts = r.timestamp || [];
  const closes = r.indicators?.quote?.[0]?.close || [];
  const series = [];
  for (let i = 0; i < ts.length; i++) {
    if (typeof closes[i] === 'number') {
      series.push([new Date(ts[i] * 1000).toISOString().slice(0, 10), closes[i]]);
    }
  }
  if (!series.length) return null;
  const last = series[series.length - 1][1];
  const prev = series.length > 1 ? series[series.length - 2][1] : last;
  const ago20 = series.length > 20 ? series[series.length - 21][1] : series[0][1];
  return {
    last,
    changePct: prev ? ((last - prev) / prev) * 100 : 0,
    trend20Pct: ago20 ? ((last - ago20) / ago20) * 100 : 0,
    series,
  };
}

/* ------------------------------------------------------------------ *
 * 4a. AUD/USD from Frankfurter (ECB reference rates)
 *
 * Yahoo blocks datacenter IPs, which is exactly what a Netlify function runs
 * on. Frankfurter is a free, keyless, ECB-sourced FX API with no such block,
 * so the single most important macro series — the one Roy's whole "AUD up,
 * market up" rule rests on — no longer depends on a source that can refuse us.
 * ------------------------------------------------------------------ */

export async function fetchAudUsd(days = 120) {
  const end = new Date();
  const start = new Date(end.getTime() - days * 86400000);
  const url =
    `https://api.frankfurter.dev/v1/${isoDate(start)}..${isoDate(end)}` +
    `?base=AUD&symbols=USD`;
  const res = await safeFetch(url, {}, 12000, 1);
  if (!res) return null;
  let j;
  try { j = await res.json(); } catch { return null; }
  const rates = j && j.rates;
  if (!rates) return null;

  const series = Object.keys(rates).sort()
    .map((d) => [d, rates[d].USD])
    .filter((r) => Number.isFinite(r[1]));
  if (series.length < 2) return null;

  return withStats(series);
}

/** Turn an ascending [date, value] series into the shape the UI expects. */
export function withStats(series) {
  const last = series[series.length - 1][1];
  const prev = series.length > 1 ? series[series.length - 2][1] : last;
  const ago20 = series.length > 20 ? series[series.length - 21][1] : series[0][1];
  return {
    last,
    changePct: prev ? ((last - prev) / prev) * 100 : 0,
    trend20Pct: ago20 ? ((last - ago20) / ago20) * 100 : 0,
    series,
  };
}

/**
 * Assemble the macro picture.
 *
 * Tier 1 — AUD/USD from Frankfurter. Verified to work from a datacenter.
 * Tier 2 — commodities and indices from Yahoo. Nice to have; frequently
 *          blocked. Failure is recorded, not fatal.
 *
 * `internal` is the caller's own cap-weighted indices built from the price
 * sweep it already did (see buildInternalIndices). Those cannot fail, because
 * they involve no extra network call at all — they are the floor under this
 * whole function.
 */
/**
 * Fetch today's quote for each ASX macro proxy ETF. Returns
 * { key: { label, code, last, changePct } } — no history; the caller chains
 * these into a stored level series (see buildProxySeries in pipeline.mjs).
 */
export async function fetchMacroProxies() {
  const keys = Object.keys(MACRO_PROXIES);
  const got = await pooled(keys, 4, async (k) => {
    const h = await fetchAsxHeader(MACRO_PROXIES[k].code);
    if (!h || !Number.isFinite(h.last)) return null;
    return { key: k, label: MACRO_PROXIES[k].label, code: MACRO_PROXIES[k].code,
             last: h.last, changePct: h.changePct };
  });
  const out = {};
  for (const g of got) if (g) out[g.key] = g;
  return out;
}

/**
 * Assemble the macro picture from sources that actually answer.
 *
 * Tier 1 — AUD/USD from Frankfurter (ECB). Verified from a datacenter, and it
 *          arrives with real history immediately. This is the one Roy's whole
 *          "AUD up, market up" rule rests on, so it gets the reliable source.
 * Tier 2 — ASX-listed proxy ETFs via markitdigital, chained into level series
 *          by the caller.
 * Tier 3 — the caller's own cap-weighted sector indices, built from the price
 *          sweep it already did. Zero extra requests, cannot be blocked.
 *
 * Yahoo is no longer in the path. It failed on every symbol in production
 * because it refuses datacenter IPs.
 */
export async function fetchMacro(supplied = {}) {
  const out = {};
  const diag = {};

  const aud = await fetchAudUsd();
  if (aud) {
    out.audusd = { label: 'AUD/USD', source: 'frankfurter/ECB', ...aud };
    diag.audusd = `ok — frankfurter/ECB, ${aud.series.length} sessions of history`;
  } else {
    diag.audusd = `FAILED — ${lastError['api.frankfurter.dev'] || 'unknown'}`;
  }

  let proxies = 0, internal = 0;
  for (const [k, v] of Object.entries(supplied)) {
    if (!v) continue;
    out[k] = v;
    if (v.source === 'asx-proxy') proxies++; else internal++;
  }
  diag.proxies = proxies
    ? `ok — ${proxies} ASX proxy ETFs via markitdigital`
    : 'none (proxy ETFs unavailable)';
  diag.internal = internal
    ? `ok — ${internal} cap-weighted indices built from the price sweep, no extra requests`
    : 'not built (no price data yet)';

  return { macro: out, diag };
}

/**
 * Daily closes from Stooq's CSV download endpoint — the backup for per-stock
 * history. Format: Date,Open,High,Low,Close,Volume.
 *
 * Only used when the primary source fails, and only for the handful of stocks
 * the dashboard actually charts, so this stays a light, once-a-day request
 * rather than a crawl.
 */
export async function stooqSeries(code, days = 200) {
  const res = await safeFetch(
    `https://stooq.com/q/d/l/?s=${encodeURIComponent(code.toLowerCase())}.au&i=d`,
    {}, 15000, 0,
  );
  if (!res) return null;
  const text = await res.text();
  if (!text || !/^Date,/i.test(text.trim())) return null;

  const lines = text.trim().split(/\r?\n/);
  const out = [];
  for (let i = 1; i < lines.length; i++) {
    const c = lines[i].split(',');
    if (c.length < 5) continue;
    const date = c[0];
    const close = parseFloat(c[4]);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(close)) continue;
    out.push([date, close]);
  }
  if (out.length < 5) return null;
  return out.slice(-days);
}

/**
 * Per-stock daily closes. Tries Yahoo, then Stooq, and reports which answered
 * so the dashboard can say whether its price history is real or accumulating.
 *
 * @returns {Promise<{series: Array, source: string}|null>}
 */
export async function fetchStockHistory(code, range = '6mo') {
  const y = await yahooSeries(`${code}.AX`, range);
  if (y && y.series.length > 5) return { series: y.series, source: 'yahoo' };

  const s = await stooqSeries(code);
  if (s && s.length > 5) return { series: s, source: 'stooq' };

  return null;
}
