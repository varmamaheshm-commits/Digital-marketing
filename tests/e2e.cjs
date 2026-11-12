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

// Stand-in for the owner's local AI engine (Ollama-compatible) so the agents can be exercised.
const aiCalls = [];
const mockAi = require('http').createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') return res.end();
  if (req.url === '/api/tags') return res.end(JSON.stringify({ models: [{ name: 'local-model' }] }));
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    const prompt = JSON.parse(body).messages[1].content;
    aiCalls.push(prompt);
    const reply = prompt.includes('"hook"') ? { hook: 'Glow like never before', tagline: 'Brighter skin in two weeks', features: ['Real vitamin C', 'Gentle on skin', 'Tested by doctors'], offer_note: 'This week only', cta: 'Order today' }
      : prompt.includes('"answer"') ? { answer: 'You can return it within 7 days if the seal is unopened. — Glow Naturals' }
      : { title: 'AI title', body: 'AI written text about Glow Serum', hashtags: ['#Glow'], subject: 'Hello', line: 'Welcome to our lovely shop' };
    res.end(JSON.stringify({ message: { content: JSON.stringify(reply) } }));
  });
});

(async () => {
  await new Promise((r) => mockAi.listen(11434, '127.0.0.1', r));
  const server = spawn('npx', ['vite', 'preview', '--port', '4173', '--strictPort'], { cwd: path.join(__dirname, '..'), stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 2500));
  const browser = await chromium.launch();
  try {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 }, acceptDownloads: true });
    // Stand-in for the desktop app's publishing bridge, so the Publisher agent can be exercised in a browser.
    await ctx.addInitScript(() => {
      window.__published = [];
      window.desktop = {
        getBackground: async () => ({ enabled: false, tray: false }),
        setBackground: async (on) => ({ enabled: on, tray: true }),
        social: {
          connect: async () => ({ ok: true, account: { accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 3.6e6, name: 'Glow Naturals Channel', extra: {} } }),
          publish: async (target, account, job) => { window.__published.push({ target, bytes: job.video.byteLength, title: job.title }); return { ok: true, url: 'https://www.youtube.com/watch?v=test' }; },
        },
      };
    });
    const page = await ctx.newPage();
    const external = [];
    const problems = [];
    page.on('request', (r) => { if (!r.url().startsWith('http://localhost:4173') && !/^http:\/\/(127\.0\.0\.1|localhost):11434\//.test(r.url()) && !r.url().startsWith('blob:') && !r.url().startsWith('data:')) external.push(r.url()); });
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
    await page.getByText('still being created').waitFor();
    assert((await page.getByTestId('approve-post').count()) === 0 && (await page.getByTestId('approve-message').count()) === 0, 'only videos wait for approval (posts and messages are approved automatically)');
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

    // posts were drafted and approved automatically
    await page.getByRole('button', { name: 'Content', exact: true }).click();
    assert((await page.locator('.chip.approved').count()) === 4, 'autopilot drafted a week of 4 posts, already approved');

    // knowledge base
    await page.getByRole('button', { name: 'Knowledge', exact: true }).click();
    await page.getByTestId('add-doc').click();
    await page.getByTestId('doc-title').fill('Policies');
    await page.getByTestId('doc-text').fill('Returns are accepted within 7 days if the seal is unopened.\n\nDelivery takes 3 to 5 working days across India.');
    await page.getByTestId('save-doc').click();
    await page.getByTestId('kb-question').fill('What is your return policy?');
    assert(/within 7 days/.test(await page.getByTestId('kb-hit').first().innerText()), 'knowledge base answers a question from the owner\'s documents');
    await page.screenshot({ path: path.join(OUT, '13-knowledge.png') });

    // a Telugu video
    await page.getByRole('button', { name: 'Videos', exact: true }).click();
    await page.getByRole('button', { name: 'Create video' }).click();
    await page.getByTestId('v-lang').selectOption('te');
    await page.getByRole('button', { name: 'Create', exact: true }).click();
    await page.getByRole('button', { name: 'Review' }).waitFor({ timeout: 300000 });
    await page.getByRole('button', { name: 'Review' }).click();
    await page.getByTestId('approve-video').click();
    const [te] = await Promise.all([page.waitForEvent('download'), page.getByTestId('download-video').click()]);
    await te.saveAs(path.join(OUT, 'telugu.mp4'));
    await page.getByRole('button', { name: 'Close' }).click();
    console.log('  ok  Telugu video rendered');

    // AI agents with the local engine
    assert(aiCalls.length === 0, 'no AI request is made while AI agents are switched off');
    await page.getByRole('button', { name: 'AI agents', exact: true }).click();
    await page.getByTestId('ai-found').waitFor();
    await page.getByTestId('ai-enable').check();
    await page.getByRole('button', { name: 'Knowledge', exact: true }).click();
    await page.getByTestId('kb-question').fill('What is your return policy?');
    await page.getByTestId('kb-ai').click();
    await page.getByText('You can return it within 7 days if the seal is unopened. — Glow Naturals').waitFor();
    assert(aiCalls.at(-1).includes('Returns are accepted within 7 days'), 'knowledge assistant sends the retrieved passage to the local engine (RAG)');
    await page.getByRole('button', { name: 'Videos', exact: true }).click();
    await page.getByRole('button', { name: 'Create video' }).click();
    await page.locator('.modal select').nth(1).selectOption('square');
    await page.getByRole('button', { name: 'Create', exact: true }).click();
    await page.getByRole('button', { name: 'Review' }).waitFor({ timeout: 300000 });
    await page.getByRole('button', { name: 'Review' }).click();
    assert((await page.locator('.modal input').first().inputValue()) === 'Glow like never before', 'script writer agent wrote the video script, and the video still waits for approval');
    await page.getByRole('button', { name: 'Close' }).click();
    await page.getByRole('button', { name: 'AI agents', exact: true }).click();
    await page.screenshot({ path: path.join(OUT, '14-agents.png'), fullPage: true });

    // auto-posting (Publisher agent)
    await page.getByRole('button', { name: 'Auto-post', exact: true }).click();
    await page.getByTestId('cid-google').fill('my-client-id');
    await page.getByTestId('connect-google').click();
    await page.getByTestId('auto-youtube').check();
    await page.waitForTimeout(800);
    assert((await page.evaluate(() => window.__published.length)) === 0, 'videos approved before auto-post was switched on are not posted retroactively');
    await page.getByRole('button', { name: 'Videos', exact: true }).click();
    await page.getByRole('button', { name: 'Create video' }).click();
    await page.getByRole('button', { name: 'Create', exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('.chip.pending').length === 2, null, { timeout: 300000 });
    assert((await page.evaluate(() => window.__published.length)) === 0, 'nothing is posted while a video is still waiting for approval');
    await page.getByRole('button', { name: 'Review' }).first().click();
    await page.getByTestId('approve-video').click();
    await page.waitForFunction(() => window.__published.length === 1, null, { timeout: 30000 });
    const sent = await page.evaluate(() => window.__published[0]);
    assert(sent.target === 'youtube' && sent.bytes > 1e6 && /#Shorts$/.test(sent.title), 'approving a video posts it to YouTube automatically, with the full file');
    await page.getByRole('link', { name: 'YouTube ✓' }).waitFor();
    await page.getByRole('button', { name: 'Close' }).click();
    await page.getByRole('button', { name: 'Auto-post', exact: true }).click();
    assert((await page.getByTestId('pub-row').count()) === 1 && (await page.locator('.chip.published').count()) === 1, 'posting history shows the published video');
    await page.screenshot({ path: path.join(OUT, '15-autopost.png'), fullPage: true });
    const tokenLeak = await page.evaluate(async () => {
      const db = await new Promise((res) => { const r = indexedDB.open('marketing-studio'); r.onsuccess = () => res(r.result); });
      const all = await new Promise((res) => { const r = db.transaction('records').objectStore('records').getAll(); r.onsuccess = () => res(r.result); });
      return /my-client-id|Glow Naturals Channel/.test(all.map((x) => new TextDecoder().decode(x.ct)).join(''));
    });
    assert(!tokenLeak, 'platform access keys are stored encrypted');

    // screen lock keeps the agents alive
    await page.getByRole('button', { name: 'AI agents', exact: true }).click();
    await page.getByTestId('keep-working').check();
    await page.getByRole('button', { name: 'Lock', exact: true }).click();
    await page.getByText('Screen locked').waitFor();
    assert((await page.getByText('Asha Rao').count()) === 0 && (await page.getByRole('button', { name: 'Leads' }).count()) === 0, 'screen lock hides all data');
    await page.locator('input[type=password]').fill(PW);
    await page.getByRole('button', { name: 'Unlock' }).click();
    await page.getByRole('button', { name: 'AI agents', exact: true }).click();
    await page.getByTestId('keep-working').uncheck();

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
    mockAi.close();
  }
})().catch((e) => { console.error(e.message || e); process.exit(1); });
