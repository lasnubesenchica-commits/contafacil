# Vivir Claro — vivirclaro.com

Landing page de un solo archivo para el ebook **Vivir Claro**, con descarga
directa gratuita en **PDF** (laptop) y **ePub** (móvil).

Esta carpeta está pensada para vivir en su **propio repositorio** llamado
`vivirclaro` con GitHub Pages y el dominio personalizado `vivirclaro.com`.

> ⚠️ No puede compartir el repo `contafacil`: GitHub Pages solo permite **un
> dominio personalizado por repositorio**, y ese repo ya usa `balanceclip.net`.

---

## Contenido

| Archivo | Para qué sirve |
|---|---|
| `index.html` | La landing completa (estilos y scripts incluidos). |
| `CNAME` | El dominio personalizado: `vivirclaro.com`. |
| `.nojekyll` | Hace que Pages sirva los archivos tal cual. |
| `descargas/` | Aquí van `vivir-claro.pdf` y `vivir-claro.epub`. |
| `assets/og-cover.svg` | Imagen de previsualización al compartir en redes. |
| `robots.txt`, `sitemap.xml` | SEO básico. |

---

## Paso 1 — Crear el repositorio `vivirclaro`

1. En GitHub: **New repository** → nombre `vivirclaro` → **Public** → Create.
2. Subí **todo el contenido de esta carpeta** a la raíz del repo nuevo
   (no la carpeta `vivirclaro/` en sí, sino lo que tiene adentro:
   `index.html`, `CNAME`, `.nojekyll`, `descargas/`, `assets/`, etc.).
   - Por la web: **Add file → Upload files**, arrastrá todo y commit.

## Paso 2 — Activar GitHub Pages

1. En el repo `vivirclaro`: **Settings → Pages**.
2. En **Source**, elegí **Deploy from a branch**.
3. Branch: `main`, carpeta `/ (root)` → **Save**.
4. A los pocos minutos verás que tomó el dominio del archivo `CNAME`.

## Paso 3 — Configurar el DNS en tu registrador

Donde compraste `vivirclaro.com`, creá estos registros:

**Para el dominio raíz (`vivirclaro.com`) — 4 registros tipo A:**

```
A   @   185.199.108.153
A   @   185.199.109.153
A   @   185.199.110.153
A   @   185.199.111.153
```

**Para `www` — 1 registro CNAME:**

```
CNAME   www   lasnubesenchica-commits.github.io
```

> El DNS puede tardar de minutos a unas horas en propagar.
> Cuando esté listo, en **Settings → Pages** activá **Enforce HTTPS**.

## Paso 4 — Subir el ebook

Poné los dos archivos en `descargas/` con estos nombres exactos:

```
descargas/vivir-claro.pdf
descargas/vivir-claro.epub
```

Si usás otros nombres, actualizá los `href` en la sección `id="descargar"`
de `index.html`.

---

## Personalizar el contenido

En `index.html`, buscá los comentarios `<!-- EDITA: ... -->` para cambiar:

- Título y subtítulo del libro (hero).
- Nombre del autor/a (en la portada y la sección "Sobre el autor").
- Títulos y descripciones de los capítulos.
- La cita y la biografía del autor/a.

**Tip:** para una mejor previsualización al compartir en WhatsApp/redes,
podés reemplazar `assets/og-cover.svg` por un PNG de 1200×630 px y volver el
meta `og:image` a `og-cover.png`.

---

## Vista previa

Mientras tanto, esta misma carpeta queda servida como preview en
`https://balanceclip.net/vivirclaro/` (es solo temporal; podés borrarla del
repo `contafacil` una vez que el sitio nuevo esté en línea).
