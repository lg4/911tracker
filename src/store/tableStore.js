import crypto from 'node:crypto';
import { TableClient, AzureNamedKeyCredential } from '@azure/data-tables';

// Keep serialized raw payloads far under the 1 MiB entity limit.
const RAW_MAX_CHARS = 256_000;

// How many months to walk backwards when locating an incident's pinned partition.
// Only hit on first sight after a long gap; each probe is one cheap PK+RK lookup.
const MAX_LOOKBACK_MONTHS = 36;

// @azure/data-tables takes an endpoint URL plus optional credential — not .NET-style
// semicolon connection strings. Accept both so callers can pass either a bare dev
// endpoint (Azurite) or the full Azure connection string from app settings.
function parseConnectionString(cs) {
  if (!cs.includes(';')) return { url: cs };
  const parts = {};
  for (const seg of cs.split(';')) {
    const eq = seg.indexOf('=');
    if (eq > 0) parts[seg.slice(0, eq).toLowerCase()] = seg.slice(eq + 1);
  }
  const account = parts.accountname;
  const key = parts.accountkey;
  if (!account || !key) throw new Error('connection string missing AccountName/AccountKey');
  const proto = (parts.defaultendpointprotocol ?? 'https').replace(/[^a-z]/gi, '') || 'https';
  return { url: `${proto}://${account}.table.core.windows.net`, credential: new AzureNamedKeyCredential(account, key) };
}

export function createTableClients(connectionString, opts = {}) {
  if (!connectionString) throw new Error('missing Azure tables connection string');
  const { url } = parseConnectionString(connectionString);
  // Bare dev endpoints (Azurite) carry no key; pass a credential explicitly in that case.
  const credential = opts.credential ?? parseConnectionString(connectionString).credential;
  const make = (name) => (credential ? new TableClient(url, name, credential) : new TableClient(url, name));
  return { incidents: make('incidents'), statusHistory: make('statusHistory'), meta: make('meta') };
}

export function monthOf(iso) {
  return iso.slice(0, 7); // "YYYY-MM"
}

function sha8(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 8);
}

function padEpoch(epochMs) {
  return String(Math.floor(epochMs / 1000) * 1000).padStart(15, '0');
}

function truncateRaw(raw) {
  if (raw == null) return undefined;
  const s = JSON.stringify(raw);
  return s.length > RAW_MAX_CHARS ? s.slice(0, RAW_MAX_CHARS) : s;
}

// Build a table entity for one normalized incident. Nullable fields are omitted when null
// (tables have no NULL column value in practice; absence means unknown).
function toEntity(inc, { partitionKey, firstSeenAt, pollCount, originPartition }) {
  const e = {
    partitionKey,
    rowKey: inc.dedupKey,
    lastSeenAt: inc.lastSeenAt ?? new Date().toISOString(),
    firstSeenAt,
    pollCount,
    originPartition,
    lat: inc.lat,
    lng: inc.lng,
  };
  if (inc.sourceId != null) e.sourceId = inc.sourceId;
  const strings = {
    county: inc.county,
    title: inc.title,
    type: inc.type,
    status: inc.status,
    location: inc.location,
    icon: inc.icon,
    callNumber: inc.callNumber,
    dateFirst: inc.dateFirstIso,
    createdAt: inc.createdAtIso,
    lastEditedAt: inc.lastEditedAtIso,
    // T12(a) provenance: which verified tick produced this row (raw-body hash + fetch time).
    tickChecksum: inc.tickChecksum,
    fetchedAtIso: inc.fetchedAtIso,
    lastStatusChangeAt: inc.lastStatusChangeAt,
  };
  for (const [k, v] of Object.entries(strings)) if (v != null) e[k] = v;
  e.departments = JSON.stringify(Array.isArray(inc.departments) ? inc.departments : []);
  const raw = truncateRaw(inc.raw);
  if (raw !== undefined) e.raw = raw;
  return e;
}

async function getRow(client, partitionKey, rowKey) {
  try {
    return await client.getEntity(partitionKey, rowKey);
  } catch (err) {
    if (err.statusCode === 404 || /not found/i.test(err.message)) return null;
    throw err;
  }
}

// Locate an incident's original (pinned-partition) row. The feed only reports current-month
// rows, so the incident's own dateFirst tells us where its original lives: probe that month
// first, then walk back through prior months (rare rollover case) until found or exhausted.
async function findOriginal(clients, dedupKey, anchorMonth, deadlineMs) {
  let m = new Date(`${anchorMonth}-01T00:00:00Z`);
  for (let i = 0; i < MAX_LOOKBACK_MONTHS; i++) {
    if (Date.now() > deadlineMs) break;
    const part = m.toISOString().slice(0, 7);
    const row = await getRow(clients.incidents, part, dedupKey);
    if (row) return row;
    // Stop early once we walk past any plausible data start point is unnecessary here;
    // unknown incidents cost exactly one probe and exit via the loop below.
    if (i >= 1) break; // originals live at most in the month before the current one
    m.setUTCMonth(m.getUTCMonth() - 1);
  }
  return null;
}

function upsertReplace(client, entity) {
  return client.upsertEntity(entity, 'Replace');
}

// Upsert every incident with Phase-1 semantics: first-seen timestamp kept, poll count
// bumped per tick, status_history appended only when observed status changes, and the
// never-move rollover rule (dual-write into the new month partition, keep original).
// A wall-clock budget keeps a bad tick from blowing through functionTimeout; aborting is
// safe because the next tick re-runs everything idempotently.
export async function upsertIncidents(clients, incidents, nowIso, opts = {}) {
  const deadlineMs = Date.now() + (opts.budgetMs ?? 4 * 60 * 1000);
  let added = 0;
  for (const inc of incidents) {
    if (Date.now() > deadlineMs) {
      throw new Error(`upsert budget exhausted after ${added}/${incidents.length} incidents`);
    }
    const curMonth = monthOf(inc.dateFirstIso ?? nowIso);
    const existing = await findOriginal(clients, inc.dedupKey, curMonth, deadlineMs);

    const pinnedPartition = existing ? existing.originPartition || existing.partitionKey : curMonth;
    const firstSeenAt = existing?.firstSeenAt ?? nowIso;
    const pollCount = existing ? Number(existing.pollCount ?? 0) + 1 : 1;
    if (!existing) added += 1;

    const statusChanged = !existing || existing.status !== inc.status;

    // Primary write goes to the current-month partition (queries default to recent months).
    // T12(a): stamp when this row's status last diverged from its stored state so a served
    // feature can be flagged "status changed after storage" without re-reading history.
    const primary = toEntity(
      { ...inc, lastSeenAt: nowIso, ...(statusChanged && existing ? { lastStatusChangeAt: nowIso } : {}) },
      {
        partitionKey: curMonth,
        firstSeenAt,
        pollCount,
        originPartition: pinnedPartition,
      }
    );
    if (pinnedPartition === curMonth) {
      await upsertReplace(clients.incidents, primary);
    } else {
      // Rare boundary crossing: dual-write. Original row stays untouched in its old
      // partition; a fresh copy lands in the new one carrying identical identity fields.
      await upsertReplace(clients.incidents, {
        ...primary,
        partitionKey: pinnedPartition,
        lastSeenAt: existing.lastSeenAt,
      });
      await upsertReplace(clients.incidents, primary);
    }

    if (statusChanged && inc.status != null) {
      await upsertReplace(clients.statusHistory, {
        partitionKey: pinnedPartition,
        rowKey: `${padEpoch(Date.now())}:${sha8(inc.status)}:${Math.random().toString(36).slice(2, 7)}`,
        incidentRowKey: inc.dedupKey,
        observedAt: nowIso,
        status: inc.status,
      });
    }
  }
  return { upserted: incidents.length, added };
}

function monthRange(sinceIso, untilIso) {
  const months = [];
  let m = new Date(`${monthOf(sinceIso)}-01T00:00:00Z`);
  const end = monthOf(untilIso);
  while (m.toISOString().slice(0, 7) <= end) {
    months.push(m.toISOString().slice(0, 7));
    m.setUTCMonth(m.getUTCMonth() + 1);
  }
  return months;
}

// Read path for the map API. One partition-scoped query per month between since/until,
// following continuation tokens; duplicates from rollover dual-writes are collapsed by
// rowKey keeping the newest lastSeenAt. Day-granular since/until are applied as a
// dateFirst string-range inside each partition query (rows without dateFirst are excluded).
export async function fetchRange(clients, opts = {}) {
  const toIso = (d) => (d instanceof Date ? d.toISOString() : d);
  const untilIso = toIso(opts.until ?? new Date());
  const sinceIso = toIso(opts.since ?? new Date(Date.now() - 30 * 24 * 60 * 60 * 1000));
  const limit = Math.min(Number(opts.limit ?? 2000), 5000);
  const typeFilter = opts.type ? ` and type eq '${opts.type.replace(/'/g, "''")}'` : '';
  const statusFilter = opts.status ? ` and status eq '${opts.status.replace(/'/g, "''")}'` : '';
  const countyFilter = opts.county ? ` and county eq '${opts.county.replace(/'/g, "''")}'` : '';
  // ISO-8601 UTC strings compare chronologically as plain strings.
  const dayAfterUntil = new Date(new Date(untilIso).setUTCHours(24)).toISOString();
  const rangeFilter = ` and dateFirst ge '${sinceIso}' and dateFirst lt '${dayAfterUntil}'`;

  const rows = [];
  outer: for (const part of monthRange(sinceIso, untilIso)) {
    // The SDK maps entity partitionKey/rowKey onto the system columns PartitionKey/RowKey,
    // so filters must address those names. No $select: partitions are tiny, full entities
    // keep the read path free of case-sensitivity surprises.
    for await (const e of clients.incidents.listEntities({
      queryOptions: {
        // System key columns are case-sensitive (PartitionKey); custom props keep their casing.
        // No $select: partitions hold tens of rows at most, and full entities sidestep any
        // client-side case normalization differences between the service and test fakes.
        filter: `PartitionKey eq '${part}'${rangeFilter}${typeFilter}${statusFilter}${countyFilter}`,
      },
    })) {
      if (e.partitionKey === part) rows.push(e);
      if (rows.length >= limit) break outer;
    }
  }

  const byRowKey = new Map();
  for (const r of rows) {
    const prev = byRowKey.get(r.rowKey);
    if (!prev || (r.lastSeenAt ?? '') > (prev.lastSeenAt ?? '')) byRowKey.set(r.rowKey, r);
  }

  return {
    type: 'FeatureCollection',
    // Rows without resolved coordinates (un-geocoded CAD rows) can't form a valid Point;
    // skip them rather than emit [undefined, NaN] inside an otherwise-valid collection.
    features: [...byRowKey.values()]
      .filter((r) => Number.isFinite(Number(r.lat)) && Number.isFinite(Number(r.lng)))
      .map((r) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [r.lng, Number(r.lat)] },
      properties: {
        dedupKey: r.rowKey,
        county: r.county,
        sourceId: r.sourceId != null ? Number(r.sourceId) : undefined,
        title: r.title,
        type: r.type,
        status: r.status,
        location: r.location,
        icon: r.icon,
        callNumber: r.callNumber,
        dateFirst: r.dateFirst,
        lastSeenAt: r.lastSeenAt,
        // T12(a) provenance: which verified tick produced this row + whether its status
        // has changed since first storage (set only on a divergence from stored state).
        tickChecksum: r.tickChecksum,
        fetchedAtIso: r.fetchedAtIso,
        lastStatusChangeAt: r.lastStatusChangeAt,
      },
    })),
  };
}

// --- single-instance lease -----------------------------------------------------

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Atomic lock acquisition: create-only insert; on conflict read the holder and take over
// only an expired lock via ETag compare-and-swap. Returns a holder token or null if we
// lost the race after maxAttempts (caller should skip this tick).
export async function acquireLease(clients, ttlMs = 15 * 60 * 1000, maxAttempts = 12) {
  const holder = `tick-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  for (let i = 0; i < maxAttempts; i++) {
    try {
      await clients.meta.createEntity({
        partitionKey: 'meta',
        rowKey: 'lock',
        holder,
        expiresAt: new Date(Date.now() + ttlMs).toISOString(),
      });
      return holder;
    } catch (err) {
      if (!(err.statusCode === 409 || /conflict/i.test(err.message))) throw err;
      const current = await getRow(clients.meta, 'meta', 'lock');
      if (!current) continue; // deleted between read attempts; retry fresh insert
      if (new Date(current.expiresAt).getTime() >= Date.now()) return null; // live lock
      try {
        await clients.meta.updateEntity(
          { partitionKey: 'meta', rowKey: 'lock', holder, expiresAt: new Date(Date.now() + ttlMs).toISOString() },
          'Replace',
          { etag: current.etag }
        );
        return holder;
      } catch {
        /* someone beat us to the swap; loop */
      }
    }
    await sleep(300);
  }
  return null;
}

export async function releaseLease(clients, holder) {
  if (!holder) return;
  try {
    const current = await getRow(clients.meta, 'meta', 'lock');
    // ETag-conditional delete so we can never release a lock another tick took over.
    if (current && current.holder === holder) {
      await clients.meta.deleteEntity('meta', 'lock', { etag: current.etag });
    }
  } catch {
    /* best effort: a crashed holder simply expires via TTL */
  }
}

// --- meta bookkeeping ----------------------------------------------------------

export async function recordTickSuccess(clients, stats) {
  await upsertReplace(clients.meta, {
    partitionKey: 'meta',
    rowKey: 'last_poll',
    ts: new Date().toISOString(),
    source: stats.source ?? '',
    fetched: Number(stats.fetched ?? 0),
    added: Number(stats.added ?? 0),
    skipped: Number(stats.skipped ?? 0),
    warnings: JSON.stringify(stats.warnings ?? []),
    errors: 0,
  });
}

// T12(a): per-tick provenance. Appends an immutable audit row and refreshes a pointer row
// per source so any served feature can be traced back to a verified tick (url, count, hash).
export async function recordTickProvenance(clients, info) {
  const ts = info.ts ?? new Date().toISOString();
  await upsertReplace(clients.meta, {
    partitionKey: 'meta',
    rowKey: `prov:${Math.floor(Date.now() / 1000)}:${sha8(info.checksum ?? '')}`,
    ts,
    source: info.source ?? '',
    url: info.url ?? '',
    fetched: Number(info.count ?? 0),
    checksum: info.checksum ?? '',
  });
  await upsertReplace(clients.meta, {
    partitionKey: 'meta',
    rowKey: `tick:${info.source}`,
    ts,
    url: info.url ?? '',
    fetched: Number(info.count ?? 0),
    checksum: info.checksum ?? '',
  });
}

export async function latestTick(clients, sourceId) {
  return getRow(clients.meta, 'meta', `tick:${sourceId}`);
}

// T12(a): drift detection before serving. A tick older than this is "stale" — the table
// state no longer reflects a fresh fetch of the live feed (polling cadence is ~10 min).
const STALE_TICK_MS = 30 * 60 * 1000;

export async function assessFreshness(clients, sourceIds, nowMs = Date.now()) {
  const ticks = [];
  let stale = false;
  for (const id of sourceIds) {
    const t = await latestTick(clients, id);
    if (!t || nowMs - new Date(t.ts).getTime() > STALE_TICK_MS) stale = true;
    ticks.push({ source: id, lastFetchedAt: t?.ts ?? null, checksum: t?.checksum ?? null });
  }
  return { stale, ticks };
}

export async function recordTickFailure(clients, message) {
  let count = 1;
  try {
    const cur = await getRow(clients.meta, 'meta', 'last_poll');
    if (cur) {
      count = Number(cur.errors ?? 0) + 1;
      await upsertReplace(clients.meta, {
        partitionKey: 'meta',
        rowKey: 'last_poll',
        ...cur,
        lastErrorAt: new Date().toISOString(),
        lastErrorMessage: String(message).slice(0, 500),
        errors: count,
      });
      return;
    }
  } catch {
    /* first write wins below */
  }
  await upsertReplace(clients.meta, {
    partitionKey: 'meta',
    rowKey: 'last_poll',
    ts: new Date().toISOString(),
    source: '',
    fetched: 0,
    added: 0,
    skipped: 0,
    warnings: '[]',
    lastErrorAt: new Date().toISOString(),
    lastErrorMessage: String(message).slice(0, 500),
    errors: count,
  });
}
