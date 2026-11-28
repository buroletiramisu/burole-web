/**
 * Burolé · Google Sheet "Burole General" <-> admin.burole.com.ar (en vivo, en los dos sentidos)
 *
 * Sheet -> panel: cada cambio en la pestaña "Clientes Estado" manda todos los pedidos al panel.
 * Panel -> Sheet: el panel llama a esta app web (doPost) para crear, cambiar o borrar filas.
 * Instalación: ver admin/sheet/README.md (una sola vez).
 *
 * Lee la tabla tal como está hoy (encabezados en la fila donde dice "Fecha Pedido"):
 *   Fecha Pedido | Clientes | Fecha Entrega | Telefono | Pedido | Unidades | $$ | $$ Total | Hecho | Seña (50%) | Pago | (nota)
 * Una fila por producto. Las filas con la misma Fecha Pedido + Cliente + Fecha Entrega forman un pedido.
 * Hecho = se hizo · Seña = pagaron una parte · Pago = pagado completo.
 */

var HOJA = 'Clientes Estado';
var URL_PANEL = 'https://admin.burole.com.ar/api/sheet';

function norm_(s) { return String(s == null ? '' : s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim(); }
function fecha_(v) { return v instanceof Date ? Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd') : String(v || '').trim(); }
function si_(v) { return v === true || /^(si|x|ok|true)/.test(norm_(v)); }
function hash_(s) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, s, Utilities.Charset.UTF_8)
    .map(function (b) { return ('0' + (b & 255).toString(16)).slice(-2); }).join('').slice(0, 16);
}
function token_() {
  var t = PropertiesService.getScriptProperties().getProperty('SHEET_TOKEN');
  if (!t) throw new Error('Falta SHEET_TOKEN en Propiedades del script');
  return t;
}

/** Lee la pestaña: devuelve la hoja, los valores, la fila de encabezados y en qué columna está cada dato. */
function leer_() {
  var hoja = SpreadsheetApp.getActive().getSheetByName(HOJA);
  if (!hoja) throw new Error('No existe la pestaña "' + HOJA + '"');
  var datos = hoja.getDataRange().getValues(), h = -1, col = {};
  for (var i = 0; i < Math.min(datos.length, 10) && h < 0; i++) {
    var enc = datos[i].map(norm_);
    if (enc.indexOf('fecha pedido') < 0) continue;
    h = i;
    enc.forEach(function (n, c) {
      if (n === 'fecha pedido') col.fp = c;
      else if (n === 'clientes' || n === 'cliente') col.cli = c;
      else if (n === 'fecha entrega') col.fe = c;
      else if (n === 'telefono') col.tel = c;
      else if (n === 'pedido' || n === 'producto') col.prod = c;
      else if (n === 'unidades' || n === 'cantidad') col.uni = c;
      else if (n === '$$') col.precio = c;
      else if (n === '$$ total') col.total = c;
      else if (n === 'hecho') col.hecho = c;
      else if (n.indexOf('sena') === 0) col.sena = c;
      else if (n === 'pago') col.pago = c;
    });
    col.nota = Math.max.apply(null, Object.keys(col).map(function (k) { return col[k]; })) + 1;
  }
  if (h < 0 || col.fe == null || col.cli == null || col.prod == null) throw new Error('No encuentro los encabezados (Fecha Pedido, Clientes, Fecha Entrega, Pedido)');
  return { hoja: hoja, datos: datos, h: h, col: col };
}

/** Clave de una fila: Fecha Pedido + Cliente + Fecha Entrega. El id del pedido es su hash. */
function clave_(f, col) { return fecha_(f[col.fp]) + '|' + norm_(f[col.cli]) + '|' + fecha_(f[col.fe]); }
function esPedido_(f, col) { return String(f[col.cli] || '').trim() !== '' && fecha_(f[col.fe]) !== '' && norm_(f[col.fp]) !== 'total'; }

/** Arma la lista de pedidos a partir de las filas. */
function pedidos_(L) {
  var col = L.col, pedidos = {}, orden = [];
  for (var r = L.h + 1; r < L.datos.length; r++) {
    var f = L.datos[r];
    if (!esPedido_(f, col)) continue;
    var clave = clave_(f, col), p = pedidos[clave];
    if (!p) {
      p = pedidos[clave] = { id: hash_(clave), fechaPedido: fecha_(f[col.fp]), fecha: fecha_(f[col.fe]), cliente: String(f[col.cli]).trim(), items: {}, notas: [], hecho: true, sena: true, pago: true };
      orden.push(clave);
    }
    var prod = String(f[col.prod] || '').trim(), uni = col.uni != null ? (+f[col.uni] || 1) : 1;
    if (prod) p.items[prod] = (p.items[prod] || 0) + uni;
    // El pedido está hecho / señado / pagado solo si TODAS sus filas lo están
    p.hecho = p.hecho && (col.hecho == null || si_(f[col.hecho]));
    p.sena = p.sena && (col.sena == null || si_(f[col.sena]));
    p.pago = p.pago && (col.pago == null || si_(f[col.pago]));
    var tel = col.tel != null ? String(f[col.tel] || '').trim() : '', extra = String(f[col.nota] || '').trim();
    if (tel && p.notas.indexOf('Tel: ' + tel) < 0) p.notas.push('Tel: ' + tel);
    if (extra && p.notas.indexOf(extra) < 0) p.notas.push(extra);
  }
  return orden.map(function (k) {
    var p = pedidos[k];
    return { id: p.id, fechaPedido: p.fechaPedido, fecha: p.fecha, cliente: p.cliente, items: p.items,
      estado: p.hecho ? 'Hecho' : 'No hecho', pago: p.pago ? 'Pagado' : p.sena ? 'Seña' : 'Sin cobrar',
      canal: '', entrega: 'Retiro', ajuste: 0, nota: p.notas.join(' · ') };
  });
}

/** Activador "al cambiar": se ejecuta con cada edición, fila agregada o borrada. */
function alCambiar(e) { enviarTodo(); }

/** Lee la pestaña completa y la manda al panel. También podés correrla a mano para probar. */
function enviarTodo() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return;
  try {
    var filas = pedidos_(leer_());
    var res = UrlFetchApp.fetch(URL_PANEL, {
      method: 'post', contentType: 'application/json', muteHttpExceptions: true,
      headers: { Authorization: 'Bearer ' + token_() },
      payload: JSON.stringify({ filas: filas })
    });
    if (res.getResponseCode() !== 200) throw new Error('El panel respondió ' + res.getResponseCode() + ': ' + res.getContentText());
    var out = JSON.parse(res.getContentText());
    if (out.avisos && out.avisos.length) SpreadsheetApp.getActive().toast('Revisar: ' + out.avisos.join(', '), 'Burolé', 6);
  } finally {
    lock.releaseLock();
  }
}

/** App web: el panel la llama para escribir en el Sheet. Responde { ok, id }. */
function doPost(e) {
  var salida = function (o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); };
  var lock = LockService.getScriptLock();
  try {
    var b = JSON.parse(e.postData.contents);
    if (!b.token || b.token !== token_()) return salida({ ok: false, error: 'Prohibido' });
    if (!lock.tryLock(20000)) return salida({ ok: false, error: 'Sheet ocupado, probá de nuevo' });
    var id = b.accion === 'borrar' ? borrarPedido_(b.id) : guardarPedido_(b.id, b.pedido);
    return salida({ ok: true, id: id });
  } catch (err) {
    return salida({ ok: false, error: String(err.message || err) });
  } finally {
    try { lock.releaseLock(); } catch (x) {}
  }
}

/** Filas (número de fila en la hoja, desde 1) que forman el pedido con ese id. */
function filasDe_(L, id) {
  var out = [];
  if (!id) return out;
  for (var r = L.h + 1; r < L.datos.length; r++) if (esPedido_(L.datos[r], L.col) && hash_(clave_(L.datos[r], L.col)) === id) out.push(r + 1);
  return out;
}

function borrarPedido_(id) {
  var L = leer_(), filas = filasDe_(L, id);
  for (var i = filas.length - 1; i >= 0; i--) L.hoja.deleteRow(filas[i]);
  return id;
}

function aFecha_(iso) { var m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})$/); return m ? new Date(+m[1], +m[2] - 1, +m[3]) : iso; }
function siNo_(v) { return v ? 'Si' : 'No'; }

/** Crea o actualiza las filas de un pedido. Devuelve el id nuevo (cambia si cambian fecha o cliente). */
function guardarPedido_(id, p) {
  if (!p || !p.cliente || !p.fecha) throw new Error('Al pedido le falta cliente o fecha de entrega');
  var L = leer_(), col = L.col, hoja = L.hoja, filas = filasDe_(L, id);
  var items = (p.items || []).slice();
  if (!items.length) throw new Error('El pedido no tiene productos');

  // Filas que ya existen: se actualizan las del mismo producto, el resto se borra
  var usadas = [], sobran = [];
  filas.forEach(function (n) {
    var prod = norm_(L.datos[n - 1][col.prod]);
    var k = -1;
    for (var i = 0; i < items.length; i++) if (norm_(items[i].nombre) === prod) { k = i; break; }
    if (k >= 0) { usadas.push({ fila: n, item: items[k] }); items.splice(k, 1); } else sobran.push(n);
  });

  // Productos nuevos: primero en filas vacías de la plantilla, si no, filas nuevas antes del "Total"
  var libres = [], filaTotal = -1;
  for (var r = L.h + 1; r < L.datos.length; r++) {
    var f = L.datos[r];
    if (norm_(f[col.fp]) === 'total') { filaTotal = r + 1; break; }
    if (!String(f[col.cli] || '').trim() && !fecha_(f[col.fp]) && sobran.indexOf(r + 1) < 0) libres.push(r + 1);
  }
  // Reusar las filas que sobran antes que las vacías
  libres = sobran.splice(0, items.length).concat(libres);
  items.forEach(function (it) {
    var n = libres.shift();
    if (!n) {
      var antes = filaTotal > 0 ? filaTotal - 1 : hoja.getLastRow();
      hoja.insertRowAfter(antes);
      hoja.getRange(antes, 1, 1, hoja.getLastColumn()).copyTo(hoja.getRange(antes + 1, 1, 1, hoja.getLastColumn()));
      n = antes + 1;
      if (filaTotal > 0) filaTotal++;
    }
    usadas.push({ fila: n, item: it, nueva: true });
  });

  var poner = function (fila, c, v) { if (c != null) { var rg = hoja.getRange(fila, c + 1); if (!rg.getFormula()) rg.setValue(v); } };
  usadas.forEach(function (u) {
    poner(u.fila, col.fp, aFecha_(p.fechaPedido || p.fecha));
    poner(u.fila, col.cli, p.cliente);
    poner(u.fila, col.fe, aFecha_(p.fecha));
    poner(u.fila, col.prod, u.item.nombre);
    poner(u.fila, col.uni, u.item.cantidad);
    if (u.nueva || !String(L.datos[u.fila - 1][col.precio] || '').trim()) poner(u.fila, col.precio, u.item.precio);
    poner(u.fila, col.total, u.item.cantidad * u.item.precio);
    poner(u.fila, col.hecho, siNo_(p.hecho));
    poner(u.fila, col.sena, siNo_(p.sena || p.pagado));
    poner(u.fila, col.pago, siNo_(p.pagado));
    if (u.nueva) poner(u.fila, col.nota, '');
  });
  // Filas que sobraron del pedido viejo (producto sacado): se borran de abajo hacia arriba
  sobran.sort(function (a, b) { return b - a; }).forEach(function (n) { hoja.deleteRow(n); });

  // El id sale de lo que quedó escrito (las fechas pueden cambiar de formato al guardarse)
  SpreadsheetApp.flush();
  var L2 = leer_(), primera = usadas.map(function (u) { return u.fila; }).sort(function (a, b) { return a - b; })[0];
  var desplazadas = sobran.filter(function (n) { return n < primera; }).length;
  return hash_(clave_(L2.datos[primera - 1 - desplazadas], L2.col));
}

/** Ejecutar UNA vez: crea los activadores (con cada cambio y cada 5 minutos, por las dudas). */
function instalar() {
  ScriptApp.getProjectTriggers().forEach(function (t) { ScriptApp.deleteTrigger(t); });
  var ss = SpreadsheetApp.getActive();
  ScriptApp.newTrigger('alCambiar').forSpreadsheet(ss).onChange().create();
  ScriptApp.newTrigger('enviarTodo').timeBased().everyMinutes(5).create();
  enviarTodo();
}
