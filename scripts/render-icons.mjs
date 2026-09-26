// Renders the PNG app icons from docs/icons/icon.svg with the preinstalled
// Chromium. Run after editing the SVG: node scripts/render-icons.mjs
//
// Variants: "any" icons keep the rounded corners; the Apple touch icon and the
// maskable icon are full-bleed squares, because iOS, macOS, and Android apply
// their own mask. The maskable art is shrunk into the central safe zone.

import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
function loadPlaywright() {
  for (const id of ['playwright', '@playwright/test', '/opt/node22/lib/node_modules/playwright']) {
    try {
      return require(id);
    } catch {
      // Try the next location.
    }
  }
  throw new Error('Playwright is not installed. Run npm install first.');
}
const { chromium } = loadPlaywright();

const iconsDir = fileURLToPath(new URL('../docs/icons/', import.meta.url));
const source = readFileSync(`${iconsDir}icon.svg`, 'utf8');

const fullBleed = source.replace('<rect id="bg" width="512" height="512" rx="112"', '<rect id="bg" width="512" height="512" rx="0"');
const maskable = fullBleed
  .replace('<g id="art">', '<g id="art" transform="translate(256 262) scale(0.78) translate(-256 -256)">');

const outputs = [
  { file: 'icon-192.png', svg: source, size: 192 },
  { file: 'icon-512.png', svg: source, size: 512 },
  { file: 'icon-maskable-512.png', svg: maskable, size: 512 },
  { file: 'apple-touch-icon.png', svg: fullBleed, size: 180 },
  { file: 'favicon-32.png', svg: source, size: 32 },
];

const browser = await chromium.launch();
const page = await browser.newPage({ deviceScaleFactor: 1 });
for (const { file, svg, size } of outputs) {
  await page.setViewportSize({ width: size, height: size });
  const dataUrl = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
  await page.setContent(
    `<html><body style="margin:0;background:transparent"><img src="${dataUrl}" width="${size}" height="${size}" style="display:block"></body></html>`,
  );
  await page.waitForFunction(() => document.images[0]?.complete);
  const png = await page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
  writeFileSync(`${iconsDir}${file}`, png);
  console.log(`wrote icons/${file}`);
}
await browser.close();
