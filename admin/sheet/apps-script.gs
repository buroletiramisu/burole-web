/**
 * Burolé · Google Sheet -> admin.burole.com.ar (en vivo)
 *
 * Cada vez que editás la hoja "Pedidos", manda todas las filas al panel.
 * Instalación: ver admin/sheet/README.md (5 minutos, una sola vez).
 *
 * Encabezados de la fila 1 (el orden no importa, mayúsculas y tildes tampoco):
 *   ID | Fecha pedido | Fecha entrega | Cliente | <una columna por producto> | Ajuste | Canal | Entrega | Estado | Pago | Nota
 * Las columnas de producto tienen que llamarse igual que en Ajustes del panel (ej. "Clásico mediano") y llevan la cantidad.
 * La columna ID la completa el script solo: no la toques.
 */

var HOJA = 'Pedidos';
var URL_PANEL = 'https://admin.burole.com.ar/api/sheet';
var FIJAS = { 'id': 'id', 'fecha pedido': 'fechaPedido', 'fecha entrega': 'fecha', 'entrega fecha': 'fecha', 'cliente': 'cliente',
  'ajuste': 'ajuste', 'canal': 'canal', 'entrega': 'entrega', 'estado': 'estado', 'pago': 'pago', 'nota': 'nota', 'total': '_ignorar' };

function norm_(s) { return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim(); }
function fecha_(v) { return v instanceof Date ? Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd') : String(v || ''); }

/** Se ejecuta con cada cambio (activador instalable). */
function alCambiar(e) {
  if (e && e.source && e.source.getActiveSheet().getName() !== HOJA) return;
  enviarTodo();
}

/** Lee la hoja completa y la manda al panel. También podés correrla a mano para probar. */
function enviarTodo() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return;
  try {
    var hoja = SpreadsheetApp.getActive().getSheetByName(HOJA);
    if (!hoja) throw new Error('No existe la hoja "' + HOJA + '"');
    var datos = hoja.getDataRange().getValues();
    if (datos.length < 2) return;
    var enc = datos[0].map(norm_), colId = enc.indexOf('id');
    if (colId < 0) throw new Error('Falta la columna ID en la fila 1');

    var filas = [], nuevosIds = [];
    for (var i = 1; i < datos.length; i++) {
      var r = datos[i];
      if (r.join('').trim() === '') continue;
      if (!r[colId]) { r[colId] = Utilities.getUuid().slice(0, 8); nuevosIds.push([i + 1, r[colId]]); }
      var f = { items: {} };
      for (var c = 0; c < enc.length; c++) {
        if (!enc[c]) continue;
        var campo = FIJAS[enc[c]];
        if (campo === '_ignorar') continue;
        if (campo) f[campo] = (campo === 'fecha' || campo === 'fechaPedido') ? fecha_(r[c]) : r[c];
        else if (r[c] !== '' && r[c] !== 0) f.items[datos[0][c]] = r[c];
      }
      filas.push(f);
    }
    nuevosIds.forEach(function (x) { hoja.getRange(x[0], colId + 1).setValue(x[1]); });

    var token = PropertiesService.getScriptProperties().getProperty('SHEET_TOKEN');
    if (!token) throw new Error('Falta SHEET_TOKEN en Propiedades del script');
    var res = UrlFetchApp.fetch(URL_PANEL, {
      method: 'post', contentType: 'application/json', muteHttpExceptions: true,
      headers: { Authorization: 'Bearer ' + token },
      payload: JSON.stringify({ filas: filas })
    });
    if (res.getResponseCode() !== 200) throw new Error('El panel respondió ' + res.getResponseCode() + ': ' + res.getContentText());
    var out = JSON.parse(res.getContentText());
    if (out.avisos && out.avisos.length) SpreadsheetApp.getActive().toast(out.avisos.join(' · '), 'Burolé: revisar', 8);
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
