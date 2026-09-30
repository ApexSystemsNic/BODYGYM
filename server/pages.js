// Páginas públicas renderizadas en el servidor (HTML completo, rastreable por buscadores):
//   /                         inicio + catálogo
//   /categoria/<slug>         catálogo de una categoría
//   /producto/<slug>          ficha del producto (mismo componente que la ventana modal)
// Cada página lleva title, description, canonical, Open Graph y JSON-LD propios.
import {
  h, Safe, esc, card, chipsHtml, productSheet, productUrl, productSlug, productAlt, normalizeCategory, categoryLabel,
  categoryUrl, CATEGORY_ORDER, CATEGORY_SLUG, rangeCountText, paginationHtml, pageSizes, pageRange, usd, ASSET_V, CARD_SIZES,
  DISCLAIMER, publicText, isRealReview,
} from '../public/js/ui.js';

export const MAX_PAGE_SIZE = 8;
const attr = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const BS = String.fromCharCode(92);
export const safeJson = (s) => s.replace(/</g, BS + 'u003c')
  .replace(new RegExp(String.fromCharCode(0x2028), 'g'), BS + 'u2028')
  .replace(new RegExp(String.fromCharCode(0x2029), 'g'), BS + 'u2029');
const clip = (s, n) => (s.length <= n ? s : s.slice(0, n - 1).replace(/\s+\S*$/, '') + '…');

const HOME_TITLE = 'BodyFactory Gym | Suplementos deportivos en Managua';
const HOME_DESC = 'Catálogo de suplementos deportivos de BodyFactory Gym: proteínas, creatina, pre-entrenos, aminoácidos y más. Precios en USD, pedidos por WhatsApp y delivery gratis en Managua.';
const CAT_INTRO = {
  'PROTEÍNAS': 'Proteína de suero, aislados y ganadores de peso para complementar tu alimentación.',
  CREATINA: 'Creatina monohidratada micronizada en distintas presentaciones.',
  'PRE-ENTRENOS': 'Fórmulas pre-entreno para energía, enfoque y bombeo muscular.',
  'AMINOÁCIDOS': 'BCAA, aminoácidos esenciales y glutamina para acompañar tu entrenamiento.',
  'QUEMADORES DE GRASA': 'Termogénicos, diuréticos y fórmulas de apoyo para la definición.',
  'SOPORTE ARTICULAR': 'Fórmulas con glucosamina, condroitina y MSM para tus articulaciones.',
  'SOPORTE HORMONAL': 'Fórmulas herbales de apoyo hormonal y rendimiento.',
  'OMEGA-3': 'Ácidos grasos esenciales omega-3 y omega-6.',
  OTROS: 'Multivitamínicos, colágeno y otros suplementos.',
};

export function findProductBySlug(products, slug) {
  return products.find((p) => productSlug(p) === slug) || null;
}
export const findProductById = (products, id) => products.find((p) => p.id === id) || null;

// ── cabecera SEO ──
function seoHead({ title, description, canonical, robots, ogType = 'website', image, jsonld = [] }) {
  const meta = [
    `<title>${esc(title)}</title>`,
    `<meta name="description" content="${attr(description)}">`,
    `<meta name="robots" content="${robots}">`,
    canonical ? `<link rel="canonical" href="${attr(canonical)}">` : '',
    `<meta property="og:site_name" content="BodyFactory Gym">`,
    `<meta property="og:locale" content="es_NI">`,
    `<meta property="og:type" content="${ogType}">`,
    `<meta property="og:title" content="${attr(title)}">`,
    `<meta property="og:description" content="${attr(description)}">`,
    canonical ? `<meta property="og:url" content="${attr(canonical)}">` : '',
    image ? `<meta property="og:image" content="${attr(image)}">` : '',
    image ? `<meta property="og:image:width" content="800"><meta property="og:image:height" content="800">` : '',
    `<meta name="twitter:card" content="${image ? 'summary_large_image' : 'summary'}">`,
    `<meta name="twitter:title" content="${attr(title)}">`,
    `<meta name="twitter:description" content="${attr(description)}">`,
    image ? `<meta name="twitter:image" content="${attr(image)}">` : '',
    ...jsonld.map((o) => `<script type="application/ld+json">${safeJson(JSON.stringify(o))}</script>`),
  ];
  return meta.filter(Boolean).join('\n  ');
}

function organizationLd(site, origin) {
  const o = {
    '@context': 'https://schema.org', '@type': 'HealthClub', name: site.name || 'BodyFactory Gym',
    url: `${origin}/`, logo: `${origin}/img/logo-512.webp`, image: `${origin}/img/logo-512.webp`,
  };
  if (site.whatsapp) o.telephone = `+${site.whatsapp}`;
  if (site.address) o.address = { '@type': 'PostalAddress', streetAddress: 'Montoya', addressLocality: 'Managua', addressCountry: 'NI' };
  const social = [site.instagram, site.facebook].filter((u) => typeof u === 'string' && /^https:\/\//.test(u));
  if (social.length) o.sameAs = social;
  return o;
}
const breadcrumbLd = (items) => ({
  '@context': 'https://schema.org', '@type': 'BreadcrumbList',
  itemListElement: items.map(([name, url], i) => ({ '@type': 'ListItem', position: i + 1, name, item: url })),
});
function productLd(p, origin) {
  const o = {
    '@context': 'https://schema.org', '@type': 'Product', name: p.name, sku: p.id,
    url: `${origin}${productUrl(p)}`,
    category: categoryLabel(normalizeCategory(p.category)),
    offers: {
      '@type': 'Offer', url: `${origin}${productUrl(p)}`, priceCurrency: 'USD', price: Number(p.price_retail).toFixed(2),
      availability: p.stock > 0 ? 'https://schema.org/InStock' : 'https://schema.org/OutOfStock',
      itemCondition: 'https://schema.org/NewCondition',
      seller: { '@type': 'Organization', name: 'BodyFactory Gym' },
    },
  };
  if (p.brand) o.brand = { '@type': 'Brand', name: p.brand };
  if (p.image) o.image = [`${origin}/${p.image}-800.webp`];
  const d = publicText(p.description);
  if (d) o.description = d;
  return o;
}

// ── bloques de la página de catálogo (inicio y categorías) ──
function catalogMain({ products, cat, page, q, site, reviews }) {
  const list = cat === 'Todas' ? products : products.filter((p) => normalizeCategory(p.category) === cat);
  const sizes = pageSizes(list.length, MAX_PAGE_SIZE);
  const totalPages = sizes.length;
  const { start, end } = pageRange(sizes, page);
  const items = list.slice(start, end);
  const isCat = cat !== 'Todas';
  const grid = items.length ? items.map((p, i) => card(p, i, { mode: 'retail', wa: site.whatsapp }).s).join('') : '<p class="muted">No encontramos productos con ese filtro.</p>';
  const hero = isCat
    ? h`<section class="hero wrap hero-cat">
        <nav class="crumbs" aria-label="Ruta de navegación"><a href="/">Inicio</a><span aria-hidden="true">›</span><span aria-current="page">${categoryLabel(cat)}</span></nav>
        <h1 id="catTitle">${categoryLabel(cat)}</h1>
        <p class="hero-sub">${CAT_INTRO[cat] || ''} ${site.delivery || ''} · Pedidos por WhatsApp.</p>
      </section>`
    : h`<section class="hero wrap">
        <img class="hero-logo" src="/img/logo-192.webp" srcset="/img/logo-192.webp 192w, /img/logo-512.webp 512w" sizes="(min-width:700px) 150px, 92px" width="170" height="151" alt="BodyFactory Gym" fetchpriority="high">
        <div><h1>Suplementos para tu mejor versión</h1>
        <p class="hero-sub"><span id="heroDelivery">${site.delivery || ''}</span> · Pedidos por WhatsApp · Precios en USD</p></div>
      </section>`;
  return { totalPages, html: h`${hero}
    <section class="wrap" id="catalogo" aria-labelledby="h-cat">
      <h2 class="sr" id="h-cat">Catálogo${isCat ? ` de ${categoryLabel(cat)}` : ''}</h2>
      <div class="toolbar">
        <button type="button" class="cat-btn" data-action="open-menu" aria-controls="menuDrawer" aria-expanded="false">
          <span>Categoría:</span> <strong id="catBtnLabel">${categoryLabel(cat)}</strong>
          <svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M4 7h16M7 12h10M10 17h4"/></svg>
        </button>
        <nav class="chips" id="chips" aria-label="Categorías">${chipsHtml(products, cat)}</nav>
        <label class="sort"><span>Ordenar</span>
          <select id="sort" data-sort>
            <option value="pop">Más vendidos</option>
            <option value="asc">Precio: menor a mayor</option>
            <option value="desc">Precio: mayor a menor</option>
          </select>
        </label>
      </div>
      <p class="muted count" id="count" aria-live="polite">${rangeCountText(list.length, list.length ? start + 1 : 0, end)}</p>
      <div class="grid" id="grid">${new Safe(grid)}</div>
      <div id="pager">${paginationHtml({ page, totalPages, base: categoryUrl(cat) })}</div>
    </section>
    ${isCat ? '' : h`<section class="wrap" id="combos" aria-labelledby="h-combos" hidden>
      <h2 id="h-combos">Combos y promociones</h2>
      <div class="combos" id="comboList"></div>
    </section>
    <section class="wrap" id="comparador" aria-labelledby="h-cmp">
      <h2 id="h-cmp">Comparador: precio por porción</h2>
      <div id="compare"></div>
    </section>
    <section class="wrap" id="resenas" aria-labelledby="h-rev">
      <div class="bar"><h2 id="h-rev">Lo que dicen los clientes</h2>
        <button type="button" class="btn metal small" data-action="open-review">Escribir una reseña</button></div>
      <div class="reviews" id="reviewList"></div>
    </section>
    <section class="wrap" id="nosotros" aria-labelledby="h-about">
      <h2 id="h-about">Sobre nosotros</h2>
      <div class="about" id="about"></div>
    </section>
    <section class="wrap" id="galeria" aria-labelledby="h-gal">
      <h2 id="h-gal">Nuestro gimnasio</h2>
      <div class="gallery-editorial" id="gallery"></div>
    </section>
    <section class="wrap" id="faq" aria-labelledby="h-faq">
      <h2 id="h-faq">Preguntas frecuentes</h2>
      <div class="faq" id="faqList">${(site.faq || []).map((f) => h`<details><summary>${f.q}</summary><p>${f.a}</p></details>`)}</div>
    </section>`}` };
}

export function buildCatalogPage({ products, reviews, site, origin, cat, page, q, indexable }) {
  const { html, totalPages } = catalogMain({ products, cat, page, q, site, reviews });
  const isCat = cat !== 'Todas';
  const base = categoryUrl(cat);
  const canonical = `${origin}${base}${page > 1 ? `?pagina=${page}` : ''}`;
  const catList = isCat ? products.filter((p) => normalizeCategory(p.category) === cat) : products;
  const brands = [...new Set(catList.map((p) => p.brand).filter(Boolean))].slice(0, 4).join(', ');
  const title = isCat ? `${categoryLabel(cat)}${page > 1 ? ` · página ${page}` : ''} | BodyFactory Gym` : (page > 1 ? `Catálogo · página ${page} | BodyFactory Gym` : HOME_TITLE);
  const description = isCat
    ? clip(`${categoryLabel(cat)} en BodyFactory Gym, Managua: ${catList.length} productos${brands ? ` de marcas como ${brands}` : ''}. ${CAT_INTRO[cat] || ''} Precios en USD y pedidos por WhatsApp.`, 158)
    : HOME_DESC;
  const robots = indexable && !q ? 'index, follow, max-image-preview:large' : 'noindex, follow';
  const crumbs = isCat ? [breadcrumbLd([['Inicio', `${origin}/`], [categoryLabel(cat), `${origin}${base}`]])] : [organizationLd(site, origin)];
  return {
    totalPages,
    head: seoHead({ title, description, canonical: q ? `${origin}${base}` : canonical, robots, image: `${origin}/img/logo-512.webp`, jsonld: crumbs }),
    main: html.s,
    first: catList[(pageRange(pageSizes(catList.length, MAX_PAGE_SIZE), page)).start],
  };
}

export function buildProductPage({ p, products, reviews, site, origin, indexable }) {
  const cat = normalizeCategory(p.category);
  const url = `${origin}${productUrl(p)}`;
  const related = products.filter((x) => x.id !== p.id && normalizeCategory(x.category) === cat).slice(0, 4);
  const desc = publicText(p.description);
  const lead = `${p.name}${p.brand && !p.name.toLowerCase().includes(p.brand.toLowerCase()) ? ` de ${p.brand}` : ''}${p.presentation ? `, ${p.presentation}` : ''}.`;
  const tail = `${usd(p.price_retail)} en BodyFactory Gym, Managua.`;
  const body = desc || `${categoryLabel(cat)} con pedido por WhatsApp.`;
  const description = `${lead} ${tail} ${body}`.length <= 158 ? `${lead} ${tail} ${body}` : clip(`${lead} ${body}`, 158);
  const title = `${p.name}${p.brand && !p.name.toLowerCase().includes(p.brand.toLowerCase()) ? ` · ${p.brand}` : ''} | BodyFactory Gym`;
  const main = h`<div class="wrap pd-page">
      <nav class="crumbs" aria-label="Ruta de navegación"><a href="/">Inicio</a><span aria-hidden="true">›</span><a href="${categoryUrl(cat)}">${categoryLabel(cat)}</a><span aria-hidden="true">›</span><span aria-current="page">${p.name}</span></nav>
      <article class="pd-article" id="productPage" data-id="${p.id}">${productSheet(p, { mode: 'retail', reviews: reviews.filter(isRealReview), wa: site.whatsapp, page: true })}</article>
      ${related.length ? h`<section class="related" aria-labelledby="h-rel">
        <h2 id="h-rel">Más en ${categoryLabel(cat)}</h2>
        <div class="grid">${related.map((x, i) => card(x, 10 + i, { mode: 'retail', wa: site.whatsapp }))}</div>
        <p class="related-more"><a class="btn metal" href="${categoryUrl(cat)}">Ver todo ${categoryLabel(cat)}</a></p>
      </section>` : ''}
    </div>`;
  const jsonld = [productLd(p, origin), breadcrumbLd([['Inicio', `${origin}/`], [categoryLabel(cat), `${origin}${categoryUrl(cat)}`], [p.name, url]])];
  return {
    head: seoHead({ title, description, canonical: url, robots: indexable ? 'index, follow, max-image-preview:large' : 'noindex, follow', ogType: 'product', image: p.image ? `${origin}/${p.image}-800.webp?v=${ASSET_V}` : `${origin}/img/logo-512.webp`, jsonld }),
    main: main.s,
  };
}

export function buildNotFound({ origin }) {
  return {
    head: seoHead({ title: 'Página no encontrada | BodyFactory Gym', description: 'La página que buscas no existe o fue movida.', robots: 'noindex, follow' }),
    main: h`<section class="wrap notfound">
      <p class="eyebrow">Error 404</p>
      <h1>No encontramos esta página</h1>
      <p class="muted">Puede que el producto ya no esté disponible o que el enlace esté incompleto.</p>
      <p class="link-row"><a class="btn" href="/">Ver el catálogo</a> <a class="btn metal" href="/categoria/proteinas">Proteínas</a> <a class="btn metal" href="/categoria/creatina">Creatina</a></p>
    </section>`.s,
  };
}

export function footNav(products) {
  const present = new Set(products.map((p) => normalizeCategory(p.category)));
  return CATEGORY_ORDER.filter((c) => present.has(c)).map((c) => `<a href="${categoryUrl(c)}">${esc(categoryLabel(c))}</a>`).join('');
}
export const drawerCats = (products, cat) => chipsHtml(products, cat).s;
export const imagePreload = (p) => (p?.image
  ? `<link rel="preload" as="image" href="/${attr(p.image)}-400.webp?v=${ASSET_V}" imagesrcset="/${attr(p.image)}-400.webp?v=${ASSET_V} 400w, /${attr(p.image)}-800.webp?v=${ASSET_V} 800w" imagesizes="${CARD_SIZES}" fetchpriority="high">`
  : '');
export { DISCLAIMER, CATEGORY_SLUG, productUrl };
