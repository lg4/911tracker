import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createTableClients,
  upsertIncidents,
  fetchRange,
  acquireLease,
  releaseLease,
  recordTickSuccess,
  recordTickProvenance,
  latestTick,
  assessFreshness,
} from '../src/store/tableStore.js';

// --- in-memory stand-in for @azure/data-tables TableClient -------------------
// Supports exactly the operations tableStore.js uses: getEntity, upsertEntity,
// createEntity (conflict on existing), replaceEntity (ETag CAS), deleteEntity,
// queryEntities with partitionKey/type/status eq filters and continuation tokens.

function makeFakeBackstore() {
  const tables = new Map(); // name -> Map(`${pk}\u0000${rk}` -> entity)
  function table(name) {
    if (!tables.has(name)) tables.set(name, new Map());
    return tables.get(name);
  }
  let etagSeq = 0;
  function stamp(entity) {
    entity._etag = `"tag-${(etagSeq += 1)}"`;
  }
  class FakeConflictError extends Error {
    constructor() {
      super('entity exists');
      this.statusCode = 409;
    }
  }
  class FakeNotFoundError extends Error {
    constructor() {
      super('entity not found');
      this.statusCode = 404;
    }
  }

  function clientFor(name) {
    // Mirrors the @azure/data-tables v13 API surface exactly (positional identifiers,
    // listEntities paged iterator, etag option objects) so unit tests can't drift from
    // what production calls. Like the real service, JS-level partitionKey/rowKey are ALSO
    // stored under the case-sensitive system columns PartitionKey/RowKey (kept alongside),
    // so OData filters on the system names match while lowercase assertions still hold.
    const sysCols = (e) => {
      const out = { ...e };
      if (out.partitionKey != null) out.PartitionKey = out.partitionKey;
      if (out.rowKey != null) out.RowKey = out.rowKey;
      return out;
    };
    const keyOf = (e) => `${e.partitionKey ?? e.PartitionKey}\u0000${e.rowKey ?? e.RowKey}`;
    return {
      async getEntity(partitionKey, rowKey) {
        const e = table(name).get(`${partitionKey}\u0000${rowKey}`);
        if (!e) throw new FakeNotFoundError();
        return structuredClone(e);
      },
      async upsertEntity(entity, mode = 'Merge') {
        const t = table(name);
        const stored = sysCols(entity);
        const key = keyOf(stored);
        const existing = t.get(key);
        const merged = mode === 'Replace' ? stored : existing ? { ...existing, ...stored } : stored;
        delete merged.etag;
        stamp(merged);
        t.set(key, merged);
      },
      async createEntity(entity) {
        const t = table(name);
        const stored = sysCols(entity);
        const key = keyOf(stored);
        if (t.has(key)) throw new FakeConflictError();
        stamp(stored);
        t.set(key, stored);
      },
      async updateEntity(entity, mode = 'Merge', options = {}) {
        const t = table(name);
        const stored = sysCols(entity);
        const key = keyOf(stored);
        const existing = t.get(key);
        if (!existing && mode === 'Replace') throw new FakeNotFoundError();
        if (options.etag != null && options.etag !== '*' && existing?.etag !== options.etag) throw new FakeConflictError();
        const merged = mode === 'Replace' ? stored : { ...existing, ...stored };
        delete merged.etag;
        stamp(merged);
        t.set(key, merged);
      },
      async deleteEntity(partitionKey, rowKey, options = {}) {
        const t = table(name);
        const key = `${partitionKey}\u0000${rowKey}`;
        if (options.etag != null && options.etag !== '*' && t.get(key)?.etag !== options.etag) throw new FakeConflictError();
        t.delete(key);
      },
      *listEntities({ queryOptions = {} } = {}) {
        let out = [...table(name).values()];
        for (const clause of String(queryOptions.filter ?? '').split(' and ')) {
          const m = clause.trim().match(/^(\w+) (eq|ge|gt|le|lt) '(.*)'$/);
          if (!m) continue;
          const [, col, op, rawVal] = m;
          const val = rawVal.replace(/''/g, "'");
          out = out.filter((e) => {
            const a = e[col];
            if (a == null) return false; // OData semantics: absent column fails any comparison
            switch (op) {
              case 'eq': return String(a) === val;
              case 'ne': return String(a) !== val;
              case 'ge': return String(a) >= val;
              case 'gt': return String(a) > val;
              case 'le': return String(a) <= val;
              case 'lt': return String(a) < val;
            }
          });
        }
        const select = queryOptions.select;
        for (const e of out) yield structuredClone(Array.isArray(select) ? Object.fromEntries(Object.entries(e).filter(([k]) => select.includes(k))) : e);
      },
    };
  }
  return { clientFor, tables };
}

function clientsFrom(backstore) {
  return {
    incidents: backstore.clientFor('incidents'),
    statusHistory: backstore.clientFor('status_history'),
    meta: backstore.clientFor('meta'),
  };
}

// --- fixtures -----------------------------------------------------------------

function incident(overrides = {}) {
  return {
    dedupKey: 'ID:42',
    sourceId: 42,
    title: 'MVA on Route 80',
    type: 'MVA-PD',
    status: 'In Progress',
    departments: ['PD'],
    location: 'Rte 80 & Seneca St',
    lat: 43.25,
    lng: -75.6,
    icon: null,
    callNumber: '911-001',
    dateFirstIso: '2026-09-10T12:00:00.000Z',
    createdAtIso: '2026-09-10T12:00:00.000Z',
    lastEditedAtIso: null,
    raw: { ID: 42 },
    ...overrides,
  };
}

test('upsert is idempotent and bumps pollCount each tick', async () => {
  const bs = makeFakeBackstore();
  const clients = clientsFrom(bs);
  const t1 = await upsertIncidents(clients, [incident()], '2026-09-10T12:05:00.000Z');
  assert.equal(t1.added, 1);
  const t2 = await upsertIncidents(clients, [incident()], '2026-09-10T12:20:00.000Z');
  assert.equal(t2.added, 0);

  const rows = [...bs.tables.get('incidents').values()];
  assert.equal(rows.length, 1);
  assert.equal(rows[0].pollCount, 2);
  assert.equal(rows[0].firstSeenAt, '2026-09-10T12:05:00.000Z'); // pinned to first sight
  assert.equal(rows[0].lastSeenAt, '2026-09-10T12:20:00.000Z');
});

test('status history appends only on change; duplicate status is a no-op', async () => {
  const bs = makeFakeBackstore();
  const clients = clientsFrom(bs);
  await upsertIncidents(clients, [incident({ status: 'In Progress' })], '2026-09-10T12:05:00.000Z');
  await upsertIncidents(clients, [incident({ status: 'In Progress' })], '2026-09-10T12:20:00.000Z');
  let hist = [...bs.tables.get('status_history').values()];
  assert.equal(hist.length, 1);
  assert.equal(hist[0].incidentRowKey, 'ID:42');

  await upsertIncidents(clients, [incident({ status: 'Resolved' })], '2026-09-11T08:00:00.000Z');
  hist = [...bs.tables.get('status_history').values()];
  assert.equal(hist.length, 2);
  assert.equal(hist[1].status, 'Resolved');
});

test('month rollover dual-writes; original untouched; reads dedupe by rowKey', async () => {
  const bs = makeFakeBackstore();
  const clients = clientsFrom(bs);
  // First sight in September.
  await upsertIncidents(clients, [incident()], '2026-09-10T12:05:00.000Z');
  const sepRow = bs.tables.get('incidents').get(`2026-09\u0000ID:42`);
  assert.ok(sepRow);
  assert.equal(sepRow.originPartition, '2026-09');

  // Same incident later reports a dateFirst that crossed into October.
  const octTick = await upsertIncidents(
    clients,
    [incident({ dateFirstIso: '2026-10-02T09:30:00.000Z' })],
    '2026-10-02T14:00:00.000Z'
  );
  assert.equal(octTick.added, 0);
  const origAfter = bs.tables.get('incidents').get(`2026-09\u0000ID:42`);
  assert.equal(origAfter.lastSeenAt, '2026-09-10T12:05:00.000Z'); // original untouched
  const copy = bs.tables.get('incidents').get(`2026-10\u0000ID:42`);
  assert.ok(copy);
  assert.equal(copy.originPartition, '2026-09');
  assert.equal(copy.firstSeenAt, '2026-09-10T12:05:00.000Z');

  // A range spanning both months returns the incident exactly once.
  const geo = await fetchRange(clients, { since: new Date('2026-09-01'), until: new Date('2026-10-31') });
  assert.equal(geo.features.length, 1);
  assert.deepEqual(geo.features[0].geometry.coordinates, [-75.6, 43.25]);
});

test('fetchRange applies type filter and default 30-day window', async () => {
  const bs = makeFakeBackstore();
  const clients = clientsFrom(bs);
  // All fixture rows pinned to fixed old dates so assertions never depend on the wall clock.
  await upsertIncidents(clients, [incident({ dateFirstIso: '2026-01-15T12:00:00.000Z' })], '2026-01-15T12:00:00.000Z');
  await upsertIncidents(
    clients,
    [incident({ dedupKey: 'ID:43', sourceId: 43, title: 'Other', type: 'Fire', dateFirstIso: '2026-01-15T12:00:00.000Z' })],
    '2026-01-15T12:00:00.000Z'
  );
  // One very old row that must never appear in a default (last-30-days) window,
  // plus one fresh row anchored to the actual current time.
  await upsertIncidents(
    clients,
    [incident({ dedupKey: 'ID:44', sourceId: 44, dateFirstIso: '2020-01-15T12:00:00.000Z' })],
    '2020-01-15T12:00:00.000Z'
  );
  const now = new Date();
  await upsertIncidents(
    clients,
    [incident({ dedupKey: 'ID:45', sourceId: 45, type: 'FreshOnly', dateFirstIso: now.toISOString() })],
    now.toISOString()
  );

  const filtered = await fetchRange(clients, {
    since: new Date('2026-01-01'),
    until: new Date('2026-01-31'),
    type: 'MVA-PD',
  });
  assert.equal(filtered.features.length, 1);
  assert.equal(filtered.features[0].properties.type, 'MVA-PD');
  assert.equal(filtered.features[0].properties.dedupKey, 'ID:42');

  // Default window (last 30 days from "now") includes only the fresh row.
  const recent = await fetchRange(clients, {});
  const keys = recent.features.map((f) => f.properties.dedupKey).sort();
  assert.deepEqual(keys, ['ID:45']);
});

test('lease is single-flight; release allows re-acquire; expired lock is taken over', async () => {
  const bs = makeFakeBackstore();
  const clients = clientsFrom(bs);
  const holderA = await acquireLease(clients, 60_000);
  assert.ok(holderA);
  assert.equal(await acquireLease(clients, 60_000), null); // live lock blocks others
  await releaseLease(clients, holderA);
  const holderB = await acquireLease(clients, 60_000);
  assert.ok(holderB && holderB !== holderA);

  // Expired lock: forge an old expiresAt, then a new tick takes it over via CAS swap.
  const metaRow = [...bs.tables.get('meta').values()].find((e) => e.rowKey === 'lock');
  metaRow.expiresAt = new Date(Date.now() - 1000).toISOString();
  const holderC = await acquireLease(clients, 60_000);
  assert.ok(holderC);
});

test('recordTickSuccess writes last_poll and resets error counter', async () => {
  const bs = makeFakeBackstore();
  const clients = clientsFrom(bs);
  await recordTickSuccess(clients, { source: 'json', fetched: 5, added: 2, skipped: 0, warnings: [] });
  const row = bs.tables.get('meta').get(`meta\u0000last_poll`);
  assert.equal(row.fetched, 5);
  assert.equal(row.added, 2);
  assert.equal(row.errors, 0);
});

test('upserted rows carry tick provenance; lastStatusChangeAt only on divergence from stored state', async () => {
  const bs = makeFakeBackstore();
  const clients = clientsFrom(bs);
  await upsertIncidents(
    clients,
    [incident({ tickChecksum: 'abc123def456', fetchedAtIso: '2026-09-10T12:00:00.000Z' })],
    '2026-09-10T12:00:00.000Z'
  );
  const partKey = '2026-09';
  const rowA = bs.tables.get('incidents').get(`${partKey}\u0000ID:42`);
  assert.equal(rowA.tickChecksum, 'abc123def456');
  assert.equal(rowA.fetchedAtIso, '2026-09-10T12:00:00.000Z');
  // First storage is not a status change — no flag yet.
  assert.equal(rowA.lastStatusChangeAt, undefined);

  // Re-polls always carry the tick's provenance tags (pollSource adds them), so they
  // survive Replace-mode upserts without wiping step 1's checksum.
  const tagged = () => incident({ tickChecksum: 'abc123def456', fetchedAtIso: '2026-09-10T12:00:00.000Z' });

  // Same status re-poll: still no flag.
  await upsertIncidents(clients, [tagged()], '2026-09-10T12:10:00.000Z');
  assert.equal(bs.tables.get('incidents').get(`${partKey}\u0000ID:42`).lastStatusChangeAt, undefined);

  // Status divergence from stored state stamps the flag.
  await upsertIncidents(
    clients,
    [incident({ ...tagged(), status: 'Resolved' })],
    '2026-09-10T12:20:00.000Z'
  );
  const rowB = bs.tables.get('incidents').get(`${partKey}\u0000ID:42`);
  assert.equal(rowB.status, 'Resolved');
  assert.equal(rowB.lastStatusChangeAt, '2026-09-10T12:20:00.000Z');

  // Served features surface all three provenance fields.
  const geo = await fetchRange(clients, { since: '2026-09-01T00:00:00Z', until: '2026-09-30T00:00:00Z' });
  const f = geo.features[0];
  assert.equal(f.properties.tickChecksum, 'abc123def456');
  assert.equal(f.properties.fetchedAtIso, '2026-09-10T12:00:00.000Z');
  assert.equal(f.properties.lastStatusChangeAt, '2026-09-10T12:20:00.000Z');
});

test('recordTickProvenance writes an immutable prov audit row and a refreshed tick pointer', async () => {
  const bs = makeFakeBackstore();
  const clients = clientsFrom(bs);
  const ts = '2026-09-10T12:00:00.000Z';
  await recordTickProvenance(clients, { ts, source: 'oneida', url: 'http://feed.example', count: 7, checksum: 'deadbeef' });
  const meta = bs.tables.get('meta');
  const tickRow = meta.get(`meta\u0000tick:oneida`);
  assert.deepEqual(
    [tickRow.ts, tickRow.url, tickRow.fetched, tickRow.checksum],
    ['2026-09-10T12:00:00.000Z', 'http://feed.example', 7, 'deadbeef']
  );
  // The audit row is append-only: keyed by second+checksum so repeated ticks never overwrite history.
  const provRows = [...meta.values()].filter((e) => e.rowKey.startsWith('prov:'));
  assert.equal(provRows.length, 1);
  assert.match(provRows[0].rowKey, /^prov:\d+:./);

  // A later tick refreshes the pointer but appends a new audit row (different checksum).
  await recordTickProvenance(clients, { ts: '2026-09-10T12:10:00.000Z', source: 'oneida', url: 'http://feed.example', count: 8, checksum: 'cafebabe' });
  assert.equal(meta.get(`meta\u0000tick:oneida`).ts, '2026-09-10T12:10:00.000Z');
  assert.equal([...meta.values()].filter((e) => e.rowKey.startsWith('prov:')).length, 2);
});

test('assessFreshness flags missing sources and ticks older than 30 minutes as stale', async () => {
  const bs = makeFakeBackstore();
  const clients = clientsFrom(bs);
  const nowMs = Date.parse('2026-09-10T12:45:00.000Z');
  const freshTs = '2026-09-10T12:40:00.000Z'; // 5 min ago
  const staleTs = '2026-09-10T12:10:00.000Z'; // 35 min ago
  await recordTickProvenance(clients, { ts: freshTs, source: 'a', count: 1, checksum: 'aa' });
  await recordTickProvenance(clients, { ts: staleTs, source: 'b', count: 2, checksum: 'bb' });

  assert.equal((await latestTick(clients, 'a')).checksum, 'aa');
  assert.equal(await latestTick(clients, 'missing'), null);

  const res = await assessFreshness(clients, ['a', 'b', 'missing'], nowMs);
  assert.equal(res.stale, true);
  assert.deepEqual(
    res.ticks.map((t) => [t.source, t.lastFetchedAt]),
    [['a', freshTs], ['b', staleTs], ['missing', null]]
  );

  // All sources fresh → not stale.
  await recordTickProvenance(clients, { ts: freshTs, source: 'b', count: 2, checksum: 'bb2' });
  const ok = await assessFreshness(clients, ['a', 'b'], nowMs);
  assert.equal(ok.stale, false);
});

test('fetchRange applies day-granular since/until inside month partitions', async () => {
  const bs = makeFakeBackstore();
  const clients = clientsFrom(bs);
  await upsertIncidents(
    clients,
    [incident({ dedupKey: 'ID:51', dateFirstIso: '2026-03-05T10:00:00.000Z' })],
    '2026-03-05T10:00:00.000Z'
  );
  await upsertIncidents(
    clients,
    [incident({ dedupKey: 'ID:52', dateFirstIso: '2026-03-18T10:00:00.000Z' })],
    '2026-03-18T10:00:00.000Z'
  );
  // March 10..19 window must include only ID:52 (both rows share the 2026-03 partition).
  const geo = await fetchRange(clients, {
    since: new Date('2026-03-10'),
    until: new Date('2026-03-19'),
  });
  assert.deepEqual(geo.features.map((f) => f.properties.dedupKey), ['ID:52']);
});
