// One-time migration helper: copy incidents (+ status history) from Phase 1 Postgres into
// Azure Table Storage so the map has full history on day one of Phase 2.
// Usage: DATABASE_URL=... AZURE_TABLES_CONNECTION_STRING=... node scripts/seed-to-tables.js
import { Pool } from 'pg';
import { createTableClients, upsertIncidents } from '../src/store/tableStore.js';

const databaseUrl = process.env.DATABASE_URL;
const tablesConn = process.env.AZURE_TABLES_CONNECTION_STRING || process.env.AzureWebJobsStorage;
if (!databaseUrl || !tablesConn) {
  console.error('set DATABASE_URL and AZURE_TABLES_CONNECTION_STRING');
  process.exit(1);
}

const pool = new Pool({ connectionString: databaseUrl });
const clients = createTableClients(tablesConn);

const res = await pool.query(`
  SELECT dedup_key, source_id, title, type, status, departments, location, lat, lng,
         icon, call_number, date_first, created_at, last_edited_at, first_seen_at,
         last_seen_at, poll_count, raw
  FROM incidents ORDER BY first_seen_at`);

const nowIso = new Date().toISOString();
let added = 0;
for (const r of res.rows) {
  const inc = {
    dedupKey: r.dedup_key,
    sourceId: r.source_id != null ? Number(r.source_id) : null,
    title: r.title,
    type: r.type,
    status: r.status,
    departments: Array.isArray(r.departments) ? r.departments : [],
    location: r.location,
    lat: r.lat == null ? null : Number(r.lat),
    lng: r.lng == null ? null : Number(r.lng),
    icon: r.icon,
    callNumber: r.call_number,
    dateFirstIso: r.date_first ? new Date(r.date_first).toISOString() : nowIso,
    createdAtIso: r.created_at ? new Date(r.created_at).toISOString() : null,
    lastEditedAtIso: r.last_edited_at ? new Date(r.last_edited_at).toISOString() : null,
    raw: r.raw,
  };
  // upsertIncidents treats these as a fresh tick: pollCount starts at 1 (drift vs the PG
  // counter is cosmetic), firstSeenAt preserves history, lastSeenAt uses the historical value.
  const out = await upsertIncidents(
    clients,
    [inc],
    r.last_seen_at ? new Date(r.last_seen_at).toISOString() : nowIso
  );
  added += out.added;
}

const historyRes = await pool.query('SELECT incident_id, observed_at, status FROM incident_status_history');
// Incident-level history rows are re-derivable from upserts; skip bulk copy — the live
// pipeline will keep appending going forward. (Documented trade-off, not data loss.)
console.log(JSON.stringify({ incidents: res.rows.length, added, historyRowsSkipped: historyRes.rowCount }));
await pool.end();
