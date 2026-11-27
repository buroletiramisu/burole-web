# Google Sheet → panel en vivo

Cargás o cambiás un pedido en el Sheet y en menos de 30 segundos aparece en admin.burole.com.ar (sin recargar).

## Cómo funciona
1. El Sheet tiene un Apps Script (`apps-script.gs`). Con cada edición manda todas las filas a `admin.burole.com.ar/api/sheet`.
2. El Worker valida una clave secreta (`SHEET_TOKEN`) y guarda los pedidos en la base D1.
3. El panel se fija cada 20 segundos si hubo cambios y se actualiza solo.

Si borrás una fila del Sheet, el pedido se borra del panel. Los pedidos del Sheet mandan: si editás uno de esos en el panel, el próximo cambio del Sheet lo pisa. Los pedidos cargados a mano en el panel no se tocan.

## Formato de la hoja
Pestaña llamada **Pedidos**. Fila 1 con estos encabezados (orden libre):

`ID | Fecha pedido | Fecha entrega | Cliente | Clásico mediano | Clásico grande | Pistacho mediano | Pistacho grande | Minis × 10 | Ajuste | Canal | Entrega | Estado | Pago | Nota`

- Productos: mismo nombre que en Ajustes del panel; el valor es la cantidad.
- Canal: Web, WhatsApp, Instagram o Conocido. Entrega: Retiro o Envío.
- Estado: Hecho / No hecho. Pago: Sin cobrar / Seña / Pagado.
- ID: lo completa el script, dejala vacía. Una columna "Total" se ignora (el panel calcula el total).

## Instalación (una vez)
1. Generar una clave: en la terminal `openssl rand -hex 32` (o pedírsela a Claude).
2. Cloudflare › Workers › burole-admin › Settings › Variables and Secrets › agregar secreto `SHEET_TOKEN` con esa clave.
3. En el Sheet: Extensiones › Apps Script › pegar `apps-script.gs` › Guardar.
4. En Apps Script: Configuración del proyecto › Propiedades del script › agregar `SHEET_TOKEN` con la misma clave.
5. Elegir la función `instalar` › Ejecutar › aceptar permisos. Listo.
