import { createServer } from 'node:http';
import { readFile, stat, mkdir } from 'node:fs/promises';
import { dirname, join, extname, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, createHash } from 'node:crypto';
import { gzipSync, brotliCompressSync, constants as zc } from 'node:zlib';
import { db, hydrate, saveProduct, hashPassword, verifyPassword } from './db.js';
import { esc, categoryFromSlug, productUrl, normalizeCategory, categoryUrl, CATEGORY_ORDER, ASSET_V } from '../public/js/ui.js'; // mismas plantillas que el navegador
import { productWebp, PRODUCT_SIZES } from './images.js';
import { buildCatalogPage, buildProductPage, buildNotFound, findProductBySlug, findProductById, footNav, drawerCats, imagePreload, safeJson, DISCLAIMER } from './pages.js';

// Sharp solo se carga cuando el admin procesa una imagen. Así el sitio público no
// se cae al arrancar si la dependencia nativa aún no está disponible en el sistema.
let sharpLoader = null;
async function getSharp() {
  if (!sharpLoader) sharpLoader = import('sharp').then((m) => m.default);
  return sharpLoader;
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const publicDir = join(root, 'public');
const PORT = Number(process.env.PORT) || 3000;
const SECURE_COOKIE = process.env.NODE_ENV === 'production';
// ── SEO / indexación ──
// SITE_URL = dominio público definitivo, sin "/" final (p. ej. https://www.midominio.com).
// ALLOW_INDEXING=true solo en producción. Sin ambas variables el sitio responde
// "noindex" y robots.txt bloquea el rastreo: el localhost nunca se indexa.
const SITE_URL = String(process.env.SITE_URL || '').trim().replace(/\/+$/, '');
const INDEXABLE = process.env.ALLOW_INDEXING === 'true' && /^https:\/\//.test(SITE_URL);
const originOf = (req) => SITE_URL || `http://${req.headers.host || `localhost:${PORT}`}`;

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
};
const COMPRESSIBLE = new Set(['.html', '.css', '.js', '.json', '.svg', '.webmanifest']);
const TAGS = new Set(['', 'best', 'new']);
const BADGES = new Set(['sin-gluten', 'keto', 'halal', 'sin-azucar']);
const ORDER_STATUS = new Set(['nuevo', 'confirmado', 'entregado', 'cancelado']);

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// ───────────── utilidades HTTP ─────────────
function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'X-Content-Type-Options': 'nosniff', ...headers });
  res.end(body);
}
const json = (res, status, data) =>
  send(res, status, JSON.stringify(data), { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });

async function readBody(req, limit) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new HttpError(413, 'Cuerpo demasiado grande');
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}
async function readJson(req) {
  const raw = await readBody(req, 256 * 1024);
  try { return raw.length ? JSON.parse(raw.toString('utf8')) : {}; } catch { throw new HttpError(400, 'JSON inválido'); }
}

// ───────────── sesiones admin ─────────────
const sessions = new Map(); // token -> { user, exp }
const SESSION_MS = 8 * 60 * 60 * 1000;
const attempts = new Map(); // clave -> { n, until }

function cookieOf(req, name) {
  const m = (req.headers.cookie || '').split(/;\s*/).find((c) => c.startsWith(name + '='));
  return m ? decodeURIComponent(m.slice(name.length + 1)) : null;
}
function sessionOf(req) {
  const t = cookieOf(req, 'bf_session');
  const s = t && sessions.get(t);
  if (!s) return null;
  if (s.exp < Date.now()) { sessions.delete(t); return null; }
  return { token: t, user: s.user };
}
function requireAdmin(req) {
  const s = sessionOf(req);
  if (!s) throw new HttpError(401, 'No autorizado');
  // Defensa CSRF: los formularios entre sitios no pueden enviar este encabezado.
  if (req.method !== 'GET' && req.headers['x-requested-with'] !== 'fetch') throw new HttpError(403, 'Solicitud no válida');
  return s;
}
const cookieHeader = (token, maxAge) =>
  `bf_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${SECURE_COOKIE ? '; Secure' : ''}`;

// ───────────── validación ─────────────
const str = (v, max) => String(v ?? '').trim().slice(0, max);
const num = (v, min = 0, max = 1e6) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) throw new HttpError(400, 'Valor numérico inválido');
  return n;
};
const money = (n) => Math.round(n * 100) / 100;
const slugify = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);

function normalizeProduct(b, id) {
  const name = str(b.name, 120);
  if (!name) throw new HttpError(400, 'El nombre es obligatorio');
  const m = b.macros || {};
  // null / vacío = dato desconocido (no se muestra). Un 0 enviado explícitamente se conserva como 0.
  const macro = (k) => (m[k] === null || m[k] === undefined || m[k] === '' ? null : num(m[k], 0, 100000));
  const items = (Array.isArray(m.items) ? m.items : []).slice(0, 20)
    .map((x) => ({ name: str(x?.name, 80), amount: str(x?.amount, 40) })).filter((x) => x.name);
  return {
    id,
    name,
    brand: str(b.brand, 80),
    category: str(b.category, 60),
    presentation: str(b.presentation, 80),
    flavors: (Array.isArray(b.flavors) ? b.flavors : []).map((f) => str(f, 50)).filter(Boolean).slice(0, 30),
    price_retail: money(num(b.price_retail)),
    price_wholesale: money(num(b.price_wholesale)),
    stock: Math.floor(num(b.stock, 0, 100000)),
    servings: Math.floor(num(b.servings ?? 0, 0, 10000)), // 0 = porciones no confirmadas (se ocultan)
    serving_size: str(b.serving_size, 60),
    image: str(b.image, 200).replace(/^\/+/, ''),
    badges: (Array.isArray(b.badges) ? b.badges : []).filter((x) => BADGES.has(x)),
    tag: TAGS.has(b.tag) ? b.tag : '',
    popularity: Math.floor(num(b.popularity ?? 0, 0, 1000)),
    macros: { calories: macro('calories'), protein: macro('protein'), carbs: macro('carbs'), sugar: macro('sugar'), fat: macro('fat'), sodium: macro('sodium'), items },
    benefits: (Array.isArray(b.benefits) ? b.benefits : []).slice(0, 8)
      .map((x) => ({ icon: str(x.icon, 20) || 'check', text: str(x.text, 200) })).filter((x) => x.text),
    usage: str(b.usage, 1000),
    warnings: (Array.isArray(b.warnings) ? b.warnings : []).map((w) => str(w, 240)).filter(Boolean).slice(0, 12),
    description: str(b.description, 600),
    active: b.active !== false,
  };
}

// ───────────── API pública ─────────────
const publicProductsStmt = db.prepare("SELECT * FROM products WHERE active = 1 ORDER BY popularity DESC, CASE WHEN image <> '' THEN 0 ELSE 1 END, name");
const publicCombosStmt = db.prepare('SELECT * FROM combos WHERE active = 1');
const publicProducts = () => publicProductsStmt.all().map(hydrate);
const publicCombos = () => publicCombosStmt.all().map((c) => ({ ...c, items: JSON.parse(c.items), active: !!c.active }));

const approvedReviewsStmt = db.prepare("SELECT id, product, name, stars, text, created_at FROM reviews WHERE status = 'approved' AND name <> 'Cliente de ejemplo' AND text NOT LIKE 'Texto de ejemplo:%' ORDER BY id DESC");
const approvedReviews = () => approvedReviewsStmt.all();

const priceOf = (p, mode) => (mode === 'wholesale' ? p.price_wholesale : p.price_retail);

// ───────────── catálogo en caché (una sola respuesta para todo el frontend) ─────────────
let catalog = null; // { json, data, etag, dataVersion }
const invalidateCatalog = () => { catalog = null; };
const dataVersion = () => Number(db.prepare('PRAGMA data_version').get()?.data_version || 0);
function getCatalog() {
  // PRAGMA data_version cambia cuando otra conexión modifica SQLite. Esto evita que
  // una actualización manual de la base deje el catálogo público sirviendo datos viejos
  // hasta reiniciar Node. Los cambios hechos por este mismo proceso siguen usando
  // invalidateCatalog() en las rutas admin.
  const version = dataVersion();
  if (!catalog || catalog.dataVersion !== version) {
    const data = {
      products: publicProducts(),
      combos: publicCombos(),
      reviews: approvedReviews(),
    };
    const json = JSON.stringify(data);
    catalog = { json, data, etag: `"${createHash('sha1').update(json).digest('base64url').slice(0, 16)}"`, dataVersion: version };
  }
  return catalog;
}

function buildOrder(body) {
  const mode = body.mode === 'wholesale' ? 'wholesale' : 'retail';
  if (!Array.isArray(body.items) || body.items.length < 1 || body.items.length > 50) throw new HttpError(400, 'El carrito está vacío');
  // Precios y stock se leen de la base en el momento del pedido (nunca de la caché ni del navegador).
  const products = new Map(publicProducts().map((p) => [p.id, p]));
  const combos = new Map(publicCombos().map((c) => [c.id, c]));
  const lines = [];
  const wanted = new Map(); // productId -> unidades totales (para validar stock)
  const want = (id, qty) => wanted.set(id, (wanted.get(id) || 0) + qty);

  for (const it of body.items) {
    const qty = Math.floor(num(it.qty, 1, 99));
    if (it.type === 'combo') {
      const c = combos.get(it.id);
      if (!c) throw new HttpError(409, 'Un combo ya no está disponible');
      let unit = 0;
      const parts = c.items.map((ci) => {
        const p = products.get(ci.product);
        if (!p) throw new HttpError(409, `El combo «${c.name}» ya no está disponible`);
        unit += priceOf(p, mode) * ci.qty;
        want(p.id, ci.qty * qty);
        return `${ci.qty}× ${p.name}`;
      });
      unit = money(unit * (1 - c.discount / 100));
      lines.push({ type: 'combo', id: c.id, name: c.name, detail: parts.join(' + '), qty, unit, subtotal: money(unit * qty) });
    } else {
      const p = products.get(it.id);
      if (!p) throw new HttpError(409, 'Un producto ya no está disponible');
      const flavor = str(it.flavor, 50);
      if (p.flavors.length && !p.flavors.includes(flavor)) throw new HttpError(400, `Elige un sabor para ${p.name}`);
      const unit = priceOf(p, mode);
      want(p.id, qty);
      lines.push({ type: 'product', id: p.id, name: p.name, brand: p.brand, presentation: p.presentation, flavor, qty, unit, subtotal: money(unit * qty) });
    }
  }
  for (const [id, qty] of wanted) {
    const p = products.get(id);
    if (p.stock < qty) throw new HttpError(409, p.stock === 0 ? `${p.name} está agotado` : `${p.name}: solo quedan ${p.stock} unidades`);
  }
  return { mode, lines, total: money(lines.reduce((s, l) => s + l.subtotal, 0)) };
}

function createOrder(body) {
  const { mode, lines, total } = buildOrder(body);
  const info = db.prepare('INSERT INTO orders (price_mode, customer_name, notes, lines, total) VALUES (?,?,?,?,?)')
    .run(mode, str(body.name, 80), str(body.notes, 300), JSON.stringify(lines), total);
  const id = Number(info.lastInsertRowid);
  const d = new Date();
  const code = `BF-${String(d.getFullYear()).slice(2)}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}-${String(id).padStart(4, '0')}`;
  db.prepare('UPDATE orders SET code = ? WHERE id = ?').run(code, id);
  return { code, mode, lines, total };
}

function rateLimit(key, max, windowMs) {
  const rl = attempts.get(key) || { n: 0, until: 0 };
  if (Date.now() > rl.until) { rl.n = 0; rl.until = Date.now() + windowMs; }
  rl.n++;
  attempts.set(key, rl);
  return rl.n > max;
}

async function publicApi(req, res, path) {
  if (req.method === 'GET' && path === '/api/catalog') {
    const c = getCatalog();
    return sendCached(req, res, path, Buffer.from(c.json), 'application/json; charset=utf-8', c.etag, 'no-cache');
  }
  if (req.method === 'GET' && path === '/api/products') return json(res, 200, publicProducts());
  if (req.method === 'GET' && path === '/api/combos') return json(res, 200, publicCombos());
  if (req.method === 'GET' && path === '/api/reviews') return json(res, 200, approvedReviews());
  // Reseña pública: siempre queda pendiente de moderación; el cliente nunca decide approved/visible.
  if (req.method === 'POST' && path === '/api/reviews') {
    if (rateLimit('review:' + req.socket.remoteAddress, 5, 10 * 60_000)) throw new HttpError(429, 'Demasiadas reseñas enviadas, intenta más tarde');
    const b = await readJson(req);
    const name = str(b.name, 60);
    if (!name) throw new HttpError(400, 'El nombre es obligatorio');
    const stars = Math.floor(num(b.stars, 1, 5));
    const text = str(b.text, 1000);
    if (text.length < 10) throw new HttpError(400, 'La reseña debe tener al menos 10 caracteres');
    const product = str(b.product, 60);
    if (product && !db.prepare('SELECT 1 FROM products WHERE id = ?').get(product)) throw new HttpError(400, 'Producto inválido');
    if (b.consent !== true) throw new HttpError(400, 'Debes aceptar que tu reseña pueda publicarse');
    db.prepare("INSERT INTO reviews (product, name, stars, text, status) VALUES (?,?,?,?,'pending')").run(product, name, stars, text);
    return json(res, 201, { ok: true });
  }
  if (req.method === 'POST' && path === '/api/orders') {
    if (rateLimit('order:' + req.socket.remoteAddress, 20, 60_000)) throw new HttpError(429, 'Demasiados pedidos, intenta en un minuto');
    return json(res, 201, createOrder(await readJson(req)));
  }
  return false;
}

// ───────────── API admin ─────────────
async function adminApi(req, res, path) {
  if (req.method === 'POST' && path === '/api/admin/login') {
    const key = 'login:' + req.socket.remoteAddress;
    const rl = attempts.get(key);
    if (rl && Date.now() < rl.until && rl.n >= 5) throw new HttpError(429, 'Demasiados intentos. Espera 15 minutos.');
    const { username, password } = await readJson(req);
    const admin = db.prepare('SELECT * FROM admins WHERE username = ?').get(str(username, 60));
    const ok = admin ? verifyPassword(String(password ?? ''), admin) : (hashPassword('x'), false); // tiempo similar
    if (!ok) {
      const cur = attempts.get(key);
      const fresh = cur && Date.now() < cur.until ? cur : { n: 0, until: 0 };
      fresh.n++; fresh.until = Date.now() + 15 * 60_000;
      attempts.set(key, fresh);
      throw new HttpError(401, 'Usuario o contraseña incorrectos');
    }
    attempts.delete(key);
    const token = randomBytes(32).toString('base64url');
    sessions.set(token, { user: admin.username, exp: Date.now() + SESSION_MS });
    return send(res, 200, JSON.stringify({ user: admin.username }), {
      'Content-Type': 'application/json; charset=utf-8', 'Set-Cookie': cookieHeader(token, SESSION_MS / 1000), 'Cache-Control': 'no-store',
    });
  }
  if (req.method === 'POST' && path === '/api/admin/logout') {
    const s = sessionOf(req);
    if (s) sessions.delete(s.token);
    return send(res, 200, '{}', { 'Content-Type': 'application/json', 'Set-Cookie': cookieHeader('', 0) });
  }

  // Comprobación de sesión al abrir el panel: responde 200 también sin sesión (evita un 401 en consola).
  if (req.method === 'GET' && path === '/api/admin/me') {
    const s = sessionOf(req);
    return json(res, 200, { user: s ? s.user : null });
  }

  const session = requireAdmin(req);
  if (req.method !== 'GET') res.on('finish', invalidateCatalog); // cualquier cambio del panel renueva el catálogo


  if (req.method === 'POST' && path === '/api/admin/password') {
    const { current, next } = await readJson(req);
    const admin = db.prepare('SELECT * FROM admins WHERE username = ?').get(session.user);
    if (!verifyPassword(String(current ?? ''), admin)) throw new HttpError(400, 'La contraseña actual no coincide');
    if (String(next ?? '').length < 8) throw new HttpError(400, 'La nueva contraseña debe tener al menos 8 caracteres');
    const { salt, hash } = hashPassword(String(next));
    db.prepare('UPDATE admins SET salt = ?, hash = ? WHERE username = ?').run(salt, hash, session.user);
    return json(res, 200, { ok: true });
  }

  if (req.method === 'GET' && path === '/api/admin/products') {
    return json(res, 200, db.prepare('SELECT * FROM products ORDER BY name').all().map(hydrate));
  }
  if (req.method === 'POST' && path === '/api/admin/products') {
    const body = await readJson(req);
    const base = slugify(str(body.name, 120)) || 'producto';
    let id = base;
    for (let i = 2; db.prepare('SELECT 1 FROM products WHERE id = ?').get(id); i++) id = `${base}-${i}`;
    saveProduct(normalizeProduct(body, id), { create: true });
    return json(res, 201, hydrate(db.prepare('SELECT * FROM products WHERE id = ?').get(id)));
  }
  // Cambio masivo de visibilidad (solo IDs exactos que el cliente ya tiene en pantalla; nunca por página/número).
  if (req.method === 'POST' && path === '/api/admin/products/bulk-active') {
    const body = await readJson(req);
    const ids = Array.isArray(body.ids) ? [...new Set(body.ids.map((x) => str(x, 60)))].filter(Boolean) : [];
    if (!ids.length || ids.length > 200) throw new HttpError(400, 'Lista de productos inválida');
    if (typeof body.active !== 'boolean') throw new HttpError(400, 'Estado inválido');
    const target = body.active ? 1 : 0;
    const existing = db.prepare(`SELECT id FROM products WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids).map((r) => r.id);
    if (existing.length !== ids.length) {
      const faltantes = ids.filter((id) => !existing.includes(id));
      throw new HttpError(409, `Algunos productos ya no existen o cambiaron: ${faltantes.join(', ')}. Refresca la página e intenta de nuevo.`);
    }
    db.exec('BEGIN IMMEDIATE');
    try {
      const up = db.prepare('UPDATE products SET active = ?, updated_at = datetime(\'now\') WHERE id = ?');
      let changed = 0;
      for (const id of ids) changed += up.run(target, id).changes;
      if (changed !== ids.length) throw new Error(`Se esperaban ${ids.length} cambios y se aplicaron ${changed}`);
      db.exec('COMMIT');
      return json(res, 200, { ok: true, changed, ids, active: body.active });
    } catch (e) {
      db.exec('ROLLBACK');
      throw new HttpError(500, 'No se pudo aplicar el cambio masivo; no se modificó nada. ' + e.message);
    }
  }
  let m = path.match(/^\/api\/admin\/products\/([a-z0-9-]+)$/);
  if (m) {
    const id = m[1];
    if (!db.prepare('SELECT 1 FROM products WHERE id = ?').get(id)) throw new HttpError(404, 'Producto no encontrado');
    if (req.method === 'PUT') {
      saveProduct(normalizeProduct(await readJson(req), id), { create: false });
      return json(res, 200, hydrate(db.prepare('SELECT * FROM products WHERE id = ?').get(id)));
    }
    if (req.method === 'DELETE') {
      db.prepare('DELETE FROM products WHERE id = ?').run(id);
      db.prepare('DELETE FROM reviews WHERE product = ?').run(id);
      return json(res, 200, { ok: true });
    }
  }
  m = path.match(/^\/api\/admin\/products\/([a-z0-9-]+)\/image$/);
  if (m && req.method === 'POST') {
    if (!/^image\/(jpeg|png|webp)$/.test(req.headers['content-type'] || '')) throw new HttpError(415, 'Sube una imagen JPG, PNG o WebP');
    const buf = await readBody(req, 10 * 1024 * 1024);
    const base = `img/products/${m[1]}-${Date.now().toString(36)}`;
    await mkdir(join(publicDir, 'img', 'products'), { recursive: true });
    try {
      const sharp = await getSharp();
      for (const w of PRODUCT_SIZES) await (await productWebp(sharp, buf, w)).toFile(join(publicDir, `${base}-${w}.webp`));
    } catch { throw new HttpError(400, 'La imagen no se pudo procesar'); }
    return json(res, 200, { image: base });
  }

  if (req.method === 'GET' && path === '/api/admin/orders') {
    const rows = db.prepare('SELECT * FROM orders ORDER BY id DESC LIMIT 300').all().map((o) => ({ ...o, lines: JSON.parse(o.lines) }));
    return json(res, 200, rows);
  }
  m = path.match(/^\/api\/admin\/orders\/(\d+)$/);
  if (m && req.method === 'PATCH') {
    const { status } = await readJson(req);
    if (!ORDER_STATUS.has(status)) throw new HttpError(400, 'Estado inválido');
    db.prepare('UPDATE orders SET status = ? WHERE id = ?').run(status, Number(m[1]));
    return json(res, 200, { ok: true });
  }
  if (m && req.method === 'DELETE') {
    const { password } = await readJson(req);
    const admin = db.prepare('SELECT * FROM admins WHERE username = ?').get(session.user);
    if (!admin || !verifyPassword(String(password ?? ''), admin)) throw new HttpError(403, 'Contraseña incorrecta');
    const info = db.prepare('DELETE FROM orders WHERE id = ?').run(Number(m[1]));
    if (!info.changes) throw new HttpError(404, 'Pedido no encontrado');
    return json(res, 200, { ok: true });
  }

  if (req.method === 'GET' && path === '/api/admin/reviews') {
    const status = new URL(req.url, 'http://x').searchParams.get('status');
    const REVIEW_STATUSES = new Set(['pending', 'approved', 'rejected']);
    if (status && REVIEW_STATUSES.has(status)) {
      return json(res, 200, db.prepare('SELECT * FROM reviews WHERE status = ? ORDER BY id DESC').all(status));
    }
    return json(res, 200, db.prepare('SELECT * FROM reviews ORDER BY id DESC').all());
  }
  if (req.method === 'POST' && path === '/api/admin/reviews') {
    const b = await readJson(req);
    const product = str(b.product, 60);
    if (product && !db.prepare('SELECT 1 FROM products WHERE id = ?').get(product)) throw new HttpError(400, 'Producto inválido');
    const name = str(b.name, 60);
    if (!name) throw new HttpError(400, 'Falta el nombre del cliente');
    // Una reseña que el propio admin agrega manualmente entra ya aprobada (no viene del público).
    db.prepare("INSERT INTO reviews (product, name, stars, text, status) VALUES (?,?,?,?,'approved')")
      .run(product, name, Math.floor(num(b.stars, 1, 5)), str(b.text, 500));
    return json(res, 201, { ok: true });
  }
  m = path.match(/^\/api\/admin\/reviews\/(\d+)\/status$/);
  if (m && req.method === 'PATCH') {
    const { status } = await readJson(req);
    if (!['pending', 'approved', 'rejected'].includes(status)) throw new HttpError(400, 'Estado inválido');
    if (!db.prepare('SELECT 1 FROM reviews WHERE id = ?').get(Number(m[1]))) throw new HttpError(404, 'Reseña no encontrada');
    db.prepare('UPDATE reviews SET status = ? WHERE id = ?').run(status, Number(m[1]));
    return json(res, 200, { ok: true });
  }
  m = path.match(/^\/api\/admin\/reviews\/(\d+)$/);
  if (m && req.method === 'DELETE') {
    db.prepare('DELETE FROM reviews WHERE id = ?').run(Number(m[1]));
    return json(res, 200, { ok: true });
  }
  return false;
}

// ───────────── archivos estáticos ─────────────
const SECURITY = {
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; frame-src https://www.google.com https://maps.google.com; base-uri 'self'; form-action 'self'",
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Frame-Options': 'SAMEORIGIN',
};

// ───────────── versión de los archivos del frontend ─────────────
// BUILD es una huella del contenido de CSS/JS. Se escribe en las URL (?v=__BUILD__) al servir HTML y JS,
// así los navegadores guardan esos archivos un año y piden la versión nueva en cuanto cambia el código,
// sin números de versión manuales. Las fotos usan ASSET_V (public/js/ui.js), que solo se sube al
// reemplazar una imagen existente con el mismo nombre.
const BUILD_FILES = ['css/styles.css', 'js/app.js', 'js/ui.js', 'admin/admin.js', 'admin/admin.css', 'sw.js'].map((f) => join(publicDir, f));
let build = { key: '', value: '' };
async function buildId() {
  const sts = await Promise.all(BUILD_FILES.map((f) => stat(f)));
  const key = sts.map((s) => `${s.size}:${s.mtimeMs}`).join('|');
  if (key !== build.key) {
    const hash = createHash('sha1');
    for (const f of BUILD_FILES) hash.update(await readFile(f));
    build = { key, value: hash.digest('hex').slice(0, 10) };
  }
  return build.value;
}
const withVersions = (text, v) => text.replaceAll('__BUILD__', v).replaceAll('__IMG_V__', ASSET_V);

// Respuesta con ETag (304 si no cambió) y compresión Brotli/gzip calculada una vez y guardada en memoria.
const encCache = new Map(); // clave -> { br, gzip }
function encode(req, key, buf) {
  const ae = req.headers['accept-encoding'] || '';
  const enc = /\bbr\b/.test(ae) ? 'br' : /\bgzip\b/.test(ae) ? 'gzip' : null;
  if (!enc || buf.length < 512) return { enc: null, data: buf };
  let e = encCache.get(key);
  if (!e) { if (encCache.size > 300) encCache.clear(); e = {}; encCache.set(key, e); }
  e[enc] ??= enc === 'br'
    ? brotliCompressSync(buf, { params: { [zc.BROTLI_PARAM_QUALITY]: 9, [zc.BROTLI_PARAM_SIZE_HINT]: buf.length } })
    : gzipSync(buf, { level: 9 });
  return { enc, data: e[enc] };
}

function sendCached(req, res, key, buf, type, etag, cacheControl, extra = {}) {
  const headers = { 'Content-Type': type, ETag: etag, 'Cache-Control': cacheControl, Vary: 'Accept-Encoding', ...extra };
  if (req.headers['if-none-match'] === etag) return send(res, 304, undefined, headers);
  const compressible = /^text\/|^application\/(json|manifest)|svg/.test(type);
  const { enc, data } = compressible ? encode(req, key + etag, buf) : { enc: null, data: buf };
  if (enc) headers['Content-Encoding'] = enc;
  headers['Content-Length'] = data.length;
  send(res, 200, req.method === 'HEAD' ? undefined : data, headers);
}

// ───────────── páginas HTML renderizadas en el servidor ─────────────
const indexPath = join(publicDir, 'index.html');
const sitePath = join(publicDir, 'data', 'site.json');
const pageCache = new Map(); // clave -> { html, etag }
const noIndexHeaders = INDEXABLE ? {} : { 'X-Robots-Tag': 'noindex, nofollow' };

async function renderPage(req, kind, opts) {
  const [idx, siteSt, v] = await Promise.all([stat(indexPath), stat(sitePath), buildId()]);
  const c = getCatalog();
  const origin = originOf(req);
  const key = `${kind}|${opts.p ? opts.p.id : JSON.stringify(opts)}|${origin}|${c.etag}|${idx.mtimeMs}|${siteSt.mtimeMs}|${v}`;
  const hit = pageCache.get(key);
  if (hit) return hit;
  const [tplRaw, siteText] = await Promise.all([readFile(indexPath, 'utf8'), readFile(sitePath, 'utf8')]);
  const tpl = withVersions(tplRaw, v);
  const site = JSON.parse(siteText);
  const cat = c.data;
  const ctx = { products: cat.products, reviews: cat.reviews, site, origin, indexable: INDEXABLE };
  let built;
  let preloadP = null;
  if (kind === 'catalog') { built = buildCatalogPage({ ...ctx, ...opts }); preloadP = built.first; }
  else if (kind === 'product') { built = buildProductPage({ ...ctx, p: opts.p }); }
  else built = buildNotFound(ctx);
  const bootJson = `<script type="application/json" id="boot">${safeJson(`{"catalog":${c.json},"etag":${JSON.stringify(c.etag)},"site":${JSON.stringify(site)}}`)}</script>`;
  const html = tpl
    .replace('<!--SEO-->', () => built.head)
    .replace('<!--BOOT-->', () => imagePreload(preloadP) + (kind === 'notfound' ? '' : bootJson))
    .replace('<!--PAGE-->', () => (kind === 'product' ? 'product' : kind === 'notfound' ? 'notfound' : 'catalog'))
    .replace('<body data-page=', () => '<body data-ssr="1" data-page=')
    .replace('<!--MAIN-->', () => built.main)
    .replace('<!--FOOTNAV-->', () => footNav(cat.products))
    .replace('<!--DRAWERCATS-->', () => drawerCats(cat.products, opts?.cat || 'Todas'))
    .replace('<!--DISCLAIMER-->', () => esc(DISCLAIMER))
    .replace('<!--YEAR-->', () => String(new Date().getFullYear()));
  const out = { html: Buffer.from(html), etag: `"${createHash('sha1').update(key).digest('base64url').slice(0, 16)}"`, totalPages: built.totalPages };
  if (pageCache.size > 400) pageCache.clear();
  pageCache.set(key, out);
  return out;
}
const sendHtml = (req, res, page, status = 200) => {
  if (status !== 200) return send(res, status, req.method === 'HEAD' ? undefined : page.html, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-cache', ...SECURITY, 'X-Robots-Tag': 'noindex' });
  return sendCached(req, res, 'page:' + page.etag, page.html, MIME['.html'], page.etag, 'no-cache', { ...SECURITY, ...noIndexHeaders });
};
const redirect = (res, to) => send(res, 301, undefined, { Location: to, 'Cache-Control': 'public, max-age=3600' });

async function servePages(req, res, url) {
  const path = url.pathname;
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  const sp = url.searchParams;
  const pagina = sp.has('pagina') ? Number(sp.get('pagina')) : 1;
  const q = str(sp.get('q'), 80);
  if (path === '/' || path === '/index.html') {
    if (path === '/index.html') return redirect(res, '/');
    if (!Number.isInteger(pagina) || pagina < 1) return redirect(res, '/');
    const page = await renderPage(req, 'catalog', { cat: 'Todas', page: pagina, q });
    if (pagina > page.totalPages) return redirect(res, '/');
    return sendHtml(req, res, page);
  }
  let m = path.match(/^\/categoria\/([a-z0-9-]+)\/?$/);
  if (m) {
    const cat = categoryFromSlug(m[1]);
    if (!cat) return sendHtml(req, res, await renderPage(req, 'notfound', {}), 404);
    if (!Number.isInteger(pagina) || pagina < 1) return redirect(res, categoryUrl(cat));
    const page = await renderPage(req, 'catalog', { cat, page: pagina, q });
    if (pagina > page.totalPages) return redirect(res, categoryUrl(cat));
    return sendHtml(req, res, page);
  }
  m = path.match(/^\/producto\/([a-z0-9-]+)\/?$/);
  if (m) {
    const { products } = getCatalog().data;
    const p = findProductBySlug(products, m[1]);
    if (p) {
      if (path.endsWith('/')) return redirect(res, productUrl(p));
      return sendHtml(req, res, await renderPage(req, 'product', { p }));
    }
    const byId = findProductById(products, m[1]); // enlace con el id interno → URL definitiva
    if (byId) return redirect(res, productUrl(byId));
    return sendHtml(req, res, await renderPage(req, 'notfound', {}), 404);
  }
  if (path === '/robots.txt') {
    const body = INDEXABLE
      ? `User-agent: *\nAllow: /\nDisallow: /admin\nDisallow: /api/\n\nSitemap: ${SITE_URL}/sitemap.xml\n`
      : '# Entorno sin dominio público configurado (SITE_URL / ALLOW_INDEXING): no se permite el rastreo.\nUser-agent: *\nDisallow: /\n';
    return send(res, 200, req.method === 'HEAD' ? undefined : body, { 'Content-Type': MIME['.txt'], 'Cache-Control': 'public, max-age=3600' });
  }
  if (path === '/sitemap.xml') {
    const origin = originOf(req);
    const { products } = getCatalog().data;
    const present = new Set(products.map((p) => normalizeCategory(p.category)));
    const today = new Date().toISOString().slice(0, 10);
    const urls = [
      `${origin}/`,
      ...CATEGORY_ORDER.filter((c) => present.has(c)).map((c) => `${origin}${categoryUrl(c)}`),
    ].map((loc) => `  <url><loc>${esc(loc)}</loc><lastmod>${today}</lastmod></url>`);
    for (const p of products) {
      const lm = String(p.updated_at || '').slice(0, 10) || today;
      urls.push(`  <url><loc>${esc(`${origin}${productUrl(p)}`)}</loc><lastmod>${lm}</lastmod>${p.image ? `<image:image><image:loc>${esc(`${origin}/${p.image}-800.webp`)}</image:loc></image:image>` : ''}</url>`);
    }
    const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">\n${urls.join('\n')}\n</urlset>\n`;
    return send(res, 200, req.method === 'HEAD' ? undefined : xml, { 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': 'public, max-age=3600', ...noIndexHeaders });
  }
  return false;
}

async function serveStatic(req, res, path) {
  if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Método no permitido');
  let rel;
  try { rel = decodeURIComponent(path); } catch { throw new HttpError(400, 'URL inválida'); }
  const isAdmin = rel === '/admin' || rel.startsWith('/admin/');
  if (rel === '/admin' || rel === '/admin/') rel = '/admin/index.html';
  const file = normalize(join(publicDir, rel));
  if (!file.startsWith(publicDir + sep)) throw new HttpError(403, 'Prohibido');
  let st = null;
  try { st = await stat(file); } catch { /* no existe */ }
  if (!st || !st.isFile()) {
    // Rutas de página inexistentes: 404 real con página útil (no "200 + no encontrado").
    if (!extname(rel) || rel.endsWith('.html')) return sendHtml(req, res, await renderPage(req, 'notfound', {}), 404);
    throw new HttpError(404, 'No encontrado');
  }
  const extra = isAdmin ? { ...SECURITY, 'X-Robots-Tag': 'noindex, nofollow' } : SECURITY;
  const versioned = /[?&]v=/.test(req.url);
  const cacheControl = rel.startsWith('/img/') || rel.startsWith('/icons/') || rel.startsWith('/images/')
    ? (versioned ? 'public, max-age=31536000, immutable' : 'public, max-age=86400')
    : (versioned && /\.(css|js)$/.test(rel) ? 'public, max-age=31536000, immutable' : 'no-cache');
  const ext = extname(file).toLowerCase();
  const templated = ext === '.js' || ext === '.html'; // llevan __BUILD__ / __IMG_V__ en sus URL
  const v = templated ? await buildId() : '';
  const etag = `"${st.size.toString(36)}-${Math.round(st.mtimeMs).toString(36)}${v ? '-' + v : ''}"`;
  const type = MIME[ext] || 'application/octet-stream';
  if (req.headers['if-none-match'] === etag) return sendCached(req, res, file, Buffer.alloc(0), type, etag, cacheControl, extra);
  const body = templated ? Buffer.from(withVersions(await readFile(file, 'utf8'), v)) : await readFile(file);
  sendCached(req, res, file, body, type, etag, cacheControl, extra);
}

createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    const path = url.pathname;
    if (path.startsWith('/api/admin/')) {
      if (await adminApi(req, res, path) === false) throw new HttpError(404, 'No encontrado');
    } else if (path.startsWith('/api/')) {
      if (await publicApi(req, res, path) === false) throw new HttpError(404, 'No encontrado');
    } else if (await servePages(req, res, url) === false) {
      await serveStatic(req, res, path);
    }
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    if (status === 500) console.error(e);
    if (res.headersSent) return res.end();
    json(res, status, { error: status === 500 ? 'Error interno' : e.message });
  }
}).listen(PORT, () => {
  console.log(`BodyFactory Gym → http://localhost:${PORT}   (admin: /admin)   indexación: ${INDEXABLE ? `SÍ (${SITE_URL})` : 'NO (define SITE_URL y ALLOW_INDEXING=true en producción)'}`);
});
