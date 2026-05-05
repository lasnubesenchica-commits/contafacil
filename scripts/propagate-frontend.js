#!/usr/bin/env node
// scripts/propagate-frontend.js
// ──────────────────────────────────────────────────────────────────
// Replica el frontend HTML del cliente "template" (default:
// iris-albelo-ho) a todas las otras carpetas de cliente listadas en
// clients.json. Aplica replacements per-target:
//   • GAS_URL: deploymentId del template → deploymentId del target
//   • Branding: nombre del template → nombre del target
//   • Mobile redirect: /<source-slug>/ → /<target-slug>/
//
// Uso:
//   node scripts/propagate-frontend.js                       # source=iris, targets=todos los demás
//   node scripts/propagate-frontend.js --source iris-albelo-ho
//   node scripts/propagate-frontend.js --targets glorimar-lasso,david-miguel-collado
//   node scripts/propagate-frontend.js --exclude ceyco       # propaga a todos menos ceyco
//   node scripts/propagate-frontend.js --dry-run             # no escribe, solo reporta
//
// Después de correr: revisar `git diff`, commitear, push. El deploy
// de GitHub Pages aplica los cambios al refrescar las páginas del
// dominio balanceclip.net.
// ──────────────────────────────────────────────────────────────────

'use strict';

const fs   = require('fs');
const path = require('path');

const REPO_ROOT    = path.resolve(__dirname, '..');
const CLIENTS_JSON = path.join(REPO_ROOT, 'clients.json');

// ─────────────────────────────────────────────────────────────
//  Args
// ─────────────────────────────────────────────────────────────
function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { source: 'iris-albelo-ho', targets: null, exclude: [], dryRun: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--source'   && args[i + 1]) opts.source  = args[++i];
    else if (a === '--targets' && args[i + 1]) opts.targets = args[++i].split(',').map(s => s.trim()).filter(Boolean);
    else if (a === '--exclude' && args[i + 1]) opts.exclude = args[++i].split(',').map(s => s.trim()).filter(Boolean);
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--help' || a === '-h') {
      console.log(`
Uso:
  node scripts/propagate-frontend.js [opciones]

Opciones:
  --source <slug>           Cliente template (default: iris-albelo-ho)
  --targets <a,b,c>         Solo a estos targets (comma-separated)
  --exclude <a,b>           Excluir estos targets
  --dry-run                 No escribe archivos, solo reporta
  --help                    Muestra esta ayuda
`);
      process.exit(0);
    }
  }
  return opts;
}

// ─────────────────────────────────────────────────────────────
//  Helpers
// ─────────────────────────────────────────────────────────────
function loadClients() {
  return JSON.parse(fs.readFileSync(CLIENTS_JSON, 'utf-8')).clientes;
}

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function walkHtml(dir, baseDir, files = []) {
  if (!fs.existsSync(dir)) return files;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkHtml(full, baseDir, files);
    } else if (entry.isFile() && entry.name.endsWith('.html')) {
      files.push(path.relative(baseDir, full));
    }
  }
  return files;
}

function applyReplacements(content, src, tgt) {
  let r = content;

  // 1) GAS_URL — deploymentId completo
  if (src.deploymentId && tgt.deploymentId && src.deploymentId !== tgt.deploymentId) {
    r = r.replace(new RegExp(escapeRegex(src.deploymentId), 'g'), tgt.deploymentId);
  }

  // 2) Branding — nombre completo del cliente
  if (src.nombre && tgt.nombre && src.nombre !== tgt.nombre) {
    const sName = escapeRegex(src.nombre);
    r = r.replace(new RegExp(`Admin — ${sName}`,                       'g'), `Admin — ${tgt.nombre}`);
    r = r.replace(new RegExp(`${sName} · Registro General`,            'g'), `${tgt.nombre} · Registro General`);
    r = r.replace(new RegExp(`>${sName}<`,                             'g'), `>${tgt.nombre}<`);
  }

  // 3) Slug en paths/redirects (ej. mobile redirect "/iris-albelo-ho/app")
  if (src.id && tgt.id && src.id !== tgt.id) {
    r = r.replace(new RegExp(`/${escapeRegex(src.id)}/`, 'g'), `/${tgt.id}/`);
  }

  return r;
}

// ─────────────────────────────────────────────────────────────
//  Main
// ─────────────────────────────────────────────────────────────
function main() {
  const opts    = parseArgs();
  const clients = loadClients();

  const source = clients.find(c => c.id === opts.source);
  if (!source) {
    console.error(`✗ Source "${opts.source}" no existe en clients.json`);
    process.exit(1);
  }
  const sourceDir = path.join(REPO_ROOT, source.id);
  if (!fs.existsSync(sourceDir)) {
    console.error(`✗ Carpeta ${source.id}/ no existe`);
    process.exit(1);
  }

  // Determinar lista de targets
  let targets;
  if (opts.targets) {
    targets = clients.filter(c => opts.targets.includes(c.id));
  } else {
    targets = clients.filter(c => c.id !== source.id && !opts.exclude.includes(c.id));
  }

  if (targets.length === 0) {
    console.error('✗ No hay targets — verificá --targets / --exclude');
    process.exit(1);
  }

  console.log(`Source: ${source.id} (${source.nombre})`);
  console.log(`Targets (${targets.length}):`);
  targets.forEach(t => console.log(`  • ${t.id} (${t.nombre})`));
  if (opts.dryRun) console.log('\n[DRY RUN — no se va a escribir nada]');
  console.log('');

  const files = walkHtml(sourceDir, sourceDir);
  console.log(`${files.length} archivos HTML en source\n`);

  let totUpd = 0, totNew = 0, totSame = 0;

  for (const tgt of targets) {
    const tgtDir = path.join(REPO_ROOT, tgt.id);
    let upd = 0, neu = 0, same = 0;

    for (const rel of files) {
      const srcFile = path.join(sourceDir, rel);
      const tgtFile = path.join(tgtDir, rel);

      const sourceContent = fs.readFileSync(srcFile, 'utf-8');
      const transformed   = applyReplacements(sourceContent, source, tgt);

      const exists   = fs.existsSync(tgtFile);
      const existing = exists ? fs.readFileSync(tgtFile, 'utf-8') : null;

      if (existing === transformed) { same++; continue; }

      if (!opts.dryRun) {
        fs.mkdirSync(path.dirname(tgtFile), { recursive: true });
        fs.writeFileSync(tgtFile, transformed);
      }

      if (exists) upd++; else neu++;
    }

    const verb = opts.dryRun ? 'would' : '';
    console.log(`  ${tgt.id}: ${upd} ${verb} updated, ${neu} ${verb} created, ${same} unchanged`);
    totUpd += upd; totNew += neu; totSame += same;
  }

  console.log(`\nTotal: ${totUpd} updated, ${totNew} created, ${totSame} unchanged${opts.dryRun ? ' (DRY RUN)' : ''}`);
  console.log('\nNext steps:');
  if (opts.dryRun) {
    console.log('  • Run again without --dry-run to apply changes');
  } else if (totUpd + totNew > 0) {
    console.log('  • git diff             # revisar cambios');
    console.log('  • git add . && git commit -m "frontend: propagate from ' + source.id + '"');
    console.log('  • git push             # GitHub Pages despliega automáticamente');
  } else {
    console.log('  • Nothing to commit — todos los targets ya están actualizados');
  }
}

main();
