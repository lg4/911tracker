import { createTableClients, fetchRange } from '../../src/store/tableStore.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function corsHeaders() {
  const origin = process.env.ALLOWED_ORIGIN || '*';
  return { 'Access-Control-Allow-Origin': origin };
}

export default async function (context) {
  const req = context.bindings.req;
  if (req.method === 'OPTIONS') {
    context.res = { status: 204, headers: { ...corsHeaders(), 'Access-Control-Allow-Methods': 'GET', 'Access-Control-Allow-Headers': 'Content-Type' } };
    return;
  }

  const q = req.query ?? {};
  let sinceIso;
  let untilIso;
  try {
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
  } catch (err) {
    context.res = { status: 400, body: { message: `invalid params: ${err.message}` }, headers: corsHeaders() };
    return;
  }

  try {
    const clients = createTableClients(
      process.env.AZURE_TABLES_CONNECTION_STRING || process.env.AzureWebJobsStorage
    );
    const geojson = await fetchRange(clients, {
      since: sinceIso,
      until: untilIso,
      type: q.type || undefined,
      status: q.status || undefined,
      limit,
    });
    context.res = { status: 200, body: geojson, headers: corsHeaders() };
  } catch (err) {
    context.error(err);
    context.res = { status: 503, body: { message: 'table read failed' }, headers: corsHeaders() };
  }
}
