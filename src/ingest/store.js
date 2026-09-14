import { Pool } from 'pg';
import { config } from '../config.js';

export function createPool(databaseUrl = config.databaseUrl) {
  return new Pool({ connectionString: databaseUrl });
}

const DDL = `
CREATE TABLE IF NOT EXISTS incidents (
  id              bigserial PRIMARY KEY,
  dedup_key       text UNIQUE NOT NULL,
  source_id       bigint,
  title           text,
  type            text,
  status          text,
  departments     text[],
  location        text,
  lat             double precision,
  lng             double precision,
  icon            text,
  call_number     text,
  date_first      timestamptz,
  created_at      timestamptz,
  last_edited_at  timestamptz,
  first_seen_at   timestamptz,
  last_seen_at    timestamptz,
  poll_count      integer DEFAULT 0,
  raw             jsonb,
  created_ts      timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_incidents_date_first ON incidents(date_first DESC);
CREATE INDEX IF NOT EXISTS idx_incidents_last_seen ON incidents(last_seen_at DESC);

CREATE TABLE IF NOT EXISTS incident_status_history (
  id           bigserial PRIMARY KEY,
  incident_id  bigint REFERENCES incidents(id) ON DELETE CASCADE,
  observed_at  timestamptz,
  status       text
);
CREATE INDEX IF NOT EXISTS idx_status_history_incident
  ON incident_status_history(incident_id, observed_at DESC);
`;

export async function initDb(pool) {
  await pool.query(DDL);
}

const UPSERT_SQL = `
INSERT INTO incidents
  (dedup_key, source_id, title, type, status, departments, location, lat, lng,
   icon, call_number, date_first, created_at, last_edited_at,
   first_seen_at, last_seen_at, poll_count, raw)
VALUES
  ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
ON CONFLICT (dedup_key) DO UPDATE SET
  source_id      = EXCLUDED.source_id,
  title          = EXCLUDED.title,
  type           = EXCLUDED.type,
  status         = COALESCE(EXCLUDED.status, incidents.status),
  departments    = EXCLUDED.departments,
  location       = EXCLUDED.location,
  lat            = EXCLUDED.lat,
  lng            = EXCLUDED.lng,
  icon           = EXCLUDED.icon,
  call_number    = EXCLUDED.call_number,
  date_first     = EXCLUDED.date_first,
  created_at     = EXCLUDED.created_at,
  last_edited_at = EXCLUDED.last_edited_at,
  last_seen_at   = EXCLUDED.last_seen_at,
  poll_count     = incidents.poll_count + 1,
  raw            = EXCLUDED.raw
RETURNING id;
`;

// Upsert each incident: set first_seen_at on first sight, bump last_seen_at/poll_count every
// tick, and append a status_history row when the observed status changes.
export async function upsertIncidents(pool, incidents, nowIso) {
  let added = 0;
  for (const inc of incidents) {
    const prevRes = await pool.query(
      'SELECT id, status FROM incidents WHERE dedup_key = $1',
      [inc.dedupKey]
    );
    const existing = prevRes.rows[0];

    const res = await pool.query(UPSERT_SQL, [
      inc.dedupKey,
      inc.sourceId,
      inc.title,
      inc.type,
      inc.status,
      inc.departments || [],
      inc.location,
      inc.lat,
      inc.lng,
      inc.icon,
      inc.callNumber,
      inc.dateFirstIso,
      inc.createdAtIso,
      inc.lastEditedAtIso,
      nowIso, // first_seen_at (only applied on insert; kept on conflict)
      nowIso, // last_seen_at (refreshed every tick)
      1, // initial poll_count for brand-new rows
      inc.raw ? JSON.stringify(inc.raw) : null,
    ]);
    const id = res.rows[0].id;

    if (!existing) added += 1;
    if (!existing || existing.status !== inc.status) {
      await pool.query(
        'INSERT INTO incident_status_history (incident_id, observed_at, status) VALUES ($1,$2,$3)',
        [id, nowIso, inc.status]
      );
    }
  }
  return { upserted: incidents.length, added };
}

// Read path used by the Phase 2 API and by tests. Returns points for the map/heatmap.
export async function fetchPoints(pool, opts = {}) {
  const sinceIso = opts.since ?? null;
  const untilIso = opts.until ?? null;
  const limit = Math.min(Number(opts.limit ?? 5000), 20000);
  const where = [];
  const params = [];
  if (sinceIso) {
    params.push(sinceIso);
    where.push(`date_first >= $${params.length}`);
  }
  if (untilIso) {
    params.push(untilIso);
    where.push(`date_first <= $${params.length}`);
  }
  params.push(limit);
  const sql = `
    SELECT source_id, title, type, status, departments, location, lat, lng, icon,
           call_number, date_first, created_at, last_edited_at, first_seen_at, last_seen_at
    FROM incidents
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY date_first DESC NULLS LAST
    LIMIT $${params.length}`;
  const res = await pool.query(sql, params);
  return res.rows;
}
