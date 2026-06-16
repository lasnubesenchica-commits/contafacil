# Seppelec · Flujo CxC

Sistema **standalone** para el control de cuentas por cobrar y flujo de
caja de Seppelec. Es independiente: **no** usa `clients.json`, el
provisioner ni el backend de BalanceClip/ContaFacil. Sólo vive en esta
carpeta.

- **`index.html`** — el tablero (frontend). Se sirve en
  `balanceclip.net/seppelec/` vía GitHub Pages.
- **`Codigo.gs`** — mini-backend de Google Apps Script (su propio
  proyecto + su propia Hoja de cálculo). Guarda los datos para que la
  usuaria edite y sus jefes vean lo mismo con el enlace.

## Cómo funciona

- Semana 1 a 52 con una columna **SALDO** al cierre de cada mes.
- Lo facturado aparece en la semana de emisión (azul). La gestión de
  cobro se muestra en la semana del vencimiento a **60 días** (rojo; rojo
  oscuro si ya pasó) y **no** baja el saldo hasta registrar el pago. El
  pago/abono va en verde.
- Saldo de fin de mes = facturado acumulado − pagado acumulado.
- Estados que controla la usuaria: **Orden → Facturado → Abonado → Pagado**.
- **Los jefes ven sin contraseña.** Editar requiere desbloquear con la
  contraseña (botón 🔒 / 🔓). La primera vez que se desbloquea se define.

## Puesta en marcha (una sola vez)

1. Crea una **Hoja de cálculo de Google** nueva (será la base de datos).
2. En esa hoja: **Extensiones → Apps Script**.
3. Borra el código de ejemplo y pega **todo** `Codigo.gs`. Guarda.
4. **Implementar → Nueva implementación → Aplicación web**:
   - *Ejecutar como:* **Yo**
   - *Quién tiene acceso:* **Cualquier persona**
   - Copia la **URL `/exec`**.
5. En `index.html`, reemplaza:
   ```js
   const GAS_URL = 'https://script.google.com/macros/s/PENDIENTE_SEPPELEC/exec';
   ```
   por la URL que copiaste.
6. Publica (merge a `main`). Listo: `balanceclip.net/seppelec/`.

> Sin el paso del backend el tablero funciona igual, pero en **modo
> local** (sólo guarda en ese navegador, no se comparte). Aparece un
> aviso en la barra superior cuando está en modo local.

## Lectura de PDF con IA (opcional)

El botón **⬆ Leer PDF (IA)** permite subir facturas u órdenes de compra
en PDF; el sistema reconoce el tipo y actualiza la data automáticamente
(crea la fila o actualiza la existente, emparejando por número de
factura u orden).

Para activarlo, en el proyecto de Apps Script:

1. **Configuración del proyecto → Propiedades de la secuencia de comandos**.
2. Agrega `ANTHROPIC_API_KEY` = tu API key de `console.anthropic.com`.
3. (Opcional) `FLUJO_MODEL` para cambiar el modelo (por defecto
   `claude-opus-4-8`).
4. (Opcional) `FLUJO_FOLDER_ID` = ID de una carpeta de Google Drive. Si la
   defines, cada PDF leído se **guarda en esa carpeta** y su código (N° de
   orden y/o de factura) se vuelve un **enlace clickeable** al documento en
   las vistas. El archivo se comparte como *“cualquiera con el enlace puede
   ver”*. Sin esta propiedad la lectura por IA funciona igual, pero sin
   enlaces. La primera vez que se use Drive, Apps Script pedirá
   **reautorizar** el permiso (Drive) y habrá que volver a implementar.

La lectura por IA queda protegida por la contraseña de edición, así sólo
quien edita puede consumir la API key.

## Datos

La pestaña `Flujo_CXC` de la hoja y la contraseña se crean solas. Cada
fila: `orden_compra | factura | fecha_factura | monto | estado |
fecha_pago | abonado | actualizado | orden_url | factura_url`. Las dos
últimas columnas (enlaces a los PDF en Drive) se agregan solas al
encabezado existente. La línea de crédito se guarda en las Script
Properties del proyecto.
