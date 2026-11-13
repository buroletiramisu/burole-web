# Burolé Tiramisú

Sitio web de Burolé (burole.com.ar). HTML estático, sin build.

## Cómo se publica

Cada push a `main` dispara un deploy automático en Cloudflare (Worker `burole-web`, vía Workers Builds), que publica burole.com.ar.

## Estructura

- `index.html`: landing (estilos y script incluidos). Arriba del script están el número de WhatsApp y los precios.
- `404.html`: página de "no encontrada"
- `assets/img/`, `assets/video/`: logo, isotipo, fotos y videos del hero
- `favicon.svg`, `robots.txt`, `sitemap.xml`
- `_headers`: cabeceras de seguridad y caché
- `wrangler.jsonc`: configuración de Cloudflare
- `.assetsignore`: archivos que no se publican
- `Imagenes/`: fotos originales (no se suben al repo ni se publican)

El diseño sale del canvas "Burolé — Landing web" en Claude.
