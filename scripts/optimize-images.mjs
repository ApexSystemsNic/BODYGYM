// Converts source images to the optimized WebP files the site serves.
//
//   <src>/products/<product-id>.{png,jpg,jpeg,webp}  ->  public/img/products/<product-id>-{400,800}.webp
//       Square black canvas, product centered at a uniform scale (same processing as uploads from /admin).
//   <src>/gallery/<name>.{png,jpg,jpeg,webp}         ->  public/images/gallery/<name>-{600,1000}.webp
//   <src>/logo/logo.{png,jpg}                        ->  public/img/logo-{96,192,512}.webp + public/icons/*.png
//
// <src> defaults to ./img-src (not versioned: original photos stay outside the repository).
// Usage: npm run images                 (or: node scripts/optimize-images.mjs --src <folder> [--only products])
// After replacing an existing product photo, bump ASSET_V in public/js/ui.js.
import sharp from 'sharp';
import { readdirSync, mkdirSync, statSync, existsSync } from 'node:fs';
import { dirname, join, extname, basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { productWebp, PRODUCT_SIZES } from '../server/images.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name) => { const i = process.argv.indexOf(name); return i > -1 ? process.argv[i + 1] : null; };
const src = resolve(arg('--src') || process.env.IMG_SRC || join(root, 'img-src'));
const only = arg('--only');
const EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp']);
let before = 0;
let after = 0;

const list = (dir) => (existsSync(dir) ? readdirSync(dir).filter((f) => EXTS.has(extname(f).toLowerCase())) : []);

async function products() {
  const dir = join(src, 'products');
  const out = join(root, 'public', 'img', 'products');
  mkdirSync(out, { recursive: true });
  for (const f of list(dir)) {
    const file = join(dir, f);
    before += statSync(file).size;
    for (const w of PRODUCT_SIZES) {
      const info = await (await productWebp(sharp, file, w)).toFile(join(out, `${basename(f, extname(f))}-${w}.webp`));
      after += info.size;
    }
    console.log(`products/${f}`);
  }
}

async function gallery() {
  const dir = join(src, 'gallery');
  const out = join(root, 'public', 'images', 'gallery');
  mkdirSync(out, { recursive: true });
  for (const f of list(dir)) {
    const file = join(dir, f);
    before += statSync(file).size;
    for (const w of [600, 1000]) {
      const info = await sharp(file).rotate().resize({ width: w, withoutEnlargement: true })
        .webp({ quality: 78, effort: 5 })
        .toFile(join(out, `${basename(f, extname(f))}-${w}.webp`));
      after += info.size;
    }
    console.log(`gallery/${f}`);
  }
}

// Removes the white background connected to the edges (inner white areas are kept).
async function withoutWhiteBackground(file) {
  const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width: w, height: h } = info;
  const isBg = (i) => data[i] > 228 && data[i + 1] > 228 && data[i + 2] > 228;
  const seen = new Uint8Array(w * h);
  const stack = [];
  const push = (x, y) => { const p = y * w + x; if (!seen[p] && isBg(p * 4)) { seen[p] = 1; stack.push(p); } };
  for (let x = 0; x < w; x++) { push(x, 0); push(x, h - 1); }
  for (let y = 0; y < h; y++) { push(0, y); push(w - 1, y); }
  while (stack.length) {
    const p = stack.pop();
    data[p * 4 + 3] = 0;
    const x = p % w; const y = (p - x) / w;
    if (x > 0) push(x - 1, y); if (x < w - 1) push(x + 1, y);
    if (y > 0) push(x, y - 1); if (y < h - 1) push(x, y + 1);
  }
  return sharp(data, { raw: { width: w, height: h, channels: 4 } }).trim().png().toBuffer();
}

async function logo() {
  const f = list(join(src, 'logo')).find((x) => basename(x, extname(x)) === 'logo');
  if (!f) return;
  const png = await withoutWhiteBackground(join(src, 'logo', f));
  for (const w of [96, 192, 512]) {
    const info = await sharp(png).resize({ width: w }).webp({ quality: 88, alphaQuality: 90 }).toFile(join(root, 'public', 'img', `logo-${w}.webp`));
    after += info.size;
  }
  const iconDir = join(root, 'public', 'icons');
  mkdirSync(iconDir, { recursive: true });
  const icon = async (name, size, ratio) => {
    const mark = await sharp(png).resize({ width: Math.round(size * ratio), height: Math.round(size * ratio), fit: 'inside' }).toBuffer();
    await sharp({ create: { width: size, height: size, channels: 4, background: '#15161a' } })
      .composite([{ input: mark, gravity: 'center' }]).png({ compressionLevel: 9 }).toFile(join(iconDir, name));
  };
  await icon('icon-192.png', 192, 0.8);
  await icon('icon-512.png', 512, 0.8);
  await icon('icon-maskable-512.png', 512, 0.6); // safe zone for maskable icons
  await icon('apple-touch-icon.png', 180, 0.8);
  console.log('logo + PWA icons');
}

if (!existsSync(src)) {
  console.error(`Source folder not found: ${src}`);
  process.exit(1);
}
const jobs = { products, gallery, logo };
for (const [name, run] of Object.entries(jobs)) if (!only || only === name) await run();
const kb = (n) => `${(n / 1024).toFixed(0)} KB`;
console.log(`Sources: ${kb(before)} -> WebP: ${kb(after)}`);
