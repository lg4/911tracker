import { runPoll } from '../../src/ingest/fetchSource.js';
import {
  createTableClients,
  acquireLease,
  releaseLease,
  upsertIncidents,
  recordTickSuccess,
  recordTickFailure,
} from '../../src/store/tableStore.js';

// Lease TTL must exceed the function timeout (set via the FUNCTION_TIMEOUT app setting,
// 10 min in production) so a running tick can never be displaced mid-run by another
// instance taking over an expired lock.
const LEASE_TTL_MS = 15 * 60 * 1000;
const JITTER_MAX_MS = 45_000;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export default async function (context) {
  let clients = null;
  let holder = null;
  try {
    const cs = process.env.AZURE_TABLES_CONNECTION_STRING || process.env.AzureWebJobsStorage;
    if (!cs) throw new Error('missing tables connection string (AZURE_TABLES_CONNECTION_STRING / AzureWebJobsStorage)');
    clients = createTableClients(cs);

    holder = await acquireLease(clients, LEASE_TTL_MS);
    if (!holder) {
      context.log('lease held by another instance; skipping tick');
      return;
    }

    // Spread load off the exact :00 minute mark for the county site.
    await sleep(Math.floor(Math.random() * (JITTER_MAX_MS + 1)));

    const nowIso = new Date().toISOString();
    const { incidents, source, skipped, warnings } = await runPoll({ checkHtml: false });
    const { added } = await upsertIncidents(clients, incidents, nowIso, { budgetMs: 8 * 60 * 1000 });

    context.log(JSON.stringify({ ts: nowIso, source, fetched: incidents.length, added, skipped, warnings }));
    await recordTickSuccess(clients, { ts: nowIso, source, fetched: incidents.length, added, skipped, warnings });
  } catch (err) {
    context.error(err);
    try {
      await recordTickFailure(clients, err.message || String(err));
    } catch (metaErr) {
      context.error(`meta bookkeeping also failed: ${metaErr.message}`);
    }
  } finally {
    await releaseLease(clients, holder);
  }
}
