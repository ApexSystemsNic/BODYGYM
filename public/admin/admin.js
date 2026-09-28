// Panel de administración BodyFactory Gym. Todo dato dinámico pasa por h`` (escapa HTML).
class Safe { constructor(s) { this.s = s; } }
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const part = (v) => (v instanceof Safe ? v.s : Array.isArray(v) ? v.map(part).join('') : v == null || v === false ? '' : esc(v));
const h = (strings, ...vals) => new Safe(strings.reduce((out, s, i) => out + s + (i < vals.length ? part(vals[i]) : ''), ''));
const raw = (s) => new Safe(s);
const $ = (s, r = document) => r.querySelector(s);
const usd = (n) => '$' + Number(n).toFixed(2);

const BADGES = { 'sin-gluten': 'Sin gluten', keto: 'Keto', halal: 'Halal', 'sin-azucar': 'Sin azúcar' };
const ICONS = 'muscle, bolt, drop, fire, check, leaf, heart';
const STATUSES = ['nuevo', 'confirmado', 'entregado', 'cancelado'];
let products = [];
let tab = 'products';
let prodQuery = '';
let prodPage = 1;
let prodPageSize = 10;
// ── estado de guardado por fila (visibilidad/precio/stock) ──
// pendingEdits: id -> { campo: valor } aún no confirmado por el servidor.
// rowStatus: id -> 'saving' | 'saved' | 'error' (ausente = sin cambios pendientes ni en curso).
// Cualquier repintado (búsqueda, paginación, tamaño de página) lee de aquí primero,
// así un cambio sin guardar nunca se pierde silenciosamente al re-renderizar.
let pendingEdits = {};
let rowStatus = {};
let rowError = {};
let currentPageItems = []; // productos exactos mostrados en la página actual (para acciones masivas)
let bulkBusy = false;
let selectedIds = new Set(); // selección manual de checkboxes, siempre acotada a la página actual
let reviewFilter = 'pending';
let reviewsCache = [];
let reviewProdsCache = [];

const norm = (s) => String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();

function paginationHtmlAdmin(page, totalPages) {
  if (totalPages <= 1) return '';
  const pages = new Set([1, totalPages]);
  for (let p = page - 1; p <= page + 1; p++) if (p >= 1 && p <= totalPages) pages.add(p);
  const sorted = [...pages].sort((a, b) => a - b);
  let last = 0;
  const nums = [];
  for (const p of sorted) {
    if (last && p - last > 1) nums.push(h`<span class="pg-gap">…</span>`);
    nums.push(h`<button type="button" class="pg-num" data-act="page" data-page="${p}" aria-current="${p === page ? 'page' : 'false'}" ${p === page ? 'disabled' : ''}>${p}</button>`);
    last = p;
  }
  return h`<nav class="pagination" aria-label="Paginación de productos">
    <button type="button" class="btn metal small" data-act="page" data-page="${page - 1}" ${page <= 1 ? 'disabled' : ''}>Anterior</button>
    <span class="pg-nums">${nums}</span>
    <button type="button" class="btn metal small" data-act="page" data-page="${page + 1}" ${page >= totalPages ? 'disabled' : ''}>Siguiente</button>
  </nav>`.s;
}

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('show'), 2600);
}

async function api(path, { method = 'GET', body, headers = {} } = {}) {
  const opts = { method, headers: { 'X-Requested-With': 'fetch', ...headers }, credentials: 'same-origin' };
  if (body instanceof Blob) opts.body = body;
  else if (body !== undefined) { opts.body = JSON.stringify(body); opts.headers['Content-Type'] = 'application/json'; }
  const r = await fetch('/api/admin' + path, opts);
  const data = await r.json().catch(() => ({}));
  if (r.status === 401 && path !== '/login') showLogin();
  if (!r.ok) throw new Error(data.error || 'Error inesperado');
  return data;
}
const run = async (fn) => { try { await fn(); } catch (e) { toast(e.message); } };

// ───────────── sesión ─────────────
function showLogin() { $('#app').hidden = true; $('#login').hidden = false; }
async function showApp() { $('#login').hidden = true; $('#app').hidden = false; await render(); refreshReviewBadge(); }

$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  $('#loginErr').textContent = '';
  try {
    await api('/login', { method: 'POST', body: { username: f.get('username'), password: f.get('password') } });
    e.target.reset();
    await showApp();
  } catch (err) { $('#loginErr').textContent = err.message; }
});

$('#tabs').addEventListener('click', (e) => {
  const b = e.target.closest('[data-tab]');
  if (!b) return;
  tab = b.dataset.tab;
  document.querySelectorAll('#tabs .chip').forEach((c) => c.setAttribute('aria-pressed', String(c === b)));
  render();
});

async function render() {
  const view = $('#view');
  if (tab === 'products') await renderProducts(view);
  else if (tab === 'orders') await renderOrders(view);
  else if (tab === 'reviews') await renderReviews(view);
  else renderAccount(view);
}

// ───────────── productos ─────────────
async function renderProducts(view) {
  products = await api('/products');
  prodPage = 1;
  paintProducts(view);
}

// Reemplaza (o agrega) un producto en la lista local con la versión confirmada por el servidor.
function upsertLocal(saved) {
  const i = products.findIndex((x) => x.id === saved.id);
  if (i >= 0) products[i] = saved;
  else products = [...products, saved].sort((a, b) => a.name.localeCompare(b.name));
}

function filteredProducts() {
  const q = norm(prodQuery);
  if (!q) return products;
  return products.filter((p) => [p.name, p.brand, p.category, p.id].some((v) => norm(v).includes(q)));
}

// Valor a mostrar para un campo editable de fila: el cambio pendiente (aún no guardado) tiene prioridad
// sobre el último valor confirmado por el servidor. Así ningún repintado (búsqueda, paginación, tamaño
// de página, edición de otra fila) descarta silenciosamente un cambio que el admin todavía no ha guardado.
function rowValue(p, field) {
  const pe = pendingEdits[p.id];
  return pe && Object.prototype.hasOwnProperty.call(pe, field) ? pe[field] : p[field];
}

function rowStatusHtml(id) {
  const st = rowStatus[id];
  if (st === 'saving') return h`<span class="row-status saving">Guardando…</span>`;
  if (st === 'saved') return h`<span class="row-status ok">Guardado ✓</span>`;
  if (st === 'error') return h`<span class="row-status bad">Error: ${rowError[id] || 'no se pudo guardar'}</span>`;
  if (pendingEdits[id]) return h`<span class="row-status pending">Cambio sin guardar</span>`;
  return '';
}

// Campos que faltan para considerar publicable un producto real (no bloquea nada por sí solo;
// solo se usa para advertir antes de una activación masiva).
function incompleteFields(p) {
  // Solo advertimos por datos realmente imprescindibles para publicar. Stock=0 es válido
  // (la tienda ofrece “Consultar disponibilidad”) y porciones es un dato opcional: ninguno
  // debe producir el falso aviso de “producto incompleto”.
  const missing = [];
  if (!p.image) missing.push('imagen');
  if (!(p.price_retail > 0)) missing.push('precio normal');
  return missing;
}

function paintProducts(view) {
  const filtered = filteredProducts();
  const total = filtered.length;
  const totalPages = Math.max(1, Math.ceil(total / prodPageSize));
  if (prodPage > totalPages) prodPage = totalPages;
  if (prodPage < 1) prodPage = 1;
  const start = (prodPage - 1) * prodPageSize;
  const pageItems = filtered.slice(start, start + prodPageSize);
  currentPageItems = pageItems; // para "Mostrar página" / "Ocultar página": IDs exactos, nunca el número de página
  // La selección solo tiene sentido sobre los productos realmente visibles ahora mismo:
  // descarta cualquier id seleccionado que ya no esté en esta página (cambió búsqueda/página/tamaño).
  const pageIds = new Set(pageItems.map((p) => p.id));
  for (const id of [...selectedIds]) if (!pageIds.has(id)) selectedIds.delete(id);
  const selectedItems = pageItems.filter((p) => selectedIds.has(p.id));
  const countText = total === 0 ? '0 productos'
    : total <= prodPageSize ? `${total} producto${total === 1 ? '' : 's'}`
    : `Mostrando ${start + 1}–${Math.min(start + prodPageSize, total)} de ${total} productos`;
  const n = pageItems.length;

  view.innerHTML = h`
    <div class="bar"><div><h2>Productos</h2><span class="muted">Edita precio y stock en la tabla y pulsa Guardar.</span></div>
      <button class="btn" type="button" data-act="new">+ Nuevo producto</button></div>
    <div class="prod-search">
      <label class="sr" for="prodSearch">Buscar productos</label>
      <input class="field" type="search" id="prodSearch" placeholder="Buscar por nombre, marca, categoría o ID…" value="${prodQuery}" autocomplete="off">
      <button class="btn metal small" type="button" data-act="clear-search" ${prodQuery ? '' : 'hidden'}>Limpiar</button>
      <label class="page-size">Por página
        <select class="field" id="pageSize">
          <option value="10" ${prodPageSize === 10 ? raw('selected') : raw('')}>10</option>
          <option value="20" ${prodPageSize === 20 ? raw('selected') : raw('')}>20</option>
          <option value="50" ${prodPageSize === 50 ? raw('selected') : raw('')}>50</option>
        </select>
      </label>
    </div>
    ${n > 0 ? h`<div class="bulk-actions">
      <div class="bulk-actions-title">Gestión de visibilidad</div>
      <label class="bulk-selectall"><input type="checkbox" id="selectAllBox" ${selectedItems.length === n ? raw('checked') : raw('')} aria-label="Seleccionar todos de esta página"> Seleccionar todos de esta página</label>
      <span class="muted bulk-selected-count">${selectedItems.length} seleccionado${selectedItems.length === 1 ? '' : 's'} de ${n} en esta página</span>
      <div class="bulk-actions-row">
        <button class="btn small" type="button" data-act="bulk-show-selected" ${bulkBusy || !selectedItems.length ? raw('disabled') : raw('')}>Mostrar seleccionados</button>
        <button class="btn small" type="button" data-act="bulk-hide-selected" ${bulkBusy || !selectedItems.length ? raw('disabled') : raw('')}>Ocultar seleccionados</button>
        <span class="bulk-sep"></span>
        <button class="btn metal small" type="button" data-act="bulk-show" ${bulkBusy ? raw('disabled') : raw('')}>Mostrar todos en esta página</button>
        <button class="btn metal small" type="button" data-act="bulk-hide" ${bulkBusy ? raw('disabled') : raw('')}>Ocultar todos en esta página</button>
      </div>
    </div>` : ''}
    <p class="muted" id="prodCount" aria-live="polite">${countText}</p>
    ${total === 0 ? h`<p class="muted">No se encontraron productos con ese criterio.</p>` : h`
    <div class="table-wrap"><table class="tbl">
      <thead><tr><th><input type="checkbox" id="selectAllRows" ${selectedItems.length === n ? raw('checked') : raw('')} aria-label="Seleccionar todos los productos de esta página"></th><th></th><th>Producto</th><th>Precio normal</th><th>Mayorista</th><th>Stock</th><th>Visible</th><th></th></tr></thead>
      <tbody>${pageItems.map((p) => {
        const active = rowValue(p, 'active');
        const saving = rowStatus[p.id] === 'saving';
        const dirty = !!pendingEdits[p.id];
        return h`<tr data-id="${p.id}" class="${active ? '' : 'off'}${dirty ? ' dirty' : ''}">
        <td><input type="checkbox" class="rowSelect" data-id="${p.id}" ${selectedIds.has(p.id) ? raw('checked') : raw('')} aria-label="Seleccionar ${p.name}"></td>
        <td>${p.image ? h`<img class="thumb" src="/${p.image}-400.webp?v=__IMG_V__" alt="" loading="lazy" width="48" height="48">` : ''}</td>
        <td><strong>${p.name}</strong><br><span class="muted">${[p.brand, p.category, p.presentation].filter((v) => String(v ?? '').trim()).join(' · ')}</span><br>${rowStatusHtml(p.id)}</td>
        <td><input class="field" type="number" step="0.01" min="0" data-f="price_retail" value="${rowValue(p, 'price_retail')}" aria-label="Precio normal" ${saving ? raw('disabled') : raw('')}></td>
        <td><input class="field" type="number" step="0.01" min="0" data-f="price_wholesale" value="${rowValue(p, 'price_wholesale')}" aria-label="Precio mayorista" ${saving ? raw('disabled') : raw('')}></td>
        <td><input class="field" type="number" step="1" min="0" data-f="stock" value="${rowValue(p, 'stock')}" aria-label="Stock" ${saving ? raw('disabled') : raw('')}></td>
        <td><input type="checkbox" data-f="active" ${active ? raw('checked') : raw('')} aria-label="Visible en la tienda" ${saving ? raw('disabled') : raw('')}></td>
        <td><div class="acts"><button class="btn small" type="button" data-act="save" ${saving ? raw('disabled') : raw('')}>${saving ? 'Guardando…' : 'Guardar'}</button>
          <button class="btn metal small" type="button" data-act="edit">Editar</button>
          <button class="btn danger small" type="button" data-act="del" aria-label="Eliminar ${p.name}">Eliminar</button></div></td>
      </tr>`;
      })}</tbody></table></div>`}
    ${raw(paginationHtmlAdmin(prodPage, totalPages))}
  `.s;
}

function productForm(p) {
  const isNew = !p;
  p = p || { name: '', brand: '', category: '', presentation: '', flavors: [], price_retail: 0, price_wholesale: 0, stock: 0, servings: 0, serving_size: '', image: '', badges: [], tag: '', popularity: 50, macros: { items: [] }, benefits: [], usage: '', description: '', active: true };
  const m = p.macros || {};
  const num = (name, label, v, step = 'any') => h`<label>${label}<input class="field" type="number" name="${name}" step="${step}" min="0" value="${v}" required></label>`;
  // Macros opcionales: vacío = dato desconocido (no se muestra en la tienda). Solo escribir valores de la etiqueta.
  const opt = (name, label, v) => h`<label>${label}<input class="field" type="number" name="${name}" step="any" min="0" value="${v ?? ''}" placeholder="—"></label>`;
  return h`<form class="form" id="pform" data-id="${p.id || ''}">
    <div class="bar" style="margin:0"><h2>${isNew ? 'Nuevo producto' : 'Editar producto'}</h2><button class="btn metal small" type="button" data-act="close">Cerrar</button></div>
    <div class="cols">
      <label>Nombre<input class="field" name="name" value="${p.name}" required maxlength="120"></label>
      <label>Marca<input class="field" name="brand" value="${p.brand}" maxlength="80"></label>
      <label>Categoría<input class="field" name="category" value="${p.category}" maxlength="60" list="cats" placeholder="Proteínas, Creatina…"></label>
      <label>Presentación<input class="field" name="presentation" value="${p.presentation}" maxlength="80" placeholder="2 lb (908 g)"></label>
    </div>
    <datalist id="cats">${[...new Set(products.map((x) => x.category).filter(Boolean))].map((c) => h`<option value="${c}">`)}</datalist>
    <label>Sabores (separados por coma; vacío si no aplica)<input class="field" name="flavors" value="${p.flavors.join(', ')}"></label>
    <div class="cols">
      ${num('price_retail', 'Precio normal (USD)', p.price_retail, '0.01')}
      ${num('price_wholesale', 'Precio mayorista (USD)', p.price_wholesale, '0.01')}
      ${num('stock', 'Stock (unidades)', p.stock, '1')}
      ${num('servings', 'Porciones por envase (0 = no confirmado)', p.servings, '1')}
      <label>Tamaño de porción<input class="field" name="serving_size" value="${p.serving_size}" maxlength="60" placeholder="1 scoop (30 g)"></label>
      ${num('popularity', 'Popularidad (0-1000, para ordenar)', p.popularity, '1')}
      <label>Etiqueta<select class="field" name="tag"><option value="" ${p.tag === '' ? raw('selected') : raw('')}>Ninguna</option><option value="best" ${p.tag === 'best' ? raw('selected') : raw('')}>Más vendido</option><option value="new" ${p.tag === 'new' ? raw('selected') : raw('')}>Nuevo</option></select></label>
    </div>
    <fieldset><legend>Distintivos</legend><div class="checks">${Object.entries(BADGES).map(([k, v]) => h`<label><input type="checkbox" name="badge" value="${k}" ${p.badges.includes(k) ? raw('checked') : raw('')}>${v}</label>`)}</div></fieldset>
    <fieldset><legend>Macros por porción (deja vacío lo que no esté confirmado en la etiqueta)</legend><div class="cols">
      ${opt('calories', 'Calorías', m.calories)}${opt('protein', 'Proteína (g)', m.protein)}${opt('carbs', 'Carbohidratos (g)', m.carbs)}
      ${opt('sugar', 'Azúcares (g)', m.sugar)}${opt('fat', 'Grasa (g)', m.fat)}${opt('sodium', 'Sodio (mg)', m.sodium)}</div></fieldset>
    <label>Ingredientes activos por porción (uno por línea, formato «ingrediente|cantidad», p. ej. «Cafeína|300 mg»)<textarea class="field" name="items">${(m.items || []).map((x) => `${x.name}|${x.amount}`).join('\n')}</textarea></label>
    <label>Beneficios (uno por línea, formato «icono|texto». Íconos: ${ICONS})<textarea class="field" name="benefits">${p.benefits.map((b) => `${b.icon}|${b.text}`).join('\n')}</textarea></label>
    <label>Modo de uso / dosis<textarea class="field" name="usage" maxlength="1000">${p.usage}</textarea></label>
    <label>Advertencias del producto (una por línea; solo las de la etiqueta o el fabricante)<textarea class="field" name="warnings">${(p.warnings || []).join('\n')}</textarea></label>
    <label>Descripción corta<input class="field" name="description" value="${p.description}" maxlength="600"></label>
    <fieldset><legend>Imagen</legend><div class="imgrow">
      ${p.image ? h`<img id="imgPrev" src="/${p.image}-400.webp?v=__IMG_V__" alt="Imagen actual">` : h`<img id="imgPrev" alt="" hidden>`}
      <div><input type="file" id="imgFile" accept="image/jpeg,image/png,image/webp"><p class="muted" style="margin:6px 0 0;font-size:.8rem">JPG, PNG o WebP (máx. 10 MB). Se convierte y comprime automáticamente a WebP.</p></div>
      <input type="hidden" name="image" value="${p.image}">
    </div></fieldset>
    <label class="checks" style="display:flex;gap:8px;align-items:center"><input type="checkbox" name="active" ${p.active ? raw('checked') : raw('')} style="width:20px;height:20px"> Visible en la tienda</label>
    <button class="btn block" type="submit">Guardar producto</button>
  </form>`;
}

function readForm(form) {
  const f = new FormData(form);
  const n = (k) => Number(f.get(k));
  const opt = (k) => (String(f.get(k) ?? '').trim() === '' ? null : Number(f.get(k))); // vacío = desconocido
  return {
    name: f.get('name'), brand: f.get('brand'), category: f.get('category'), presentation: f.get('presentation'),
    flavors: String(f.get('flavors')).split(',').map((x) => x.trim()).filter(Boolean),
    price_retail: n('price_retail'), price_wholesale: n('price_wholesale'), stock: n('stock'), servings: n('servings'),
    serving_size: f.get('serving_size'), popularity: n('popularity'), tag: f.get('tag'),
    badges: f.getAll('badge'), image: f.get('image'), active: f.get('active') === 'on',
    macros: {
      calories: opt('calories'), protein: opt('protein'), carbs: opt('carbs'), sugar: opt('sugar'), fat: opt('fat'), sodium: opt('sodium'),
      items: String(f.get('items') || '').split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
        const i = l.indexOf('|');
        return i > 0 ? { name: l.slice(0, i).trim(), amount: l.slice(i + 1).trim() } : { name: l, amount: '' };
      }),
    },
    benefits: String(f.get('benefits')).split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
      const i = l.indexOf('|');
      return i > 0 ? { icon: l.slice(0, i).trim(), text: l.slice(i + 1).trim() } : { icon: 'check', text: l };
    }),
    usage: f.get('usage'), description: f.get('description'),
    warnings: String(f.get('warnings') || '').split('\n').map((l) => l.trim()).filter(Boolean),
  };
}

function openForm(p) {
  const dlg = $('#formDlg');
  dlg.innerHTML = productForm(p).s;
  if (!dlg.open) dlg.showModal();
}

$('#view').addEventListener('click', (e) => run(async () => {
  const b = e.target.closest('[data-act]');
  if (!b) return;
  const row = b.closest('tr');
  const p = row && products.find((x) => x.id === row.dataset.id);
  switch (b.dataset.act) {
    case 'new': openForm(null); break;
    case 'edit': openForm(p); break;
    case 'save': {
      if (rowStatus[p.id] === 'saving') break; // evita doble envío por clics repetidos
      const edits = pendingEdits[p.id] || {};
      const body = { ...p, ...edits };
      rowStatus[p.id] = 'saving'; delete rowError[p.id];
      paintProducts($('#view'));
      try {
        const saved = await api(`/products/${p.id}`, { method: 'PUT', body });
        // No se afirma "guardado" hasta confirmar que el servidor persistió exactamente lo enviado.
        const changedFields = Object.keys(edits);
        const mismatch = changedFields.some((k) => JSON.stringify(saved[k]) !== JSON.stringify(edits[k]));
        if (mismatch) throw new Error('El servidor confirmó valores distintos a los enviados; revisa e intenta de nuevo');
        const idx = products.findIndex((x) => x.id === p.id);
        if (idx >= 0) products[idx] = saved;
        delete pendingEdits[p.id];
        rowStatus[p.id] = 'saved';
        toast('Guardado');
        paintProducts($('#view'));
        setTimeout(() => { if (rowStatus[p.id] === 'saved') { delete rowStatus[p.id]; paintProducts($('#view')); } }, 2000);
      } catch (err) {
        rowStatus[p.id] = 'error'; rowError[p.id] = err.message;
        paintProducts($('#view'));
        toast(err.message);
      }
      break;
    }
    case 'bulk-show': openBulkConfirm(true, currentPageItems, 'todos en esta página'); break;
    case 'bulk-hide': openBulkConfirm(false, currentPageItems, 'todos en esta página'); break;
    case 'bulk-show-selected': openBulkConfirm(true, currentPageItems.filter((x) => selectedIds.has(x.id)), 'los seleccionados'); break;
    case 'bulk-hide-selected': openBulkConfirm(false, currentPageItems.filter((x) => selectedIds.has(x.id)), 'los seleccionados'); break;
    case 'del':
      if (confirm(`¿Eliminar «${p.name}»? Esta acción no se puede deshacer.`)) {
        await api(`/products/${p.id}`, { method: 'DELETE' });
        products = products.filter((x) => x.id !== p.id);
        toast('Producto eliminado'); paintProducts($('#view'));
      }
      break;
    case 'del-review':
      if (confirm('¿Eliminar esta reseña? Esta acción no se puede deshacer.')) { await api(`/reviews/${b.dataset.id}`, { method: 'DELETE' }); toast('Reseña eliminada'); await render(); await refreshReviewBadge(); }
      break;
    case 'approve-review':
      await api(`/reviews/${b.dataset.id}/status`, { method: 'PATCH', body: { status: 'approved' } });
      toast('Reseña aprobada y publicada'); await render(); await refreshReviewBadge();
      break;
    case 'reject-review':
      await api(`/reviews/${b.dataset.id}/status`, { method: 'PATCH', body: { status: 'rejected' } });
      toast('Reseña rechazada'); await render(); await refreshReviewBadge();
      break;
    case 'review-filter':
      reviewFilter = b.dataset.status; paintReviews($('#view'));
      break;
    case 'clear-search':
      prodQuery = ''; prodPage = 1; paintProducts($('#view'));
      $('#prodSearch')?.focus();
      break;
    case 'page': {
      const pnum = Number(b.dataset.page);
      if (pnum >= 1) {
        prodPage = pnum; paintProducts($('#view'));
        // Lleva al inicio del listado (debajo de la barra fija) para ver la nueva página desde arriba.
        const top = $('#prodSearch').getBoundingClientRect().top + window.scrollY - ($('.topbar')?.offsetHeight || 0) - 12;
        if (top < window.scrollY) window.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
      }
      break;
    }
    default:
  }
}));

$('#view').addEventListener('input', (e) => {
  if (e.target.id === 'prodSearch') {
    prodQuery = e.target.value;
    prodPage = 1;
    const sel = e.target.selectionStart;
    paintProducts($('#view'));
    const el = $('#prodSearch');
    if (el) { el.focus(); try { el.setSelectionRange(sel, sel); } catch { /* ignorar */ } }
    return;
  }
  // Edición de precio/stock/visibilidad directamente en la tabla: se guarda como "cambio pendiente"
  // en memoria (no en el servidor todavía) para que un repintado posterior no lo pierda.
  const f = e.target.dataset.f;
  const row = e.target.closest('tr[data-id]');
  if (!f || !row) return;
  const id = row.dataset.id;
  const val = e.target.type === 'checkbox' ? e.target.checked : Number(e.target.value);
  pendingEdits[id] = { ...pendingEdits[id], [f]: val };
  delete rowStatus[id]; delete rowError[id]; // una nueva edición limpia el estado de guardado/error anterior
  const sel = e.target.selectionStart;
  paintProducts($('#view'));
  const again = document.querySelector(`tr[data-id="${CSS.escape(id)}"] [data-f="${CSS.escape(f)}"]`);
  if (again) {
    again.focus();
    if (again.type !== 'checkbox') { try { again.setSelectionRange(sel, sel); } catch { /* ignorar */ } }
  }
});

$('#formDlg').addEventListener('click', (e) => run(async () => {
  if (e.target === $('#formDlg') || e.target.closest('[data-act=close]')) $('#formDlg').close();
}));
$('#formDlg').addEventListener('change', (e) => run(async () => {
  if (e.target.id !== 'imgFile' || !e.target.files[0]) return;
  const file = e.target.files[0];
  const form = $('#pform');
  let id = form.dataset.id;
  if (!id) { // producto nuevo: la imagen se sube después de crearlo
    toast('Guarda el producto primero y luego súbele la imagen (Editar).'); e.target.value = ''; return;
  }
  toast('Subiendo…');
  const { image } = await api(`/products/${id}/image`, { method: 'POST', body: file, headers: { 'Content-Type': file.type } });
  form.elements.image.value = image;
  const prev = $('#imgPrev'); prev.src = `/${image}-400.webp`; prev.hidden = false;
  toast('Imagen lista. Pulsa «Guardar producto».');
}));
$('#formDlg').addEventListener('submit', (e) => {
  e.preventDefault();
  run(async () => {
    const id = e.target.dataset.id;
    const body = readForm(e.target);
    const saved = await api(id ? `/products/${id}` : '/products', { method: id ? 'PUT' : 'POST', body });
    $('#formDlg').close(); toast('Producto guardado');
    // Actualización puntual: solo se reemplaza el producto guardado (sin volver a pedir el listado).
    upsertLocal(saved);
    if (tab === 'products') paintProducts($('#view')); else await render();
  });
});

// ───────────── acciones masivas: mostrar/ocultar SOLO la página actual ─────────────
// bulkPending guarda los IDs exactos capturados en el momento de abrir el diálogo (no el número de
// página): así, aunque el listado cambie mientras el admin decide, el backend valida esos IDs contra
// el estado real de la base y rechaza la operación completa si alguno ya no coincide.
let bulkPending = null; // { active, ids }

function bulkConfirmHtml(active, items, scopeLabel) {
  const n = items.length;
  const incompletos = active ? items.map((p) => ({ p, missing: incompleteFields(p) })).filter((x) => x.missing.length) : [];
  const titulo = active ? `Mostrar ${scopeLabel}` : `Ocultar ${scopeLabel}`;
  return h`<div class="sheet-in">
    <h2>${titulo}</h2>
    <p>${active ? `Se marcarán como visibles en la tienda estos ${n} producto${n === 1 ? '' : 's'} (${scopeLabel}):` : `Se ocultarán de la tienda estos ${n} producto${n === 1 ? '' : 's'} (${scopeLabel}):`}</p>
    <ul class="bulk-list">${items.map((p) => h`<li>${p.name} <span class="muted">(${p.id})</span></li>`)}</ul>
    ${incompletos.length ? h`<div class="warn"><h3>⚠ ${incompletos.length} producto${incompletos.length === 1 ? '' : 's'} incompleto${incompletos.length === 1 ? '' : 's'}</h3>
      <p>Aún no tienen todos los datos confirmados. Si continúas, quedarán visibles para los clientes tal como están:</p>
      <ul>${incompletos.map((x) => h`<li><strong>${x.p.name}</strong>: falta ${x.missing.join(', ')}</li>`)}</ul>
    </div>` : ''}
    <p class="muted">Ningún otro producto fuera de esta lista será modificado.</p>
    <div class="bar" style="justify-content:flex-end;margin-top:6px">
      <button class="btn metal small" type="button" data-act="bulk-cancel">Cancelar</button>
      <button class="btn small" type="button" data-act="bulk-confirm">${incompletos.length ? 'Confirmar de todas formas' : `Confirmar (${n})`}</button>
    </div>
  </div>`;
}

function openBulkConfirm(active, items, scopeLabel) {
  if (!items.length) return;
  bulkPending = { active, ids: items.map((p) => p.id) };
  const dlg = $('#bulkDlg');
  dlg.innerHTML = bulkConfirmHtml(active, items, scopeLabel).s;
  if (!dlg.open) dlg.showModal();
}

$('#bulkDlg').addEventListener('click', (e) => run(async () => {
  const b = e.target.closest('[data-act]');
  if (!b) { if (e.target === $('#bulkDlg')) $('#bulkDlg').close(); return; }
  if (b.dataset.act === 'bulk-cancel') { $('#bulkDlg').close(); return; }
  if (b.dataset.act === 'bulk-confirm') {
    if (bulkBusy) return; // evita doble aplicación por clics repetidos
    bulkBusy = true; b.disabled = true; b.textContent = 'Aplicando…';
    try {
      const { active, ids } = bulkPending;
      const res = await api('/products/bulk-active', { method: 'POST', body: { ids, active } });
      $('#bulkDlg').close();
      ids.forEach((id) => selectedIds.delete(id));
      toast(`${res.changed} producto${res.changed === 1 ? '' : 's'} ${active ? 'mostrado' : 'ocultado'}${res.changed === 1 ? '' : 's'}`);
      const changed = new Set(res.ids);
      products = products.map((x) => (changed.has(x.id) ? { ...x, active: res.active } : x));
      paintProducts($('#view'));
    } catch (err) {
      b.disabled = false; b.textContent = 'Reintentar';
      toast(err.message);
    } finally {
      bulkBusy = false;
    }
  }
}));

// ───────────── pedidos ─────────────
async function renderOrders(view) {
  const orders = await api('/orders');
  view.innerHTML = h`<div class="bar"><div><h2>Pedidos</h2><span class="muted">Historial de pedidos armados en el carrito y enviados a WhatsApp.</span></div></div>
    ${orders.length ? orders.map((o) => {
      const when = new Date(o.created_at.replace(' ', 'T') + 'Z').toLocaleString('es-NI');
      return h`<article class="order"><header><div class="order-title"><strong>${o.code}</strong><span class="muted">${when} · ${o.price_mode === 'wholesale' ? 'Mayorista' : 'Normal'}</span></div>
        <div class="order-controls"><label class="sr" for="order-status-${o.id}">Estado del pedido ${o.code}</label><select id="order-status-${o.id}" class="field order-status status-${o.status}" data-order="${o.id}" aria-label="Estado del pedido ${o.code}">${STATUSES.map((s) => h`<option value="${s}" ${o.status === s ? raw('selected') : raw('')}>${s[0].toUpperCase() + s.slice(1)}</option>`)}</select>
        <button class="btn danger small order-delete" type="button" data-act="delete-order" data-order-id="${o.id}" data-order-code="${o.code}">Eliminar</button></div></header>
        <ul>${o.lines.map((l) => h`<li>${l.qty}× ${l.name}${l.flavor ? ` (${l.flavor})` : ''} — ${usd(l.subtotal)}</li>`)}</ul>
        <div><strong>Total ${usd(o.total)}</strong>${o.customer_name ? h` · ${o.customer_name}` : ''}${o.notes ? h` · <span class="muted">${o.notes}</span>` : ''}</div></article>`;
    }) : h`<p class="muted">Aún no hay pedidos registrados.</p>`}`.s;
}

let deleteOrderPending = null;
function openDeleteOrder(id, code) {
  deleteOrderPending = { id, code };
  const dlg = $('#orderDeleteDlg');
  dlg.innerHTML = h`<form class="sheet-in order-delete-form" id="orderDeleteForm">
    <h2>Eliminar pedido ${code}</h2>
    <p>Esta acción elimina el pedido del historial. Confirma con la contraseña actual del administrador.</p>
    <label>Contraseña<input class="field" type="password" name="password" autocomplete="current-password" required></label>
    <p class="err" id="orderDeleteErr" role="alert"></p>
    <div class="bar" style="justify-content:flex-end"><button class="btn metal" type="button" data-act="cancel-delete-order">Cancelar</button><button class="btn danger" type="submit">Eliminar pedido</button></div>
  </form>`.s;
  dlg.showModal();
  dlg.querySelector('input[name=password]')?.focus();
}

$('#orderDeleteDlg').addEventListener('click', (e) => {
  if (e.target === $('#orderDeleteDlg') || e.target.closest('[data-act="cancel-delete-order"]')) $('#orderDeleteDlg').close();
});
$('#orderDeleteDlg').addEventListener('submit', (e) => run(async () => {
  e.preventDefault();
  if (!deleteOrderPending) return;
  const form = e.target;
  const password = new FormData(form).get('password');
  const submit = form.querySelector('button[type=submit]');
  submit.disabled = true; submit.textContent = 'Eliminando…';
  try {
    await api(`/orders/${deleteOrderPending.id}`, { method: 'DELETE', body: { password } });
    $('#orderDeleteDlg').close();
    toast(`Pedido ${deleteOrderPending.code} eliminado`);
    deleteOrderPending = null;
    await renderOrders($('#view'));
  } catch (err) {
    $('#orderDeleteErr').textContent = err.message;
    submit.disabled = false; submit.textContent = 'Eliminar pedido';
  }
}));

$('#view').addEventListener('click', (e) => {
  const b = e.target.closest('[data-act="delete-order"]');
  if (b) openDeleteOrder(Number(b.dataset.orderId), b.dataset.orderCode);
});

// Cambios de estado de pedidos y controles de selección/tabla de productos.
$('#view').addEventListener('change', (e) => run(async () => {
  if (e.target.dataset.order) {
    await api(`/orders/${e.target.dataset.order}`, { method: 'PATCH', body: { status: e.target.value } });
    e.target.className = `field order-status status-${e.target.value}`;
    toast('Estado actualizado');
  } else if (e.target.id === 'pageSize') {
    prodPageSize = Number(e.target.value); prodPage = 1; selectedIds.clear(); paintProducts($('#view'));
  } else if (e.target.id === 'selectAllRows' || e.target.id === 'selectAllBox') {
    const checked = e.target.checked;
    if (checked) currentPageItems.forEach((p) => selectedIds.add(p.id));
    else currentPageItems.forEach((p) => selectedIds.delete(p.id));
    document.querySelectorAll('.rowSelect').forEach((box) => { box.checked = checked; });
    const a = $('#selectAllRows'), b = $('#selectAllBox');
    if (a) a.checked = checked; if (b) b.checked = checked;
    const count = document.querySelector('.bulk-selected-count');
    if (count) count.textContent = `${checked ? currentPageItems.length : 0} seleccionado${checked && currentPageItems.length === 1 ? '' : 's'} de ${currentPageItems.length} en esta página`;
    document.querySelectorAll('[data-act="bulk-show-selected"],[data-act="bulk-hide-selected"]').forEach((btn) => { btn.disabled = !checked || bulkBusy; });
  } else if (e.target.classList.contains('rowSelect')) {
    const id = e.target.dataset.id;
    if (e.target.checked) selectedIds.add(id); else selectedIds.delete(id);
    const n = currentPageItems.filter((p) => selectedIds.has(p.id)).length;
    const all = n === currentPageItems.length && n > 0;
    const a = $('#selectAllRows'), b = $('#selectAllBox');
    if (a) a.checked = all; if (b) b.checked = all;
    const count = document.querySelector('.bulk-selected-count');
    if (count) count.textContent = `${n} seleccionado${n === 1 ? '' : 's'} de ${currentPageItems.length} en esta página`;
    document.querySelectorAll('[data-act="bulk-show-selected"],[data-act="bulk-hide-selected"]').forEach((btn) => { btn.disabled = n === 0 || bulkBusy; });
  }
}));

// ───────────── reseñas ─────────────
const REVIEW_FILTERS = [['all', 'Todas'], ['pending', 'Pendientes'], ['approved', 'Aprobadas'], ['rejected', 'Rechazadas']];
async function refreshReviewBadge() {
  try {
    const pending = await api('/reviews?status=pending');
    const el = $('#revBadge');
    if (el) el.textContent = pending.length ? ` [${pending.length} pendiente${pending.length === 1 ? '' : 's'}]` : '';
  } catch { /* no bloquea el resto del panel */ }
}
async function renderReviews(view) {
  const [reviews, prods] = await Promise.all([api('/reviews'), api('/products')]);
  reviewsCache = reviews; reviewProdsCache = prods;
  paintReviews(view);
  refreshReviewBadge();
}
function paintReviews(view) {
  const prods = reviewProdsCache;
  const name = (id) => (id ? prods.find((p) => p.id === id)?.name || id : 'Experiencia general');
  const list = reviewFilter === 'all' ? reviewsCache : reviewsCache.filter((r) => r.status === reviewFilter);
  const badgeCls = { pending: 'row-status pending', approved: 'row-status ok', rejected: 'row-status bad' };
  view.innerHTML = h`<div class="bar"><div><h2>Reseñas</h2><span class="muted">Modera las reseñas enviadas desde la tienda; también puedes agregar una manualmente.</span></div></div>
    <form class="rev-form" id="revForm">
      <label>Producto<select class="field" name="product"><option value="">Experiencia general</option>${prods.map((p) => h`<option value="${p.id}">${p.name}</option>`)}</select></label>
      <label>Cliente<input class="field" name="name" required maxlength="60"></label>
      <label>Estrellas<select class="field" name="stars">${[5, 4, 3, 2, 1].map((n) => h`<option value="${n}">${n} ★</option>`)}</select></label>
      <label style="grid-column:1/-1">Comentario<input class="field" name="text" maxlength="500"></label>
      <button class="btn" type="submit">Agregar reseña (se publica de inmediato)</button>
    </form>
    <div class="chips" role="group" aria-label="Filtrar reseñas" style="margin:16px 0">
      ${REVIEW_FILTERS.map(([k, label]) => h`<button type="button" class="chip" data-act="review-filter" data-status="${k}" aria-pressed="${reviewFilter === k ? 'true' : 'false'}">${label} (${k === 'all' ? reviewsCache.length : reviewsCache.filter((r) => r.status === k).length})</button>`)}
    </div>
    ${list.length ? list.map((r) => h`<div class="rev-item">
        <div><strong>${'★'.repeat(r.stars)}</strong> ${r.name} · <span class="muted">${name(r.product)}</span> · <span class="${badgeCls[r.status] || 'row-status'}">${r.status}</span><br><span>${r.text}</span><br><span class="muted" style="font-size:.78rem">${r.created_at}</span></div>
        <div class="acts">
          ${r.status !== 'approved' ? h`<button class="btn small" type="button" data-act="approve-review" data-id="${r.id}">Aprobar</button>` : ''}
          ${r.status !== 'rejected' ? h`<button class="btn metal small" type="button" data-act="reject-review" data-id="${r.id}">Rechazar</button>` : ''}
          <button class="btn danger small" type="button" data-act="del-review" data-id="${r.id}">Eliminar</button>
        </div>
      </div>`) : h`<p class="muted">No hay reseñas en este filtro.</p>`}`.s;
}
$('#view').addEventListener('submit', (e) => {
  e.preventDefault();
  run(async () => {
    if (e.target.id === 'revForm') {
      const f = Object.fromEntries(new FormData(e.target));
      await api('/reviews', { method: 'POST', body: { ...f, stars: Number(f.stars) } });
      toast('Reseña agregada'); await render();
    } else if (e.target.id === 'pwForm') {
      const f = Object.fromEntries(new FormData(e.target));
      if (f.next !== f.again) throw new Error('Las contraseñas nuevas no coinciden');
      await api('/password', { method: 'POST', body: { current: f.current, next: f.next } });
      e.target.reset(); toast('Contraseña actualizada');
    }
  });
});

// ───────────── cuenta ─────────────
function renderAccount(view) {
  view.innerHTML = h`<h2>Cuenta</h2>
    <form class="narrow panel" id="pwForm">
      <label>Contraseña actual<input class="field" type="password" name="current" autocomplete="current-password" required></label>
      <label>Nueva contraseña (mín. 8 caracteres)<input class="field" type="password" name="next" minlength="8" autocomplete="new-password" required></label>
      <label>Repite la nueva contraseña<input class="field" type="password" name="again" minlength="8" autocomplete="new-password" required></label>
      <button class="btn" type="submit">Cambiar contraseña</button>
    </form>
    <p><button class="btn metal" type="button" id="logout">Cerrar sesión</button></p>`.s;
  $('#logout').addEventListener('click', () => run(async () => { await api('/logout', { method: 'POST' }); showLogin(); }));
}

// ───────────── arranque ─────────────
(async () => {
  try { await api('/me'); await showApp(); } catch { showLogin(); }
})();
