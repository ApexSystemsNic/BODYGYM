import { createServer } from 'node:http';
import { readFile, stat, mkdir, rm } from 'node:fs/promises';
import { dirname, join, extname, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, createHash } from 'node:crypto';
import { gzipSync, brotliCompressSync, constants as zc } from 'node:zlib';
import { hydrate, saveProduct, hashPassword, verifyPassword, normalizeUsername, MIN_PASSWORD, initialPasswordFile } from './db.js';
import { pool, queryOne, queryAll, execute, transaction, testPostgresConnection } from './postgres.js';
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
// Detrás de un proxy inverso (Nginx, Caddy…) la IP real del cliente llega en X-Forwarded-For.
// Solo se usa si TRUST_PROXY=true; así nadie puede falsificar su IP para evadir los límites de intentos.
const TRUST_PROXY = process.env.TRUST_PROXY === 'true';
const clientIp = (req) => (TRUST_PROXY && String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || req.socket.remoteAddress || '';
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
  '.webmanifest': 'application/manifest+json; charset=utf-8', '.woff2': 'font/woff2',
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
// Sesiones en memoria: token aleatorio (256 bits) -> { user, exp }. Cada petición comprueba además que la
// cuenta siga existiendo y activa, de modo que desactivar o eliminar un usuario corta su acceso al instante.
const sessions = new Map();
const SESSION_MS = 8 * 60 * 60 * 1000;
const attempts = new Map(); // clave -> { n, until }

function cookieOf(req, name) {
  const m = (req.headers.cookie || '').split(/;\s*/).find((c) => c.startsWith(name + '='));
  if (!m) return null;
  try { return decodeURIComponent(m.slice(name.length + 1)); } catch { return null; }
}
async function sessionOf(req) {
  const t = cookieOf(req, 'bf_session');
  const s = t && sessions.get(t);
  if (!s) return null;
  if (s.exp < Date.now()) { sessions.delete(t); return null; }
  const acc = await queryOne('SELECT username, role, active FROM admins WHERE username = $1', [s.user]);
  if (!acc || !acc.active) { sessions.delete(t); return null; }
  return { token: t, user: acc.username, role: acc.role };
}
// Cierra todas las sesiones de una cuenta (salvo, opcionalmente, la actual).
function dropSessions(user, exceptToken = null) {
  for (const [t, s] of sessions) if (s.user === user && t !== exceptToken) sessions.delete(t);
}
async function requireAdmin(req) {
  const s = await sessionOf(req);
  if (!s) throw new HttpError(401, 'No autorizado');
  // Defensa CSRF: los formularios entre sitios no pueden enviar este encabezado.
  if (req.method !== 'GET' && req.headers['x-requested-with'] !== 'fetch') throw new HttpError(403, 'Solicitud no válida');
  return s;
}
const requireRole = (session, role) => { if (session.role !== role) throw new HttpError(403, 'No tienes permiso para esta acción'); };
const cookieHeader = (token, maxAge) =>
  `bf_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${SECURE_COOKIE ? '; Secure' : ''}`;
// Limpieza periódica de sesiones vencidas y contadores de intentos caducados.
setInterval(() => {
  const now = Date.now();
  for (const [t, s] of sessions) if (s.exp < now) sessions.delete(t);
  for (const [k, a] of attempts) if (a.until < now) attempts.delete(k);
}, 10 * 60_000).unref();

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
const publicProducts = async () => (await queryAll("SELECT * FROM products WHERE active = 1 ORDER BY popularity DESC, CASE WHEN image <> '' THEN 0 ELSE 1 END, name")).map(hydrate);
const publicCombos = async () => (await queryAll('SELECT * FROM combos WHERE active = 1')).map((c) => ({ ...c, items: JSON.parse(c.items), active: !!c.active }));

// Fotos de «Nuestro gimnasio»: las del sitio (data/site.json, «gallery») menos las quitadas desde el panel
// (tabla gallery_removed; los archivos versionados no se borran) + las subidas desde el panel (tabla gallery).
const GALLERY_SIZES = [600, 1000];
const GALLERY_NAME = /^[a-z0-9][a-z0-9-]{0,79}$/;
async function siteGallery() {
  try {
    const list = JSON.parse(await readFile(join(publicDir, 'data', 'site.json'), 'utf8')).gallery;
    return (Array.isArray(list) ? list : []).filter((p) => p && GALLERY_NAME.test(p.file)).map((p) => ({ file: p.file, alt: str(p.alt, 160) }));
  } catch { return []; }
}
async function galleryPhotos() {
  const removed = new Set((await queryAll('SELECT file FROM gallery_removed')).map((r) => r.file));
  const site = (await siteGallery()).filter((p) => !removed.has(p.file)).map((p) => ({ ...p, origin: 'site' }));
  const uploads = (await queryAll('SELECT file, alt FROM gallery ORDER BY id')).map((p) => ({ ...p, origin: 'upload' }));
  return [...site, ...uploads];
}

const approvedReviews = () => queryAll("SELECT id, product, name, stars, text, created_at FROM reviews WHERE status = 'approved' AND name <> 'Cliente de ejemplo' AND text NOT LIKE 'Texto de ejemplo:%' ORDER BY id DESC");

const priceOf = (p, mode) => (mode === 'wholesale' ? p.price_wholesale : p.price_retail);

// ───────────── catálogo en caché (una sola respuesta para todo el frontend) ─────────────
let catalog = null; // { json, data, etag }
let catalogGen = 0; // sube con cada invalidación: una lectura que empezó antes no deja una caché vieja
const invalidateCatalog = () => { catalog = null; catalogGen++; };
// Los cambios hechos desde el panel invalidan la caché (invalidateCatalog en adminApi). Una edición directa
// en PostgreSQL por fuera de la app se ve al reiniciar el proceso.
async function getCatalog() {
  if (catalog) return catalog;
  const gen = catalogGen;
  const [products, combos, reviews] = await Promise.all([publicProducts(), publicCombos(), approvedReviews()]);
  const data = { products, combos, reviews };
  const json = JSON.stringify(data);
  const built = { json, data, etag: `"${createHash('sha1').update(json).digest('base64url').slice(0, 16)}"` };
  if (gen === catalogGen) catalog = built;
  return built;
}

async function buildOrder(body) {
  const mode = body.mode === 'wholesale' ? 'wholesale' : 'retail';
  if (!Array.isArray(body.items) || body.items.length < 1 || body.items.length > 50) throw new HttpError(400, 'El carrito está vacío');
  // Precios se leen de la base en el momento del pedido (nunca de la caché ni del navegador).
  // La disponibilidad no bloquea el pedido: se confirma por WhatsApp al recibirlo.
  const products = new Map((await publicProducts()).map((p) => [p.id, p]));
  const combos = new Map((await publicCombos()).map((c) => [c.id, c]));
  const lines = [];

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
      lines.push({ type: 'product', id: p.id, name: p.name, brand: p.brand, presentation: p.presentation, flavor, qty, unit, subtotal: money(unit * qty) });
    }
  }
  return { mode, lines, total: money(lines.reduce((s, l) => s + l.subtotal, 0)) };
}

async function createOrder(body) {
  const { mode, lines, total } = await buildOrder(body);
  const { id } = await queryOne('INSERT INTO orders (price_mode, customer_name, notes, lines, total) VALUES ($1,$2,$3,$4,$5) RETURNING id',
    [mode, str(body.name, 80), str(body.notes, 300), JSON.stringify(lines), total]);
  const d = new Date();
  const code = `BF-${String(d.getFullYear()).slice(2)}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}-${String(id).padStart(4, '0')}`;
  await execute('UPDATE orders SET code = $1 WHERE id = $2', [code, id]);
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
    const c = await getCatalog();
    return sendCached(req, res, path, Buffer.from(c.json), 'application/json; charset=utf-8', c.etag, 'no-cache');
  }
  if (req.method === 'GET' && path === '/api/products') return json(res, 200, await publicProducts());
  if (req.method === 'GET' && path === '/api/combos') return json(res, 200, await publicCombos());
  if (req.method === 'GET' && path === '/api/reviews') return json(res, 200, await approvedReviews());
  if (req.method === 'GET' && path === '/api/gallery') return json(res, 200, (await galleryPhotos()).map(({ file, alt }) => ({ file, alt })));
  // Reseña pública: siempre queda pendiente de moderación; el cliente nunca decide approved/visible.
  if (req.method === 'POST' && path === '/api/reviews') {
    if (rateLimit('review:' + clientIp(req), 5, 10 * 60_000)) throw new HttpError(429, 'Demasiadas reseñas enviadas, intenta más tarde');
    const b = await readJson(req);
    const name = str(b.name, 60);
    if (!name) throw new HttpError(400, 'El nombre es obligatorio');
    const stars = Math.floor(num(b.stars, 1, 5));
    const text = str(b.text, 1000);
    if (text.length < 10) throw new HttpError(400, 'La reseña debe tener al menos 10 caracteres');
    const product = str(b.product, 60);
    if (product && !(await queryOne('SELECT 1 FROM products WHERE id = $1', [product]))) throw new HttpError(400, 'Producto inválido');
    if (b.consent !== true) throw new HttpError(400, 'Debes aceptar que tu reseña pueda publicarse');
    await execute("INSERT INTO reviews (product, name, stars, text, status) VALUES ($1,$2,$3,$4,'pending')", [product, name, stars, text]);
    return json(res, 201, { ok: true });
  }
  if (req.method === 'POST' && path === '/api/orders') {
    if (rateLimit('order:' + clientIp(req), 20, 60_000)) throw new HttpError(429, 'Demasiados pedidos, intenta en un minuto');
    return json(res, 201, await createOrder(await readJson(req)));
  }
  return false;
}

// ───────────── API admin ─────────────
async function adminApi(req, res, path) {
  if (req.method === 'POST' && path === '/api/admin/login') {
    if (req.headers['x-requested-with'] !== 'fetch') throw new HttpError(403, 'Solicitud no válida');
    // Límite de intentos fallidos por IP y por nombre de usuario (15 minutos).
    const ipKey = 'login-ip:' + clientIp(req);
    const { username, password } = await readJson(req);
    const uname = str(username, 60).toLowerCase();
    const userKey = 'login-user:' + uname;
    const blocked = (k, max) => { const a = attempts.get(k); return a && Date.now() < a.until && a.n >= max; };
    if (blocked(ipKey, 5) || blocked(userKey, 10)) throw new HttpError(429, 'Demasiados intentos. Espera 15 minutos.');
    const admin = await queryOne('SELECT username, salt, hash, role, active FROM admins WHERE lower(username) = $1', [uname]);
    // Mismo tiempo de respuesta y mismo mensaje para usuario inexistente, desactivado o contraseña incorrecta.
    const valid = admin ? verifyPassword(String(password ?? ''), admin) : (hashPassword('x'), false);
    if (!valid || !admin.active) {
      for (const k of [ipKey, userKey]) {
        const cur = attempts.get(k);
        const fresh = cur && Date.now() < cur.until ? cur : { n: 0, until: 0 };
        fresh.n++; fresh.until = Date.now() + 15 * 60_000;
        attempts.set(k, fresh);
      }
      throw new HttpError(401, 'Usuario o contraseña incorrectos');
    }
    attempts.delete(ipKey); attempts.delete(userKey);
    // Nunca se reutiliza un token presentado por el navegador: siempre se emite uno nuevo (anti session fixation).
    const prev = cookieOf(req, 'bf_session');
    if (prev) sessions.delete(prev);
    const token = randomBytes(32).toString('base64url');
    sessions.set(token, { user: admin.username, exp: Date.now() + SESSION_MS });
    return send(res, 200, JSON.stringify({ user: admin.username, role: admin.role }), {
      'Content-Type': 'application/json; charset=utf-8', 'Set-Cookie': cookieHeader(token, SESSION_MS / 1000), 'Cache-Control': 'no-store',
    });
  }
  if (req.method === 'POST' && path === '/api/admin/logout') {
    const t = cookieOf(req, 'bf_session');
    if (t) sessions.delete(t);
    return send(res, 200, '{}', {
      'Content-Type': 'application/json; charset=utf-8', 'Set-Cookie': cookieHeader('', 0), 'Cache-Control': 'no-store',
    });
  }

  // Comprobación de sesión al abrir el panel: responde 200 también sin sesión (evita un 401 en consola).
  if (req.method === 'GET' && path === '/api/admin/me') {
    const s = await sessionOf(req);
    return json(res, 200, s ? { user: s.user, role: s.role } : { user: null });
  }

  const session = await requireAdmin(req);
  if (req.method !== 'GET') res.on('finish', invalidateCatalog); // cualquier cambio del panel renueva el catálogo


  if (req.method === 'POST' && path === '/api/admin/password') {
    const { current, next } = await readJson(req);
    const admin = await queryOne('SELECT username, salt, hash FROM admins WHERE username = $1', [session.user]);
    if (!admin || !verifyPassword(String(current ?? ''), admin)) throw new HttpError(400, 'La contraseña actual no coincide');
    const pw = validPassword(next);
    const { salt, hash } = hashPassword(pw);
    await execute('UPDATE admins SET salt = $1, hash = $2 WHERE username = $3', [salt, hash, session.user]);
    dropSessions(session.user, session.token); // cierra la cuenta en otros dispositivos
    await rm(initialPasswordFile, { force: true }).catch(() => {});
    return json(res, 200, { ok: true });
  }

  // ── usuarios del panel (solo administradores) ──
  if (path === '/api/admin/users' || path.startsWith('/api/admin/users/')) {
    requireRole(session, 'admin');
    return usersApi(req, res, path, session);
  }

  if (req.method === 'GET' && path === '/api/admin/products') {
    return json(res, 200, (await queryAll('SELECT * FROM products ORDER BY name')).map(hydrate));
  }
  if (req.method === 'POST' && path === '/api/admin/products') {
    const body = await readJson(req);
    const base = slugify(str(body.name, 120)) || 'producto';
    let id = base;
    for (let i = 2; await queryOne('SELECT 1 FROM products WHERE id = $1', [id]); i++) id = `${base}-${i}`;
    await saveProduct(normalizeProduct(body, id), { create: true });
    return json(res, 201, hydrate(await queryOne('SELECT * FROM products WHERE id = $1', [id])));
  }
  // Cambio masivo de visibilidad (solo IDs exactos que el cliente ya tiene en pantalla; nunca por página/número).
  if (req.method === 'POST' && path === '/api/admin/products/bulk-active') {
    const body = await readJson(req);
    const ids = Array.isArray(body.ids) ? [...new Set(body.ids.map((x) => str(x, 60)))].filter(Boolean) : [];
    if (!ids.length || ids.length > 200) throw new HttpError(400, 'Lista de productos inválida');
    if (typeof body.active !== 'boolean') throw new HttpError(400, 'Estado inválido');
    const target = body.active ? 1 : 0;
    try {
      // Una sola transacción: se comprueba que existan todos los IDs (bloqueando las filas) y se actualizan juntos.
      const changed = await transaction(async (client) => {
        const found = await client.query(`SELECT id FROM products WHERE id IN (${ids.map((_, i) => `$${i + 1}`).join(',')}) FOR UPDATE`, ids);
        if (found.rowCount !== ids.length) {
          const existing = new Set(found.rows.map((r) => r.id));
          const faltantes = ids.filter((id) => !existing.has(id));
          throw new HttpError(409, `Algunos productos ya no existen o cambiaron: ${faltantes.join(', ')}. Refresca la página e intenta de nuevo.`);
        }
        const up = await client.query(`UPDATE products SET active = $1, updated_at = CURRENT_TIMESTAMP WHERE id IN (${ids.map((_, i) => `$${i + 2}`).join(',')})`, [target, ...ids]);
        if (up.rowCount !== ids.length) throw new Error(`Se esperaban ${ids.length} cambios y se aplicaron ${up.rowCount}`);
        return up.rowCount;
      });
      return json(res, 200, { ok: true, changed, ids, active: body.active });
    } catch (e) {
      if (e instanceof HttpError) throw e;
      throw new HttpError(500, 'No se pudo aplicar el cambio masivo; no se modificó nada. ' + e.message);
    }
  }
  let m = path.match(/^\/api\/admin\/products\/([a-z0-9-]+)$/);
  if (m) {
    const id = m[1];
    if (!(await queryOne('SELECT 1 FROM products WHERE id = $1', [id]))) throw new HttpError(404, 'Producto no encontrado');
    if (req.method === 'PUT') {
      await saveProduct(normalizeProduct(await readJson(req), id), { create: false });
      return json(res, 200, hydrate(await queryOne('SELECT * FROM products WHERE id = $1', [id])));
    }
    if (req.method === 'DELETE') {
      await transaction(async (client) => {
        await client.query('DELETE FROM products WHERE id = $1', [id]);
        await client.query('DELETE FROM reviews WHERE product = $1', [id]);
      });
      return json(res, 200, { ok: true });
    }
  }
  m = path.match(/^\/api\/admin\/products\/([a-z0-9-]+)\/image$/);
  if (m && req.method === 'POST') {
    if (!(await queryOne('SELECT 1 FROM products WHERE id = $1', [m[1]]))) throw new HttpError(404, 'Producto no encontrado');
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

  // ── fotos de «Nuestro gimnasio» (mismo acceso que las fotos de productos) ──
  if (req.method === 'GET' && path === '/api/admin/gallery') return json(res, 200, await galleryPhotos());
  if (req.method === 'POST' && path === '/api/admin/gallery') {
    const type = req.headers['content-type'] || '';
    if (!/^image\/(jpeg|png|webp)$/.test(type)) throw new HttpError(415, 'Sube una imagen JPG, PNG o WebP');
    const buf = await readBody(req, 10 * 1024 * 1024);
    let alt = '';
    try { alt = str(decodeURIComponent(req.headers['x-photo-alt'] || ''), 120); } catch { /* texto no válido: se usa el genérico */ }
    // Nombre generado por el servidor: nunca se usa el nombre ni la ruta que envía el navegador.
    const file = `gym-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`;
    const dir = join(publicDir, 'images', 'gallery');
    await mkdir(dir, { recursive: true });
    try {
      const sharp = await getSharp();
      const meta = await sharp(buf).metadata(); // formato real del archivo, no solo la cabecera
      if (!['jpeg', 'png', 'webp'].includes(meta.format) || type !== `image/${meta.format}`) throw new Error('formato');
      if (!(meta.width >= 300 && meta.height >= 300)) throw new Error('tamaño');
      for (const w of GALLERY_SIZES) {
        await sharp(buf).rotate().resize({ width: w, withoutEnlargement: true }).webp({ quality: 78, effort: 5 }).toFile(join(dir, `${file}-${w}.webp`));
      }
    } catch {
      await Promise.all(GALLERY_SIZES.map((w) => rm(join(dir, `${file}-${w}.webp`), { force: true }).catch(() => {})));
      throw new HttpError(400, 'La imagen no se pudo procesar (JPG, PNG o WebP de al menos 300 px)');
    }
    await execute('INSERT INTO gallery (file, alt) VALUES ($1, $2)', [file, alt || 'Foto de BodyFactory Gym']);
    return json(res, 201, { file, alt: alt || 'Foto de BodyFactory Gym' });
  }

  // Quitar una foto de la galería. Solo se aceptan nombres que están en la galería actual (nunca rutas):
  //  · subida desde el panel → se borra su fila y sus dos WebP (nombre generado por el servidor);
  //  · foto del sitio → se registra como quitada (el archivo versionado del proyecto no se toca).
  m = path.match(/^\/api\/admin\/gallery\/([^/]+)$/);
  if (m && req.method === 'DELETE') {
    const file = m[1];
    if (!GALLERY_NAME.test(file)) throw new HttpError(404, 'Foto no encontrada');
    const row = await queryOne('SELECT id, file FROM gallery WHERE file = $1', [file]);
    if (row) {
      await execute('DELETE FROM gallery WHERE id = $1', [row.id]);
      if (/^gym-[a-z0-9]+-[a-f0-9]{8}$/.test(row.file)) {
        const dir = join(publicDir, 'images', 'gallery');
        await Promise.all(GALLERY_SIZES.map((w) => rm(join(dir, `${row.file}-${w}.webp`), { force: true }).catch(() => {})));
      }
      return json(res, 200, { ok: true });
    }
    const removed = await queryOne('SELECT 1 FROM gallery_removed WHERE file = $1', [file]);
    if (removed || !(await siteGallery()).some((p) => p.file === file)) throw new HttpError(404, 'Foto no encontrada');
    await execute('INSERT INTO gallery_removed (file) VALUES ($1)', [file]);
    return json(res, 200, { ok: true });
  }

  if (req.method === 'GET' && path === '/api/admin/orders') {
    const rows = (await queryAll('SELECT * FROM orders ORDER BY id DESC LIMIT 300')).map((o) => ({ ...o, lines: JSON.parse(o.lines) }));
    return json(res, 200, rows);
  }
  m = path.match(/^\/api\/admin\/orders\/(\d+)$/);
  if (m && req.method === 'PATCH') {
    const { status } = await readJson(req);
    if (!ORDER_STATUS.has(status)) throw new HttpError(400, 'Estado inválido');
    await execute('UPDATE orders SET status = $1 WHERE id = $2', [status, Number(m[1])]);
    return json(res, 200, { ok: true });
  }
  if (m && req.method === 'DELETE') {
    const { password } = await readJson(req);
    const admin = await queryOne('SELECT salt, hash FROM admins WHERE username = $1', [session.user]);
    if (!admin || !verifyPassword(String(password ?? ''), admin)) throw new HttpError(403, 'Contraseña incorrecta');
    const info = await execute('DELETE FROM orders WHERE id = $1', [Number(m[1])]);
    if (!info.changes) throw new HttpError(404, 'Pedido no encontrado');
    return json(res, 200, { ok: true });
  }

  if (req.method === 'GET' && path === '/api/admin/reviews') {
    const status = new URL(req.url, 'http://x').searchParams.get('status');
    const REVIEW_STATUSES = new Set(['pending', 'approved', 'rejected']);
    if (status && REVIEW_STATUSES.has(status)) {
      return json(res, 200, await queryAll('SELECT * FROM reviews WHERE status = $1 ORDER BY id DESC', [status]));
    }
    return json(res, 200, await queryAll('SELECT * FROM reviews ORDER BY id DESC'));
  }
  if (req.method === 'POST' && path === '/api/admin/reviews') {
    const b = await readJson(req);
    const product = str(b.product, 60);
    if (product && !(await queryOne('SELECT 1 FROM products WHERE id = $1', [product]))) throw new HttpError(400, 'Producto inválido');
    const name = str(b.name, 60);
    if (!name) throw new HttpError(400, 'Falta el nombre del cliente');
    // Una reseña que el propio admin agrega manualmente entra ya aprobada (no viene del público).
    await execute("INSERT INTO reviews (product, name, stars, text, status) VALUES ($1,$2,$3,$4,'approved')",
      [product, name, Math.floor(num(b.stars, 1, 5)), str(b.text, 500)]);
    return json(res, 201, { ok: true });
  }
  m = path.match(/^\/api\/admin\/reviews\/(\d+)\/status$/);
  if (m && req.method === 'PATCH') {
    const { status } = await readJson(req);
    if (!['pending', 'approved', 'rejected'].includes(status)) throw new HttpError(400, 'Estado inválido');
    if (!(await queryOne('SELECT 1 FROM reviews WHERE id = $1', [Number(m[1])]))) throw new HttpError(404, 'Reseña no encontrada');
    await execute('UPDATE reviews SET status = $1 WHERE id = $2', [status, Number(m[1])]);
    return json(res, 200, { ok: true });
  }
  m = path.match(/^\/api\/admin\/reviews\/(\d+)$/);
  if (m && req.method === 'DELETE') {
    await execute('DELETE FROM reviews WHERE id = $1', [Number(m[1])]);
    return json(res, 200, { ok: true });
  }
  return false;
}

// ───────────── usuarios del panel ─────────────
// Nunca se devuelven hash, sal ni tokens. Todas las comprobaciones de permisos se hacen aquí, en el servidor.
const ROLES = new Set(['admin', 'staff']);
const listUsers = async () => (await queryAll('SELECT username, role, active, created_at FROM admins ORDER BY role, username'))
  .map((u) => ({ ...u, active: !!u.active }));
const activeAdmins = async () => (await queryOne("SELECT COUNT(*)::integer AS n FROM admins WHERE role = 'admin' AND active = 1")).n;
function validPassword(p) {
  const pw = String(p ?? '');
  if (pw.length < MIN_PASSWORD) throw new HttpError(400, `La contraseña debe tener al menos ${MIN_PASSWORD} caracteres`);
  if (pw.length > 200) throw new HttpError(400, 'La contraseña es demasiado larga');
  return pw;
}

async function usersApi(req, res, path, session) {
  if (path === '/api/admin/users') {
    if (req.method === 'GET') return json(res, 200, await listUsers());
    if (req.method === 'POST') {
      const b = await readJson(req);
      const username = normalizeUsername(b.username);
      if (!username) throw new HttpError(400, 'Usuario inválido: 3 a 32 caracteres (letras, números, punto, guion o guion bajo)');
      const role = ROLES.has(b.role) ? b.role : 'staff';
      const pw = validPassword(b.password);
      if (await queryOne('SELECT 1 FROM admins WHERE lower(username) = $1', [username])) throw new HttpError(409, 'Ese nombre de usuario ya existe');
      const { salt, hash } = hashPassword(pw);
      await execute('INSERT INTO admins (username, salt, hash, role, active, created_at) VALUES ($1,$2,$3,$4,1,CURRENT_TIMESTAMP)', [username, salt, hash, role]);
      return json(res, 201, (await listUsers()).find((u) => u.username === username));
    }
    throw new HttpError(405, 'Método no permitido');
  }
  const m = path.match(/^\/api\/admin\/users\/([^/]+)(\/password)?$/);
  let target = null;
  try { target = m && normalizeUsername(decodeURIComponent(m[1])); } catch { /* inválido */ }
  const acc = target && await queryOne('SELECT username, role, active FROM admins WHERE username = $1', [target]);
  if (!acc) throw new HttpError(404, 'Usuario no encontrado');
  const self = acc.username === session.user;
  const isLastAdmin = acc.role === 'admin' && acc.active && (await activeAdmins()) <= 1;

  if (m[2] && req.method === 'POST') { // restablecer contraseña de otra cuenta
    if (self) throw new HttpError(400, 'Para tu propia cuenta usa «Cambiar contraseña»');
    const pw = validPassword((await readJson(req)).password);
    const { salt, hash } = hashPassword(pw);
    await execute('UPDATE admins SET salt = $1, hash = $2 WHERE username = $3', [salt, hash, acc.username]);
    dropSessions(acc.username);
    return json(res, 200, { ok: true });
  }
  if (!m[2] && req.method === 'PATCH') { // activar/desactivar o cambiar rol
    if (self) throw new HttpError(400, 'No puedes cambiar el estado ni el rol de tu propia cuenta');
    const b = await readJson(req);
    const active = typeof b.active === 'boolean' ? b.active : !!acc.active;
    const role = ROLES.has(b.role) ? b.role : acc.role;
    if (isLastAdmin && (!active || role !== 'admin')) throw new HttpError(409, 'Debe quedar al menos un administrador activo');
    await execute('UPDATE admins SET active = $1, role = $2 WHERE username = $3', [active ? 1 : 0, role, acc.username]);
    if (!active) dropSessions(acc.username);
    return json(res, 200, (await listUsers()).find((u) => u.username === acc.username));
  }
  if (!m[2] && req.method === 'DELETE') {
    if (self) throw new HttpError(400, 'No puedes eliminar tu propia cuenta');
    if (isLastAdmin) throw new HttpError(409, 'Debe quedar al menos un administrador activo');
    const me = await queryOne('SELECT salt, hash FROM admins WHERE username = $1', [session.user]);
    if (!me || !verifyPassword(String((await readJson(req)).password ?? ''), me)) throw new HttpError(403, 'Tu contraseña no es correcta');
    await execute('DELETE FROM admins WHERE username = $1', [acc.username]);
    dropSessions(acc.username);
    return json(res, 200, { ok: true });
  }
  throw new HttpError(405, 'Método no permitido');
}

// ───────────── archivos estáticos ─────────────
const SECURITY = {
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; frame-src https://www.google.com https://maps.google.com; base-uri 'self'; form-action 'self'; object-src 'none'",
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Frame-Options': 'SAMEORIGIN',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
  ...(SECURE_COOKIE ? { 'Strict-Transport-Security': 'max-age=31536000' } : {}),
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
  const [idx, siteSt, v, c] = await Promise.all([stat(indexPath), stat(sitePath), buildId(), getCatalog()]);
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
    const { products } = (await getCatalog()).data;
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
    const { products } = (await getCatalog()).data;
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
  // El panel se aísla además de otras ventanas (la tienda no, porque abre WhatsApp en una pestaña nueva).
  const extra = isAdmin ? { ...SECURITY, 'X-Robots-Tag': 'noindex, nofollow', 'Cross-Origin-Opener-Policy': 'same-origin' } : SECURITY;
  const adminPage = isAdmin && extname(rel) === '.html'; // el panel nunca se guarda en caché (ni en «atrás»)
  const versioned = /[?&]v=/.test(req.url);
  const cacheControl = rel.startsWith('/img/') || rel.startsWith('/icons/') || rel.startsWith('/images/')
    ? (versioned ? 'public, max-age=31536000, immutable' : 'public, max-age=86400')
    : (versioned && /\.(css|js)$/.test(rel) ? 'public, max-age=31536000, immutable' : adminPage ? 'no-store' : 'no-cache');
  const ext = extname(file).toLowerCase();
  const templated = ext === '.js' || ext === '.html'; // llevan __BUILD__ / __IMG_V__ en sus URL
  const v = templated ? await buildId() : '';
  const etag = `"${st.size.toString(36)}-${Math.round(st.mtimeMs).toString(36)}${v ? '-' + v : ''}"`;
  const type = MIME[ext] || 'application/octet-stream';
  if (req.headers['if-none-match'] === etag) return sendCached(req, res, file, Buffer.alloc(0), type, etag, cacheControl, extra);
  const body = templated ? Buffer.from(withVersions(await readFile(file, 'utf8'), v)) : await readFile(file);
  sendCached(req, res, file, body, type, etag, cacheControl, extra);
}

const server = createServer(async (req, res) => {
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
});

// Arranque: sin PostgreSQL no se acepta tráfico (no hay respaldo en SQLite).
async function start() {
  const info = await testPostgresConnection();
  console.log(`PostgreSQL conectado (base: ${info.database}).`);
  pool.on('error', (e) => console.error('PostgreSQL (conexión inactiva):', e.message)); // sin esto un corte tumba el proceso
  server.listen(PORT, () => {
    console.log(`BodyFactory Gym → http://localhost:${PORT}   (admin: /admin)   indexación: ${INDEXABLE ? `SÍ (${SITE_URL})` : 'NO (define SITE_URL y ALLOW_INDEXING=true en producción)'}`);
  });
}

// Cierre limpio (Railway envía SIGTERM al redeplegar): deja de aceptar conexiones, cierra el pool y sale.
let closing = false;
function shutdown(signal) {
  if (closing) return;
  closing = true;
  console.log(`${signal}: cerrando servidor y conexiones PostgreSQL…`);
  setTimeout(() => process.exit(1), 10_000).unref();
  server.close(async () => {
    await pool.end().catch(() => {});
    process.exit(0);
  });
  server.closeIdleConnections();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

start().catch((e) => {
  console.error('No se pudo conectar a PostgreSQL; el servidor no arranca.', e);
  process.exit(1);
});
