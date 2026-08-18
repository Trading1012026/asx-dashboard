/**
 * Renders docs/ exactly as GitHub Pages will serve it — a static directory,
 * no API — against the data.json produced by build.test.mjs. Verifies the
 * whole chain end to end and screenshots every tab in both themes.
 *
 * Run: node test/build.test.mjs && node test/render.test.mjs
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname } from 'node:path';
import pw from '/home/claude/.npm-global/lib/node_modules/playwright/index.js';

const { chromium } = pw;
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DOCS = join(ROOT, 'docs');
const PORT = 8931;
const TYPES = { '.html': 'text/html', '.json': 'application/json', '.css': 'text/css', '.js': 'text/javascript' };

const server = createServer(async (req, res) => {
  const path = new URL(req.url, 'http://x').pathname;
  const file = join(DOCS, path === '/' ? 'index.html' : path);
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404); res.end('not found');
  }
});
await new Promise((r) => server.listen(PORT, r));

let pass = 0, fail = 0;
const check = (n, c, extra = '') => {
  if (c) { pass++; console.log(`  ok   ${n}`); }
  else { fail++; console.log(`  FAIL ${n} ${extra}`); }
};

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--enable-blink-features=ClipboardAPI'],
});
const tabs = ['shorts', 'signals', 'portfolio', 'watch'];
const allErrors = [];

for (const theme of ['dark', 'light']) {
  const page = await browser.newPage({
    viewport: { width: 1400, height: 1100 }, deviceScaleFactor: 2,
    permissions: ['clipboard-read', 'clipboard-write'],
  });
  page.on('pageerror', (e) => allErrors.push(`[${theme}] pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') allErrors.push(`[${theme}] console: ${m.text()}`); });

  await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'networkidle' });
  if (theme === 'light') await page.click('#themeBtn');
  await page.waitForTimeout(600);

  if (theme === 'dark') {
    console.log('\n— dashboard loads from a static data.json —');
    const stamp = await page.textContent('#stamp');
    check('header shows the ASIC trade date', /Short data: \d{4}-\d{2}-\d{2}/.test(stamp), stamp);
    check('header states the refresh cadence', /Auto-refreshes daily/.test(stamp), stamp);
    check('macro strip rendered', (await page.locator('.macro-chip').count()) > 3);
    check('ranked short chart drew bars', (await page.locator('#rankChart rect[rx="4"]').count()) > 5);
    check('linked price/short chart drew paths', (await page.locator('#linkedChart path').count()) >= 2);

    await page.click('nav.tabs button[data-tab="signals"]');
    await page.waitForTimeout(300);
    check('signal cards rendered', (await page.locator('#longCards .card').count()) > 0);
    check('signals carry written arguments',
      (await page.locator('#longCards .card ul.reasons li').count()) > 3);

    console.log('\n— holdings live in the browser, not the repo —');
    await page.click('nav.tabs button[data-tab="portfolio"]');
    await page.waitForTimeout(300);
    check('empty state shown before any holdings are entered',
      /No positions saved yet/.test(await page.textContent('#pfTable')));

    await page.click('#editHoldings');
    await page.waitForTimeout(200);
    await page.fill('#editorRows .hc', 'BHP');
    await page.fill('#editorRows .hu', '300');
    await page.fill('#editorRows .ha', '41.20');
    await page.click('#saveHoldings');
    await page.waitForTimeout(400);

    const pf = await page.textContent('#pfTable');
    check('saved position appears in the table', /BHP/.test(pf), pf.slice(0, 120));
    check('P&L was computed against the live price', /%/.test(pf));
    const stored = await page.evaluate(() => localStorage.getItem('asx-dashboard-holdings-v1'));
    check('holdings persisted to localStorage', !!stored && /BHP/.test(stored));

    await page.reload({ waitUntil: 'networkidle' });
    await page.click('nav.tabs button[data-tab="portfolio"]');
    await page.waitForTimeout(500);
    check('holdings survive a page reload', /BHP/.test(await page.textContent('#pfTable')));

    const ext = await page.textContent('#pfExtremes');
    check('short-interest extremes computed in-browser for held stock',
      ext.length > 0);

    console.log('\n— share link —');
    // Drive the real button rather than calling the function, so this covers
    // the path Roy actually uses.
    await page.click('#editHoldings');
    await page.waitForTimeout(200);
    await page.click('#addRow');
    const rows = page.locator('#editorRows > div');
    await rows.nth(1).locator('.hc').fill('PLS');
    await rows.nth(1).locator('.hu').fill('4000');
    await rows.nth(1).locator('.ha').fill('2.85');
    await page.click('#saveHoldings');
    await page.waitForTimeout(300);
    await page.click('#editHoldings');
    await page.waitForTimeout(200);
    await page.click('#shareHoldings');
    await page.waitForTimeout(400);

    let shareUrl = await page.evaluate(async () => {
      try { return await navigator.clipboard.readText(); } catch { return null; }
    });
    if (!shareUrl) {
      shareUrl = await page.locator('#saveMsg textarea').inputValue().catch(() => null);
    }
    check('the share button produced a link', !!shareUrl && /#h=/.test(shareUrl),
      String(shareUrl).slice(0, 60));

    const frag = String(shareUrl).split('#')[1] || '';
    check('the link carries no ticker in plain text', !/BHP|PLS/.test(frag));

    const other = await browser.newPage({ viewport: { width: 1400, height: 1100 } });
    await other.goto(shareUrl, { waitUntil: 'networkidle' });
    await other.click('nav.tabs button[data-tab="portfolio"]');
    await other.waitForTimeout(500);
    const shared = await other.textContent('#pfTable');
    check('a fresh browser opening the link sees both positions',
      /BHP/.test(shared) && /PLS/.test(shared));
    check('the shared view says where the positions came from',
      /shared portfolio/i.test(shared));
    const leaked = await other.evaluate(() => localStorage.getItem('asx-dashboard-holdings-v1'));
    check("opening a share link does not write to the visitor's storage", leaked === null);

    await other.goto(`http://localhost:${PORT}/`, { waitUntil: 'networkidle' });
    await other.click('nav.tabs button[data-tab="portfolio"]');
    await other.waitForTimeout(400);
    check('the plain public address still shows no portfolio',
      /No positions saved yet/.test(await other.textContent('#pfTable')));
    await other.close();

    console.log('\n— nothing is silently truncated —');
    await page.click('nav.tabs button[data-tab="shorts"]');
    await page.waitForTimeout(300);
    const dataRows = await page.evaluate(() => window.__d?.shorts?.rows?.length ?? null);
    await page.click('#tableToggle2');
    await page.waitForTimeout(400);
    const tableRows = await page.locator('#rankTable tbody tr').count();
    check('the short table lists every stock in the universe',
      dataRows !== null && tableRows === dataRows, `table ${tableRows} vs data ${dataRows}`);
    const options = await page.locator('#stockPick option').count();
    check('every stock is selectable in the chart picker', options === dataRows,
      `${options} vs ${dataRows}`);
    await page.click('#tableToggle2');
    await page.waitForTimeout(200);

    await page.click('nav.tabs button[data-tab="watch"]');
    await page.waitForTimeout(300);
    check('data health table rendered', (await page.locator('#health table tr').count()) > 3);
    check('health explains the GitHub Actions schedule',
      /GitHub Actions/.test(await page.textContent('#health')));

    console.log('\n— track record panel —');
    const btText = await page.textContent('#backtest');
    check('track record table rendered', (await page.locator('#backtest table tr').count()) > 4);
    check('shows excess return, not raw', /excess/i.test(await page.textContent('#tab-watch')));
    check('states the market baseline', /Market baseline/i.test(btText), btText.slice(0, 120));
    check('is explicit that weights are not tuned to the results',
      /not.{0,6}tuned/i.test(btText));
    check('reports the ignition bucket', /Ignition/i.test(btText));
  }

  for (const t of tabs) {
    await page.click(`nav.tabs button[data-tab="${t}"]`);
    await page.waitForTimeout(400);
    await page.screenshot({ path: `/tmp/shots2/${theme}-${t}.png`, fullPage: true });
  }
  await page.close();
}

await browser.close();
server.close();

console.log('\n— console cleanliness —');
check('no page or console errors in either theme', allErrors.length === 0, allErrors.join(' | '));

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
