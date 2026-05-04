# Repo: contafacil (BalanceClip / ContaFacil)

Multi-client SaaS for accounting/invoicing in Panama. Single repo,
multiple clients.

## Hosting
- **GitHub Pages** at `balanceclip.net` (CNAME in repo root).
- Each client lives at `balanceclip.net/<client-slug>/` (desktop) and
  `balanceclip.net/<client-slug>/app/` (mobile).
- `.nojekyll` is present so GitHub Pages serves files as-is.

## Backend (Google Apps Script)
- Code lives in `backend-gas/`. One Apps Script project per client
  (different `scriptId`s in `clients.json`).
- Layout:
  - `Code.js` — main router with `doGet` / `doPost`
  - `ContaFacil_*.gs` — feature modules (Acreedores, Operaciones,
    Auth, Reportes, Planilla, Inventario, etc.)
  - `AutoSync.gs` — `installSyncTrigger()` for the email sync job
  - `appsscript.json` — manifest

## Auto-deploy (GitHub Actions)
- Workflow: `.github/workflows/deploy-gas.yml`
- Trigger: push to `main` touching `backend-gas/**`, `BalanceClip/**`,
  or `clients.json` (also manual `workflow_dispatch`).
- Action: `node scripts/deploy-gas.js` reads `clients.json`, for each
  client pulls their current per-client config (SHEET_ID, ADMIN_EMAIL,
  NEGOCIO, WA_NUM, VOUCHER_FOLDER_ID, ITBMS_RATE) from their existing
  GAS, re-injects it into the new code, uploads, creates a new
  version, and updates the production deployment in place.
- **Per-client values are preserved automatically** — do NOT bake
  customer-specific values into the source.
- Secrets used (already configured in repo settings):
  `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN`.
- **Workflow for backend changes**: open PR → merge to `main` → Action
  runs → all clients in `clients.json` updated. **Do NOT instruct the
  user to clasp push or re-deploy manually.**

## Clients (`clients.json`)
Each entry: `id`, `nombre`, `scriptId`, `gasDir`, `deploymentId`.
Currently active: `ceyco`, `iris-albelo-ho`. More client folders
exist (`aurorita`, `pro`, `ramon`, `trade`) but may not be in the
deploy list yet.

## Reports
- `reportes/cierre_anual.html` — anual fiscal close per client (DGI Panama)
- `reportes/itbms_mensual.html` — monthly ITBMS report (Panama)
- Embedded inside the desktop client app via `<iframe>`-like loader.

## Auth (Option 2 — server-backed)
- `password_hash` row in `config_operaciones`.
- Endpoints in `ContaFacil_Auth.gs`: `getAuthState`, `verifyPassword`,
  `setPassword`, `resetPassword`.
- Reset requires the `AUTH_RESET_TOKEN` Script Property (admin-only).
- Frontend stores `bc_authed=1` in `localStorage` to suppress
  re-prompt on the same device after a successful unlock.

## Email pipeline (Acreedores / Comercialización)
- Inbound mail for all clients lands at the Workspace mailbox
  `facturas@balanceclip.net` (Google Workspace, MX = Google).
- Workspace Gmail filters apply per-client labels on receipt
  (e.g. `cf-iris` for everything matching Iris's forwarder, `cf-ceyco`
  for CEYCO, etc.). The filter trigger is typically free-text match
  of the configured `email_acr_remitente` so it catches both direct
  forwards and Gmail caf_ rewrites.
- Each client's `config_operaciones` has:
  - `email_acr_destino` — the alias the client forwards to (legacy
    `to:` matching) — `facturas@balanceclip.net` for all clients now.
  - `email_acr_remitente` — the authorized forwarder address (e.g.
    Iris's personal Gmail). Validated in code per-message.
  - `email_acr_label` — the Gmail label applied by Workspace filter.
    When present, the script queries `label:<X>` directly (efficient).
    When absent, falls back to broad search + dest header validation
    (legacy compat).
- Apps Script projects must be authorized by `facturas@balanceclip.net`
  to read its inbox. Triggers are installed under that user.

## Conventions
- Spanish UI copy, English code/comments.
- Open PRs (squash merge), don't push directly to `main`.
- Frontend changes in `<client>/index.html` + `<client>/app/index.html`
  (mobile). Backend in `backend-gas/`.
- `Iris` is `iris-albelo-ho` slug. `CEYCO` is `ceyco`.
