// Burolé Admin: login con usuario y contraseña, sesiones y datos (pedidos, clientes, tareas, ajustes) en D1.
// Secreto extra: SHEET_TOKEN (clave larga que comparte con el Apps Script del Google Sheet, ver admin/sheet/README.md)
// Variable SHEET_WEBAPP_URL (wrangler.jsonc): app web del Apps Script; con ella los cambios del panel se escriben en el Sheet
// Secretos del Worker: ADMIN_USER y ADMIN_HASH ("salt:hash" PBKDF2-SHA256, 100.000 iteraciones). Nunca la contraseña en texto.

const COOKIE = 'burole_admin';
const SESION_DIAS = 14;
const PUBLICAS = ['/login', '/favicon.svg', '/robots.txt'];
const TIPOS = ['pedido', 'cliente', 'tarea', 'config'];

let esquemaListo = false;
async function esquema(db) {
  if (esquemaListo) return;
  await db.batch([
    db.prepare('CREATE TABLE IF NOT EXISTS items (kind TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, updated INTEGER NOT NULL, PRIMARY KEY (kind, id))'),
    db.prepare('CREATE TABLE IF NOT EXISTS sesiones (token TEXT PRIMARY KEY, expira INTEGER NOT NULL)'),
    db.prepare('CREATE TABLE IF NOT EXISTS intentos (ip TEXT NOT NULL, ts INTEGER NOT NULL)'),
    db.prepare('CREATE TABLE IF NOT EXISTS version (id INTEGER PRIMARY KEY, v INTEGER NOT NULL)')
  ]);
  esquemaListo = true;
}

// Una sola fila que cambia con cada escritura: el panel la consulta cada pocos segundos sin leer toda la base
const subirVersion = (db) => db.prepare('INSERT INTO version (id, v) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET v = excluded.v').bind(Date.now());

const json = (data, status = 200, extra = {}) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extra } });

function leerCookie(req) {
  const m = (req.headers.get('cookie') || '').match(new RegExp('(?:^|;\\s*)' + COOKIE + '=([a-f0-9]{64})'));
  return m ? m[1] : null;
}
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const deHex = (s) => new Uint8Array(s.match(/../g).map((h) => parseInt(h, 16)));

async function claveValida(pass, guardado) {
  if (!guardado || !guardado.includes(':')) return false;
  const [salt, hash] = guardado.split(':');
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pass), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: deHex(salt), iterations: 100000 }, key, 256);
  const a = deHex(hash), b = new Uint8Array(bits);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

// En la base se guarda el SHA-256 del token, no el token: si alguien lee la tabla no puede usar las sesiones
async function huella(token) {
  return hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token)));
}

async function sesionValida(env, req) {
  const t = leerCookie(req);
  if (!t) return false;
  const r = await env.DB.prepare('SELECT expira FROM sesiones WHERE token = ?').bind(await huella(t)).first();
  return !!r && r.expira > Date.now();
}

async function login(env, req) {
  const ip = req.headers.get('cf-connecting-ip') || 'local';
  const desde = Date.now() - 15 * 60 * 1000;
  // Límite por IP (8 fallos en 15 min) y global (40 fallos en 15 min, frena ataques que rotan IPs)
  const fallos = await env.DB.prepare('SELECT SUM(ip = ?) AS n, COUNT(*) AS total FROM intentos WHERE ts > ?').bind(ip, desde).first();
  if (fallos && (fallos.n >= 8 || fallos.total >= 40)) return json({ error: 'Demasiados intentos. Probá de nuevo en 15 minutos.' }, 429);
  if (!env.ADMIN_USER || !env.ADMIN_HASH) return json({ error: 'Falta configurar el acceso.' }, 503);

  let body = {};
  try { body = await req.json(); } catch (e) {}
  const user = String(body.usuario || '').trim().toLowerCase();
  // La clave se verifica siempre (aunque el usuario no coincida) para no revelar por tiempo de respuesta si el usuario existe
  const claveOk = await claveValida(String(body.clave || ''), env.ADMIN_HASH);
  const ok = user === String(env.ADMIN_USER).toLowerCase() && claveOk;
  if (!ok) {
    await env.DB.batch([
      env.DB.prepare('INSERT INTO intentos (ip, ts) VALUES (?, ?)').bind(ip, Date.now()),
      env.DB.prepare('DELETE FROM intentos WHERE ts < ?').bind(desde)
    ]);
    return json({ error: 'Usuario o contraseña incorrectos.' }, 401);
  }
  const token = hex(crypto.getRandomValues(new Uint8Array(32)));
  await env.DB.batch([
    env.DB.prepare('INSERT INTO sesiones (token, expira) VALUES (?, ?)').bind(await huella(token), Date.now() + SESION_DIAS * 86400000),
    env.DB.prepare('DELETE FROM sesiones WHERE expira < ?').bind(Date.now()),
    env.DB.prepare('DELETE FROM intentos WHERE ip = ? OR ts < ?').bind(ip, desde)
  ]);
  return json({ ok: true }, 200, {
    'set-cookie': `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESION_DIAS * 86400}`
  });
}

// ===== Google Sheet -> pedidos =====
// El Apps Script del Sheet manda TODAS las filas cada vez que algo cambia. Los pedidos que vienen del Sheet
// se guardan con id "sh_<id de fila>" y origen "sheet"; si una fila se borra del Sheet, se borra acá también.
function igualSeguro(a, b) {
  const x = new TextEncoder().encode(String(a)), y = new TextEncoder().encode(String(b));
  if (x.length !== y.length) return false;
  let d = 0;
  for (let i = 0; i < x.length; i++) d |= x[i] ^ y[i];
  return d === 0;
}
const norm = (s) => String(s == null ? '' : s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
const PROD_BASE = [{ id: 'cm', nombre: 'Clásico mediano', precio: 18000 }, { id: 'cg', nombre: 'Clásico grande', precio: 28000 }, { id: 'pm', nombre: 'Pistacho mediano', precio: 28000 }, { id: 'pg', nombre: 'Pistacho grande', precio: 36000 }, { id: 'mini', nombre: 'Minis × 10', precio: 0 }];
const CANAL_BASE = [{ id: 'web', nombre: 'Web' }, { id: 'whatsapp', nombre: 'WhatsApp' }, { id: 'instagram', nombre: 'Instagram' }, { id: 'conocido', nombre: 'Conocido' }];
const numero = (v) => Math.round(+String(v == null ? '' : v).replace(/[^\d,.-]/g, '').replace(/\.(?=\d{3}(\D|$))/g, '').replace(',', '.') || 0);

function fechaIso(v) {
  const t = String(v || '').trim();
  let m = t.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = t.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2,4})$/); // 27/11/2026 (formato argentino)
  if (m) return `${m[3].length === 2 ? '20' + m[3] : m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return '';
}

async function sincronizarSheet(env, req) {
  if (!env.SHEET_TOKEN || env.SHEET_TOKEN.length < 24) return json({ error: 'Falta configurar SHEET_TOKEN' }, 503);
  const auth = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!igualSeguro(auth, env.SHEET_TOKEN)) return json({ error: 'Prohibido' }, 403);
  const texto = await req.text();
  if (texto.length > 2000000) return json({ error: 'Demasiado grande' }, 413);
  let body;
  try { body = JSON.parse(texto); } catch (e) { return json({ error: 'JSON inválido' }, 400); }
  const filas = Array.isArray(body.filas) ? body.filas.slice(0, 5000) : null;
  if (!filas) return json({ error: 'Faltan filas' }, 400);

  const cfgRow = await env.DB.prepare("SELECT data FROM items WHERE kind = 'config' AND id = 'general'").first();
  const cfg = cfgRow ? JSON.parse(cfgRow.data) : {};
  const prodPorNombre = new Map((cfg.productos || PROD_BASE).map((x) => [norm(x.nombre), x.id]));
  const canalPorNombre = new Map((cfg.canales || CANAL_BASE).map((x) => [norm(x.nombre), x.id]));

  // Los pedidos son un espejo del Sheet: se comparan contra TODOS los pedidos de la base (también los cargados a mano)
  const { results: previos } = await env.DB.prepare("SELECT id, data FROM items WHERE kind = 'pedido'").all();
  const previo = new Map(previos.map((r) => [r.id, JSON.parse(r.data)]));
  const ahora = Date.now(), vistos = new Set(), stmts = [], avisos = new Set();

  for (const f of filas) {
    const idFila = String((f && f.id) || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 60);
    const fecha = fechaIso(f && f.fecha);
    if (!idFila || !fecha) continue; // fila vacía o sin fecha de entrega: se ignora
    const id = 'sh_' + idFila;
    if (vistos.has(id)) continue;
    vistos.add(id);
    const items = {};
    for (const [nombre, cant] of Object.entries(f.items || {})) {
      const pid = prodPorNombre.get(norm(nombre)), n = numero(cant);
      if (pid && n > 0) items[pid] = n;
      else if (!pid && n > 0) avisos.add(`Producto desconocido: ${String(nombre).slice(0, 40)}`);
    }
    const pago = norm(f.pago), estado = norm(f.estado), ant = previo.get(id) || {};
    const ped = {
      id, origen: 'sheet', creado: ant.creado || ahora,
      fecha, pedidoEl: fechaIso(f.fechaPedido) || fecha,
      cliente: String(f.cliente || '').slice(0, 120), clienteId: ant.clienteId || '',
      items, ajuste: numero(f.ajuste),
      canal: canalPorNombre.get(norm(f.canal)) || '',
      entrega: /envio/.test(norm(f.entrega)) ? 'envio' : 'retiro',
      // Palabras exactas: "sin cobrar" empieza con "si" y antes se tomaba como pagado
      hecho: /^(hecho|si|entregado|listo)$/.test(estado),
      pagado: /^(pagado|pago|si|cobrado)$/.test(pago), sena: /^(pagado|pago|si|cobrado|sena|senado)$/.test(pago),
      nota: String(f.nota || '').slice(0, 1000), extra: ant.extra || {}
    };
    const data = JSON.stringify(ped);
    // Solo se escribe si la fila cambió, así el panel no recarga de gusto
    if (!previo.has(id) || JSON.stringify(ant) !== data)
      stmts.push(env.DB.prepare('INSERT INTO items (kind, id, data, updated) VALUES (?, ?, ?, ?) ON CONFLICT(kind, id) DO UPDATE SET data = excluded.data, updated = excluded.updated').bind('pedido', id, data, ahora));
  }
  // Seguro: si el Sheet llega sin ningún pedido válido y en la base hay varios, no se borra nada (evita vaciar todo por un error de lectura)
  if (vistos.size === 0 && previo.size > 3) return json({ error: 'El Sheet llegó vacío: no borro los pedidos por seguridad' }, 409);
  let borrados = 0;
  for (const id of previo.keys()) if (!vistos.has(id)) { stmts.push(env.DB.prepare("DELETE FROM items WHERE kind = 'pedido' AND id = ?").bind(id)); borrados++; }
  const cambios = stmts.length - borrados;
  if (stmts.length) stmts.push(subirVersion(env.DB));
  for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));
  return json({ ok: true, pedidos: vistos.size, cambios, borrados, avisos: [...avisos].slice(0, 10) });
}

// ===== Panel -> Google Sheet =====
// Cada alta, cambio o borrado de un pedido en el panel se escribe primero en el Sheet (app web del Apps Script).
// Si el Sheet no responde, no se guarda: así los dos lados nunca quedan distintos.
async function aSheet(env, accion, idViejo, ped) {
  if (!env.SHEET_WEBAPP_URL || !env.SHEET_TOKEN) return null; // sin app web configurada: el panel guarda solo en la base
  const cuerpo = { token: env.SHEET_TOKEN, accion, id: idViejo && idViejo.startsWith('sh_') ? idViejo.slice(3) : '' };
  if (ped) {
    const cfgRow = await env.DB.prepare("SELECT data FROM items WHERE kind = 'config' AND id = 'general'").first();
    const prods = (cfgRow && JSON.parse(cfgRow.data).productos) || PROD_BASE;
    let cliente = ped.cliente || '';
    if (ped.clienteId) {
      const c = await env.DB.prepare("SELECT data FROM items WHERE kind = 'cliente' AND id = ?").bind(ped.clienteId).first();
      if (c) cliente = JSON.parse(c.data).nombre || cliente;
    }
    cuerpo.pedido = {
      fechaPedido: ped.pedidoEl || ped.fecha, fecha: ped.fecha, cliente,
      items: prods.filter((x) => (ped.items || {})[x.id] > 0).map((x) => ({ nombre: x.nombre, cantidad: ped.items[x.id], precio: x.precio || 0 })),
      hecho: !!ped.hecho, sena: !!(ped.sena || ped.pagado), pagado: !!ped.pagado
    };
  }
  const r = await fetch(env.SHEET_WEBAPP_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(cuerpo), redirect: 'follow' });
  let out = {};
  try { out = await r.json(); } catch (e) {}
  if (!r.ok || !out.ok) throw new Error(out.error || 'El Sheet no respondió');
  return out; // { ok, id } con el id nuevo del pedido en el Sheet
}

async function api(env, req, url) {
  const p = url.pathname;
  if (p === '/api/datos' && req.method === 'GET') {
    const { results } = await env.DB.prepare('SELECT kind, id, data FROM items').all();
    const out = { pedido: [], cliente: [], tarea: [], config: {} };
    for (const r of results) {
      const d = JSON.parse(r.data);
      if (r.kind === 'config') out.config[r.id] = d;
      else if (out[r.kind]) out[r.kind].push(d);
    }
    return json(out);
  }
  // Versión liviana de los datos: el panel la consulta cada 20 s y solo recarga si cambió algo (así el Sheet se ve en vivo)
  if (p === '/api/version' && req.method === 'GET') {
    const r = await env.DB.prepare('SELECT v FROM version WHERE id = 1').first();
    return json({ v: String(r ? r.v : 0) });
  }
  const m = p.match(/^\/api\/item\/([a-z]+)\/([A-Za-z0-9_-]{1,64})$/);
  if (m && TIPOS.includes(m[1])) {
    const [, kind, id] = m;
    if (req.method === 'PUT') {
      const texto = await req.text();
      if (texto.length > 100000) return json({ error: 'Demasiado grande' }, 413);
      let data;
      try { data = JSON.parse(texto); } catch (e) { return json({ error: 'JSON inválido' }, 400); }
      let idFinal = id;
      if (kind === 'pedido') {
        let s;
        try { s = await aSheet(env, 'guardar', id, data); } catch (e) { return json({ error: 'No se pudo escribir en el Sheet: ' + e.message }, 502); }
        if (s && s.id) { idFinal = 'sh_' + String(s.id).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 60); data.id = idFinal; data.origen = 'sheet'; }
      }
      const stmts = [env.DB.prepare('INSERT INTO items (kind, id, data, updated) VALUES (?, ?, ?, ?) ON CONFLICT(kind, id) DO UPDATE SET data = excluded.data, updated = excluded.updated')
        .bind(kind, idFinal, JSON.stringify(data), Date.now())];
      if (idFinal !== id) stmts.push(env.DB.prepare('DELETE FROM items WHERE kind = ? AND id = ?').bind(kind, id));
      stmts.push(subirVersion(env.DB));
      await env.DB.batch(stmts);
      return json({ ok: true, id: idFinal });
    }
    if (req.method === 'DELETE') {
      if (kind === 'pedido' && id.startsWith('sh_')) {
        try { await aSheet(env, 'borrar', id, null); } catch (e) { return json({ error: 'No se pudo borrar en el Sheet: ' + e.message }, 502); }
      }
      await env.DB.batch([env.DB.prepare('DELETE FROM items WHERE kind = ? AND id = ?').bind(kind, id), subirVersion(env.DB)]);
      return json({ ok: true });
    }
  }
  return json({ error: 'No encontrado' }, 404);
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const p = url.pathname;
    await esquema(env.DB);

    if (p === '/api/login' && req.method === 'POST') {
      if (req.headers.get('x-burole') !== '1') return json({ error: 'Prohibido' }, 403);
      return login(env, req);
    }
    // Entrada del Google Sheet: no usa sesión, se autentica con SHEET_TOKEN en el header Authorization
    if (p === '/api/sheet' && req.method === 'POST') return sincronizarSheet(env, req);
    if (p === '/api/logout' && req.method === 'POST') {
      const t = leerCookie(req);
      if (t) await env.DB.prepare('DELETE FROM sesiones WHERE token = ?').bind(await huella(t)).run();
      return json({ ok: true }, 200, { 'set-cookie': `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0` });
    }

    const publica = PUBLICAS.includes(p) || p.startsWith('/assets/');
    const logueado = publica ? false : await sesionValida(env, req);

    if (p.startsWith('/api/')) {
      if (!logueado) return json({ error: 'Sesión vencida' }, 401);
      // Protección CSRF básica: solo pedidos desde la misma página
      if (req.method !== 'GET' && req.headers.get('x-burole') !== '1') return json({ error: 'Prohibido' }, 403);
      return api(env, req, url);
    }
    if (p === '/login') {
      if (await sesionValida(env, req)) return Response.redirect(url.origin + '/', 302);
      return env.ASSETS.fetch(new Request(url.origin + '/login.html', req));
    }
    if (!publica && !logueado) return Response.redirect(url.origin + '/login', 302);
    if (p === '/' || p === '/index.html') return env.ASSETS.fetch(new Request(url.origin + '/index.html', req));
    return env.ASSETS.fetch(req);
  }
};
