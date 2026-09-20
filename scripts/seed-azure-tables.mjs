#!/usr/bin/env node
// One-off seeder: copy locally-ingested incidents from Postgres exports into Azure Table
// Storage tables (incidents / statusHistory / meta), producing EXACTLY the entity shapes
// src/store/tableStore.js reads via fetchRange(). Run after exporting with:
//   docker exec -i <db> psql -U oneida -d oneida911 -A -t \
//     <<< "SELECT json_agg(row_to_json(t)) FROM incidents t;" > /tmp/incidents.json
//   docker exec -i <db> psql -U oneida -d oneida911 -A -F $'\t' -t \
//     <<< "SELECT incident_id AS id, observed_at, status FROM incident_status_history ORDER BY incident_id, observed_at;" \
//     > /tmp/history.tsv
// The connection string is read from AZURE_TABLES_CONNECTION_STRING (env) and never printed.
import fs from 'node:fs';
import { createTableClients } from '../src/store/tableStore.js';

const CS = process.env.AZURE_TABLES_CONNECTION_STRING;
if (!CS) {
  console.error('AZURE_TABLES_CONNECTION_STRING not set');
  process.exit(1);
}
const clients = createTableClients(CS);

// Postgres emits timestamptz as "YYYY-MM-DD HH:MM:SS[.ms][+00]". Normalize to canonical
// ISO-8601 UTC ("...T..Z") so fetchRange()'s plain string-range filter sorts correctly.
function toIso(s) {
  if (s == null || s === '') return undefined;
  const str = String(s).trim();
  if (/Z$/i.test(str)) return str;
  // space->T makes it a valid ISO instant; "+00" parses as +hh (UTC), then re-normalize.
  const d = new Date(str.replace(' ', 'T'));
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

function monthOf(iso) {
  return iso.slice(0, 7); // "YYYY-MM" partition key
}
const RAW_MAX_CHARS = 256_000; // mirror tableStore.js entity-size budget
function truncateRaw(raw) {
  if (raw == null) return undefined;
  const s = typeof raw === 'string' ? raw : JSON.stringify(raw);
  return s.length > RAW_MAX_CHARS ? s.slice(0, RAW_MAX_CHARS) : s;
}
function padEpoch(epochMs) {
  return String(Math.floor(epochMs / 1000) * 1000).padStart(15, '0');
}

// Map one Postgres incident row to the exact table-store entity shape (toEntity parity).
function toEntity(row) {
  const dateFirstIso = toIso(row.date_first) ?? toIso(row.created_at) ?? new Date().toISOString();
  const e = {
    partitionKey: monthOf(dateFirstIso),
    rowKey: row.dedup_key,
    lastSeenAt: toIso(row.last_seen_at) ?? dateFirstIso,
    firstSeenAt: toIso(row.first_seen_at) ?? dateFirstIso,
    pollCount: Number(row.poll_count ?? 0),
    originPartition: monthOf(dateFirstIso),
    lat: row.lat != null ? Number(row.lat) : undefined,
    lng: row.lng != null ? Number(row.lng) : undefined,
  };
  if (row.source_id != null) e.sourceId = Number(row.source_id);
  const strings = {
    title: row.title,
    type: row.type,
    status: row.status,
    location: row.location,
    icon: row.icon,
    callNumber: row.call_number,
    dateFirst: dateFirstIso,
    createdAt: toIso(row.created_at),
    lastEditedAt: toIso(row.last_edited_at),
  };
  for (const [k, v] of Object.entries(strings)) if (v != null && v !== '') e[k] = String(v);
  e.departments = JSON.stringify(Array.isArray(row.departments) ? row.departments : []);
  const raw = truncateRaw(row.raw);
  if (raw !== undefined) e.raw = raw;
  return e;
}

async function main() {
  const incidents = JSON.parse(fs.readFileSync(process.argv[2] ?? '/tmp/incidents.json', 'utf8'));
  const historyLines = fs
    .readFileSync(process.argv[3] ?? '/tmp/history.tsv', 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      // id \t observed_at \t status (status has no tabs/newlines in practice)
      const idx1 = l.indexOf('\t');
      const rest = l.slice(idx1 + 1);
      const idx2 = rest.lastIndexOf('\t');
      return { incidentId: l.slice(0, idx1), observedAt: rest.slice(0, idx2), status: rest.slice(idx2 + 1) };
    });

  let upserted = 0;
  for (const row of incidents) {
    await clients.incidents.upsertEntity(toEntity(row), 'Replace');
    upserted++;
  }
  console.log(`incidents upserted=${upserted}`);

  let hist = 0;
  for (let i = 0; i < historyLines.length; i++) {
    const h = historyLines[i];
    if (!h.status) continue;
    const parent = incidents.find((r) => r.dedup_key && String(r.id) === h.incidentId);
    const dedupKey = parent?.dedup_key;
    if (!dedupKey) continue; // history without a resolvable parent is unqueryable by the app
    const observedIso = toIso(h.observedAt) ?? new Date().toISOString();
    await clients.statusHistory.upsertEntity(
      {
        partitionKey: monthOf(observedIso),
        rowKey: `${padEpoch(new Date(observedIso).getTime())}-${String(i).padStart(4, '0')}`,
        incidentRowKey: dedupKey,
        observedAt: observedIso,
        status: h.status,
      },
      'Replace'
    );
    hist++;
  }
  console.log(`statusHistory upserted=${hist}`);

  // Seed meta.last_poll so /api and ops have a baseline; the ingest timer overwrites it.
  await clients.meta.upsertEntity(
    {
      partitionKey: 'meta',
      rowKey: 'last_poll',
      ts: new Date().toISOString(),
      source: 'local-seed',
      fetched: Number(upserted),
      added: Number(upserted),
      skipped: 0,
      warnings: '[]',
      errors: 0,
    },
    'Replace'
  );
  console.log('meta.last_poll seeded (source=local-seed)');
}

main().catch((err) => {
  console.error('SEED FAILED:', err.message ?? err);
  process.exit(1);
});
