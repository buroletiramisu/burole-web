/**
 * Burolé · Google Sheet "Burole General" -> admin.burole.com.ar (en vivo)
 *
 * Cada vez que editás la pestaña "Clientes Estado", manda todos los pedidos al panel.
 * Instalación: ver admin/sheet/README.md (una sola vez).
 *
 * Lee la tabla tal como está hoy (encabezados en la fila donde dice "Fecha Pedido"):
 *   Fecha Pedido | Clientes | Fecha Entrega | Telefono | Pedido | Unidades | $$ | $$ Total | Hecho | Seña (50%) | Pago | (nota)
 * Una fila por producto. Las filas con la misma Fecha Pedido + Cliente + Fecha Entrega se juntan en un solo pedido.
 * "Pedido" tiene que llamarse como el producto en Ajustes del panel (ej. "Clasico Mediano", sin importar tildes).
 */

var HOJA = 'Clientes Estado';
var URL_PANEL = 'https://admin.burole.com.ar/api/sheet';

function norm_(s) { return String(s == null ? '' : s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim(); }
function fecha_(v) { return v instanceof Date ? Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd') : String(v || '').trim(); }
function si_(v) { return /^(si|sí|x|ok|true)/.test(norm_(v)) || v === true; }
function hash_(s) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, s, Utilities.Charset.UTF_8)
    .map(function (b) { return ('0' + (b & 255).toString(16)).slice(-2); }).join('').slice(0, 16);
}

/** Se ejecuta con cada cambio (activador instalable). */
function alCambiar(e) {
  if (e && e.source && e.source.getActiveSheet().getName() !== HOJA) return;
  enviarTodo();
}

/** Lee la pestaña completa y la manda al panel. También podés correrla a mano para probar. */
function enviarTodo() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return;
  try {
    var hoja = SpreadsheetApp.getActive().getSheetByName(HOJA);
    if (!hoja) throw new Error('No existe la pestaña "' + HOJA + '"');
    var datos = hoja.getDataRange().getValues();

    // Buscar la fila de encabezados y cada columna por su nombre
    var h = -1, col = {};
    for (var i = 0; i < Math.min(datos.length, 10) && h < 0; i++) {
      var enc = datos[i].map(norm_);
      if (enc.indexOf('fecha pedido') >= 0) {
        h = i;
        enc.forEach(function (n, c) {
          if (n === 'fecha pedido') col.fp = c;
          else if (n === 'clientes' || n === 'cliente') col.cli = c;
          else if (n === 'fecha entrega') col.fe = c;
          else if (n === 'telefono') col.tel = c;
          else if (n === 'pedido' || n === 'producto') col.prod = c;
          else if (n === 'unidades' || n === 'cantidad') col.uni = c;
          else if (n === 'hecho') col.hecho = c;
          else if (n.indexOf('sena') === 0) col.sena = c;
          else if (n === 'pago') col.pago = c;
        });
        col.nota = Math.max.apply(null, Object.keys(col).map(function (k) { return col[k]; })) + 1;
      }
    }
    if (h < 0 || col.fe == null || col.cli == null || col.prod == null) throw new Error('No encuentro los encabezados (Fecha Pedido, Clientes, Fecha Entrega, Pedido)');

    var pedidos = {}, orden = [];
    for (var r = h + 1; r < datos.length; r++) {
      var f = datos[r], cliente = String(f[col.cli] || '').trim(), fe = fecha_(f[col.fe]);
      if (!cliente || !fe) continue;
      var fp = fecha_(f[col.fp]), clave = fp + '|' + norm_(cliente) + '|' + fe;
      var p = pedidos[clave];
      if (!p) {
        p = pedidos[clave] = { id: hash_(clave), fechaPedido: fp, fecha: fe, cliente: cliente, items: {}, notas: [], hecho: true, sena: true, pago: true };
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

    var filas = orden.map(function (k) {
      var p = pedidos[k];
      return { id: p.id, fechaPedido: p.fechaPedido, fecha: p.fecha, cliente: p.cliente, items: p.items,
        estado: p.hecho ? 'Hecho' : 'No hecho', pago: p.pago ? 'Pagado' : p.sena ? 'Seña' : 'Sin cobrar',
        canal: '', entrega: 'Retiro', ajuste: 0, nota: p.notas.join(' · ') };
    });

    var token = PropertiesService.getScriptProperties().getProperty('SHEET_TOKEN');
    if (!token) throw new Error('Falta SHEET_TOKEN en Propiedades del script');
    var res = UrlFetchApp.fetch(URL_PANEL, {
      method: 'post', contentType: 'application/json', muteHttpExceptions: true,
      headers: { Authorization: 'Bearer ' + token },
      payload: JSON.stringify({ filas: filas })
    });
    if (res.getResponseCode() !== 200) throw new Error('El panel respondió ' + res.getResponseCode() + ': ' + res.getContentText());
    var out = JSON.parse(res.getContentText());
    SpreadsheetApp.getActive().toast(out.pedidos + ' pedidos en el panel' + (out.avisos && out.avisos.length ? ' · Revisar: ' + out.avisos.join(', ') : ''), 'Burolé', 5);
  } finally {
    lock.releaseLock();
  }
}

/** Ejecutar UNA vez: crea los activadores (con cada cambio y cada 5 minutos, por las dudas). */
function instalar() {
  ScriptApp.getProjectTriggers().forEach(function (t) { ScriptApp.deleteTrigger(t); });
  var ss = SpreadsheetApp.getActive();
  ScriptApp.newTrigger('alCambiar').forSpreadsheet(ss).onChange().create();
  ScriptApp.newTrigger('enviarTodo').timeBased().everyMinutes(5).create();
  enviarTodo();
}
