# Google Sheet ⇄ panel en vivo (dos sentidos)

- **Sheet → panel**: cargás, cambiás o borrás un pedido en el Sheet y en ~10 segundos se ve en el admin.
- **Panel → Sheet**: crear, editar, marcar hecho/seña/pago o borrar un pedido en el admin lo escribe en el Sheet al instante.
- Hecho = se hizo · Seña = pagaron una parte · Pago = pagado completo. Iguales en los dos lados.

## Cómo funciona
1. El Apps Script (`apps-script.gs`) manda todos los pedidos a `admin.burole.com.ar/api/sheet` con cada cambio (y cada 5 min por las dudas).
2. El panel escribe en el Sheet llamando a la app web del mismo script (`doPost`). Si el Sheet no responde, el cambio no se guarda y el panel avisa: así nunca quedan distintos.
3. El panel consulta cada 5 segundos si hubo cambios (lee una sola fila) y se actualiza solo.

Los clientes, tareas y ajustes viven solo en el panel. Por seguridad, si el Sheet llega vacío no se borra nada.

## Formato de la hoja
Usa el Sheet **Burole General**, pestaña **Clientes Estado**, tal como está hoy. No hace falta cambiar nada:

`Fecha Pedido | Clientes | Fecha Entrega | Telefono | Pedido | Unidades | $$ | $$ Total | Hecho | Seña (50%) | Pago | (nota)`

- Una fila por producto. Las filas con la misma Fecha Pedido + Cliente + Fecha Entrega se juntan en un solo pedido.
- Pedido: nombre del producto igual que en Ajustes del panel (tildes y mayúsculas no importan).
- Hecho / Seña / Pago: "Si" o "No". Teléfono y la última columna (ej. "Entregado") van a la nota.
- El total lo calcula el panel con los precios de Ajustes (hoy coinciden con la columna $$).

## Instalación (una vez)
1. Cloudflare › burole-admin › Settings › Variables and Secrets › secreto `SHEET_TOKEN` (la clave larga).
2. En el Sheet Burole General: Extensiones › Apps Script › pegar `apps-script.gs` › Guardar.
3. ⚙️ Configuración del proyecto › Propiedades del script › `SHEET_TOKEN` con la misma clave.
4. Elegir la función `instalar` › Ejecutar › aceptar permisos.
5. Implementar › Nueva implementación › tipo **App web** › Ejecutar como: **Yo** · Quién tiene acceso: **Cualquier usuario** › Implementar. Copiar la URL (termina en `/exec`) y ponerla en `SHEET_WEBAPP_URL` de `admin/wrangler.jsonc`.

Si después cambiás el script, usá Implementar › Gestionar implementaciones › editar › Versión nueva, así la URL no cambia.
