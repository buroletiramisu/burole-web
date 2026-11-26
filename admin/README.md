# Burolé · Admin

Panel interno en admin.burole.com.ar: pedidos (planilla y tablero), facturación y tráfico de la web (Google Analytics).

Hoy es una **vista previa**: los números de Analytics son de ejemplo y los pedidos se guardan solo en el navegador (localStorage).

## Cómo se publica

Worker `burole-admin` de Cloudflare, conectado a este mismo repo con **Root directory = `admin`** (Workers Builds). Cada push a `main` lo vuelve a publicar. La carpeta `admin/` está en el `.assetsignore` de la raíz, así que no se publica en burole.com.ar.

## Próximos pasos

- Proteger con Cloudflare Access (login con Google, solo mails autorizados) antes de cargar pedidos reales.
- Guardar pedidos en una base (Cloudflare D1) en vez del navegador.
- Leer GA4 por la Google Analytics Data API con una cuenta de servicio (secreto en el Worker).
