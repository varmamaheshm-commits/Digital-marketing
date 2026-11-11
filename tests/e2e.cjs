/**
 * End-to-end check in a real browser (run: npm run build && node tests/e2e.cjs).
 * Walks the whole owner journey: set up the vault, add a product, let Autopilot
 * create videos, approve one, save it, lock and unlock. Output goes to test-output/.
 */
const { chromium } = require('playwright');
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, '..', 'test-output');
const PHOTOS = fs.existsSync(path.join(OUT, 'photos')) ? fs.readdirSync(path.join(OUT, 'photos')).map((f) => path.join(OUT, 'photos', f)) : [];
const PW = 'blue-Tiger-2026!';
const assert = (ok, msg) => { if (!ok) throw new Error('FAILED: ' + msg); console.log('  ok  ' + msg); };

(async () => {
  const server = spawn('npx', ['vite', 'preview', '--port', '4173', '--strictPort'], { cwd: path.join(__dirname, '..'), stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 2500));
  const browser = await chromium.launch();
  try {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 }, acceptDownloads: true });
    const page = await ctx.newPage();
    const external = [];
    const problems = [];
    page.on('request', (r) => { if (!r.url().startsWith('http://localhost:4173') && !r.url().startsWith('blob:') && !r.url().startsWith('data:')) external.push(r.url()); });
    page.on('console', (m) => { if (m.type() === 'error') problems.push(m.text()); });
    page.on('pageerror', (e) => problems.push(String(e)));

    await page.goto('http://localhost:4173/');
    await page.getByPlaceholder('e.g. Varma Naturals').fill('Glow Naturals');
    await page.locator('input[type=password]').nth(0).fill('weak');
    await page.locator('input[type=password]').nth(1).fill('weak');
    await page.getByRole('button', { name: 'Create secure workspace' }).click();
    assert(await page.getByRole('alert').isVisible(), 'weak password is refused');
    await page.locator('input[type=password]').nth(0).fill(PW);
    await page.locator('input[type=password]').nth(1).fill(PW);
    await page.getByRole('button', { name: 'Create secure workspace' }).click();
    const recovery = await page.getByTestId('recovery').innerText();
    assert(/^([A-Z2-9]{5}-){5}[A-Z2-9]{5}$/.test(recovery), 'recovery key is shown once');
    await page.getByRole('checkbox').check();
    await page.getByRole('button', { name: 'Open Marketing Studio' }).click();
    await page.screenshot({ path: path.join(OUT, '1-dashboard-empty.png') });

    // product
    await page.getByRole('button', { name: 'Products' }).click();
    await page.getByTestId('add-product').click();
    await page.getByTestId('p-name').fill('Glow Serum');
    await page.getByTestId('p-category').fill('skincare');
    await page.getByTestId('p-price').fill('499');
    await page.getByTestId('p-offer').fill('20% off this week');
    await page.getByTestId('p-desc').fill('A light vitamin C serum that brightens skin in two weeks.');
    await page.getByTestId('p-features').fill('Pure vitamin C\nNo parabens or sulphates\nDermatologist tested');
    if (PHOTOS.length) {
      await page.getByTestId('p-photos').setInputFiles(PHOTOS);
      await page.waitForFunction((n) => document.querySelectorAll('.photos .ph').length === n, PHOTOS.length);
    }
    await page.getByTestId('save-product').click();

    // lead
    await page.getByRole('button', { name: 'Leads' }).click();
    await page.getByTestId('add-lead').click();
    await page.getByTestId('l-name').fill('Asha Rao');
    await page.getByTestId('l-phone').fill('+91 98765 43210');
    await page.getByTestId('l-consent').check();
    await page.getByTestId('save-lead').click();

    // autopilot output
    await page.getByRole('button', { name: /Approvals/ }).click();
    await page.getByTestId('approve-message').first().waitFor();
    assert((await page.getByTestId('approve-post').count()) === 4, 'autopilot drafted 4 posts for approval');
    assert((await page.getByTestId('approve-message').count()) === 1, 'autopilot drafted a welcome message for the lead');
    console.log('  ..  waiting for videos to render');
    const t0 = Date.now();
    await page.waitForFunction(() => /Videos \(2\)/.test(document.body.innerText) && !/still being created/.test(document.body.innerText), null, { timeout: 600000 });
    console.log(`  ok  2 videos rendered in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
    await page.screenshot({ path: path.join(OUT, '2-approvals.png'), fullPage: true });

    // review + approve + save each video
    for (let i = 0; i < 2; i++) {
      await page.getByRole('button', { name: 'Review' }).first().click();
      await page.getByTestId('player').waitFor();
      assert((await page.getByTestId('download-video').count()) === 0, 'saving is locked before approval');
      if (i === 0) await page.screenshot({ path: path.join(OUT, '3-review.png') });
      await page.getByTestId('approve-video').click();
      const [dl] = await Promise.all([page.waitForEvent('download'), page.getByTestId('download-video').click()]);
      const file = path.join(OUT, dl.suggestedFilename());
      await dl.saveAs(file);
      const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file]).toString());
      const v = probe.streams.find((s) => s.codec_type === 'video');
      const a = probe.streams.find((s) => s.codec_type === 'audio');
      console.log(`      ${path.basename(file)}: ${v.codec_name} ${v.width}x${v.height} ${v.r_frame_rate}, audio ${a ? a.codec_name : 'none'}, ${Number(probe.format.duration).toFixed(1)}s, ${(probe.format.size / 1e6).toFixed(1)} MB`);
      assert(v && Math.max(v.width, v.height) === 1920 && Math.min(v.width, v.height) === 1080, 'saved file is a full-HD video');
      assert(Number(probe.format.duration) > 10, 'video has full length');
      await page.getByRole('button', { name: 'Close' }).click();
    }

    // approvals: text
    await page.getByTestId('approve-message').click();
    await page.getByTestId('approve-post').first().click();
    await page.getByRole('button', { name: 'Dashboard' }).click();
    await page.screenshot({ path: path.join(OUT, '4-dashboard.png'), fullPage: true });
    for (const [name, file] of [['Videos', '5-videos'], ['Content', '6-content'], ['Leads', '7-leads'], ['Campaigns', '8-campaigns'], ['Settings', '9-settings']]) {
      await page.getByRole('button', { name, exact: true }).click();
      await page.screenshot({ path: path.join(OUT, file + '.png'), fullPage: true });
    }

    // data at rest is ciphertext
    const leak = await page.evaluate(async () => {
      const db = await new Promise((res) => { const r = indexedDB.open('marketing-studio'); r.onsuccess = () => res(r.result); });
      const all = await new Promise((res) => { const r = db.transaction('records').objectStore('records').getAll(); r.onsuccess = () => res(r.result); });
      const text = all.map((x) => new TextDecoder().decode(x.ct)).join('');
      return { n: all.length, leak: /Asha|98765|Glow/.test(text) };
    });
    assert(leak.n > 5 && !leak.leak, `${leak.n} stored records are encrypted (no readable names or numbers)`);

    // lock / unlock
    await page.getByRole('button', { name: 'Lock', exact: true }).click();
    await page.locator('input[type=password]').fill('wrong-password-1');
    await page.getByRole('button', { name: 'Unlock' }).click();
    assert(/Wrong password/.test(await page.getByRole('alert').innerText()), 'wrong password is rejected');
    await page.screenshot({ path: path.join(OUT, '10-lock.png') });
    await page.locator('input[type=password]').fill(PW);
    await page.getByRole('button', { name: 'Unlock' }).click();
    await page.getByRole('button', { name: 'Leads' }).click();
    assert(await page.getByText('Asha Rao').isVisible(), 'data is back after unlocking');

    // phone layout
    const phone = await ctx.newPage();
    await phone.setViewportSize({ width: 390, height: 800 });
    await phone.goto('http://localhost:4173/');
    await phone.locator('input[type=password]').fill(PW);
    await phone.getByRole('button', { name: 'Unlock' }).click();
    await phone.getByRole('button', { name: /Approvals/ }).click();
    await phone.waitForTimeout(500);
    await phone.screenshot({ path: path.join(OUT, '11-phone.png') });
    assert(await phone.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'phone layout has no sideways scrolling');

    assert(external.length === 0, 'the app made no requests to any outside server');
    assert(problems.length === 0, 'no errors in the browser console' + (problems.length ? ': ' + problems.join(' | ') : ''));
    console.log('\nALL CHECKS PASSED');
  } finally {
    await browser.close();
    server.kill();
  }
})().catch((e) => { console.error(e.message || e); process.exit(1); });
