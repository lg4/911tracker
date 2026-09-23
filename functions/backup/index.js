// Node v4 programming model (@azure/functions): registers the timer trigger programmatically.
// T12(b): hourly mirror-table backup lane. Copies incidents + status_history into sibling
// archive tables in the SAME storage account so a table-level loss or an app-side bug can be
// restored from the archive without touching infra. Lease-guarded exactly like ingest so a
// multi-instance consumption plan never double-copies concurrently.
import { app } from '@azure/functions';
import {
  createTableClients,
  acquireLease,
  releaseLease,
  backupDataTables,
  recordTickFailure,
} from '../../src/store/tableStore.js';

// Same TTL/timeout relationship as ingest: lease outlives the run so a live copy can't be
// displaced mid-run by another instance taking over an expired lock.
const LEASE_TTL_MS = 15 * 60 * 1000;
const JITTER_MAX_MS = 45_000;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function handler(_schedule, context) {
  let clients = null;
  let holder = null;
  try {
    const cs = process.env.AZURE_TABLES_CONNECTION_STRING || process.env.AzureWebJobsStorage;
    if (!cs) throw new Error('missing tables connection string (AZURE_TABLES_CONNECTION_STRING / AzureWebJobsStorage)');
    clients = createTableClients(cs);

    // Multi-instance guard: skip this round if another instance holds the same lease.
    holder = await acquireLease(clients, LEASE_TTL_MS);
    if (!holder) {
      context.log('lease held by another instance; skipping backup');
      return;
    }

    // Spread off the exact :00 minute mark for the county site.
    await sleep(Math.floor(Math.random() * (JITTER_MAX_MS + 1)));

    const nowIso = new Date().toISOString();
    const { incidents, statusHistory } = await backupDataTables(clients, nowIso, { budgetMs: 4 * 60 * 1000 });
    context.log(JSON.stringify({ ts: nowIso, copiedIncidents: incidents, copiedStatusHistory: statusHistory }));
  } catch (err) {
    context.error(err);
    try {
      await recordTickFailure(clients, `backup: ${err.message}`);
    } catch (metaErr) {
      context.error(`meta bookkeeping also failed: ${metaErr.message}`);
    }
  } finally {
    await releaseLease(clients, holder);
  }
}

app.timer('backup', { schedule: '5 */1 * * * *', handler });
