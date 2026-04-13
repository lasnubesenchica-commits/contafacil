#!/usr/bin/env node
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
    const ext  = path.extname(entry).toLowerCase();
    const name = path.basename(entry, ext);
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
  if (!fs.existsSync(gasDir)) throw new Error(`Directorio no encontrado: ${gasDir}`);
  const files = readGasFiles(gasDir);
  if (files.length === 0) throw new Error(`Sin archivos .gs/.js en ${gasDir}`);
  console.log(`\nDeployando ${cliente.nombre} (${files.length} archivos)...`);
  files.forEach(f => console.log(`  • ${f.name}  [${f.type}]`));
  await scriptApi.projects.updateContent({
    scriptId: cliente.scriptId,
    requestBody: { scriptId: cliente.scriptId, files },
  });
  console.log(`✓ ${cliente.nombre} actualizado correctamente.`);
}

async function main() {
  const repoRoot    = process.cwd();
  const clientsFile = path.join(repoRoot, 'clients.json');
  if (!fs.existsSync(clientsFile)) throw new Error('clients.json no encontrado.');
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
      if (apiError) console.error(`  Código: ${apiError.code} — ${apiError.message}`);
      fail++;
    }
  }
  console.log(`\n─────────────────────────────`);
  console.log(`Resultado: ${ok} OK, ${fail} fallidos`);
  if (fail > 0) process.exit(1);
}

main().catch(err => { console.error('\nError fatal:', err.message); process.exit(1); });
