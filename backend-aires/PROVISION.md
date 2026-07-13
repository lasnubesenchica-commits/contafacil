# Aires de Chicá — Guía de provisión y puesta en marcha

Sistema de estados de cuenta y cobros de mantenimiento para la comunidad
**Aires de Chicá** (Los Laureles, El Quira, El Higuerón).

Mismo stack que el resto de BalanceClip: **Google Sheet + Apps Script** (backend)
y **frontend estático en GitHub Pages** (`balanceclip.net/aires-de-chica/`).

Hoy el frontend ya funciona en **modo demostración** (datos embebidos). Estos
pasos conectan el backend real para que los datos vivan en el Drive de Aires de
Chicá y se puedan enviar correos y conciliar el banco.

---

## 0. Cuenta / dominio

- Ideal: cuenta de **Google Workspace** bajo `airesdechica.com` (p. ej.
  `admin@airesdechica.com`). Todo el Drive, el Sheet y los correos saldrán de ahí.
- Alternativa para arrancar: cualquier cuenta Google existente. Se puede migrar
  al dominio después (copiar el Sheet al nuevo Drive y re-desplegar).

## 1. Crear el Google Sheet

1. En el Drive de Aires de Chicá: **Nuevo → Google Sheets**.
2. Nómbralo, p. ej. `Aires de Chicá — Cobros 2026`.
3. Copia el **ID del Sheet** de la URL
   (`https://docs.google.com/spreadsheets/d/`**`ESTE_ID`**`/edit`).

## 2. Crear el proyecto Apps Script

1. En el Sheet: **Extensiones → Apps Script**.
2. Borra el `Code.gs` por defecto.
3. Crea un archivo por cada uno de estos (mismo nombre) y pega su contenido
   desde `backend-aires/`:
   - `Code.js`
   - `AiresChica_Data.gs`
   - `AiresChica_EstadoCuenta.gs`
   - `AiresChica_Email.gs`
   - `AiresChica_Conciliacion.gs`
   - `AiresChica_Seed.gs`
   - `appsscript.json` (Proyecto → ⚙ → “Mostrar archivo de manifiesto”)
4. En `Code.js`, en el objeto `CONFIG`:
   - `SHEET_ID`: pega el ID del paso 1 (o déjalo vacío si el script quedó
     ligado al Sheet — usa el activo).
   - `ADMIN_EMAIL` / `REPLY_TO`: el correo de la administración.
   - Verifica `CUENTA_NUM`, `BANCO`, etc. (ya vienen con los datos de Aires de Chicá).

## 3. Cargar los datos iniciales

En el editor de Apps Script, selecciona y ejecuta (botón ▶):

1. `ensureSheets` → crea las pestañas **Propietarios**, **Pagos**, **ConciliacionLog**.
2. `seedInicial` → carga los **67 propietarios** y su histórico de pagos 2026.
   (La primera ejecución pedirá autorizar permisos: acéptalos.)

> Revisa en la pestaña **Propietarios** las 3 cuentas sin correo
> (`Daphney Visueti`, `Omar/Yessenia H-28`, `Alfonso Castillo`) y las marcadas
> con nota *“Lote repetido en sub-bloque”* (Los Laureles 6 y 9). Completa/ajusta
> a mano; el sistema respeta lo que quede en el Sheet.

## 4. Publicar el Web App

1. **Implementar → Nueva implementación → Aplicación web.**
2. Ejecutar como: **yo**. Con acceso: **cualquier usuario**.
3. Copia la **URL `/exec`** que te da.

## 5. Conectar el frontend

En el repo, pega esa URL en la constante `GAS_URL`:
- `aires-de-chica/index.html`  → `const GAS_URL = 'https://script.google.com/macros/s/…/exec';`
- `aires-de-chica/app/index.html` → misma URL.

Al hacerlo, el badge “Modo demostración” desaparece y el dashboard lee/escribe
en el Sheet real. Haz commit y push; GitHub Pages publica en
`balanceclip.net/aires-de-chica/`.

## 6. Automatizar los correos

En Apps Script, para el correo automático **al registrar un pago** ya está: el
botón *“Enviar estado de cuenta al consolidar”* en Conciliación lo dispara.

Para **recordatorios programados**, crea disparadores por tiempo
(**Activadores → Añadir activador**):
- `enviarRecordatorios` con argumento (vía una función envoltura, ver abajo) —
  p. ej. mensual, día 1.

```js
function recordatorioMensual() { enviarRecordatorios('mensual'); }
function avisoDeMora()         { enviarRecordatorios('mora'); }
```
Crea un activador *time-driven* para cada una con la periodicidad deseada.

## 7. (Opcional) Auto-deploy con el resto del stack

Para que los cambios del backend se desplieguen solos con GitHub Actions
(como los demás clientes), una vez tengas `scriptId` y `deploymentId`:

1. Añade a `clients.json`:
   ```json
   {
     "id": "aires-de-chica",
     "nombre": "Aires de Chicá",
     "scriptId": "TU_SCRIPT_ID",
     "gasDir": "backend-aires",
     "deploymentId": "TU_DEPLOYMENT_ID"
   }
   ```
   (El `scriptId` está en Apps Script → ⚙ Configuración del proyecto.)
2. Añade `backend-aires/**` a los `paths` del workflow
   `.github/workflows/deploy-gas.yml` para que los cambios de backend disparen el deploy.

> **No añadas la entrada a `clients.json` antes de tener los IDs reales**: el
> workflow fallaría al intentar desplegar un `scriptId` vacío.

---

## Cómo funciona (resumen técnico)

- **Cuota** = `45.00 × lotes + 13.50 × cabañas` / mes.
- **Mora** = 10% mensual sobre el saldo de cada cuota morosa, **desde abril 2026**.
  La cuota vence a fin de mes y se vuelve morosa el mes siguiente.
- **Pagos**: se aplican en cascada al saldo más antiguo primero (incluye saldo 2025).
- **Conciliación**: lee el export `.xlsx` de Banco General (`BGRExcelContReport`),
  detecta los créditos, extrae `lote` + nombre del pagador, cruza contra
  Propietarios (por lote, con desambiguación por nombre entre residenciales),
  descarta duplicados e interés/devoluciones, y consolida los que confirmes.
  En la prueba con el estado de mayo 2026: **91% de conciliación automática**,
  el resto queda marcado para asignar con un clic.
