# ASX Short & Squeeze Dashboard

Finds short-squeeze setups on the ASX 300, weighted toward mining, with
semiconductor and AI names as a secondary bucket.

**Start here: [SETUP.md](SETUP.md)** — 20 minutes in a browser, no command line.

Runs entirely on GitHub: Actions fetches and scores the data on a schedule,
Pages serves the dashboard. No server, no database, no dependencies, nothing to
keep awake, nothing to pay for.

```
GitHub Actions (cron)  →  scripts/build.mjs  →  data/ + docs/data.json  →  GitHub Pages
```

---

## What the data actually is

This matters more than anything else here, because two very different numbers
both get called "short selling".

| | ASIC aggregate short positions | ASX daily short sales |
|---|---|---|
| Measures | **Open** short interest — shares currently held short | **Flow** — shares sold short in one session |
| As % of | Issued capital | Issued capital |
| Typical range | 0–16% | 0–1.5% |
| Delay | T+4 trading days | T+1 |
| Used here | **Yes, primary** | No — the source is behind bot protection |
| Extreme tier | > 10% | > 1.0% |

The 0.6 / 1.0 thresholds most people quote are **flow** thresholds. They don't
apply to ASIC position data, where those values are unremarkable. They're
preserved in `lib/signals.mjs` as `THRESHOLDS.flowElevated` / `flowExtreme` in
case the ASX file becomes reachable again.

**Neither number is live, and no live version exists.** Australian short data is
published daily, full stop. This tool is built to find setups, not to time
entries — do the timing on a live order book.

---

## Sources

| Source | What | Delay |
|---|---|---|
| `download.asic.gov.au/short-selling/RR{YYYYMMDD}-001-SSDailyAggShortPos.csv` | Open short positions, every listed stock | T+4 |
| `asx.api.markitdigital.com/asx-research/1.0/companies/{code}/header` | Price, bid/ask, volume, market cap, sector | ~20 min |
| `…/companies/{code}/announcements` | Announcements + price-sensitive flag | near-live |
| `api.frankfurter.dev` | AUD/USD, ECB reference rates, with real history | daily |
| `stooq.com/q/d/l/?s={code}.au&i=d` | Per-stock daily closes — fallback when Yahoo refuses | daily |
| `…/companies/{GOLD,SEMI,IOZ,OOO}/header` | Macro proxies as ASX-listed ETFs | ~20 min |
| *(computed, no request)* | Cap-weighted ASX 300 / materials / energy / tech indices | ~20 min |

The ASIC fetcher walks back up to 14 days and tries sequence suffixes `001`,
`002`, `003`, `010`, because ASIC's filenames aren't perfectly consistent.

**Yahoo Finance is deliberately not in the critical path.** It was the original
macro and price-history source and it failed on every symbol in production,
because it refuses datacenter IPs. The macro tier was rebuilt on sources that
answer: ECB rates for FX, ASX-listed ETFs through the same endpoint that already
serves every stock price, and cap-weighted sector indices computed from data
already in hand. That last tier costs zero requests and cannot be blocked.

For per-stock daily history the build tries Yahoo first and falls back to Stooq,
then to the closes it has accumulated itself. GitHub Actions runs on Azure rather
than AWS, so Yahoo may well answer here even though it refused from Netlify — and
if it doesn't, the fallback covers it. The Data health tab names whichever source
actually answered, so this is never a guess.

Short history is backfilled 180 sessions from ASIC's archive on the first run,
so the short panel is readable immediately rather than filling in over months.

---

## Track record

`lib/backtest.mjs` replays the scoring engine over the stored history: at each
past date it scores using only data available up to that day, then measures what
the price did over the next 5, 10 and 20 sessions.

Two things make it worth reading rather than decorative:

- **Everything is reported as excess return** — the bucket's average minus the
  average of every stock over the same windows. In a rising market every signal
  looks clever until you subtract the market.
- **No lookahead**, enforced by a test: trimming future data to the minimum the
  measurement needs must not change a single score.

It deliberately does not tune the weights to fit its own results. With a few
months of one market regime that would fit noise and produce confident nonsense.
It measures the engine; it does not train it. Announcements aren't replayed (they
aren't stored historically) and macro is excluded, since feeding today's macro
into a past date would be cheating.

---

## Layout

```
.github/workflows/refresh.yml   the schedule and the commit step
scripts/build.mjs               the whole pipeline
lib/sources.mjs                 data adapters, CSV parser, fetch pooling
lib/signals.mjs                 scoring engine + thresholds
lib/pipeline.mjs                shared scoring/persist step, sector indices, session clock
lib/backtest.mjs                replays the engine over stored history
lib/filestore.mjs               JSON-on-disk store (same shape as Netlify Blobs)
docs/index.html                 the entire dashboard, single file, no CDN
docs/data.json                  generated; what the dashboard reads
data/                           generated state, committed so history survives
test/                           160 checks, no network required
```

Zero runtime dependencies. `package.json` exists only for the scripts.

---

## Running it locally

```bash
node scripts/build.mjs --mode=full     # fetches for real
npx serve docs                         # or any static file server
npm test                               # engine + pipeline + rendered UI
```

The test suite stubs the network entirely, including reproducing Yahoo's 429
block, so it runs anywhere and proves the fallbacks work.

---

## How the scoring works

**Squeeze score (long)** — weighted, 0–100:

- 34% **fuel** — open short interest, ramping 3% → 14% of issued capital
- 18% **days to cover** — short shares ÷ average volume, ramping 2 → 10 days
- 28% **ignition** — short interest *falling* while price *rises*. This is what
  separates a squeeze from a stock that is merely hated.
- 10% **macro** — AUD trend plus the sector complex
- 10% **catalyst** — a price-sensitive announcement in the last 10 days

Fuel without ignition returns a *warning*, not a recommendation: "the fuel is
there but nothing has lit it — this is a watch, not a buy."

**Short score** refuses outright to score anything already above 8% short
interest. Joining a crowded short is how you end up on the wrong side of the
squeeze you were looking for. Scores build (40%), price weakness (35%) and macro
headwind (25%), and warns on a sharp recent bounce.

Horizons: ignition- or catalyst-driven setups are tagged **swing**
(days–weeks); fuel-and-macro setups are tagged **position** (weeks–months).

---

## Notes on the charts

Price and short interest are two panels sharing one time axis, not one chart
with two y-scales. A dual axis lets you manufacture whatever correlation you
want by rescaling one side; two panels make the divergence real. The crosshair
is synchronised across both.

Palette validated for colour-blind separation against both the light and dark
surfaces.

---

## Sharing and privacy

The dashboard address is public — market data, signals and the watchlist are
visible to anyone you send it to. Nothing there is held back: the full universe
is in the tables and the picker, the complete ranked signal lists are one click
from the top five, and the watchlist is uncapped.

Holdings are the exception, deliberately. They live in browser `localStorage`,
are never committed, and the "extremes in your book" detection runs client-side
(`computeHeldExtremes`) for that reason.

To share the portfolio, **Copy share link** encodes the positions into the URL
fragment (`#h=…`). A fragment is never sent to a server and never stored, so the
recipient sees the full dashboard including the portfolio while the plain public
address still shows none. The alternative — committing holdings to the repo —
would put them in a public git history permanently, which is not undoable.
