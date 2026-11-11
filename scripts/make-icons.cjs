// Renders the app icon to PNG files (run with: node scripts/make-icons.cjs). Needs Playwright.
const { chromium } = require('playwright');
const path = require('path');
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#7c3aed"/><stop offset="1" stop-color="#f59e0b"/></linearGradient></defs><rect width="512" height="512" fill="url(#g)"/><path d="M280 96 150 284h92l-22 132 142-196h-96z" fill="#fff"/></svg>`;
(async () => {
  const b = await chromium.launch();
  for (const [size, file] of [[192, 'public/icons/icon-192.png'], [512, 'public/icons/icon-512.png'], [1024, 'build/icon.png']]) {
    const p = await b.newPage({ viewport: { width: size, height: size } });
    await p.setContent(`<body style="margin:0">${svg.replace('<svg', `<svg width="${size}" height="${size}"`)}</body>`);
    await p.screenshot({ path: path.join(__dirname, '..', file) });
    await p.close();
  }
  await b.close();
})();
