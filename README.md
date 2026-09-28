# Body Factory Gym

Catálogo web de suplementos de Body Factory Gym (Managua, Nicaragua): tienda pública con precio normal y
mayorista, carrito que envía el pedido por WhatsApp, API con SQLite y panel de administración para
productos, inventario, pedidos y reseñas.

Node.js sin frameworks: el servidor genera el HTML (SSR) con las mismas plantillas que usa el navegador
(`public/js/ui.js`), de modo que cada página es rastreable y se ve completa antes de que cargue el JavaScript.

## Requisitos

- Node.js **22.13 o superior** (probado con Node 22 y 24). Usa el módulo integrado `node:sqlite`.
- npm 10 o superior.
- Única dependencia: [`sharp`](https://sharp.pixelplumbing.com/) (procesamiento de imágenes del panel y de `npm run images`).

## Instalación

```bash
npm ci
cp .env.example .env      # en Windows: copy .env.example .env
npm start
```

- Tienda: <http://localhost:3000>
- Panel: <http://localhost:3000/admin>

## Configuración

La configuración se lee de variables de entorno. `npm start` carga automáticamente el archivo `.env`
si existe (`node --env-file-if-exists`). `.env` nunca se versiona; `.env.example` documenta las variables.

| Variable | Valor por defecto | Uso |
|---|---|---|
| `PORT` | `3000` | Puerto HTTP. |
| `NODE_ENV` | `development` | Con `production` la cookie de sesión del panel se marca `Secure` (requiere HTTPS). |
| `SITE_URL` | vacío | Origen público canónico, sin `/` final (p. ej. `https://www.dominio.com`). Se usa en canonical, Open Graph, JSON-LD, robots.txt y sitemap.xml. |
| `ALLOW_INDEXING` | `false` | `true` solo en el dominio de producción. La indexación se activa únicamente si además `SITE_URL` empieza por `https://`. |
| `DB_PATH` | `data/bodyfactory.db` | Ruta del archivo SQLite. |
| `ADMIN_USER` / `ADMIN_PASSWORD` | `admin` / generada | Solo se usan al crear el primer administrador (base sin cuentas). Si no hay contraseña, se genera una aleatoria y se guarda en `data/initial-admin-password.txt` (nunca en la consola); el archivo se borra cuando esa cuenta cambia su contraseña. |
| `TRUST_PROXY` | `false` | `true` solo detrás de un proxy inverso propio (Nginx, Caddy): la IP del cliente se toma de `X-Forwarded-For` para los límites de intentos. |

Datos del negocio (WhatsApp, Instagram, dirección, mapa, horario, preguntas frecuentes): `public/data/site.json`.

## Base de datos

SQLite en un solo archivo (modo WAL). El esquema se crea y migra de forma aditiva al arrancar (`server/db.js`).

- **La base real no está en Git** (`data/` y `*.db` están ignorados): contiene pedidos, reseñas y el usuario administrador.
- **Instalación nueva:** si la base no existe, se crea vacía y se carga el catálogo público de
  `server/seed/catalog.json` (productos y combos; sin pedidos, reseñas ni usuarios). Después se crea el administrador.
- **Producción:** copia la base real al servidor por un canal privado (SFTP/SCP) en `DB_PATH`,
  o arranca con el catálogo semilla y crea el administrador con `ADMIN_PASSWORD`.
- Actualizar el catálogo semilla desde la base actual: `npm run export:catalog`.

### Respaldo

```bash
npm run backup:db                       # backups/bodyfactory-<fecha>.db + PRAGMA integrity_check
npm run backup:db -- --reason antes-de-migrar
```

La copia se hace con `VACUUM INTO`, es consistente aunque el servidor esté en marcha y se verifica con
`PRAGMA integrity_check`. `backups/` no se versiona: guarda las copias fuera del servidor de la aplicación.

## Estructura

```
public/              Archivos servidos al navegador
  index.html         Plantilla HTML (el servidor inserta SEO, contenido y datos iniciales)
  css/styles.css     Estilos del sitio
  js/ui.js           Plantillas compartidas servidor/navegador (tarjetas, ficha, paginación, URLs)
  js/app.js          Lógica del navegador (filtros, búsqueda, carrito, ficha modal, historial)
  admin/             Panel de administración
  data/site.json     Datos de contacto, horario y FAQ
  img/               Logo, fotos de producto (img/products/<id>-400.webp y -800.webp)
  images/gallery/    Fotos del gimnasio (600 y 1000 px)
  icons/, manifest.webmanifest, sw.js   App instalable (PWA) y service worker
server/
  server.js          HTTP: páginas SSR, API pública y de administración, archivos estáticos
  pages.js           HTML de inicio, categorías, producto y 404 con metadatos SEO
  db.js              Esquema SQLite, migraciones aditivas, semilla y contraseñas (scrypt)
  images.js          Procesamiento de fotos de producto (lienzo negro cuadrado, escala uniforme)
  seed/catalog.json  Catálogo público para instalaciones nuevas
scripts/
  backup-db.mjs      Respaldo consistente de SQLite
  export-catalog.mjs Regenera server/seed/catalog.json desde la base
  optimize-images.mjs  Genera las imágenes WebP desde fotos originales
```

## Imágenes

- Productos: `public/img/products/<id>-400.webp` (tarjetas) y `-800.webp` (ficha), cuadradas sobre fondo negro.
  El campo `image` del producto guarda la ruta sin sufijo (`img/products/<id>`).
- Subir desde el panel (Editar → Imagen) genera ambas versiones automáticamente con un nombre nuevo.
- En lote: coloca las fotos originales en `img-src/products/<id>.png` (fondo transparente o negro) y ejecuta
  `npm run images`. `img-src/` no se versiona; conserva las fotos originales en un almacenamiento aparte.
- Caché: CSS y JS se versionan solos con una huella de su contenido. Las imágenes usan `ASSET_V`
  (`public/js/ui.js`); súbelo solo si reemplazas un archivo existente conservando su nombre.

## Rendimiento

- HTML generado en el servidor y guardado en memoria; se regenera solo cuando cambian el catálogo o las plantillas.
- Catálogo en memoria con invalidación inmediata al guardar desde el panel (y detección de cambios externos con
  `PRAGMA data_version`), por lo que el inventario nunca queda congelado ni requiere reiniciar.
- Compresión Brotli/gzip, `ETag`/304, CSS/JS/imágenes versionados con caché de un año; `/api/*` y el panel sin caché.
- El panel actualiza solo el producto guardado (sin recargar el listado completo).
- Imágenes WebP 400/800 con `srcset`/`sizes`, carga diferida y prioridad para la primera imagen visible.
- Service worker: archivos versionados desde caché, páginas con red primero; nunca guarda API ni panel.

## SEO

- URLs: `/`, `/categoria/<slug>`, `/producto/<slug>`, paginación con `?pagina=N`.
- Cada página tiene title, description, canonical, Open Graph, Twitter Card y JSON-LD
  (`Product` + `Offer`, `BreadcrumbList` y `HealthClub` con los datos de `site.json`). No se publican
  calificaciones agregadas (`AggregateRating`) ni códigos GTIN/MPN.
- `robots.txt` y `sitemap.xml` se generan dinámicamente. Sin `SITE_URL` + `ALLOW_INDEXING=true` el sitio responde
  `noindex` y robots.txt bloquea el rastreo (así un entorno local o de pruebas nunca se indexa).
- Búsquedas (`?q=`), panel y páginas 404 son `noindex`; el panel está excluido del sitemap y de robots.

Para producción:

```bash
SITE_URL=https://www.dominio-definitivo.com
ALLOW_INDEXING=true
NODE_ENV=production
```

Luego registra `https://www.dominio-definitivo.com/sitemap.xml` en Google Search Console y Bing Webmaster Tools.

## Despliegue

1. Servidor con Node.js 22.13+ detrás de un proxy HTTPS (Nginx, Caddy o el balanceador del proveedor).
2. `npm ci --omit=dev` y crear `.env` con las variables de producción.
3. Provisionar la base (`DB_PATH`) según la sección *Base de datos*.
4. Mantener el proceso activo con PM2 (`pm2 start ecosystem.config.cjs --env production`) o un servicio del sistema.
5. Programar `npm run backup:db` y copiar los respaldos fuera del servidor.

## Panel de administración y cuentas

- `/admin`: productos, pedidos, reseñas y cuenta. En teléfonos y tablets los productos se muestran como tarjetas
  (foto, precios y stock) y se editan en una hoja con guardado explícito; en escritorio se conserva la tabla con
  edición rápida por fila y acciones masivas de visibilidad.
- Roles (columna `admins.role`):
  - `admin` — Administrador: todo lo anterior y además gestiona usuarios (crear, restablecer contraseña,
    activar/desactivar, cambiar rol y eliminar).
  - `staff` — Empleado: productos, pedidos y reseñas; solo puede cambiar su propia contraseña.
- Reglas del servidor: nombres de usuario únicos (3–32 caracteres), contraseñas de al menos 10 caracteres,
  siempre debe quedar al menos un administrador activo, nadie puede desactivarse, cambiar su rol ni eliminarse a
  sí mismo, y eliminar una cuenta exige la contraseña de quien la elimina. Desactivar, eliminar o restablecer la
  contraseña de una cuenta cierra sus sesiones al instante.
- Migración: al arrancar, `server/db.js` añade las columnas `role`, `active` y `created_at` a `admins` si faltan
  (idempotente). Las cuentas existentes quedan como administradoras activas.

## Seguridad

- No versionar `.env`, bases de datos, respaldos ni documentos del cliente (ver `.gitignore`).
- Contraseñas con scrypt y sal (nunca se devuelven ni se registran); sesión con token aleatorio de 256 bits en cookie
  `HttpOnly` + `SameSite=Strict` (+ `Secure` y HSTS en producción), token nuevo en cada inicio de sesión, cierre de sesión en el servidor;
  cabecera obligatoria contra CSRF en acciones del panel; límite de intentos de inicio de sesión.
- CSP sin scripts en línea; todo texto dinámico se escapa antes de insertarse en HTML.
- Los precios y el stock de un pedido se recalculan en el servidor; nunca se confía en el navegador.
- Solo se sirve el contenido de `public/`: `data/`, `server/`, `scripts/` y `.env` no son accesibles por HTTP.
- Límite de intentos de inicio de sesión por IP y por usuario, con el mismo mensaje para usuario inexistente,
  desactivado o contraseña incorrecta.
- El panel se sirve con `Cache-Control: no-store`, fuera del service worker; sus APIs nunca se guardan en caché.
- Las sesiones del panel viven en memoria: reiniciar el servidor cierra las sesiones abiertas.

## Pedidos

1. El cliente arma el carrito y pulsa «Enviar pedido por WhatsApp».
2. `POST /api/orders` recalcula precios desde la base, valida stock y guarda el pedido con un código `BF-AAMMDD-NNNN`.
3. Se abre WhatsApp con el mensaje redactado e incluye ese código.
4. En el panel (Pedidos) se cambia el estado: nuevo, confirmado, entregado o cancelado.

El stock no se descuenta automáticamente: se actualiza en el panel al confirmar cada venta.
