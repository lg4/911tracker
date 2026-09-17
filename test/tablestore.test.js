import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createTableClients,
  upsertIncidents,
  fetchRange,
  acquireLease,
  releaseLease,
  recordTickSuccess,
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
    return {
      async getEntity({ partitionKey, rowKey }) {
        const e = table(name).get(`${partitionKey}\u0000${rowKey}`);
        if (!e) throw new FakeNotFoundError();
        return structuredClone(e);
      },
      async upsertEntity(entity) {
        const t = table(name);
        const key = `${entity.partitionKey}\u0000${entity.rowKey}`;
        const existing = t.get(key);
        const merged = existing ? { ...existing, ...entity } : { ...entity };
        delete merged._etag;
        stamp(merged);
        t.set(key, merged);
      },
      async createEntity(entity) {
        const t = table(name);
        const key = `${entity.partitionKey}\u0000${entity.rowKey}`;
        if (t.has(key)) throw new FakeConflictError();
        const stored = { ...entity };
        stamp(stored);
        t.set(key, stored);
      },
      async replaceEntity(entity, etag) {
        const t = table(name);
        const key = `${entity.partitionKey}\u0000${entity.rowKey}`;
        const existing = t.get(key);
        if (!existing || existing._etag !== etag) throw new FakeConflictError();
        const merged = { ...existing, ...entity };
        delete merged._etag;
        stamp(merged);
        t.set(key, merged);
      },
      async deleteEntity({ partitionKey, rowKey }, etag) {
        const t = table(name);
        const key = `${partitionKey}\u0000${rowKey}`;
        if (etag != null && t.get(key)?._etag !== etag) throw new FakeConflictError();
        t.delete(key);
      },
      async queryEntities({ queryOptions = {}, continuationToken } = {}) {
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
        const top = queryOptions.top ?? 1000;
        const start = Number(continuationToken ?? 0);
        const page = out.slice(start, start + top);
        return {
          items: structuredClone(page),
          continuationToken: start + top < out.length ? String(start + top) : undefined,
        };
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
