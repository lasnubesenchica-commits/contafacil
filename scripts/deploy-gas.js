#!/usr/bin/env node
/**
 * deploy-gas.js
 * Sube los archivos .gs/.js de cada cliente a su proyecto Google Apps Script,
 * crea una nueva version y actualiza el deployment de produccion automaticamente.
 *
 * Secrets requeridos en GitHub:
 *   GOOGLE_CLIENT_ID      — OAuth2 Client ID (aplicacion web)
 *   GOOGLE_CLIENT_SECRET  — OAuth2 Client Secret
 *   GOOGLE_REFRESH_TOKEN  — Refresh token obtenido via OAuth Playground
 */

const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');

function getAuthClient() {
  const clientId     = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;

  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error(
      'Faltan variables: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN'
    );
  }

  const auth = new google.auth.OAuth2(clientId, clientSecret);
  auth.setCredentials({ refresh_token: refreshToken });
  return auth;
}

function readGasFiles(dirPath) {
  const files = [];
  const entries = fs.readdirSync(dirPath).sort();

  for (const entry of entries) {
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

async function deployCliente(scriptApi, cliente, repoRoot) {
  const gasDir = path.join(repoRoot, cliente.gasDir);

  if (!fs.existsSync(gasDir)) {
    throw new Error(`Directorio no encontrado: ${gasDir}`);
  }

  const files = readGasFiles(gasDir);
  if (files.length === 0) {
    throw new Error(`Sin archivos .gs/.js en ${gasDir}`);
  }

  // 1. Actualizar codigo fuente
  console.log(`\nDeployando ${cliente.nombre} (${files.length} archivos)...`);
  files.forEach(f => console.log(`  • ${f.name}  [${f.type}]`));

  await scriptApi.projects.updateContent({
    scriptId: cliente.scriptId,
    requestBody: { scriptId: cliente.scriptId, files },
  });
  console.log(`  ✓ Codigo actualizado`);

  // 2. Crear nueva version
  const versionRes = await scriptApi.projects.versions.create({
    scriptId: cliente.scriptId,
    requestBody: { description: `Auto-deploy ${new Date().toISOString()}` },
  });
  const versionNumber = versionRes.data.versionNumber;
  console.log(`  ✓ Version ${versionNumber} creada`);

  // 3. Actualizar deployment de produccion (si tiene deploymentId)
  if (cliente.deploymentId) {
    await scriptApi.projects.deployments.update({
      scriptId:     cliente.scriptId,
      deploymentId: cliente.deploymentId,
      requestBody: {
        deploymentConfig: {
          scriptId:         cliente.scriptId,
          versionNumber,
          manifestFileName: 'appsscript',
          description:      `Auto-deploy ${new Date().toISOString()}`,
        },
      },
    });
    console.log(`  ✓ Deployment actualizado a version ${versionNumber}`);
  }

  console.log(`✓ ${cliente.nombre} deployado correctamente.`);
}

async function main() {
  const repoRoot    = process.cwd();
  const clientsFile = path.join(repoRoot, 'clients.json');

  if (!fs.existsSync(clientsFile)) {
    throw new Error('clients.json no encontrado en la raiz del repo.');
  }

  const { clientes } = JSON.parse(fs.readFileSync(clientsFile, 'utf8'));
  console.log(`Clientes a deployar: ${clientes.length}`);

  const auth      = getAuthClient();
  const scriptApi = google.script({ version: 'v1', auth });

  let ok = 0, fail = 0;

  for (const cliente of clientes) {
    try {
      await deployCliente(scriptApi, cliente, repoRoot);
      ok++;
    } catch (err) {
      console.error(`\n✗ ${cliente.nombre}: ${err.message}`);
      const apiError = err.response?.data?.error;
      if (apiError) {
        console.error(`  Codigo: ${apiError.code} — ${apiError.message}`);
      }
      fail++;
    }
  }

  console.log(`\n─────────────────────────────`);
  console.log(`Resultado: ${ok} OK, ${fail} fallidos`);

  if (fail > 0) process.exit(1);
}

main().catch(err => {
  console.error('\nError fatal:', err.message);
  process.exit(1);
});
