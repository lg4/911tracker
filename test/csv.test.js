import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
// web/csvExport.js attaches toCsv on globalThis as a plain browser script; load
// it the same way the browser does and grab the exported function.
new Function(readFileSync(join(here, '..', 'web', 'csvExport.js'), 'utf8'))({});
const toCsv = globalThis.toCsv;

const geo = {
  type: 'FeatureCollection',
  features: [
    {
      properties: { county: 'Oneida', type: 'Fire', title: 'Structure fire, 42 Main St', lat: 43.05, lng: -75.25, lastSeenAt: '2026-09-21T01:40:03Z' },
      geometry: { type: 'Point', coordinates: [-75.25, 43.05] },
    },
    {
      // In-field quotes AND an embedded newline — the RFC-4180 case Excel only
      // honors in-field newlines when the row joins are CRLF.
      properties: { county: 'Onondaga', type: 'EMS', title: 'Multi-alarm\n"roof collapse"', lat: 43.05, lng: -75.25, lastSeenAt: null },
      geometry: { type: 'Point', coordinates: [-75.25, 43.05] },
    },
  ],
};

test('toCsv writes the header row first, unquoted column names', () => {
  const out = toCsv(geo);
  assert.ok(out.startsWith('county,type,title,lat,lng,lastSeenAt\r\n'));
});

test('toCsv joins rows with CRLF so embedded newlines stay inside one quoted field', () => {
  const lines = toCsv(geo).split('\r\n');
  assert.equal(lines.length, 3); // header + 2 data rows despite the embedded \n in the title
  // Every field is quoted (uniform quoting keeps parsing simple); lat/lng come from coordinates.
  assert.equal(lines[1], '"Oneida","Fire","Structure fire, 42 Main St","43.05","-75.25","2026-09-21T01:40:03Z"');
  assert.equal(lines[2], `"Onondaga","EMS","Multi-alarm\n""roof collapse""","43.05","-75.25",""`);
});

test('toCsv doubles quotes inside fields (RFC-4180)', () => {
  assert.ok(toCsv(geo).includes('"Multi-alarm\n""roof collapse"""'));
});

test('toCsv nulls become empty quoted fields and lat/lng come from coordinates', () => {
  const [header, r1, r2] = toCsv(geo).split('\r\n');
  assert.equal(header, 'county,type,title,lat,lng,lastSeenAt');
  assert.ok(r1.endsWith(',"43.05","-75.25","2026-09-21T01:40:03Z"'));
  assert.ok(r2.endsWith(',"43.05","-75.25",""'));
});
