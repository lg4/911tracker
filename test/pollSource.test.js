import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { pollSource } from '../src/ingest/fetchSource.js';

const sha256hex = (text) => crypto.createHash('sha256').update(text).digest('hex');

const here = dirname(fileURLToPath(import.meta.url));
const CADINET_HTML = readFileSync(join(here, 'fixtures', 'cadinet.snippet.html'), 'utf8');

// T12(a): the primary JSON feed's raw body is hashed; every parsed row carries the tick
// checksum + fetch time so a stored row traces back to exactly those bytes.
test('pollSource tags incidents with the raw-body sha256 and exposes per-tick checksum/fetchedAt', async () => {
  const realFetch = globalThis.fetch;
  const BODY = readFileSync(join(here, 'fixtures', 'incident.sample.json'), 'utf8');
  globalThis.fetch = async () => ({ ok: true, text: async () => BODY });
  try {
    const result = await pollSource({ id: 'oneida', kind: 'json', url: 'http://stub.local/incident.sample.json' }, {});
    assert.equal(result.checksum, sha256hex(BODY));
    assert.ok(result.fetchedAt && !Number.isNaN(Date.parse(result.fetchedAt)));
    assert.ok(result.incidents.length > 0);
    for (const inc of result.incidents) {
      assert.equal(inc.tickChecksum, sha256hex(BODY));
      assert.equal(inc.fetchedAtIso, result.fetchedAt);
    }
  } finally {
    globalThis.fetch = realFetch;
  }
});

// Stub fetch: the feed GET returns the fixture table; Nominatim is never hit because we
// inject fetchQuery directly via opts.
test('pollSource drops cadinet rows whose geocode lands outside the source bbox', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => ({ ok: true, text: async () => CADINET_HTML });
  try {
    const source = {
      id: 'onondaga',
      kind: 'cadinet-html',
      url: 'http://stub.local/events.jsp',
      geocodeContext: 'Syracuse NY',
      bbox: { latMin: 42.85, latMax: 43.35, lngMin: -76.55, lngMax: -75.9 },
    };
    // First row resolves inside the box; every other row resolves far away (Boston).
    const fetchQuery = async (q) =>
      q.startsWith('DEERFIELD') ? [42.98, -76.0] : [42.36, -71.06];
    const result = await pollSource(source, { cache: new Map(), fetchQuery, pacingMs: 0 });

    assert.equal(result.incidents.length, 1);
    assert.deepEqual([result.incidents[0].lat, result.incidents[0].lng], [42.98, -76]);
    assert.equal(result.incidents[0].county, 'onondaga');
    assert.match(result.warnings.join('; '), /row\(s\) dropped: geocode outside onondaga bbox/);
  } finally {
    globalThis.fetch = realFetch;
  }
});
