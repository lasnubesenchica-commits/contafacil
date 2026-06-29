# Storyboard de animación — Landing de Servicios (BalanceClip)
**Página:** `balanceclip.net/servicios/`
**Objetivo:** elevar el landing de "tiene animaciones" a "se siente vivo y cuenta una historia".
**Para:** Claude Design (handoff de motion / micro-interacciones).

---

## 0) North Star (la idea en una frase)
> **"Ves un montón de documentos desordenados que la IA lee y, solos, se vinculan y se convierten en un número claro."**

Toda la página debe reforzar ese gesto: **caos → lectura → vínculo → claridad**. La animación protagonista es el **vínculo** (dos documentos que se conectan y escupen un resultado). Todo lo demás la apoya.

---

## 1) Principios y restricciones (no negociables)
- **Marca:** fuente Nunito (700–900 en titulares). Paleta: naranja `#f97316`, ink `#1e1b4b`, teal `#14b8a6`, morado `#8b5cf6`, blanco/`#fafafa`. Bordes suaves, radios grandes (16–26px).
- **Tono:** profesional, "fintech cálido". Sutil > llamativo. Nada de rebotes exagerados ni confeti.
- **Mobile-first:** todo debe verse igual de bien en 390px. Animaciones más cortas/simples en móvil.
- **Performance:** solo animar `transform` y `opacity`. Presupuesto: 60fps, sin "jank". Lottie ≤ 60KB por pieza.
- **Accesibilidad:** respetar `prefers-reduced-motion` → estado final estático, sin movimiento.
- **Trigger:** las escenas se disparan al entrar en viewport (IntersectionObserver), una sola vez. La protagonista puede tener un loop sutil.

---

## 2) 🌟 EL MOMENTO ESTRELLA — "La Vinculación"
Es el corazón del landing (sección **"El motor"**, paso 3). Si solo se anima una cosa bien, es esta.

**Escena (≈3.5s, loop suave cada ~6s):**
1. **0.0s** — Entran dos "documentos" (tarjetas tipo PDF) desde los lados: a la izquierda **Factura de compra** (acento morado), a la derecha **Factura de venta** / o **Orden ↔ Factura** (acento naranja). Easing `cubic-bezier(.22,1,.36,1)` (entrada con desaceleración). Llegan inclinados ~3°, desordenados.
2. **0.6s** — Una **línea de escaneo IA** (gradiente naranja, glow) recorre cada documento de arriba a abajo. Mientras pasa, "aparecen" 2–3 líneas de datos resaltadas (número de factura, monto). Da la sensación de "leyendo".
3. **1.4s** — Los documentos se **enderezan** (rotan a 0°) y se acercan al centro. Micro-imán: se acomodan en su sitio con un settle sutil.
4. **1.8s** — **Se dibuja un conector** entre ambos (un trazo que se "draw-on", `stroke-dashoffset`), con un nodo ✓ teal que hace *pop* en el punto medio.
5. **2.3s** — Del nodo central **emerge un chip de resultado** que cuenta hacia arriba: `$0 → $7,653.78` (o "Margen +28%"), con un leve glow naranja. *Number ticker*.
6. **3.0s** — Asienta. Glow respira (loop). Reset suave para el siguiente ciclo.

**Notas:** el "scan line" y el "draw-on" del conector son los frames que más venden el concepto de IA + vínculo. No escatimar ahí.

---

## 3) Storyboard escena por escena

### Escena A — HERO (al cargar)
- **Beats:** entrada escalonada (stagger 80–120ms): pill → titular → subtítulo → botones → trust line. Cada uno `translateY(16px)+fade`, easing salida.
- **Plus (elevar):** detrás del titular, un **fondo vivo muy sutil** — malla de puntos/líneas que se conectan lentamente (estilo "constelación de documentos") con parallax leve al mover el mouse / scroll. Opacidad baja (≤8%). En la palabra **"conectados solos"** (naranja), un subrayado que se dibuja solo (draw-on) al terminar la entrada.
- **Duración total:** ~1.1s. Móvil: sin constelación (o estática), solo el stagger.

### Escena B — PROBLEMA ("Tu operación vive en Excel, correo y PDFs")
- **Concepto:** **caos.** Al revelarse, los 4 chips (🧾 digitación, 🔌 conciliación, ❓ visibilidad, 📉 errores) **caen/tiemblan** ligeramente desordenados (rotaciones ±2°, entradas dispares). Transmite "desorden".
- **Contraste narrativo:** este es el "antes" — debe sentirse un poco tenso/desalineado, a propósito. La siguiente sección (motor) lo "resuelve".
- **Easing:** entradas con un micro-overshoot. **Duración:** 0.7s.

### Escena C — EL MOTOR (5 pasos) ← contiene el Momento Estrella
- **Beats:** los 5 pasos hacen reveal en secuencia izquierda→derecha (stagger 90ms). Entre paso y paso, **una "chispa"/dot naranja viaja** por encima de las flechas conectando 1→2→3→4→5 (loop lento). 
- El **paso 3 "Vincula A↔B"** ejecuta la animación del **Momento Estrella** (sección 2) en miniatura dentro de su tarjeta, y mantiene el pulse/glow.
- **Móvil:** grid 2 columnas; el dot viajero se simplifica a un pulse por paso.

### Escena D — CASOS (Seppelec / Círculo Financiero)
- **Beats:** las dos tarjetas hacen reveal con leve stagger (120ms). La **barra superior de color** (naranja / morado-azul) se **dibuja** de izquierda a derecha (scaleX 0→1).
- **Micro:** en la fila `Orden → Factura → Pago` / `Compra ↔ Venta`, las flechas laten o un dot las recorre una vez al entrar. El chip de "Resultado" hace un *pop* sutil + glow.
- **Hover (desktop):** la tarjeta se eleva (translateY -4px, sombra), la barra superior intensifica.

### Escena E — BOTS DE WHATSAPP (mockup de chat) ⭐ (segundo momento fuerte)
- **Concepto:** un chat que se **escribe solo**, en vivo.
- **Beats (secuencia realista):**
  1. Burbuja entrante (usuario) "📎 Factura F26281.pdf" aparece.
  2. **Indicador de "escribiendo…"** (3 puntitos animados) del bot ~0.8s.
  3. Burbuja del bot hace *pop*: "✅ Registrada · $7,653.78 · vence 21-ago".
  4. Pausa, "escribiendo…", siguiente burbuja "🔔 Mañana vence F26225…".
  5. Usuario "¿Cuánto me debe Industrias Lácteas?" → "escribiendo…" → "💬 $67,698.98 por cobrar…".
- **Loop:** al terminar, espera 3s y reinicia (o reinicia al volver a entrar en viewport).
- **Detalle premium:** el teléfono flota muy levemente (idle float ±4px, 4s) y tiene reflejo sutil. Checks ✓✓ que pasan a azul ("leído").
- **Móvil:** el teléfono va arriba del texto; misma secuencia.

### Escena F — APLICA A / POR QUÉ
- **Beats:** cards en reveal con stagger por fila. Iconos con un micro "settle" (scale 0.8→1). 
- **Hover:** icono hace un pequeño *tilt*/wiggle una vez.

### Escena G — CIERRE (CTA naranja)
- **Beats:** el bloque entra; el botón de **WhatsApp pulsa una vez** para llamar la atención (scale 1→1.04→1) y luego idle. Un brillo diagonal (*shimmer*) cruza el bloque naranja cada ~5s.
- **Hover botón:** lift + sombra (ya existe) + el ícono 💬 hace un mini bounce.

---

## 4) Micro-interacciones globales (toda la página)
- **Botones:** lift + sombra al hover (ya está); agregar *press* (scale .97) al click.
- **Links de nav:** subrayado que se dibuja al hover.
- **Scroll:** indicador de progreso fino (barra naranja arriba) — opcional.
- **Cursor (desktop, opcional):** los documentos del hero reaccionan levemente al mouse (parallax).

---

## 5) Recomendación técnica (qué herramienta para qué)
| Pieza | Técnica sugerida | Por qué |
|---|---|---|
| Hero stagger, reveals, hovers, pulses | **CSS** (keyframes + IntersectionObserver) | Liviano, ya montado, fácil de mantener |
| Constelación del hero | **Canvas** ligero o SVG animado | Orgánico; mantener opacidad baja y pausar fuera de viewport |
| **Momento Estrella (vinculación)** | **Lottie** (After Effects → JSON) o **SVG + GSAP** | Control fino del scan + draw-on + ticker; es la pieza premium |
| Chat de WhatsApp | **CSS/JS** (timeline con delays) | Secuencia simple; no necesita Lottie |
| Number ticker | JS pequeño o Lottie | — |

- **Una sola librería** si se puede (GSAP o Lottie-web). Evitar cargar varias.
- **Pausar** animaciones en loop cuando la sección sale del viewport (ahorra batería).
- **Fallback** `prefers-reduced-motion`: render del frame final, sin loops.

---

## 6) Entregables a pedirle a Claude Design
1. **Animación "Vinculación"** (la estrella): Lottie JSON + versión reducida para móvil. ~3.5s, loop opcional.
2. **Fondo "constelación de documentos"** del hero (loop sutil, parametrizable en densidad/opacidad).
3. **Secuencia del chat de WhatsApp** (timing + assets de burbujas + indicador "escribiendo").
4. **Set de micro-interacciones** (hover de tarjetas/botones, draw-on de subrayados y barras).
5. **Guía de timing/easing** (tokens reutilizables: duraciones, curvas) para mantener consistencia.

---

## 7) Curvas y tiempos de referencia (tokens)
- **Entrada (ease-out):** `cubic-bezier(.22,1,.36,1)` · 600–700ms
- **Settle/imán:** `cubic-bezier(.34,1.3,.64,1)` (overshoot leve) · 400ms
- **Draw-on (líneas/conectores):** linear o ease-in-out · 500–800ms
- **Stagger entre hermanos:** 80–120ms
- **Loops idle (float/glow/shimmer):** 4–6s, `ease-in-out`, amplitud mínima

> Regla de oro: si dudas, hazlo **más sutil y más corto**. La elegancia está en el *restraint*.
