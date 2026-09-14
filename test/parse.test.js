import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  normalizeTimestamp,
  recordToIncident,
  parseFeedArray,
  parseHtmlFallback,
  splitDepartments,
} from '../src/ingest/parse.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  readFileSync(join(here, 'fixtures', 'incident.sample.json'), 'utf8')
);

test('normalizeTimestamp converts Eastern wall-clock to UTC (EDT in summer)', () => {
  assert.equal(normalizeTimestamp('2026-09-14 09:52:41'), '2026-09-14T13:52:41.000Z');
});

test('normalizeTimestamp handles EST in winter (DST-aware via IANA zone)', () => {
  assert.equal(normalizeTimestamp('2026-01-15 08:00:00'), '2026-01-15T13:00:00.000Z');
});

test('normalizeTimestamp rejects invalid / missing values', () => {
  assert.equal(normalizeTimestamp('not-a-date'), null);
  assert.equal(normalizeTimestamp(null), null);
  assert.equal(normalizeTimestamp(''), null);
});

test('splitDepartments trims tokens and drops empties', () => {
  assert.deepEqual(splitDepartments('A Dept, B Dept ,C'), ['A Dept', 'B Dept', 'C']);
  assert.deepEqual(splitDepartments(null), []);
  assert.deepEqual(splitDepartments('   '), []);
});

test('recordToIncident maps fields and dedup key from numeric ID', () => {
  const inc = recordToIncident(fixture[0]);
  assert.ok(inc);
  assert.equal(inc.dedupKey, 'ID:700079');
  assert.equal(inc.sourceId, 700079);
  assert.equal(inc.title, '2026-00005096');
  assert.equal(inc.type, 'MVA-PD');
  assert.equal(inc.status, 'In Progress');
  assert.equal(inc.icon, 'police');
  assert.equal(inc.callNumber, '993');
  assert.deepEqual(inc.departments, [
    'Utica Police Department',
    'Oneida County Emergency Services',
  ]);
  assert.equal(typeof inc.lat, 'number');
  assert.equal(typeof inc.lng, 'number');
  assert.equal(inc.dateFirstIso, '2026-09-14T13:49:14.000Z');
});

test('recordToIncident rejects coordinates outside the county bounding box', () => {
  assert.equal(recordToIncident(fixture[2]), null); // lat 44.99 out of range
});

test('recordToIncident rejects records with no usable coordinates or identity', () => {
  assert.equal(recordToIncident(fixture[3]), null); // missing Lat/Lng
  assert.equal(recordToIncident({}), null);
});

test('parseFeedArray keeps valid incidents and counts skipped ones', () => {
  const { incidents, skipped } = parseFeedArray(fixture);
  assert.equal(incidents.length, 2);
  assert.equal(skipped, 2);
  assert.deepEqual(
    incidents.map((i) => i.dedupKey).sort(),
    ['ID:700001', 'ID:700079']
  );
});

test('parseFeedArray tolerates non-array payloads', () => {
  const { incidents, skipped } = parseFeedArray({ foo: 1 });
  assert.equal(incidents.length, 0);
  assert.equal(skipped, 0);
});

const FALLBACK_HTML = `
<tr><td><div>100-0001</div></td>
  <a class="viewOnMap" data-lat="43.1" data-lng="-75.3">m</a>
  <a class="viewOnMap" data-lat="43.1" data-lng="-75.3">d</a></tr>
<tr><td><div>100-0002</div></td>
  <a class="viewOnMap" data-lat="43.4" data-lng="-75.4">m</a>
  <a class="viewOnMap" data-lat="43.4" data-lng="-75.4">d</a></tr>
<a class="viewOnMap" data-lat="44.9" data-lng="-75.3">out-of-bbox</a>`;

test('parseHtmlFallback dedupes paired anchors and ignores out-of-bbox points', () => {
  const rows = parseHtmlFallback(FALLBACK_HTML);
  assert.equal(rows.length, 2); // mobile+desktop pairs collapsed to unique coords
  assert.deepEqual(
    rows.map((r) => [r.lat, r.lng]).sort(),
    [
      [43.1, -75.3],
      [43.4, -75.4],
    ]
  );
  assert.ok(rows.every((r) => typeof r.dedupKey === 'string' && r.dedupKey.length > 0));
});

test('parseHtmlFallback is defensive on empty or non-HTML input', () => {
  assert.deepEqual(parseHtmlFallback(''), []);
  assert.deepEqual(parseHtmlFallback(null), []);
});
