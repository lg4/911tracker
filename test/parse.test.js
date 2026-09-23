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

import { parseCadinet } from '../src/ingest/parse.js';

const CADINET_HTML = readFileSync(join(here, 'fixtures', 'cadinet.snippet.html'), 'utf8');

test('parseCadinet parses all rows of the real Onondaga event table', () => {
  const { incidents, skipped } = parseCadinet(CADINET_HTML);
  assert.equal(skipped, 0);
  // The fixture table has 10 data rows; every one carries address + time fields.
  assert.ok(incidents.length >= 9, `expected ~10 incidents, got ${incidents.length}`);
});

test('parseCadinet maps first row fields (agency, type, street, cross, wall-clock→UTC)', () => {
  const { incidents } = parseCadinet(CADINET_HTML);
  const [first] = incidents;
  assert.deepEqual(first.departments, ['Dewitt Fire Department']);
  assert.equal(first.type, 'ALARM');
  assert.equal(first.title, 'DEERFIELD RD x FRANKLIN PARK DR & SAGINAW DR');
  assert.equal(first.status, 'Active');
  assert.equal(first.lat, null); // no coordinates in this feed — geocoding step fills them
  assert.equal(first.lng, null);
  // "09/20/26 23:32" America/New_York EDT → 03:32 UTC next day
  assert.equal(first.dateFirstIso, '2026-09-21T03:32:00.000Z');
  assert.equal(first.dedupKey, 'TITLE:09-21T03:32:deerfieldrd'); // minute-slice + street slug
});

test('parseCadinet dedup keys are stable across re-scrapes of the same table', () => {
  const a = parseCadinet(CADINET_HTML).incidents.map((i) => i.dedupKey);
  const b = parseCadinet(CADINET_HTML.replace(/\s+/g, ' ')).incidents.map((i) => i.dedupKey);
  assert.deepEqual(a, b);
});

test('parseCadinet tolerates malformed / empty input without throwing', () => {
  assert.deepEqual(parseCadinet('').incidents, []);
  assert.deepEqual(parseCadinet(null), { incidents: [], skipped: 0 });
  const rowsOnly = `<!DOCTYPE html><html><body>
    <table class="dataTableEx"><thead><tr><td colspan="6">headers</td></tr></thead>
      <tbody>
        <tr><td>x</td><td>y</td></tr><!-- too few cells → ignored, not counted -->
        <tr>${'<td></td>'.repeat(7)}</tr><!-- zero fields → skipped -->
      </tbody>
    </table></body></html>`;
  const { incidents, skipped } = parseCadinet(rowsOnly);
  assert.equal(incidents.length, 0);
  assert.equal(skipped, 1);
});

// ---- TINC SY-zone feed (TINC events page, plain-GET HTML table) -------------------------
import { parseTinc, tincTimeToIso } from '../src/ingest/parse.js';
import { DateTime } from 'luxon';

const TINC_HTML = readFileSync(join(here, 'fixtures', 'tinc.snippet.html'), 'utf8');
const TINC_REF = DateTime.fromObject({ month: 9, day: 23, year: 2026, hour: 4, minute: 27, second: 40 }, { zone: 'America/New_York' });

test('parseTinc parses every row of the live fixture', () => {
  const { incidents, skipped } = parseTinc(TINC_HTML);
  assert.equal(incidents.length, 10);
  assert.equal(skipped, 0);
});

test('parseTinc maps fields and infers year-less times against the as-of footer (EDT)', () => {
  const [first] = parseTinc(TINC_HTML).incidents;
  assert.equal(first.callNumber, '0449');
  assert.equal(first.type, 'LANE CLOSURE');
  assert.match(first.location, /^MP 343\.00 TO 346\.0 I-90 West$/);
  assert.equal(first.lat, null); // milepost-only locations are not geocodable
  // "9/22 08:16 PM" America/New_York EDT → 00:16 UTC next day. Year comes from the footer's 9/23/2026.
  assert.equal(first.dateFirstIso, '2026-09-23T00:16:00.000Z');
  assert.equal(first.dedupKey, 'TINC:0449'); // zero-padded call number is stable across re-scrapes
  assert.equal(first.status, 'Active');
});

test('tincTimeToIso attributes rows after the as-of moment to the prior year', () => {
  // Fixture row "10/07 01:55 PM" sits AFTER the as-of instant (Sep 23) → prior calendar year;
  // Oct 7, 2025 is still daylight time (DST ends Nov 2) so 1:55 PM EDT → 17:55 UTC.
  const iso = tincTimeToIso(10, 7, 1, 55, 'PM', TINC_REF);
  assert.equal(iso, '2025-10-07T17:55:00.000Z');
  // A row dated before the as-of instant stays in its own year.
  assert.equal(tincTimeToIso(8, 12, 21, 31, 'PM', TINC_REF), '2026-08-13T01:31:00.000Z');
});

test('parseTinc dedup keys are stable across whitespace-normalized re-scrapes', () => {
  const a = parseTinc(TINC_HTML).incidents.map((i) => i.dedupKey);
  const b = parseTinc(TINC_HTML.replace(/\s+/g, ' ')).incidents.map((i) => i.dedupKey);
  assert.deepEqual(a, b);
});

test('parseTinc tolerates malformed / empty input without throwing', () => {
  assert.deepEqual(parseTinc('').incidents, []);
  assert.deepEqual(parseTinc(null), { incidents: [], skipped: 0 });
  // No footer → falls back to current-year inference; rows with no date at all are skipped.
  const noFooter = `<table><tbody>
    <tr><td></td><td></td><td></td><td></td></tr><!-- zero fields → skipped -->
    <tr><td>0777</td><td>nonsense time</td><td>Lane Closure</td><td>MP 99 I-480 West</td></tr>
  </tbody></table>`;
  const { incidents, skipped } = parseTinc(noFooter);
  assert.equal(skipped, 1);
  assert.equal(incidents.length, 1);
  assert.equal(incidents[0].callNumber, '0777');
  assert.equal(incidents[0].dedupKey, 'TINC:0777'); // call number wins over the timestamp-fallback key
  assert.equal(incidents[0].dateFirstIso, null);
});
