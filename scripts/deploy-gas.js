#!/usr/bin/env node
/**
 * deploy-gas.js
 * Sube los archivos .gs/.js de cada cliente a su proyecto Google Apps Script,
 * crea una nueva version y actualiza el deployment de produccion automaticamente.
 *
 * Antes de subir, lee la config actual del proyecto GAS de cada cliente
 * (SHEET_ID, ADMIN_EMAIL, etc.) y la re-inyecta en el codigo nuevo para que
 * cada cliente conserve sus propios valores.
 *
 * Secrets requeridos en GitHub:
 *   GOOGLE_CLIENT_ID      — OAuth2 Client ID (aplicacion web)
 *   GOOGLE_CLIENT_SECRET  — OAuth2 Client Secret
 *   GOOGLE_REFRESH_TOKEN  — Refresh token obtenido via OAuth Playground
 */

const { google } = require('googleapis');
const fs   = require('fs');
const path = require('path');

function getAuthClient() {
  const clientId     = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;

  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error('Faltan variables: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN');
  }

  const auth = new google.auth.OAuth2(clientId, clientSecret);
  auth.setCredentials({ refresh_token: refreshToken });
  return auth;
}

function readGasFiles(dirPath) {
  const files = [];
  for (const entry of fs.readdirSync(dirPath).sort()) {
    const fullPath = path.join(dirPath, entry);
    if (!fs.statSync(fullPath).isFile()) continue;
    const ext    = path.extname(entry).toLowerCase();
    const name   = path.basename(entry, ext);
    const source = fs.readFileSync(fullPath, 'utf8');
    if (entry === 'appsscript.json') {
      files.push({ name: 'appsscript', type: 'JSON', source });
    } else if (ext === '.gs' || ext === '.js') {
      files.push({ name, type: 'SERVER_JS', source });
    }
  }
  return files;
}

// Lee la config actual del proyecto GAS del cliente para re-inyectarla.
async function readClientConfig(scriptApi, scriptId) {
  const res = await scriptApi.projects.getContent({ scriptId });
  const codeFile = (res.data.files || []).find(f => f.name === 'Code');
  if (!codeFile) return {};
  const src = codeFile.source;
  const pick = (re) => { const m = src.match(re); return m ? m[1] : null; };
  return {
    sheetId:    pick(/SHEET_ID:\s*'([^']*)'/),
    adminEmail: pick(/ADMIN_EMAIL:\s*'([^']*)'/),
    negocio:    pick(/NEGOCIO:\s*'([^']*)'/),
    waNum:      pick(/WA_NUM:\s*'([^']*)'/),
    folderId:   pick(/VOUCHER_FOLDER_ID:\s*'([^']*)'/),
    itbms:      pick(/ITBMS_RATE:\s*([\d.]+)/),
  };
}

// Mismo mecanismo de inyección que el provisioner (deploy.html → injectConfig).
function injectConfig(files, cfg) {
  return files.map(f => {
    let src = f.source;
    if (f.name === 'Code') {
      if (cfg.sheetId)    src = src.replace(/SHEET_ID:\s*'[^']*'/,          `SHEET_ID:          '${cfg.sheetId}'`);
      if (cfg.adminEmail) src = src.replace(/ADMIN_EMAIL:\s*'[^']*'/,       `ADMIN_EMAIL:       '${cfg.adminEmail}'`);
      if (cfg.negocio)    src = src.replace(/NEGOCIO:\s*'[^']*'/,           `NEGOCIO:           '${cfg.negocio}'`);
      if (cfg.waNum)      src = src.replace(/WA_NUM:\s*'[^']*'/,            `WA_NUM:            '${cfg.waNum}'`);
      if (cfg.folderId)   src = src.replace(/VOUCHER_FOLDER_ID:\s*'[^']*'/, `VOUCHER_FOLDER_ID: '${cfg.folderId}'`);
      if (cfg.itbms)      src = src.replace(/ITBMS_RATE:\s*[\d.]+/,         `ITBMS_RATE:        ${cfg.itbms}`);
    }
    if (f.name === 'ContaFacil_Operaciones') {
      if (cfg.sheetId) src = src.replace(/SHEET_ID:\s*'[^']*'/, `SHEET_ID: '${cfg.sheetId}'`);
    }
    return { name: f.name, type: f.type, source: src };
  });
}

async function deploymentExists(scriptApi, scriptId, deploymentId) {
  try {
    await scriptApi.projects.deployments.get({ scriptId, deploymentId });
    return true;
  } catch (err) {
    if (err.response?.status === 404) return false;
    throw err;
  }
}

async function findWebAppDeploymentId(scriptApi, scriptId) {
  const res = await scriptApi.projects.deployments.list({ scriptId });
  for (const dep of (res.data.deployments || [])) {
    if (!dep.deploymentConfig?.versionNumber) continue; // ignorar HEAD (read-only)
    for (const ep of (dep.entryPoints || [])) {
      if (ep.entryPointType === 'WEB_APP') return dep.deploymentId;
    }
  }
  return null;
}

async function deployCliente(scriptApi, cliente, repoRoot) {
  const gasDir = path.join(repoRoot, cliente.gasDir);
  if (!fs.existsSync(gasDir)) throw new Error(`Directorio no encontrado: ${gasDir}`);

  const rawFiles = readGasFiles(gasDir);
  if (rawFiles.length === 0) throw new Error(`Sin archivos .gs/.js en ${gasDir}`);

  // 1. Leer config actual del GAS del cliente y re-inyectar
  const cfg   = await readClientConfig(scriptApi, cliente.scriptId);
  const files = injectConfig(rawFiles, cfg);
  const injected = Object.entries(cfg).filter(([, v]) => v).map(([k]) => k);
  console.log(`\nDeployando ${cliente.nombre} (${files.length} archivos)...`);
  files.forEach(f => console.log(`  • ${f.name}  [${f.type}]`));
  if (injected.length) console.log(`  → Config inyectada: ${injected.join(', ')}`);

  // 2. Actualizar codigo fuente
  await scriptApi.projects.updateContent({
    scriptId: cliente.scriptId,
    requestBody: { scriptId: cliente.scriptId, files },
  });
  console.log(`  ✓ Codigo actualizado`);

  // 3. Crear nueva version
  const versionRes = await scriptApi.projects.versions.create({
    scriptId: cliente.scriptId,
    requestBody: { description: `Auto-deploy ${new Date().toISOString()}` },
  });
  const versionNumber = versionRes.data.versionNumber;
  console.log(`  ✓ Version ${versionNumber} creada`);

  // 4. Resolver deploymentId: usar el guardado si existe, si no buscar el activo real
  let deploymentId    = cliente.deploymentId;
  let deploymentFixed = false;

  if (!deploymentId || !(await deploymentExists(scriptApi, cliente.scriptId, deploymentId))) {
    console.warn(`  ⚠ deploymentId ${deploymentId || '(none)'} no válido — buscando deployment activo`);
    deploymentId = await findWebAppDeploymentId(scriptApi, cliente.scriptId);
    if (!deploymentId) throw new Error('No se encontró ningún web app deployment activo en el proyecto GAS');
    console.log(`  → Deployment activo encontrado: ${deploymentId}`);
    deploymentFixed = true;
  }

  await scriptApi.projects.deployments.update({
    scriptId: cliente.scriptId,
    deploymentId,
    requestBody: {
      deploymentConfig: {
        scriptId:         cliente.scriptId,
        versionNumber,
        manifestFileName: 'appsscript',
        description:      `Auto-deploy ${new Date().toISOString()}`,
      },
    },
  });
  console.log(`  ✓ Deployment ${deploymentId} actualizado a version ${versionNumber}`);
  console.log(`✓ ${cliente.nombre} deployado correctamente.`);

  return { deploymentId, deploymentFixed };
}

async function main() {
  const repoRoot    = process.cwd();
  const clientsFile = path.join(repoRoot, 'clients.json');
  if (!fs.existsSync(clientsFile)) throw new Error('clients.json no encontrado en la raiz del repo.');

  const clientsData = JSON.parse(fs.readFileSync(clientsFile, 'utf8'));
  console.log(`Clientes a deployar: ${clientsData.clientes.length}`);

  const auth      = getAuthClient();
  const scriptApi = google.script({ version: 'v1', auth });

  let ok = 0, fail = 0;
  let clientsJsonModified = false;

  for (const cliente of clientsData.clientes) {
    try {
      const { deploymentId, deploymentFixed } = await deployCliente(scriptApi, cliente, repoRoot);
      // Actualizar clients.json si encontramos un deploymentId diferente
      if (deploymentFixed && deploymentId !== cliente.deploymentId) {
        console.log(`  → Actualizando deploymentId en clients.json para ${cliente.nombre}`);
        cliente.deploymentId = deploymentId;
        clientsJsonModified = true;
      }
      ok++;
    } catch (err) {
      console.error(`\n✗ ${cliente.nombre}: ${err.message}`);
      const apiError = err.response?.data?.error;
      if (apiError) console.error(`  Codigo: ${apiError.code} — ${apiError.message}`);
      fail++;
    }
  }

  // Guardar clients.json si hubo cambios en deploymentIds
  if (clientsJsonModified) {
    fs.writeFileSync(clientsFile, JSON.stringify(clientsData, null, 2) + '\n');
    console.log('\n→ clients.json actualizado con nuevos deploymentIds');
  }

  console.log(`\n─────────────────────────────`);
  console.log(`Resultado: ${ok} OK, ${fail} fallidos`);
  if (fail > 0) process.exit(1);
}

main().catch(err => {
  console.error('\nError fatal:', err.message);
  process.exit(1);
});
