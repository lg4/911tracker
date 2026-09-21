import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pollSource } from '../src/ingest/fetchSource.js';

const here = dirname(fileURLToPath(import.meta.url));
const CADINET_HTML = readFileSync(join(here, 'fixtures', 'cadinet.snippet.html'), 'utf8');

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
