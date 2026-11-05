# Burolé Tiramisú

Sitio web de Burolé. HTML estático, sin build.

## Cómo se publica

Cada push a `main` dispara un deploy automático en Cloudflare (Worker `burole`, vía Workers Builds).

## Estructura

- `_headers`: cabeceras de seguridad y caché
- `wrangler.jsonc`: configuración de Cloudflare
- `.assetsignore`: archivos que no se publican
- `Imagenes/`: fotos originales (no se suben al repo ni se publican)
