// Burolé Admin: login con usuario y contraseña, sesiones y datos (pedidos, clientes, tareas, ajustes) en D1.
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
    db.prepare('CREATE TABLE IF NOT EXISTS intentos (ip TEXT NOT NULL, ts INTEGER NOT NULL)')
  ]);
  esquemaListo = true;
}

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
  const m = p.match(/^\/api\/item\/([a-z]+)\/([A-Za-z0-9_-]{1,64})$/);
  if (m && TIPOS.includes(m[1])) {
    const [, kind, id] = m;
    if (req.method === 'PUT') {
      const texto = await req.text();
      if (texto.length > 100000) return json({ error: 'Demasiado grande' }, 413);
      let data;
      try { data = JSON.parse(texto); } catch (e) { return json({ error: 'JSON inválido' }, 400); }
      await env.DB.prepare('INSERT INTO items (kind, id, data, updated) VALUES (?, ?, ?, ?) ON CONFLICT(kind, id) DO UPDATE SET data = excluded.data, updated = excluded.updated')
        .bind(kind, id, JSON.stringify(data), Date.now()).run();
      return json({ ok: true });
    }
    if (req.method === 'DELETE') {
      await env.DB.prepare('DELETE FROM items WHERE kind = ? AND id = ?').bind(kind, id).run();
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
