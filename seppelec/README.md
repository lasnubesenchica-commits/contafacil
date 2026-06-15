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

## Datos

La pestaña `Flujo_CXC` de la hoja y la contraseña se crean solas. Cada
fila: `orden_compra | factura | fecha_factura | monto | estado |
fecha_pago | abonado | actualizado`. La línea de crédito se guarda en las
Script Properties del proyecto.
