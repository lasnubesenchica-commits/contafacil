#!/usr/bin/env node
const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');

const SCOPES = ['https://www.googleapis.com/auth/script.projects'];

async function getAuthClient() {
  const keyJson = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (!keyJson) throw new Error('Variable GOOGLE_SERVICE_ACCOUNT_KEY no definida.');
  let credentials;
  try { credentials = JSON.parse(keyJson); }
  catch { throw new Error('GOOGLE_SERVICE_ACCOUNT_KEY no es un JSON válido.'); }
  const auth = new google.auth.JWT(
    credentials.client_email, null, credentials.private_key, SCOPES
  );
  await auth.authorize();
  return auth;
}

function readGasFiles(dirPath) {
  const files = [];
  const entries = fs.readdirSync(dirPath).sort();
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry);
    if (!fs.statSync(fullPath).isFile()) continue;
    const ext = path.extname(entry).toLowerCase();
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
  const repoRoot = process.cwd();
  const clientsFile = path.join(repoRoot, 'clients.json');
  if (!fs.existsSync(clientsFile)) throw new Error('clients.json no encontrado.');
  const { clientes } = JSON.parse(fs.readFileSync(clientsFile, 'utf8'));
  console.log(`Clientes a deployar: ${clientes.length}`);
  const auth = await getAuthClient();
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
