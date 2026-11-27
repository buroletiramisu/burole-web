# Google Sheet → panel en vivo

Cargás o cambiás un pedido en el Sheet y en menos de 30 segundos aparece en admin.burole.com.ar (sin recargar).

## Cómo funciona
1. El Sheet tiene un Apps Script (`apps-script.gs`). Con cada edición manda todas las filas a `admin.burole.com.ar/api/sheet`.
2. El Worker valida una clave secreta (`SHEET_TOKEN`) y guarda los pedidos en la base D1.
3. El panel se fija cada 20 segundos si hubo cambios y se actualiza solo.

Los pedidos del panel son un **espejo del Sheet**: si borrás una fila del Sheet, el pedido se borra del panel, y un pedido cargado o editado solo en el panel se pisa o se borra con el próximo cambio del Sheet (o a los 5 minutos). Los clientes, tareas y ajustes del panel no se tocan. Por seguridad, si el Sheet llega vacío no se borra nada.

## Formato de la hoja
Usa el Sheet **Burole General**, pestaña **Clientes Estado**, tal como está hoy. No hace falta cambiar nada:

`Fecha Pedido | Clientes | Fecha Entrega | Telefono | Pedido | Unidades | $$ | $$ Total | Hecho | Seña (50%) | Pago | (nota)`

- Una fila por producto. Las filas con la misma Fecha Pedido + Cliente + Fecha Entrega se juntan en un solo pedido.
- Pedido: nombre del producto igual que en Ajustes del panel (tildes y mayúsculas no importan).
- Hecho / Seña / Pago: "Si" o "No". Teléfono y la última columna (ej. "Entregado") van a la nota.
- El total lo calcula el panel con los precios de Ajustes (hoy coinciden con la columna $$).

## Instalación (una vez)
1. Generar una clave: en la terminal `openssl rand -hex 32` (o pedírsela a Claude).
2. Cloudflare › Workers › burole-admin › Settings › Variables and Secrets › agregar secreto `SHEET_TOKEN` con esa clave.
3. En el Sheet Burole General: Extensiones › Apps Script › pegar `apps-script.gs` › Guardar.
4. En Apps Script: Configuración del proyecto › Propiedades del script › agregar `SHEET_TOKEN` con la misma clave.
5. Elegir la función `instalar` › Ejecutar › aceptar permisos. Listo.
