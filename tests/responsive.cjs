/**
 * Layout check on phone, tablet and PC sizes (run: npm run build && node tests/responsive.cjs).
 * Opens every page and every main dialog at each size and fails if anything is cut off
 * or scrolls sideways. Screenshots go to test-output/responsive/.
 */
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, '..', 'test-output', 'responsive');
fs.mkdirSync(OUT, { recursive: true });
const PW = 'blue-Tiger-2026!';
const SIZES = [['phone', 390, 800], ['tablet', 820, 1180], ['pc', 1280, 860]];
const PAGES = ['Dashboard', 'Approvals', 'Products', 'Videos', 'Content', 'Leads', 'Knowledge', 'Campaigns', 'Auto-post', 'Phone & automation', 'AI agents', 'Settings'];
// [page, button that opens the dialog]
const DIALOGS = [['Products', 'Add product'], ['Videos', 'Upload my video'], ['Videos', 'Create video'], ['Content', 'Write a post'], ['Leads', 'Add lead'], ['Knowledge', 'Add document'], ['Campaigns', 'New campaign'], ['Auto-post', 'Connect YouTube'], ['Auto-post', 'Connect Instagram + Facebook']];

(async () => {
  const server = spawn('npx', ['vite', 'preview', '--port', '4175', '--strictPort'], { cwd: path.join(__dirname, '..'), stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 2500));
  const browser = await chromium.launch();
  const problems = [];
  try {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => problems.push('script error: ' + e));
    await page.goto('http://localhost:4175/');
    await page.getByPlaceholder('e.g. Varma Naturals').fill('Sahasra Infinity Enterprises International');
    for (const i of [0, 1]) await page.locator('input[type=password]').nth(i).fill(PW);
    await page.getByRole('button', { name: 'Create secure workspace' }).click();
    await page.getByRole('checkbox').check();
    await page.getByRole('button', { name: 'Open Marketing Studio' }).click();
    await page.getByRole('checkbox', { name: 'Autopilot' }).uncheck();
    // some realistic, long content so wrapping is exercised
    await page.getByRole('button', { name: 'Products' }).click();
    await page.getByTestId('add-product').click();
    await page.getByTestId('p-name').fill('Organic Cold-Pressed Groundnut Oil 5 Litre Family Pack');
    await page.getByTestId('p-category').fill('cooking oil');
    await page.getByTestId('p-price').fill('1,499');
    await page.getByTestId('p-features').fill('Wood-pressed the traditional way\nNo chemicals or preservatives\nDelivered fresh across Telangana and Andhra Pradesh');
    await page.getByTestId('save-product').click();
    await page.getByRole('button', { name: 'Leads' }).click();
    await page.getByTestId('add-lead').click();
    await page.getByTestId('l-name').fill('Venkata Subrahmanyam Raghavendra Rao');
    await page.getByTestId('l-phone').fill('+91 98765 43210');
    await page.locator('.modal input').nth(2).fill('a.very.long.email.address.for.testing@example-company-name.co.in');
    await page.getByTestId('l-consent').check();
    await page.getByTestId('save-lead').click();
    await page.getByRole('button', { name: 'Content', exact: true }).click();
    await page.getByRole('button', { name: 'Write a post' }).click();
    await page.getByRole('button', { name: 'Write it' }).click();

    // on phone and tablet-portrait sizes, pages beyond the four main ones sit behind "More"
    const go = async (name) => {
      const btn = page.getByRole('button', { name, exact: true }).first();
      if (!(await btn.isVisible())) await page.getByRole('button', { name: 'More pages' }).click();
      await btn.click();
    };
    const check = async (label) => {
      const r = await page.evaluate(() => {
        const vw = window.innerWidth;
        const out = [];
        if (document.documentElement.scrollWidth > vw + 1) out.push(`page scrolls sideways (${document.documentElement.scrollWidth}px wide)`);
        const modal = document.querySelector('.modal');
        if (modal) {
          const b = modal.getBoundingClientRect();
          if (b.left < -1 || b.right > vw + 1) out.push('dialog is wider than the screen');
          if (modal.scrollWidth > modal.clientWidth + 1) out.push('dialog content scrolls sideways');
        }
        // anything visible that sticks out of the main area (tables may scroll inside their own wrapper)
        const main = document.querySelector('.modal') || document.querySelector('.main');
        if (main) for (const el of main.querySelectorAll('button, input, select, textarea, h1, h2, .card, .chip, .notice, code')) {
          if (el.closest('.table-wrap')) continue;
          const b = el.getBoundingClientRect();
          if (b.width > 0 && (b.right > vw + 1 || b.left < -1)) { out.push(`cut off: <${el.tagName.toLowerCase()}> "${(el.textContent || el.placeholder || '').trim().slice(0, 30)}"`); break; }
        }
        // buttons must be big enough to tap
        const small = [...document.querySelectorAll('.nav')].filter((n) => { const b = n.getBoundingClientRect(); return b.width > 0 && (b.height < 40 || b.width < 40); });
        if (small.length) out.push('navigation buttons too small to tap');
        return out;
      });
      r.forEach((p) => problems.push(`${label}: ${p}`));
    };

    for (const [size, w, h] of SIZES) {
      await page.setViewportSize({ width: w, height: h });
      for (const name of PAGES) {
        await go(name);
        await page.waitForTimeout(150);
        await check(`${size} / ${name}`);
        if (size !== 'pc') await page.screenshot({ path: path.join(OUT, `${size}-${name.replace(/\W+/g, '-').toLowerCase()}.png`) });
      }
      for (const [name, button] of DIALOGS) {
        await go(name);
        await page.getByRole('button', { name: button }).first().click();
        await page.locator('.modal').waitFor();
        await check(`${size} / ${name} / "${button}" dialog`);
        if (size === 'phone') await page.screenshot({ path: path.join(OUT, `${size}-dialog-${button.replace(/\W+/g, '-').toLowerCase()}.png`) });
        await page.getByRole('button', { name: 'Close' }).first().click();
        await page.locator('.modal').waitFor({ state: 'detached' });
      }
      console.log(`  checked ${size} (${w}×${h}): ${PAGES.length} pages, ${DIALOGS.length} dialogs`);
    }
    // phone navigation: four main buttons + More, nothing hidden off-screen, More lists the rest
    await page.setViewportSize({ width: 390, height: 800 });
    const bar = await page.evaluate(() => { const s = document.querySelector('.side'); return { sideways: s.scrollWidth > s.clientWidth + 1, visible: [...s.querySelectorAll('.nav')].filter((n) => n.getBoundingClientRect().width > 0).map((n) => n.textContent.replace(/\d+/g, '').trim()) }; });
    if (bar.sideways) problems.push('phone: navigation bar scrolls sideways');
    if (bar.visible.join(',') !== 'Dashboard,Approvals,Videos,Leads,More') problems.push('phone: unexpected bottom bar: ' + bar.visible.join(','));
    await page.getByRole('button', { name: 'More pages' }).click();
    const sheet = await page.evaluate(() => [...document.querySelectorAll('.side .nav.extra')].filter((n) => { const b = n.getBoundingClientRect(); return b.width > 0 && b.top >= 0 && b.bottom <= window.innerHeight; }).length);
    if (sheet !== 9) problems.push(`phone: More menu shows ${sheet} of 9 entries on screen`);
    await page.screenshot({ path: path.join(OUT, 'phone-more-menu.png') });
    console.log(`  phone navigation: ${bar.visible.join(' · ')}; More menu lists ${sheet} further entries`);
  } finally {
    await browser.close();
    server.kill();
  }
  if (problems.length) { console.log('\nPROBLEMS FOUND:\n' + [...new Set(problems)].map((p) => '  - ' + p).join('\n')); process.exit(1); }
  console.log('\nNO LAYOUT PROBLEMS FOUND');
})().catch((e) => { console.error(e.message || e); process.exit(1); });
