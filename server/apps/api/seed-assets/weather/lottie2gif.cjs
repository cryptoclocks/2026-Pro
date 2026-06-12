const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

// args: inputJson outDir size frames
const [,, input, outDir, sizeArg, framesArg] = process.argv;
const SIZE = parseInt(sizeArg || '128', 10);
const NFRAMES = parseInt(framesArg || '36', 10);

(async () => {
  const json = fs.readFileSync(input, 'utf8');
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setViewport({ width: SIZE, height: SIZE, deviceScaleFactor: 1 });
  await page.setContent(`<!doctype html><html><head><style>
    html,body{margin:0;padding:0;background:transparent}
    #c{width:${SIZE}px;height:${SIZE}px}
  </style></head><body><div id="c"></div></body></html>`);
  // lottie-web from CDN (chromium has network)
  await page.addScriptTag({ url: 'https://unpkg.com/lottie-web@5.12.2/build/player/lottie_svg.min.js' });
  const total = await page.evaluate((data, size) => {
    window.__data = JSON.parse(data);
    window.anim = lottie.loadAnimation({
      container: document.getElementById('c'),
      renderer: 'svg', loop: false, autoplay: false, animationData: window.__data,
      rendererSettings: { preserveAspectRatio: 'xMidYMid meet' },
    });
    return new Promise((res) => {
      window.anim.addEventListener('DOMLoaded', () => res(window.anim.totalFrames));
    });
  }, json, SIZE);

  const el = await page.$('#c');
  for (let i = 0; i < NFRAMES; i++) {
    const f = (i / NFRAMES) * total;
    await page.evaluate((fr) => window.anim.goToAndStop(fr, true), f);
    const out = path.join(outDir, `f${String(i).padStart(3,'0')}.png`);
    await el.screenshot({ path: out, omitBackground: true });
  }
  await browser.close();
  console.log(`rendered ${NFRAMES} frames @${SIZE}px (total lottie frames ${total})`);
})();
