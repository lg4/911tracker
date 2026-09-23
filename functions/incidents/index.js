// Node v4 programming model (@azure/functions): registers triggers programmatically
// and supports ES module imports of shared src/ modules — the legacy function.json
// layout does not on node ~4.
import { app } from '@azure/functions';
import { createTableClients, fetchRange, assessFreshness } from '../../src/store/tableStore.js';
import { config } from '../../src/config.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function corsHeaders() {
  const origin = process.env.ALLOWED_ORIGIN || '*';
  return { 'Access-Control-Allow-Origin': origin };
}

async function handler(req, context) {
  if (req.method === 'OPTIONS') {
    return { status: 204, headers: { ...corsHeaders(), 'Access-Control-Allow-Methods': 'GET', 'Access-Control-Allow-Headers': 'Content-Type' } };
  }

  try {
    // In v4, req.query is a URLSearchParams, not a plain object.
    const q = Object.fromEntries(req.query);
    let sinceIso;
    let untilIso;
    untilIso = q.until ? new Date(`${q.until}T23:59:59Z`) : new Date();
    sinceIso = q.since ? new Date(`${q.since}T00:00:00Z`) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    if (!Number.isFinite(sinceIso.getTime()) || !Number.isFinite(untilIso.getTime())) throw new Error('bad date');
    if ((q.since && !DATE_RE.test(q.since)) || (q.until && !DATE_RE.test(q.until))) throw new Error('bad format');
    if (sinceIso > untilIso) throw new Error('since after until');
    let limit;
    if (q.limit != null) {
      limit = Number(q.limit);
      if (!Number.isInteger(limit) || limit <= 0) throw new Error('limit must be a positive integer');
    }

    const cs = process.env.AZURE_TABLES_CONNECTION_STRING || process.env.AzureWebJobsStorage;
    const clients = createTableClients(cs);
    const geojson = await fetchRange(clients, {
      since: sinceIso,
      until: untilIso,
      type: q.type || undefined,
      status: q.status || undefined,
      county: q.county || undefined,
      limit,
    });
    // T12(a): detect drift between table state and a fresh fetch before serving — if any
    // source's last verified tick is stale, flag the collection rather than serve silently.
    try {
      geojson.provenance = await assessFreshness(clients, config.sources.map((s) => s.id));
    } catch (provErr) {
      context.log(`provenance check skipped: ${provErr.message}`);
    }
    // The v4/Kestrel host coerces object bodies via .toString() ("[object Object]")
    // and defaults Content-Type to text/plain; serialize explicitly + declare JSON.
    return {
      status: 200,
      body: JSON.stringify(geojson),
      headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
    };
  } catch (err) {
    context.log(err);
    return { status: 503, body: { message: 'table read failed' }, headers: corsHeaders() };
  }
}

app.http('incidents', { methods: ['GET', 'OPTIONS'], handler });
