// Renders the aged-paper texture (soft relief, stains, grain) once into public/paper.jpg, so players'
// browsers don't have to compute it live. The board multiplies it over the land.
// Run: node tools/build-paper.js
const path = require('path');
const { chromium } = require('playwright');
const W = 2000, H = 994; // board is 1000 x 497 units -> 2 px per unit
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: W, height: H } });
  await p.setContent(`<html><body style="margin:0"><svg width="${W}" height="${H}" viewBox="0 0 1000 497">
    <filter id="paper" x="0" y="0" width="100%" height="100%" color-interpolation-filters="sRGB">
      <feTurbulence type="fractalNoise" baseFrequency=".012" numOctaves="5" seed="8" result="h"/>
      <feDiffuseLighting in="h" surfaceScale="5" lighting-color="#fff8ec" result="light"><feDistantLight azimuth="225" elevation="48"/></feDiffuseLighting>
      <feComponentTransfer in="light" result="relief"><feFuncR type="linear" slope=".18" intercept=".88"/><feFuncG type="linear" slope=".18" intercept=".87"/><feFuncB type="linear" slope=".18" intercept=".84"/></feComponentTransfer>
      <feTurbulence type="fractalNoise" baseFrequency=".004" numOctaves="3" seed="21" result="st"/>
      <feColorMatrix in="st" type="matrix" values="0 0 0 0 .62  0 0 0 0 .5  0 0 0 0 .32  1.1 0 0 0 -.5" result="stains"/>
      <feTurbulence type="fractalNoise" baseFrequency="1.4" numOctaves="2" seed="2" result="grain"/>
      <feColorMatrix in="grain" values="0 0 0 0 .3  0 0 0 0 .22  0 0 0 0 .12  0 0 0 .16 0" result="grainC"/>
      <feMerge><feMergeNode in="relief"/><feMergeNode in="stains"/><feMergeNode in="grainC"/></feMerge>
    </filter>
    <rect width="1000" height="497" fill="#fff" filter="url(#paper)"/></svg></body></html>`);
  await p.waitForTimeout(300);
  const out = path.join(__dirname, '..', 'public', 'paper.jpg');
  await p.screenshot({ path: out, type: 'jpeg', quality: 72, clip: { x: 0, y: 0, width: W, height: H } });
  console.log('Wrote public/paper.jpg', Math.round(require('fs').statSync(out).size / 1024) + ' KB');
  await b.close();
})();
