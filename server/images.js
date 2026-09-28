// Product photo processing shared by the admin upload endpoint and scripts/optimize-images.mjs.
// Output: square black canvas with the product centered inside an 80% x 84% box, so every
// product keeps the same visual scale in cards and product pages. Best results come from
// sources with a transparent or black background.
export const PRODUCT_SIZES = [400, 800];

export async function productWebp(sharp, input, size) {
  const inner = await sharp(input).rotate()
    .flatten({ background: '#000000' })
    .resize({ width: Math.round(size * 0.8), height: Math.round(size * 0.84), fit: 'inside' })
    .toBuffer();
  return sharp({ create: { width: size, height: size, channels: 3, background: '#000000' } })
    .composite([{ input: inner, gravity: 'center' }])
    .webp({ quality: 86 });
}
