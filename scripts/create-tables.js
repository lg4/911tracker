// One-time bootstrap: ensure the incidents / statusHistory / meta tables exist in Azure
// Table Storage (idempotent; safe to re-run). Usage:
//   AZURE_TABLES_CONNECTION_STRING=... node scripts/create-tables.js
import { TableServiceClient, AzureNamedKeyCredential } from '@azure/data-tables';

const cs = process.env.AZURE_TABLES_CONNECTION_STRING || process.env.AzureWebJobsStorage;
if (!cs) {
  console.error('set AZURE_TABLES_CONNECTION_STRING');
  process.exit(1);
}

let accountName, accountKey, endpoint;
if (cs.includes(';')) {
  const parts = {};
  for (const seg of cs.split(';')) {
    const eq = seg.indexOf('=');
    if (eq > 0) parts[seg.slice(0, eq).toLowerCase()] = seg.slice(eq + 1);
  }
  accountName = parts.accountname;
  accountKey = parts.accountkey;
  const proto = (parts.defaultendpointprotocol ?? 'https').replace(/[^a-z]/gi, '') || 'https';
  endpoint = `${proto}://${accountName}.table.core.windows.net`;
} else {
  endpoint = cs;
}

const credential = accountName && accountKey ? new AzureNamedKeyCredential(accountName, accountKey) : undefined;
const svc = credential ? new TableServiceClient(endpoint, credential) : new TableServiceClient(endpoint);

for (const name of ['incidents', 'statusHistory', 'meta', 'incidentsArchive', 'statusHistoryArchive']) {
  try {
    await svc.createTable(name);
    console.log(`created ${name}`);
  } catch (err) {
    if (err.statusCode === 409) console.log(`${name} already exists`);
    else throw err;
  }
}
console.log('tables ready at ' + endpoint);
