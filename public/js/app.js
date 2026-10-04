// Catálogo BodyFactory Gym — frontend sin dependencias.
// Toda cadena que viene de datos pasa por h`` (escapa HTML) para evitar inyección.
// Las plantillas viven en ui.js: el servidor las usa para pintar las páginas en el HTML.
import { Safe, h, icon, stars, usd, img, placeholder, DISCLAIMER, stockInfo, known, hasServings, isRealReview, priceOf as priceIn, perServing as perServingIn, ratingOf as ratingIn, card as cardTpl, chipsHtml, productSheet, productUrl, productSlug, normalizeCategory, categoryLabel, categoryUrl, categoryFromSlug, CATEGORY_ORDER, rangeCountText, paginationHtml, pageSizes, pageRange, ASSET_V } from './ui.js?v=__BUILD__';

const MAX_PAGE_SIZE = 8; // reparto equilibrado automático, ver pageSizes() en ui.js

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];


// ───────────── estado ─────────────
const state = {
  products: [], combos: [], reviews: [], site: null,
  mode: 'retail', cart: [], cat: 'Todas', q: '', sort: 'pop', galGroup: 'Todas', page: 1,
  compareExpanded: false, compareCat: 'Todas',
};
const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* modo privado */ } },
};
state.mode = store.get('bf_mode', 'retail') === 'wholesale' ? 'wholesale' : 'retail';
state.cart = store.get('bf_cart', []);

const byId = (id) => state.products.find((p) => p.id === id);
const priceOf = (p, mode = state.mode) => priceIn(p, mode);
const perServing = (p) => perServingIn(p, state.mode);

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => t.classList.remove('show'), 2600);
}

// Si una foto no carga (red, archivo ausente), se sustituye por el marcador de marca:
// nunca queda un cuadro negro vacío.
document.addEventListener('error', (e) => {
  const t = e.target;
  if (!(t instanceof HTMLImageElement) || t.classList.contains('noimg-mark') || t.dataset.failed) return;
  t.dataset.failed = '1';
  t.insertAdjacentHTML('afterend', placeholder(t.alt).s);
  t.remove();
}, true);

// ───────────── carga de datos ─────────────
async function getJson(url) {
  const r = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!r.ok) throw new Error(url);
  return r.json();
}
async function loadCatalog() {
  try {
    Object.assign(state, await getJson('/api/catalog'));
  } catch {
    // Sin datos del servidor no se muestran precios ni stock que podrían estar desactualizados.
    const grid = $('#grid');
    if (grid) grid.innerHTML = '<p class="muted">No se pudo cargar el catálogo. Revisa tu conexión e intenta de nuevo.</p>';
  }
  sanitizeCart();
}

// Quita del carrito lo que ya no existe en el catálogo.
function sanitizeCart() {
  const valid = new Set(state.products.map((p) => p.id));
  state.cart = state.cart.filter((l) => (l.type === 'combo' ? state.combos.some((c) => c.id === l.id) : valid.has(l.id)));
  saveCart();
}

// El servidor incrusta el catálogo y la configuración en el HTML: arranque sin esperar a la red.
function readBoot() {
  try { return JSON.parse(document.getElementById('boot').textContent); } catch { return null; }
}

// Actualiza en segundo plano si el catálogo cambió desde que se generó la página (o la copia sin conexión).
// Petición condicional (ETag): si nada cambió el servidor responde 304 sin cuerpo y no se repinta nada.
async function revalidate() {
  try {
    const r = await fetch('/api/catalog', { cache: 'no-store', headers: { Accept: 'application/json', ...(state.etag ? { 'If-None-Match': state.etag } : {}) } });
    if (r.status === 304 || !r.ok) return;
    const fresh = await r.json();
    state.etag = r.headers.get('ETag') || '';
    Object.assign(state, fresh); sanitizeCart(); renderAll();
  } catch { /* sin conexión: se queda con lo que ya se ve */ }
}

// ───────────── catálogo ─────────────
function visibleProducts() {
  // Búsqueda sin distinguir mayúsculas ni tildes («proteína» = «PROTEINA»). Solo compara texto: nunca se interpreta como HTML.
  const norm = (s) => String(s ?? '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const q = norm(state.q.trim());
  let list = state.products.filter((p) => (state.cat === 'Todas' || normalizeCategory(p.category) === state.cat)
    && (!q || norm([p.name, p.brand, p.category, normalizeCategory(p.category), p.presentation, ...(p.flavors || [])].join(' ')).includes(q)));
  if (state.sort === 'asc') list.sort((a, b) => priceOf(a) - priceOf(b));
  else if (state.sort === 'desc') list.sort((a, b) => priceOf(b) - priceOf(a));
  else list.sort((a, b) => (b.popularity - a.popularity) || (Number(Boolean(b.image)) - Number(Boolean(a.image))) || a.name.localeCompare(b.name));
  return list;
}

const listBase = () => categoryUrl(state.cat);
function renderChips() {
  const chips = $('#chips');
  if (chips) chips.innerHTML = chipsHtml(state.products, state.cat).s;
  const dc = $('#drawerCats');
  if (dc) dc.innerHTML = chipsHtml(state.products, state.cat).s;
  const lbl = $('#catBtnLabel');
  if (lbl) lbl.textContent = categoryLabel(state.cat);
}

const card = (p, i = 99) => cardTpl(p, i, { mode: state.mode, wa: state.site?.whatsapp });

function renderGrid() {
  if (!$('#grid')) return;
  const list = visibleProducts();
  const total = list.length;
  const sizes = pageSizes(total, MAX_PAGE_SIZE);
  const totalPages = sizes.length;
  if (state.page > totalPages) state.page = totalPages;
  if (state.page < 1) state.page = 1;
  const { start, end } = pageRange(sizes, state.page);
  const pageItems = list.slice(start, end);
  $('#count').textContent = rangeCountText(total, total ? start + 1 : 0, end);
  $('#grid').innerHTML = pageItems.length ? h`${pageItems.map(card)}`.s : '<p class="muted">No encontramos productos con ese filtro.</p>';
  $('#pager').innerHTML = paginationHtml({ page: state.page, totalPages, base: listBase() }).s;
  const h1 = $('#catTitle');
  if (h1 && state.cat !== 'Todas') h1.textContent = categoryLabel(state.cat);
}

// ───────────── navegación (URLs reales, sin recargar) ─────────────
// La lista usa /  ·  /categoria/<slug>  ·  ?pagina=N ; la ficha usa /producto/<slug>.
let listUrl = location.pathname + location.search; // a dónde volver al cerrar una ficha
function listHref() {
  const qs = new URLSearchParams();
  if (state.page > 1) qs.set('pagina', state.page);
  if (state.q.trim()) qs.set('q', state.q.trim());
  const q = qs.toString();
  return listBase() + (q ? `?${q}` : '');
}
function syncListUrl(push) {
  if (document.body.dataset.page === 'product') return;
  const url = listHref();
  listUrl = url;
  if (url !== location.pathname + location.search) history[push ? 'pushState' : 'replaceState']({ list: true }, '', url);
  document.title = state.cat === 'Todas' ? 'BodyFactory Gym | Suplementos en Managua' : `${categoryLabel(state.cat)} | BodyFactory Gym`;
}
function readListUrl() {
  const m = location.pathname.match(/^\/categoria\/([a-z0-9-]+)\/?$/);
  state.cat = (m && categoryFromSlug(m[1])) || 'Todas';
  const sp = new URLSearchParams(location.search);
  state.page = Math.max(1, Number(sp.get('pagina')) || 1);
  state.q = sp.get('q') || '';
  if ($('#q')) $('#q').value = state.q;
}

// ───────────── ficha de producto (mismo componente que la página /producto/...) ─────────────
function openProduct(id, push = true) {
  const p = byId(id);
  if (!p) return;
  const dlg = $('#productDialog');
  dlg.innerHTML = h`<header class="sheet-bar">
      <span class="sheet-bar-title"><span class="brandline">${p.brand}</span> ${p.name}</span>
      <a class="btn metal small sheet-link" href="${productUrl(p)}" data-action="product-page">Página del producto</a>
      <button type="button" class="icon-btn close" data-action="close-dialog" aria-label="Cerrar ficha">${icon('close')}</button>
    </header>
    <div class="sheet-body" tabindex="-1" autofocus>${productSheet(p, { mode: state.mode, reviews: state.reviews.filter(isRealReview), wa: state.site?.whatsapp })}</div>`.s;
  dlg.dataset.id = id;
  if (!dlg.open) dlg.showModal();
  dlg.querySelector('.sheet-body').scrollTop = 0;
  if (push && location.pathname !== productUrl(p)) { history.pushState({ product: id }, '', productUrl(p)); dlg.dataset.pushed = '1'; }
  document.title = `${p.name} | BodyFactory Gym`;
}
const refreshOpenDialog = () => {
  const d = $('#productDialog');
  if (!d.open) return;
  const y = d.querySelector('.sheet-body')?.scrollTop || 0;
  openProduct(d.dataset.id, false);
  d.querySelector('.sheet-body').scrollTop = y;
};
function refreshProductPage() {
  const art = $('#productPage');
  if (!art) return;
  const p = byId(art.dataset.id);
  if (p) art.innerHTML = productSheet(p, { mode: state.mode, reviews: state.reviews.filter(isRealReview), wa: state.site?.whatsapp, page: true }).s;
}

// ───────────── carrito ─────────────
const saveCart = () => store.set('bf_cart', state.cart);
const lineKey = (l) => (l.type === 'combo' ? `combo:${l.id}` : `${l.id}|${l.flavor || ''}`);

function addToCart(line) {
  const key = lineKey(line);
  const cur = state.cart.find((l) => lineKey(l) === key);
  if (cur) cur.qty = Math.min(99, cur.qty + line.qty); else state.cart.push({ ...line });
  saveCart(); renderCartBadge();
  toast('Agregado al carrito');
}
function comboPrice(c) {
  const sum = c.items.reduce((s, i) => s + (byId(i.product) ? priceOf(byId(i.product)) * i.qty : 0), 0);
  return { sum, price: Math.round(sum * (1 - c.discount / 100) * 100) / 100 };
}
function describe(l) {
  if (l.type === 'combo') {
    const c = state.combos.find((x) => x.id === l.id);
    return c ? { name: c.name, sub: c.note, unit: comboPrice(c).price, image: byId(c.items[0]?.product)?.image } : null;
  }
  const p = byId(l.id);
  return p ? { name: p.name, sub: [p.presentation, l.flavor].filter(Boolean).join(' · '), unit: priceOf(p), image: p.image } : null;
}
const cartLines = () => state.cart.map((l) => ({ l, d: describe(l) })).filter((x) => x.d);
const cartTotal = () => cartLines().reduce((s, { l, d }) => s + d.unit * l.qty, 0);

function renderCartBadge() {
  const n = state.cart.reduce((s, l) => s + l.qty, 0);
  $('#cartCount').textContent = n;
  $('[data-action="open-cart"]').setAttribute('aria-label', `Abrir carrito (${n})`); // incluye el número visible
}

function renderCart() {
  const lines = cartLines();
  $('#cartDialog').innerHTML = h`
    <div class="cart-head"><h2>Tu pedido</h2><button type="button" class="btn metal small close" style="position:static;margin:0" data-action="close-dialog" aria-label="Cerrar carrito">${icon('close')}</button></div>
    ${lines.length ? h`
      <div class="cart-lines">${lines.map(({ l, d }) => h`<div class="line">
        ${img(d.image, { alt: '', sizes: '64px', w: 64, hgt: 80 })}
        <div><div class="nm">${d.name}</div><div class="sm">${d.sub} · ${usd(d.unit)} c/u</div>
          <div class="qty"><button type="button" data-action="cq" data-key="${lineKey(l)}" data-d="-1" aria-label="Menos">−</button><output>${l.qty}</output><button type="button" data-action="cq" data-key="${lineKey(l)}" data-d="1" aria-label="Más">+</button></div></div>
        <div><div class="sub">${usd(d.unit * l.qty)}</div><button type="button" class="rm" data-action="rm" data-key="${lineKey(l)}" aria-label="Quitar ${d.name}">${icon('trash')}</button></div>
      </div>`)}</div>
      <div class="cart-foot">
        <div class="total-row"><span>Total (${state.mode === 'retail' ? 'precio normal' : 'mayorista'})</span><strong>${usd(cartTotal())}</strong></div>
        <input class="field" id="custName" type="text" maxlength="80" placeholder="Tu nombre (opcional)" autocomplete="name">
        <input class="field" id="custNotes" type="text" maxlength="300" placeholder="Notas: dirección, hora de entrega… (opcional)">
        <button type="button" class="btn wa block" data-action="send-order">${icon('whatsapp')} Enviar pedido por WhatsApp</button>
        <p class="fine" style="margin:0">${state.site.delivery}. El pedido se confirma por WhatsApp; el precio y la disponibilidad se validan al enviarlo.</p>
      </div>` : h`<div class="empty">${icon('cart')}<p>Tu carrito está vacío.</p><button type="button" class="btn" data-action="close-dialog">Ver productos</button></div>`}
  `.s;
}
function openCart() { renderCart(); const d = $('#cartDialog'); if (!d.open) d.showModal(); }

function waMessage(order, name, notes) {
  const L = [`Hola ${state.site.name} 👋 Quiero hacer este pedido${order.code ? ` (${order.code})` : ''}:`, ''];
  for (const l of order.lines) {
    L.push(`• ${l.qty}× ${l.name}${l.flavor ? ` (${l.flavor})` : ''}${l.presentation ? ` ${l.presentation}` : ''}${l.detail ? ` [${l.detail}]` : ''} — ${usd(l.subtotal)}`);
  }
  L.push('', `Precio: ${order.mode === 'wholesale' ? 'Mayorista' : 'Normal'}`, `Total: ${usd(order.total)}`);
  if (name) L.push(`Nombre: ${name}`);
  if (notes) L.push(`Notas: ${notes}`);
  return L.join('\n');
}

async function sendOrder(btn) {
  const name = $('#custName')?.value.trim() || '';
  const notes = $('#custNotes')?.value.trim() || '';
  // Se abre la pestaña dentro del gesto del usuario para que el navegador no la bloquee.
  const win = window.open('', '_blank');
  btn.disabled = true;
  let order = null;
  try {
    const r = await fetch('/api/orders', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: state.mode, name, notes, items: state.cart.map(({ type, id, flavor, qty }) => ({ type, id, flavor, qty })) }),
    });
    const data = await r.json().catch(() => ({}));
    if (r.ok) order = data;
    else if (r.status >= 400 && r.status < 500) {
      win?.close();
      toast(data.error || 'No se pudo procesar el pedido');
      await loadCatalog(); renderAll(); renderCart();
      return;
    }
  } catch { /* sin servidor: seguimos con el cálculo local para no perder la venta */ }
  if (!order) {
    order = {
      mode: state.mode, total: Math.round(cartTotal() * 100) / 100,
      lines: cartLines().map(({ l, d }) => ({ name: d.name, flavor: l.flavor, qty: l.qty, subtotal: Math.round(d.unit * l.qty * 100) / 100, detail: '' })),
    };
  }
  const url = `https://wa.me/${state.site.whatsappSales || state.site.whatsapp}?text=${encodeURIComponent(waMessage(order, name, notes))}`;
  if (win) win.location.href = url; else location.href = url;
  state.cart = []; saveCart(); renderCartBadge();
  $('#cartDialog').close();
  toast(order.code ? `Pedido ${order.code} registrado` : 'Abriendo WhatsApp…');
  btn.disabled = false;
}

// ───────────── secciones ─────────────
function renderCombos() {
  const list = state.combos;
  $('#combos').hidden = !list.length;
  $('#comboList').innerHTML = h`${list.map((c) => {
    const { sum, price } = comboPrice(c);
    const items = c.items.map((i) => ({ p: byId(i.product), qty: i.qty }));
    const ok = items.every((x) => x.p);
    return h`<article class="combo">
      <h3>${c.name}<span class="off-tag">-${c.discount}%</span></h3>
      <ul>${items.filter((x) => x.p).map((x) => h`<li>${x.qty}× ${x.p.name} (${x.p.presentation})</li>`)}</ul>
      <div><span class="old">${usd(sum)}</span><span class="now">${usd(price)}</span></div>
      <button type="button" class="btn" data-action="add-combo" data-id="${c.id}" ${ok ? '' : 'disabled'}>${icon('cart')} ${ok ? 'Agregar combo' : 'No disponible'}</button>
    </article>`;
  })}`.s;
}

function renderCompare() {
  const all = state.products.filter(hasServings);
  $('#comparador').hidden = !all.length;
  if (!all.length) { $('#compare').innerHTML = ''; return; }

  const order = ['PROTEÍNAS', 'CREATINA', 'PRE-ENTRENOS', 'AMINOÁCIDOS', 'QUEMADORES DE GRASA', 'SOPORTE ARTICULAR', 'SOPORTE HORMONAL', 'OMEGA-3', 'OTROS'];
  const present = new Set(all.map((p) => normalizeCategory(p.category)));
  // Solo tiene sentido comparar dentro de una misma categoría (proteína con proteína, etc.).
  const cats = order.filter((c) => present.has(c));
  if (!cats.includes(state.compareCat)) state.compareCat = cats[0];

  const rows = all
    .filter((p) => normalizeCategory(p.category) === state.compareCat)
    .sort((a, b) => perServing(a) - perServing(b));
  const top = rows.slice(0, 3);
  const next = rows.slice(3, 5);
  const rest = state.compareExpanded ? rows.slice(5) : [];

  const metric = (p) => known(p.macros?.protein) && Number(p.macros.protein) > 0
    ? h`<span class="compare-extra"><b>${p.macros.protein} g</b><small>proteína/porción</small></span>` : '';

  const compactRow = (p, rank) => h`<article class="compare-row">
    <span class="compare-row-rank">${rank}</span>
    <div class="compare-product"><strong>${p.name}</strong><span>${[p.brand, p.presentation].filter(Boolean).join(' · ')}</span></div>
    <span class="compare-row-price"><b>${usd(perServing(p))}</b><small>por porción</small></span>
    <span class="compare-row-meta">${p.servings} porciones · ${usd(priceOf(p))}</span>
  </article>`;

  $('#compare').innerHTML = h`<div class="compare-shell">
    <div class="compare-toolbar">
      <div><span class="eyebrow">Compra inteligente</span><strong>¿Cuánto cuesta realmente cada porción?</strong><p>Calculado con las porciones indicadas en cada envase y el precio ${state.mode === 'retail' ? 'normal' : 'mayorista'} activo.</p></div>
      <div class="chips compare-chips" role="group" aria-label="Categoría del comparador">${cats.map((c) => h`<button type="button" class="chip" data-action="cmp-cat" data-cat="${c}" aria-pressed="${String(c === state.compareCat)}">${categoryLabel(c)}</button>`)}</div>
    </div>
    ${rows.length ? h`
      <div class="compare-podium">
        ${top.map((p, i) => h`<article class="compare-card ${i === 0 ? 'winner' : ''}">
          <div class="compare-card-top"><span class="compare-rank">${i + 1}</span>${i === 0 ? h`<span class="compare-best">Mejor valor</span>` : ''}</div>
          <div class="compare-product"><strong>${p.name}</strong><span>${[p.brand, p.presentation].filter(Boolean).join(' · ')}</span></div>
          <div class="compare-value"><b>${usd(perServing(p))}</b><small>por porción</small></div>
          <div class="compare-metrics">
            <span><b>${usd(priceOf(p))}</b><small>${state.mode === 'retail' ? 'precio normal' : 'precio mayorista'}</small></span>
            <span><b>${p.servings}</b><small>porciones</small></span>
            ${metric(p)}
          </div>
        </article>`) }
      </div>
      ${next.length ? h`<div class="compare-quick">${next.map((p, i) => compactRow(p, i + 4))}</div>` : ''}
      ${rest.length ? h`<div class="compare-expanded"><div class="compare-expanded-head"><span>Comparador completo</span><small>${rows.length} productos</small></div>${rest.map((p, i) => compactRow(p, i + 6))}</div>` : ''}
    ` : h`<p class="muted compare-empty">Todavía no hay productos de esta categoría para comparar.</p>`}
    ${rows.length > 5 ? h`<button type="button" class="btn metal compare-toggle" data-action="cmp-toggle">${state.compareExpanded ? 'Mostrar solo Top 5' : `Ver comparador completo (${rows.length})`}</button>` : ''}
  </div>`.s;
}
function renderReviews() {
  const list = state.reviews.filter(isRealReview).slice(0, 6);
  $('#reviewList').innerHTML = list.length
    ? h`${list.map((r) => h`<article class="review">${stars(r.stars)}<p>${r.text}</p><span class="who">${r.name} · ${byId(r.product)?.name || 'Cliente Body Factory Gym'}</span></article>`)}`.s
    : h`<p class="muted">Todavía no hay reseñas publicadas. ¡Sé el primero en dejar la tuya!</p>`.s;
}

// ───────────── reseña pública ─────────────
function reviewDialogHtml() {
  const opts = state.products.map((p) => h`<option value="${p.id}">${p.name}</option>`);
  return h`<div class="sheet-in">
    <button type="button" class="btn metal close" data-action="close-dialog" aria-label="Cerrar">${icon('close')}</button>
    <h2>Escribir una reseña</h2>
    <form id="reviewForm" class="narrow" novalidate>
      <label>Tu nombre<input class="field" name="name" required maxlength="60" placeholder="Tu nombre" autocomplete="name"></label>
      <fieldset>
        <legend>Calificación</legend>
        <div class="star-pick" role="radiogroup" aria-label="Calificación de 1 a 5 estrellas">
          ${[5, 4, 3, 2, 1].map((n) => h`<label class="star-opt"><input type="radio" name="stars" value="${n}" ${n === 5 ? 'checked' : ''} required> <span aria-hidden="true">${'★'.repeat(n)}</span><span class="sr-only">${n} de 5 estrellas</span></label>`)}
        </div>
      </fieldset>
      <label>¿Sobre qué producto quieres opinar?
        <select class="field" name="product">
          <option value="">Experiencia general con Body Factory Gym</option>
          ${opts}
        </select>
      </label>
      <label>Tu reseña<textarea class="field" name="text" required minlength="10" maxlength="1000" rows="4" placeholder="Cuéntanos tu experiencia..."></textarea></label>
      <label class="checks"><input type="checkbox" name="consent" required> Acepto que mi reseña pueda publicarse en el sitio de Body Factory Gym.</label>
      <p class="err" id="reviewErr"></p>
      <button class="btn" type="submit">Enviar reseña</button>
    </form>
  </div>`;
}
function openReviewDialog() {
  const dlg = $('#reviewDialog');
  dlg.innerHTML = reviewDialogHtml().s;
  if (!dlg.open) dlg.showModal();
}
async function submitReview(form) {
  const btn = form.querySelector('button[type=submit]');
  const errEl = $('#reviewErr');
  errEl.textContent = '';
  const f = new FormData(form);
  const text = String(f.get('text') || '').trim();
  if (text.length < 10) { errEl.textContent = 'La reseña debe tener al menos 10 caracteres.'; return; }
  if (!f.get('consent')) { errEl.textContent = 'Debes aceptar que tu reseña pueda publicarse.'; return; }
  btn.disabled = true;
  btn.textContent = 'Enviando...';
  try {
    const r = await fetch('/api/reviews', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: f.get('name'), stars: Number(f.get('stars')), product: f.get('product') || '', text, consent: f.get('consent') === 'on' }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) { errEl.textContent = data.error || 'No se pudo enviar la reseña.'; btn.disabled = false; btn.textContent = 'Enviar reseña'; return; }
    $('#reviewDialog').innerHTML = h`<div class="sheet-in">
      <button type="button" class="btn metal close" data-action="close-dialog" aria-label="Cerrar">${icon('close')}</button>
      <h2>¡Gracias por tu reseña!</h2>
      <p>La revisaremos antes de publicarla.</p>
      <button type="button" class="btn" data-action="close-dialog">Cerrar</button>
    </div>`.s;
  } catch {
    errEl.textContent = 'No se pudo enviar la reseña. Intenta de nuevo.';
    btn.disabled = false; btn.textContent = 'Enviar reseña';
  }
}

function renderAbout() {
  const s = state.site;
  if ($('#heroDelivery')) $('#heroDelivery').textContent = s.delivery;
  $('#about').innerHTML = h`
    <div class="panel"><h3>${icon('pin')} Ubicación</h3>
      <iframe class="map" title="Mapa de ${s.name}" src="${s.mapEmbed}" loading="lazy" referrerpolicy="no-referrer-when-downgrade"></iframe>
      <span>${s.address}</span>
      <div class="link-row"><a class="btn metal small" href="${s.mapLink}" target="_blank" rel="noopener noreferrer">Cómo llegar</a></div></div>
    <div class="panel"><h3>${icon('clock')} Horario</h3>
      <dl>${s.hours.map((x) => h`<dt>${x.days}</dt><dd>${x.time}</dd>`)}</dl></div>
    <div class="panel"><h3>${icon('truck')} ${s.delivery}</h3>
      <p class="muted" style="margin:0">Llevamos tu pedido sin costo a cualquier punto de Managua. Para otras zonas, coordinamos por WhatsApp.</p>
      <div class="link-row">
        ${s.whatsappSales ? h`<a class="btn wa small" href="https://wa.me/${s.whatsappSales}" target="_blank" rel="noopener noreferrer">${icon('whatsapp')} Ventas y pedidos</a>` : ''}
        <a class="btn wa small" href="https://wa.me/${s.whatsapp}" target="_blank" rel="noopener noreferrer">${icon('whatsapp')} ${s.whatsappSales ? 'Consultas' : 'WhatsApp'}</a>
        <a class="btn metal small" href="${s.instagram}" target="_blank" rel="noopener noreferrer">${icon('instagram')} ${s.instagramHandle}</a>
        ${/^https:\/\//.test(s.facebook || '') ? h`<a class="btn metal small" href="${s.facebook}" target="_blank" rel="noopener noreferrer" aria-label="Facebook de ${s.name} (se abre en otra pestaña)">${icon('facebook')} Facebook</a>` : ''}</div></div>
    ${(s.transfers || []).length ? h`<div class="panel transfers"><h3>${icon('bank')} Transferencias</h3>
      <ul class="transfer-list">${s.transfers.map((t) => h`<li>
        <span class="tr-bank">${t.bank}${t.currency ? h` <span class="tr-cur">${t.currency}</span>` : ''}</span>
        <span class="tr-acc">${t.account}</span>
        ${t.holder ? h`<span class="tr-holder">${t.holder}</span>` : ''}
      </li>`)}</ul></div>` : ''}`.s;
}

// Fotos reales del gimnasio (public/images/gallery/, versiones de 600 y 1000 px). La lista publicada la da
// /api/gallery (fotos de data/site.json que no se quitaron desde el panel + fotos subidas desde el panel);
// si la API no responde se usa la lista de data/site.json.
let galleryList = null;
// Cinta continua: las fotos se desplazan sin pausas (requestAnimationFrame sobre el scroll horizontal de la
// pista, así el deslizamiento manual sigue siendo nativo). La lista se pinta dos o más veces SOLO en el DOM:
// al recorrer una vuelta completa se resta su ancho exacto y el salto es invisible porque el contenido es idéntico.
// Se mueve siempre, también con «reducir movimiento» del sistema (en Windows lo activa el ajuste «Efectos de
// animación» apagado): es un desplazamiento lento, sin destellos ni zoom, y el visitante puede arrastrarlo o usar las flechas.
const GAL_SPEED = 32; // píxeles por segundo
const GAL_IDLE = 180; // ms sin eventos de scroll para dar por terminada una interacción manual
const gal = { raf: 0, last: 0, pos: 0, set: 0, n: 0, visible: true, observer: null, active: false, down: false, idle: 0, dots: 0 };
const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

function renderGallery() {
  const photos = (galleryList || state.site.gallery || []).filter((p) => p && /^[a-z0-9][a-z0-9-]*$/.test(p.file));
  const copies = photos.length < 2 ? 1 : photos.length <= 3 ? 4 : 2; // copias visuales para el bucle infinito
  const slide = (p, i, clone) => h`
      <figure class="gal-slide" ${clone ? new Safe('aria-hidden="true"') : h`aria-roledescription="diapositiva" aria-label="${i + 1} de ${photos.length}"`}>
        <img src="/images/gallery/${p.file}-600.webp?v=${ASSET_V}"
             srcset="/images/gallery/${p.file}-600.webp?v=${ASSET_V} 600w, /images/gallery/${p.file}-1000.webp?v=${ASSET_V} 1000w"
             sizes="(min-width:1000px) 33vw, (min-width:640px) 50vw, 85vw"
             width="600" height="750" alt="${clone ? '' : p.alt}" loading="lazy" decoding="async">
      </figure>`;
  $('#gallery').innerHTML = h`
    <div class="gal-track" id="galTrack" tabindex="0" role="region" aria-roledescription="carrusel" aria-label="Fotos de nuestro gimnasio">${Array.from({ length: copies }, (_, c) => photos.map((p, i) => slide(p, i, c > 0)))}</div>
    <div class="gal-nav">
      <button type="button" class="btn metal small gal-arrow" data-action="gal-prev" aria-label="Foto anterior">‹</button>
      <div class="gal-dots" aria-hidden="true"></div>
      <button type="button" class="btn metal small gal-arrow" data-action="gal-next" aria-label="Foto siguiente">›</button>
    </div>`.s;
  gal.n = photos.length;
  gal.dots = 0;
  const track = $('#galTrack');
  galMeasure();
  gal.pos = 0;
  // Interacción manual (tocar, arrastrar, rueda, teclado): la cinta cede el control mientras dura y vuelve a
  // moverse sola en cuanto el desplazamiento se detiene. El ratón encima y el foco NO la detienen.
  // Con el dedo apoyado la cinta no se mueve; al soltar espera a que termine la inercia y sigue.
  const start = () => { gal.active = true; clearTimeout(gal.idle); };
  const settle = () => { clearTimeout(gal.idle); if (!gal.down) gal.idle = setTimeout(galResume, GAL_IDLE); };
  // El ratón no arrastra la cinta (solo el dedo o un lápiz), así que un clic con ratón no la detiene.
  const down = (e) => { if (e.pointerType === 'mouse') return; gal.down = true; start(); };
  const up = () => { if (!gal.down) return; gal.down = false; settle(); };
  track.addEventListener('pointerdown', down, { passive: true });
  track.addEventListener('touchstart', down, { passive: true });
  // (pointercancel no cuenta como soltar: el navegador lo emite cuando toma el control del arrastre táctil)
  for (const ev of ['pointerup', 'touchend', 'touchcancel']) track.addEventListener(ev, up, { passive: true });
  track.addEventListener('wheel', () => { start(); settle(); }, { passive: true });
  track.addEventListener('keydown', () => { start(); settle(); });
  track.addEventListener('scroll', () => { if (gal.active) settle(); galDots(); }, { passive: true });
  if (!gal.observer && 'IntersectionObserver' in window) {
    gal.observer = new IntersectionObserver(([e]) => { gal.visible = e.isIntersecting; galLoop(); });
    gal.observer.observe($('#gallery'));
  }
  galDots();
  galLoop();
}
// Ancho exacto de una vuelta (distancia entre la primera foto y su primera copia).
function galMeasure() {
  const track = $('#galTrack');
  const s = track ? track.children : [];
  gal.set = s.length > gal.n && gal.n > 1 ? s[gal.n].getBoundingClientRect().left - s[0].getBoundingClientRect().left : 0;
}
function galStep() {
  const s = $('#galTrack')?.children;
  return s && s.length > 1 ? s[1].getBoundingClientRect().left - s[0].getBoundingClientRect().left : 0;
}
// Mantiene la posición dentro de la primera vuelta (el contenido de la copia es idéntico: no se nota).
function galWrap(track) {
  if (!gal.set) return;
  if (gal.pos >= gal.set) gal.pos -= gal.set;
  else if (gal.pos < 0) gal.pos += gal.set;
  track.scrollLeft = gal.pos;
}
function galResume() {
  const track = $('#galTrack');
  if (!track) return;
  gal.active = false;
  gal.pos = track.scrollLeft;
  galWrap(track);
  gal.last = 0;
  galLoop();
}
function galRunning() {
  return !!gal.set && !gal.active && gal.visible && !document.hidden;
}
function galLoop() {
  if (gal.raf || !galRunning()) return;
  gal.last = 0;
  gal.raf = requestAnimationFrame(galFrame);
}
function galFrame(t) {
  gal.raf = 0;
  const track = $('#galTrack');
  if (!track || !galRunning()) return;
  const dt = gal.last ? Math.min(t - gal.last, 100) : 0; // sin saltos al volver de otra pestaña
  gal.last = t;
  gal.pos += (GAL_SPEED * dt) / 1000;
  galWrap(track);
  gal.raf = requestAnimationFrame(galFrame);
}
// Flechas: avanzan o retroceden una foto con desplazamiento suave y luego la cinta sigue sola.
function galGo(d) {
  const track = $('#galTrack');
  const step = galStep();
  if (!track || !step) return;
  gal.active = true;
  clearTimeout(gal.idle);
  gal.pos = track.scrollLeft;
  if (d < 0 && gal.pos < step && gal.set) { gal.pos += gal.set; track.scrollLeft = gal.pos; }
  track.scrollBy({ left: d * step, behavior: reducedMotion() ? 'auto' : 'smooth' });
  gal.idle = setTimeout(galResume, 700);
}
function galDots() {
  const dots = $('#gallery .gal-dots');
  const track = $('#galTrack');
  if (!dots || !track) return;
  if (gal.dots !== gal.n) { dots.innerHTML = '<i></i>'.repeat(gal.n > 1 ? gal.n : 0); gal.dots = gal.n; }
  const step = galStep();
  const i = step ? Math.round(track.scrollLeft / step) % gal.n : 0;
  [...dots.children].forEach((d, k) => d.classList.toggle('on', k === i));
}
window.addEventListener('resize', () => { if ($('#galTrack')) { galMeasure(); gal.pos = $('#galTrack').scrollLeft; } }, { passive: true });
document.addEventListener('visibilitychange', galLoop);
async function loadGallery() {
  try { const list = await getJson('/api/gallery'); if (Array.isArray(list)) galleryList = list; } catch { /* se usa data/site.json */ }
  renderGallery();
}

function renderFaq() {
  $('#faqList').innerHTML = h`${state.site.faq.map((f) => h`<details><summary>${f.q}</summary><p>${f.a}</p></details>`)}`.s;
}

// Lo que se ve al abrir: se pinta primero para que los productos aparezcan cuanto antes.
function renderTop() {
  renderChips(); renderGrid(); renderCartBadge(); syncModeButtons();
}
function syncModeButtons() { $$('.switch button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === state.mode))); }
// Secciones más abajo: se pintan después del primer cuadro.
function renderRest() { if ($('#comboList')) renderCombos(); if ($('#compare')) renderCompare(); if ($('#reviewList')) renderReviews(); }
function renderAll() {
  renderTop(); renderRest();
  refreshOpenDialog(); refreshProductPage();
  if ($('#cartDialog').open) renderCart();
}
// Cede el hilo al navegador para que dibuje antes de seguir.
// Con un tope de 150 ms: en pestañas ocultas requestAnimationFrame se pausa y no debe bloquear el resto.
const nextPaint = () => new Promise((resolve) => {
  let done = false;
  const go = () => { if (!done) { done = true; resolve(); } };
  requestAnimationFrame(() => setTimeout(go, 0));
  setTimeout(go, 150);
});

// ───────────── eventos ─────────────
async function share(id) {
  const p = byId(id);
  const url = `${location.origin}${productUrl(p)}`;
  const data = { title: `${p.name} — ${state.site.name}`, text: `${p.name} ${p.presentation}: ${usd(priceOf(p))}`, url };
  if (navigator.share) { try { await navigator.share(data); } catch { /* cancelado */ } return; }
  try { await navigator.clipboard.writeText(url); toast('Enlace copiado'); } catch { toast(url); }
}

function changeQty(key, d) {
  const l = state.cart.find((x) => lineKey(x) === key);
  if (!l) return;
  l.qty = Math.max(1, Math.min(99, l.qty + d));
  saveCart(); renderCartBadge(); renderCart();
}

// Enlaces reales (<a href>) interceptados: clic normal = sin recargar; Ctrl/Cmd/clic medio = pestaña nueva.
const plainClick = (e) => !(e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button === 1);
function scrollToCatalog() {
  const c = $('#catalogo');
  if (!c) return;
  const top = c.getBoundingClientRect().top + window.scrollY - ($('.topbar')?.offsetHeight || 0) - 8;
  window.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
}
function setMenu(open) {
  const d = $('#menuDrawer');
  if (open && !d.open) d.showModal();
  if (!open && d.open) d.close();
  $$('[data-action="open-menu"]').forEach((b) => b.setAttribute('aria-expanded', String(open)));
}
function toggleSearch(force) {
  const open = force ?? !document.body.classList.contains('search-open');
  document.body.classList.toggle('search-open', open);
  $('.search-toggle')?.setAttribute('aria-expanded', String(open));
  if (open) setTimeout(() => $('#q')?.focus(), 30);
}

document.addEventListener('click', (e) => {
  const t = e.target.closest('[data-action]');
  if (!t) return;
  const { action, id } = t.dataset;
  const isLink = t.tagName === 'A';
  if (isLink && !plainClick(e)) return; // el navegador abre la URL real
  switch (action) {
    case 'mode': state.mode = t.dataset.mode; store.set('bf_mode', state.mode); renderAll(); break;
    case 'cat': {
      if (!$('#grid')) return; // en la página de producto el enlace navega normalmente
      e.preventDefault();
      state.cat = t.dataset.cat; state.page = 1;
      renderChips(); renderGrid(); syncListUrl(true);
      setMenu(false);
      scrollToCatalog();
      break;
    }
    case 'page': {
      if (!$('#grid')) return;
      e.preventDefault();
      state.page = Number(t.dataset.page) || 1;
      renderGrid(); syncListUrl(true); scrollToCatalog();
      break;
    }
    case 'open': e.preventDefault(); openProduct(id); break;
    case 'product-page': break; // enlace normal a la página del producto
    case 'cmp-toggle': state.compareExpanded = !state.compareExpanded; renderCompare(); break;
    case 'cmp-cat': state.compareCat = t.dataset.cat; state.compareExpanded = false; renderCompare(); break;
    case 'gal-prev': case 'gal-next': galGo(action === 'gal-next' ? 1 : -1); break;
    case 'open-menu': setMenu(true); break;
    case 'toggle-search': toggleSearch(); break;
    case 'drawer-link': {
      if (!$('#grid')) return; // fuera del inicio el enlace /#seccion navega normalmente
      e.preventDefault(); setMenu(false);
      const target = $(new URL(t.href).hash);
      if (target) setTimeout(() => target.scrollIntoView({ behavior: 'smooth' }), 60);
      break;
    }
    case 'quick-add': {
      const p = byId(id);
      if (p.flavors.length > 1) { openProduct(id); toast('Elige tu sabor'); } else addToCart({ type: 'product', id, flavor: p.flavors[0] || '', qty: 1 });
      break;
    }
    case 'dq': { const o = t.closest('.buyrow')?.querySelector('output') || $('#dQty'); o.textContent = Math.max(1, Math.min(99, Number(o.textContent) + Number(t.dataset.d))); break; }
    case 'add-detail': {
      const p = byId(id);
      const scope = t.closest('.pd') || document;
      const flavor = p.flavors.length ? scope.querySelector('input[name="flavor"]:checked')?.value || '' : '';
      addToCart({ type: 'product', id, flavor, qty: Number(scope.querySelector('.buyrow output')?.textContent) || 1 });
      break;
    }
    case 'add-combo': addToCart({ type: 'combo', id, qty: 1 }); break;
    case 'share': share(id); break;
    case 'open-cart': openCart(); break;
    case 'open-review': openReviewDialog(); break;
    case 'close-dialog': t.closest('dialog').close(); break;
    case 'cq': changeQty(t.dataset.key, Number(t.dataset.d)); break;
    case 'rm': state.cart = state.cart.filter((l) => lineKey(l) !== t.dataset.key); saveCart(); renderCartBadge(); renderCart(); break;
    case 'send-order': sendOrder(t); break;
    default:
  }
});
// Cierra los diálogos al tocar el fondo (el propio <dialog> recibe el clic fuera del contenido)
$$('dialog').forEach((d) => {
  d.addEventListener('click', (e) => { if (e.target === d) d.close(); });
});
$('#menuDrawer').addEventListener('close', () => $$('[data-action="open-menu"]').forEach((b) => b.setAttribute('aria-expanded', 'false')));
$('#productDialog').addEventListener('close', () => {
  const d = $('#productDialog');
  if (d.dataset.pushed) { d.dataset.pushed = ''; if (history.state?.product) history.back(); else history.replaceState(null, '', listUrl); }
  else if (/^\/producto\//.test(location.pathname) && document.body.dataset.page !== 'product') history.replaceState(null, '', listUrl);
  if (document.body.dataset.page !== 'product') syncListUrl(false);
});
window.addEventListener('popstate', () => {
  const d = $('#productDialog');
  const m = location.pathname.match(/^\/producto\/([a-z0-9-]+)$/);
  if (m && document.body.dataset.page !== 'product') {
    const p = state.products.find((x) => productSlug(x) === m[1]);
    if (p) openProduct(p.id, false);
    return;
  }
  if (d.open) { d.dataset.pushed = ''; d.close(); }
  if ($('#grid')) { readListUrl(); renderChips(); renderGrid(); }
});

const q = $('#q');
q.addEventListener('input', (e) => {
  if (!$('#grid')) return; // fuera del catálogo la búsqueda envía el formulario a /?q=
  clearTimeout(q.t);
  q.t = setTimeout(() => {
    state.q = e.target.value; state.page = 1;
    if (state.q.trim() && state.cat !== 'Todas') { state.cat = 'Todas'; renderChips(); } // la búsqueda recorre todo el catálogo
    renderGrid(); syncListUrl(false);
  }, 140);
});
$('#searchForm').addEventListener('submit', (e) => {
  if (!$('#grid')) return;
  e.preventDefault(); state.q = q.value; state.page = 1; renderGrid(); syncListUrl(true); toggleSearch(false); scrollToCatalog();
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && document.body.classList.contains('search-open')) toggleSearch(false); });
document.addEventListener('change', (e) => {
  if (e.target?.matches?.('[data-sort]')) {
    state.sort = e.target.value;
    $$('[data-sort]').forEach((s) => { s.value = state.sort; });
    state.page = 1; renderGrid(); syncListUrl(false);
  }
});
document.addEventListener('submit', (e) => {
  if (e.target.id === 'reviewForm') { e.preventDefault(); if (!e.target.dataset.busy) submitReview(e.target); }
});

// Enlaces antiguos con #p=<id> (versión anterior del sitio): se abren y se pasa a la URL nueva.
function routeHash() {
  const m = location.hash.match(/^#p=([a-z0-9-]+)$/);
  if (m && byId(m[1])) { history.replaceState(null, '', listUrl); openProduct(m[1]); }
}

// ───────────── arranque ─────────────
async function init() {
  const boot = readBoot();
  try { state.site = boot?.site || await getJson('/data/site.json'); } catch { state.site = { name: 'BodyFactory Gym', whatsapp: '', instagram: '#', instagramHandle: '', address: '', mapEmbed: '', mapLink: '#', hours: [], delivery: 'Delivery gratis en Managua', gallery: [], faq: [] }; }
  if (boot?.catalog) { Object.assign(state, boot.catalog); state.etag = boot.etag || ''; sanitizeCart(); } else await loadCatalog();
  if ($('#grid')) readListUrl();
  if (state.site?.whatsapp && $('#drawerWa')) $('#drawerWa').href = `https://wa.me/${state.site.whatsapp}`;
  if (state.site?.whatsappSales && $('#drawerWaSales')) $('#drawerWaSales').href = `https://wa.me/${state.site.whatsappSales}`;
  // Si el servidor ya dibujó la página con precio normal, no se repinta: solo se enlazan los eventos.
  const painted = document.body.dataset.ssr === '1' && state.mode === 'retail' && boot?.catalog && !state.q;
  if (painted) { renderCartBadge(); syncModeButtons(); } else { renderTop(); refreshProductPage(); }
  const sortSel = $('#sort');
  if (sortSel && sortSel.value !== 'pop') { state.sort = sortSel.value; renderGrid(); }
  await nextPaint();
  renderRest();
  if ($('#about')) renderAbout();
  if ($('#gallery')) loadGallery();
  if ($('#faqList')) renderFaq();
  routeHash();
  setTimeout(revalidate, 1200);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') revalidate(); });
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' }).then((r) => r.update()).catch(() => {});
}
window.addEventListener('hashchange', routeHash);
init();
