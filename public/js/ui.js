// Plantillas compartidas entre el navegador y el servidor (sin DOM: solo funciones puras).
// El servidor las usa para pintar la primera pantalla directamente en el HTML.
// Toda cadena que viene de datos pasa por h`` (escapa HTML) para evitar inyección.

export class Safe { constructor(s) { this.s = s; } }
export const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const part = (v) => (v instanceof Safe ? v.s : Array.isArray(v) ? v.map(part).join('') : v == null || v === false ? '' : esc(v));
export const h = (strings, ...vals) => new Safe(strings.reduce((out, s, i) => out + s + (i < vals.length ? part(vals[i]) : ''), ''));
export const usd = (n) => '$' + Number(n).toFixed(2);

const ICONS = {
  muscle: '<path d="M3 9v6M6 7v10M18 7v10M21 9v6M6 12h12"/>',
  bolt: '<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>',
  drop: '<path d="M12 3c4 5 6 8 6 11a6 6 0 0 1-12 0c0-3 2-6 6-11z"/>',
  fire: '<path d="M12 2c1 4 5 6 5 11a5 5 0 0 1-10 0c0-2 1-3 2-4 0 2 1 3 2 3 0-4-1-6 1-10z"/>',
  check: '<path d="m5 13 4 4 10-10"/>',
  leaf: '<path d="M5 19c0-9 5-14 15-14 0 10-5 15-14 15M5 19c3-5 6-8 10-10"/>',
  heart: '<path d="M12 20s-8-5-8-11a4.5 4.5 0 0 1 8-2.5A4.5 4.5 0 0 1 20 9c0 6-8 11-8 11z"/>',
  scoop: '<path d="M3 9h12a6 6 0 0 1-6 7H9a6 6 0 0 1-6-7z"/><path d="M15 9l6-5"/>',
  cart: '<path d="M3 4h2l2.5 11h10L20 7H6"/><circle cx="9" cy="19" r="1.5"/><circle cx="17" cy="19" r="1.5"/>',
  search: '<circle cx="11" cy="11" r="6"/><path d="m20 20-4-4"/>',
  share: '<circle cx="6" cy="12" r="2.5"/><circle cx="18" cy="6" r="2.5"/><circle cx="18" cy="18" r="2.5"/><path d="m8.2 10.8 7.6-3.6M8.2 13.2l7.6 3.6"/>',
  pin: '<path d="M12 21s7-6 7-11a7 7 0 0 0-14 0c0 5 7 11 7 11z"/><circle cx="12" cy="10" r="2.5"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  truck: '<path d="M2 6h11v10H2zM13 10h4l3 3v3h-7"/><circle cx="7" cy="18" r="2"/><circle cx="17" cy="18" r="2"/>',
  instagram: '<rect x="3" y="3" width="18" height="18" rx="5"/><circle cx="12" cy="12" r="4"/><circle cx="17.5" cy="6.5" r=".8"/>',
  whatsapp: '<path d="M4 20l1.3-4.2A8 8 0 1 1 8.4 18.8z"/><path d="M9 9c0 3 3 6 6 6l1-2-2-1-1 1c-1-.5-2-1.5-2.5-2.5l1-1-1-2z"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  warn: '<path d="M12 3 2 20h20z"/><path d="M12 10v5M12 18v.5"/>',
  trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>',
};
export const icon = (name) => new Safe(`<svg class="ic" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[name] || ICONS.check}</svg>`);
export const stars = (n) => {
  const r = Math.round(n);
  return new Safe(`<span class="stars" role="img" aria-label="${r} de 5 estrellas">${'★'.repeat(r)}<span class="off">${'★'.repeat(5 - r)}</span></span>`);
};

// ── lógica de producto ──
export const priceOf = (p, mode) => (mode === 'wholesale' ? p.price_wholesale : p.price_retail);
// Un valor nutricional solo se muestra si es un número real; null/ausente = desconocido.
export const known = (v) => typeof v === 'number' && Number.isFinite(v);
// Texto libre (descripción, modo de uso...): oculta valores que son en realidad
// placeholders de investigación interna ("Descripción pendiente de confirmar."),
// nunca datos reales del producto — así no se publican por accidente.
const PLACEHOLDER_TEXT_RE = /pendiente de confirmar\.?/i;
export const cleanText = (s) => (typeof s === 'string' && s.trim() && !PLACEHOLDER_TEXT_RE.test(s) ? s.trim() : '');
// Algunos productos guardan benefits como ["texto", ...] en vez de [{icon,text}, ...].
// El texto en sí es un dato real (viene de la investigación), solo cambia de forma;
// se normaliza aquí para que la ficha nunca muestre un ícono sin texto.
export const benefitsOf = (p) => (Array.isArray(p.benefits) ? p.benefits : []).map((b) => (typeof b === 'string' ? { icon: 'check', text: b } : b)).filter((b) => b && b.text);
// 0 = porciones no confirmadas (default explícito). 1 también se trata como no confirmado:
// en esta base de datos "servings = 1" se ha usado como valor por defecto técnico (nunca
// acompañado de `presentation` ni `serving_size` reales), no como una porción real verificada.
export const hasServings = (p) => Number(p.servings) > 1;
export const perServing = (p, mode) => (hasServings(p) ? priceOf(p, mode) / p.servings : null);
export const stockInfo = (p) => (p.stock <= 0 ? { cls: 'none', label: 'Agotado' } : p.stock <= 8 ? { cls: 'low', label: `Últimas ${p.stock}` } : { cls: '', label: 'En stock' });
export const ratingOf = (reviews, id) => {
  const rs = reviews.filter((r) => r.product === id);
  return rs.length ? { avg: rs.reduce((s, r) => s + r.stars, 0) / rs.length, n: rs.length } : null;
};

// Reseñas semilla de ejemplo (texto/nombre genérico del seed inicial, nunca escritas por un
// cliente real): se excluyen del listado público para no mostrar reseñas falsas como si fueran
// reales. No borra nada de la base de datos, solo evita pintarlas.
const PLACEHOLDER_REVIEW_RE = /^texto de ejemplo:/i;
export const isRealReview = (r) => r && r.name !== 'Cliente de ejemplo' && !PLACEHOLDER_REVIEW_RE.test(String(r.text || ''));

// Versión de las imágenes (?v=). Las imágenes se sirven con caché de un año: si se reemplaza un
// archivo existente conservando su nombre, sube este valor para que los navegadores lo descarguen.
// (Las fotos subidas desde /admin reciben un nombre nuevo y no lo necesitan. CSS/JS se versionan solos.)
export const ASSET_V = '20260927c';
// Marcador único de marca para productos sin fotografía confirmada (nunca la foto de otro producto).
export const placeholder = (alt = '') => h`<span class="noimg" role="img" aria-label="${alt}"><img class="noimg-mark" src="/img/logo-192.webp?v=${ASSET_V}" alt="" aria-hidden="true" width="96" height="85" loading="lazy" decoding="async"><span class="noimg-txt">Imagen próximamente</span></span>`;
// Imágenes WebP responsivas con carga diferida (las primeras se cargan de inmediato).
export function img(base, { sizes, w = 400, hgt = 400, alt = '', lazy = true, priority = false } = {}) {
  if (!base) return placeholder(alt);
  const u = (n) => `/${base}-${n}.webp?v=${ASSET_V}`;
  return h`<img src="${u(400)}" srcset="${u(400)} 400w, ${u(800)} 800w" sizes="${sizes || CARD_SIZES}" width="${w}" height="${hgt}" alt="${alt}" ${lazy ? new Safe('loading="lazy"') : new Safe('')} ${priority ? new Safe('fetchpriority="high"') : new Safe('')} decoding="async">`;
}
// Ancho real de la foto en la tarjeta según las columnas del catálogo (4 / 3 / 2 / 1).
// En teléfonos la tarjeta es horizontal y la foto ocupa ~36 % del ancho: así se descarga la versión de 400 px.
export const CARD_SIZES = '(min-width: 1000px) min(300px, 24vw), (min-width: 700px) 31vw, (min-width: 556px) 46vw, calc(36vw - 12px)';

// Textos públicos: se descartan frases de uso interno o de administración que no son contenido
// comercial ("pendiente", "por confirmar", "consulta la etiqueta", "ver envase"...).
const ADMIN_PHRASE_RE = /(pendiente|por confirmar|sin confirmar|no confirmad|informaci[oó]n no disponible|(revis|consult)\w* (la )?etiqueta|etiqueta del envase|ver (el )?envase)/i;
export const publicText = (s) => {
  const t = cleanText(s).replace(/\s*\((seg[uú]n (el )?fabricante|etiqueta|confirmado[^)]*)\)/gi, '').replace(/\s*Confirmado directamente en el envase del cliente\.?/gi, '');
  if (!t) return '';
  return t.split(/(?<=[.!?])\s+/).filter((x) => !ADMIN_PHRASE_RE.test(x)).join(' ').trim();
};

// Tarjeta del catálogo: SIEMPRE la misma estructura (imagen · info · precio · acciones).
// Imagen, nombre y "Ver ficha" son enlaces reales a la página del producto (rastreables por
// buscadores); el navegador intercepta el clic y abre la ficha en la ventana modal.
export function card(p, i, { mode, wa }) {
  const st = stockInfo(p);
  const other = mode === 'retail' ? { l: 'Mayorista', v: p.price_wholesale } : { l: 'Normal', v: p.price_retail };
  const meta = [p.presentation, (p.flavors || []).join(', ')].filter(Boolean).join(' · ');
  const ps = perServing(p, mode);
  const out = p.stock <= 0;
  const url = productUrl(p);
  return h`<article class="card ${out ? 'out' : ''}">
    <a class="media" href="${url}" data-action="open" data-id="${p.id}" aria-label="Ver ficha de ${p.name}" tabindex="-1">
      ${p.tag === 'best' ? h`<span class="ribbon">Más vendido</span>` : p.tag === 'new' ? h`<span class="ribbon new">Nuevo</span>` : ''}
      <span class="stock-pill pill ${st.cls}"><i></i>${st.label}</span>
      ${img(p.image, { alt: productAlt(p), lazy: i > 3, priority: i === 0 })}
    </a>
    <div class="card-body">
      <span class="brandline">${p.brand}</span>
      <h3 class="card-name"><a href="${url}" data-action="open" data-id="${p.id}">${p.name}</a></h3>
      <span class="meta">${meta || new Safe('&nbsp;')}</span>
      <div class="prices">
        <div class="price-main">${usd(priceOf(p, mode))}<small>${mode === 'retail' ? 'Normal' : 'Mayorista'}</small></div>
        <div class="price-alt">${other.l}: ${usd(other.v)}${ps != null ? h` · <span class="ps">${usd(ps)}/porción</span>` : ''}</div>
      </div>
      <div class="card-actions">
        <a class="btn metal small" href="${url}" data-action="open" data-id="${p.id}">Ver ficha</a>
        ${out && wa
          ? h`<a class="btn wa small" href="https://wa.me/${wa}?text=${encodeURIComponent(`Hola, quiero consultar disponibilidad de ${p.name}`)}" target="_blank" rel="noopener noreferrer">${icon('whatsapp')} Consultar</a>`
          : h`<button type="button" class="btn small" data-action="quick-add" data-id="${p.id}" ${out ? 'disabled' : ''}>${icon('cart')} Agregar</button>`}
      </div>
    </div>
  </article>`;
}

// ── URLs públicas estables (producto y categoría) ──
export const slugify = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .replace(/%/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 70);
export const productSlug = (p) => slugify(p.name) || p.id;
export const productUrl = (p) => `/producto/${productSlug(p)}`;
export const productAlt = (p) => [p.brand, p.name, p.presentation].filter(Boolean).join(' ');

// ── Ficha de producto: UN SOLO componente para la ventana modal y para la página /producto/... ──
export const DISCLAIMER = 'Las declaraciones sobre estos productos no han sido evaluadas por ninguna autoridad sanitaria. Estos productos no están destinados a diagnosticar, tratar, curar ni prevenir ninguna enfermedad. Los suplementos no sustituyen una dieta variada y equilibrada.';
const BADGE_LABEL = { 'sin-gluten': 'Sin gluten', keto: 'Keto', halal: 'Halal', 'sin-azucar': 'Sin azúcar' };
const DASH = new Safe('<span class="nodata" aria-label="Sin dato">—</span>');
const MACRO_ROWS = [['calories', 'Calorías', 'kcal'], ['protein', 'Proteína', 'g'], ['carbs', 'Carbohidratos', 'g'], ['sugar', 'Azúcares', 'g'], ['fat', 'Grasa total', 'g'], ['sodium', 'Sodio', 'mg']];
export function nutritionRows(p) {
  const m = p.macros || {};
  const rows = MACRO_ROWS.filter(([k]) => known(m[k]) && m[k] !== 0).map(([k, l, u]) => [l, `${m[k]} ${u}`]);
  for (const x of Array.isArray(m.items) ? m.items : []) if (x?.name && x?.amount) rows.push([x.name, x.amount]);
  return rows;
}
const fact = (title, value) => h`<div class="fact"><dt>${title}</dt><dd>${value || DASH}</dd></div>`;

// ctx: { mode, reviews (solo reales), wa, page (true en la página del producto) }
export function productSheet(p, { mode, reviews = [], wa, page = false }) {
  const st = stockInfo(p);
  const out = p.stock <= 0;
  const other = mode === 'retail' ? { l: 'Mayorista', v: p.price_wholesale } : { l: 'Normal', v: p.price_retail };
  const ps = perServing(p, mode);
  const own = reviews.filter((r) => r.product === p.id);
  const r = ratingOf(own, p.id);
  const description = publicText(p.description);
  const usage = publicText(p.usage);
  const benefits = benefitsOf(p).map((b) => ({ ...b, text: publicText(b.text) })).filter((b) => b.text);
  const warnings = (Array.isArray(p.warnings) ? p.warnings : []).map(publicText).filter(Boolean);
  const nutrition = nutritionRows(p);
  const portions = hasServings(p) ? [`${p.servings} porciones`, p.serving_size ? `porción: ${p.serving_size}` : ''].filter(Boolean).join(' · ') : (p.serving_size ? `Porción: ${p.serving_size}` : '');
  const Title = page ? 'h1' : 'h2';
  return h`<div class="pd">
    <div class="pd-main">
      <div class="pd-media">${img(p.image, { alt: productAlt(p), sizes: '(min-width: 900px) 420px, (min-width: 640px) 40vw, 90vw', lazy: false, priority: page, w: 800, hgt: 800 })}</div>
      <div class="pd-summary">
        <span class="brandline">${p.brand}</span>
        ${new Safe(`<${Title} class="pd-name">`)}${p.name}${new Safe(`</${Title}>`)}
        ${description ? h`<p class="pd-desc">${description}</p>` : ''}
        ${(p.badges.length || p.tag) ? h`<div class="badges">${p.badges.map((b) => h`<span class="badge">${BADGE_LABEL[b] || b}</span>`)}${p.tag === 'best' ? h`<span class="badge accent">Más vendido</span>` : p.tag === 'new' ? h`<span class="badge danger">Nuevo</span>` : ''}</div>` : ''}
        <div class="pd-price">
          <span class="price-main">${usd(priceOf(p, mode))}<small>${mode === 'retail' ? 'Normal' : 'Mayorista'}</small></span>
          <span class="price-other">${other.l}: <strong>${usd(other.v)}</strong></span>
          ${ps != null ? h`<span class="per-serving-inline">${usd(ps)}/porción</span>` : ''}
        </div>
        <div class="pd-status"><span class="pill ${st.cls}"><i></i>${st.label}</span>${r ? h`<span class="rating-line">${stars(r.avg)} ${r.avg.toFixed(1)} (${r.n})</span>` : ''}</div>
        ${p.flavors.length ? h`<div class="opt"><div class="opt-label">Sabor</div><div class="flavors" role="radiogroup" aria-label="Sabor">${p.flavors.map((f, i) => h`<label><input type="radio" name="flavor" value="${f}" ${i === 0 ? new Safe('checked') : new Safe('')}><span>${f}</span></label>`)}</div></div>` : ''}
        <div class="buyrow">
          ${out ? '' : h`<div class="qty" role="group" aria-label="Cantidad"><button type="button" data-action="dq" data-d="-1" aria-label="Disminuir cantidad">−</button><output id="dQty">1</output><button type="button" data-action="dq" data-d="1" aria-label="Aumentar cantidad">+</button></div>`}
          ${out && wa
            ? h`<a class="btn wa grow" href="https://wa.me/${wa}?text=${encodeURIComponent(`Hola, quiero consultar disponibilidad de ${p.name}`)}" target="_blank" rel="noopener noreferrer">${icon('whatsapp')} Consultar disponibilidad</a>`
            : h`<button type="button" class="btn grow" data-action="add-detail" data-id="${p.id}" ${out ? 'disabled' : ''}>${icon('cart')} ${out ? 'Agotado' : 'Agregar al carrito'}</button>`}
          <button type="button" class="btn metal" data-action="share" data-id="${p.id}">${icon('share')} Compartir</button>
        </div>
      </div>
    </div>

    <section class="pd-block pd-facts" aria-label="Ficha técnica">
      <h3 class="pd-h"><span class="eyebrow">Ficha técnica</span>Información del producto</h3>
      <dl class="facts">
        ${fact('Presentación', p.presentation)}
        ${fact('Sabor', p.flavors.join(', '))}
        ${fact('Porciones', portions)}
      </dl>
      ${nutrition.length ? h`<dl class="nutri-row" aria-label="Información nutricional por porción">${nutrition.map(([l, v]) => h`<div><dt>${l}</dt><dd>${v}</dd></div>`)}</dl>` : ''}
    </section>

    <section class="pd-block pd-usage">
      <h3 class="pd-h">${icon('scoop')} Modo de uso</h3>
      ${usage ? h`<p>${usage}</p>` : h`<p>${DASH}</p>`}
    </section>

    <div class="pd-duo">
      <section class="pd-block pd-benefits">
        <h3 class="pd-h">${icon('check')} Beneficios</h3>
        ${benefits.length ? h`<ul class="benefit-list">${benefits.map((b) => h`<li><span class="ico">${icon(b.icon)}</span><span>${b.text}</span></li>`)}</ul>` : h`<p>${DASH}</p>`}
      </section>
      <section class="pd-block pd-warnings">
        <h3 class="pd-h">${icon('warn')} Advertencias</h3>
        ${warnings.length ? h`<ul class="warn-list">${warnings.map((w) => h`<li>${w}</li>`)}</ul>` : h`<p>${DASH}</p>`}
      </section>
    </div>

    <section class="pd-block pd-reviews">
      <h3 class="pd-h">${icon('heart')} Reseñas</h3>
      ${own.length ? h`<div class="review-mini">${own.map((v) => h`<div>${stars(v.stars)} <strong>${v.name}</strong><p>${v.text}</p></div>`)}</div>` : h`<p class="muted">Aún no hay reseñas de este producto.</p>`}
      <p class="fine disclaimer">${DISCLAIMER}</p>
    </section>
  </div>`;
}

// ── normalización de categorías (única fuente de verdad, compartida navegador/SSR) ──
// La base de datos trae categorías demasiado específicas o duplicadas (p. ej. "Proteína whey"
// y "Proteínas" por separado). Esta función las agrupa en el set público final, SIN tocar el
// campo `category` real de cada producto en la base de datos — es solo una capa de presentación.
export const CATEGORY_ORDER = ['PROTEÍNAS', 'CREATINA', 'PRE-ENTRENOS', 'AMINOÁCIDOS', 'QUEMADORES DE GRASA', 'SOPORTE ARTICULAR', 'SOPORTE HORMONAL', 'OMEGA-3', 'OTROS'];
export const CATEGORY_LABEL = { 'PROTEÍNAS': 'Proteínas', 'CREATINA': 'Creatina', 'PRE-ENTRENOS': 'Pre-entrenos', 'AMINOÁCIDOS': 'Aminoácidos', 'QUEMADORES DE GRASA': 'Quemadores de grasa', 'SOPORTE ARTICULAR': 'Soporte articular', 'SOPORTE HORMONAL': 'Soporte hormonal', 'OMEGA-3': 'Omega-3', 'OTROS': 'Otros' };
export const CATEGORY_SLUG = Object.fromEntries(CATEGORY_ORDER.map((c) => [c, slugify(CATEGORY_LABEL[c])]));
export const categoryFromSlug = (slug) => CATEGORY_ORDER.find((c) => CATEGORY_SLUG[c] === slug) || null;
export const categoryUrl = (c) => (c === 'Todas' ? '/' : `/categoria/${CATEGORY_SLUG[c]}`);
export const categoryLabel = (c) => c === 'Todas' ? 'Todas' : (CATEGORY_LABEL[c] || c);
const CATEGORY_MAP = {
  'proteínas': 'PROTEÍNAS',
  'proteína whey': 'PROTEÍNAS',
  'whey': 'PROTEÍNAS',
  'whey protein': 'PROTEÍNAS',
  'isolate': 'PROTEÍNAS',
  'creatina': 'CREATINA',
  'pre-entreno': 'PRE-ENTRENOS',
  'pre-entrenos': 'PRE-ENTRENOS',
  'aminoácidos': 'AMINOÁCIDOS',
  'aminoácidos esenciales (eaa)': 'AMINOÁCIDOS',
  'eaa': 'AMINOÁCIDOS',
  'bcaa': 'AMINOÁCIDOS',
  'quemadores de grasa': 'QUEMADORES DE GRASA',
  'quemador de grasa termogénico': 'QUEMADORES DE GRASA',
  'diurético': 'QUEMADORES DE GRASA',
  'gel tópico reductor': 'QUEMADORES DE GRASA',
  'soporte articular': 'SOPORTE ARTICULAR',
  'soporte hormonal': 'SOPORTE HORMONAL',
  'soporte de testosterona': 'SOPORTE HORMONAL',
  'omega-3': 'OMEGA-3',
  'colágeno': 'OTROS',
  'multivitamínico': 'OTROS',
};
export function normalizeCategory(raw) {
  const key = String(raw || '').trim().toLowerCase();
  if (!key) return 'OTROS';
  return CATEGORY_MAP[key] || 'OTROS';
}

export function chipsHtml(products, cat) {
  const present = new Set(products.map((p) => normalizeCategory(p.category)));
  const cats = ['Todas', ...CATEGORY_ORDER.filter((c) => present.has(c))];
  return h`${cats.map((c) => h`<a class="chip" href="${categoryUrl(c)}" data-action="cat" data-cat="${c}" aria-pressed="${String(c === cat)}" ${c === cat ? new Safe('aria-current="page"') : new Safe('')}>${categoryLabel(c)}</a>`)}`;
}

// ── paginación equilibrada (compartida entre el navegador y el SSR del servidor) ──
// Reparte "total" elementos en páginas de máximo "max", evitando que la última
// quede desbalanceada: 45 con max=8 da 8,8,8,7,7,7 (no 8,8,8,8,8,5). Funciona para
// cualquier total (1, 5, 8, 9, 15, 24, 45, 50...), no está fijado para un número concreto.
export function pageSizes(total, max = 8) {
  if (total <= 0) return [0];
  const pageCount = Math.max(1, Math.ceil(total / max));
  const base = Math.floor(total / pageCount);
  const remainder = total % pageCount;
  return Array.from({ length: pageCount }, (_, i) => base + (i < remainder ? 1 : 0));
}

// Índice [start, end) de una página dentro de la lista, según el reparto de pageSizes().
export function pageRange(sizes, page) {
  let start = 0;
  for (let i = 0; i < page - 1; i++) start += sizes[i] || 0;
  const size = sizes[page - 1] || 0;
  return { start, end: start + size };
}

export function rangeCountText(total, from, to, plural = 'productos', singular = 'producto') {
  if (total === 0) return `0 ${plural}`;
  if (from === 1 && to === total) return `${total} ${total === 1 ? singular : plural}`;
  return `Mostrando ${from}–${to} de ${total} ${plural}`;
}

function pageWindow(page, totalPages, span = 1) {
  const pages = new Set([1, totalPages]);
  for (let p = page - span; p <= page + span; p++) if (p >= 1 && p <= totalPages) pages.add(p);
  return [...pages].sort((a, b) => a - b);
}

export function paginationHtml({ page, totalPages, base = '/' }, action = 'page') {
  if (totalPages <= 1) return h``;
  const href = (n) => (n <= 1 ? base : `${base}?pagina=${n}`);
  let last = 0;
  const nums = [];
  for (const p of pageWindow(page, totalPages)) {
    if (last && p - last > 1) nums.push(h`<span class="pg-gap">…</span>`);
    nums.push(p === page
      ? h`<span class="pg-num" aria-current="page">${p}</span>`
      : h`<a class="pg-num" href="${href(p)}" data-action="${action}" data-page="${p}">${p}</a>`);
    last = p;
  }
  const prev = page > 1 ? h`<a class="btn metal small" rel="prev" href="${href(page - 1)}" data-action="${action}" data-page="${page - 1}">Anterior</a>` : h`<span class="btn metal small is-disabled" aria-disabled="true">Anterior</span>`;
  const next = page < totalPages ? h`<a class="btn metal small" rel="next" href="${href(page + 1)}" data-action="${action}" data-page="${page + 1}">Siguiente</a>` : h`<span class="btn metal small is-disabled" aria-disabled="true">Siguiente</span>`;
  return h`<nav class="pagination" aria-label="Paginación">${prev}<span class="pg-nums">${nums}</span>${next}</nav>`;
}
