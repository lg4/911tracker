// Node v4 programming model (@azure/functions): registers the timer trigger
// programmatically and supports ES module imports of shared src/ modules — the
// legacy function.json layout does not on node ~4.
import { app } from '@azure/functions';
import { pollSource } from '../../src/ingest/fetchSource.js';
import { config } from '../../src/config.js';
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

async function handler(_schedule, context) {
  let clients = null;
  let holder = null;
  try {
    const cs = process.env.AZURE_TABLES_CONNECTION_STRING || process.env.AzureWebJobsStorage;
    if (!cs) throw new Error('missing tables connection string (AZURE_TABLES_CONNECTION_STRING / AzureWebJobsStorage)');
    clients = createTableClients(cs);

    // Multi-instance guard: consumption plan may run several instances simultaneously.
    // Acquire a short-lived lease before polling; skip this tick if another instance holds it.
    holder = await acquireLease(clients, LEASE_TTL_MS);
    if (!holder) {
      context.log('lease held by another instance; skipping tick');
      return;
    }

    // Spread load off the exact :00 minute mark for the county site.
    await sleep(Math.floor(Math.random() * (JITTER_MAX_MS + 1)));

    const nowIso = new Date().toISOString();
    // Poll every configured source; a single source failing never cancels the others.
    let totalFetched = 0;
    let totalAdded = 0;
    const allWarnings = [];
    for (const source of config.sources) {
      try {
        const { incidents, skipped, warnings } = await pollSource(source, {});
        const { added } = await upsertIncidents(clients, incidents, nowIso, { budgetMs: 4 * 60 * 1000 });
        totalFetched += incidents.length;
        totalAdded += added;
        if (warnings.length) allWarnings.push(`${source.id}: ${warnings.join('; ')}`);
        context.log(JSON.stringify({ ts: nowIso, source: source.id, fetched: incidents.length, added, skipped, warnings }));
        await recordTickSuccess(clients, { ts: nowIso, source: source.id, fetched: incidents.length, added, skipped, warnings });
      } catch (perSourceErr) {
        allWarnings.push(`${source.id}: tick failed (${perSourceErr.message})`);
        context.error(`tick failed for ${source.id}: ${perSourceErr.message}`);
        try {
          await recordTickFailure(clients, `${source.id}: ${perSourceErr.message}`);
        } catch (metaErr) {
          context.error(`meta bookkeeping also failed: ${metaErr.message}`);
        }
      }
    }

    context.log(JSON.stringify({ ts: nowIso, source: 'all', fetched: totalFetched, added: totalAdded, skipped: 0, warnings: allWarnings }));
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

app.timer('ingest', { schedule: '0 */10 * * * *', handler });
