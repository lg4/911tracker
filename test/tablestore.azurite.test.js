import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { TableServiceClient, AzureNamedKeyCredential } from '@azure/data-tables';
import {
  createTableClients,
  upsertIncidents,
  fetchRange,
  acquireLease,
  releaseLease,
  recordTickSuccess,
} from '../src/store/tableStore.js';

const here = path.dirname(fileURLToPath(import.meta.url));

// Real-SDK integration tests against the Azurite emulator over TLS (the SDK refuses
// plain-http endpoints; self-signed cert + relaxed validation is test-only).
const PORT = 11568;
const ACCOUNT = 'devstoreaccount1';
// Azurite's built-in dev-store account key (see EMULATOR_ACCOUNT_KEY in azurite constants).
const DEV_KEY = 'Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==';
const ENDPOINT = `https://127.0.0.1:${PORT}/${ACCOUNT}`;

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; // test-only: Azurite's self-signed cert

let child;
let dataDir;

async function waitForEndpoint(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(`${url}/?comp=list`, {
        agent: new (await import('node:https')).Agent({ rejectUnauthorized: false }),
      });
      if (res.status < 500) return;
    } catch {}
    if (Date.now() > deadline) throw new Error('azurite did not become ready');
    await new Promise((r) => setTimeout(r, 250));
  }
}

test.before(async () => {
  const { execSync } = await import('node:child_process');
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'azurite-'));
  execSync(
    `openssl req -x509 -newkey rsa:2048 -keyout ${dataDir}/key.pem -out ${dataDir}/cert.pem -days 1 -nodes -subj "/CN=localhost"`,
    { stdio: 'ignore' }
  );
  child = spawn(
    process.execPath,
    [
      path.join(here, '..', 'node_modules', 'azurite', 'dist', 'src', 'table', 'main.js'),
      `--tablePort=${PORT}`,
      `--location=${dataDir}`,
      `--cert=${dataDir}/cert.pem`,
      `--key=${dataDir}/key.pem`,
    ],
    { stdio: ['ignore', 'pipe', 'inherit'] }
  );
  await waitForEndpoint(ENDPOINT, 30_000);
});

test.after(() => {
  child?.kill();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

let cred;

async function ensureTables(base) {
  cred = new AzureNamedKeyCredential(ACCOUNT, DEV_KEY);
  const svc = new TableServiceClient(base, new AzureNamedKeyCredential(ACCOUNT, DEV_KEY));
  for (const name of ['incidents', 'statusHistory', 'meta']) {
    try {
      await svc.createTable(name);
    } catch (err) {
      if (err.statusCode !== 409) throw err;
    }
  }
}

test('real SDK round-trip: upsert idempotency + pollCount bump', async () => {
  await ensureTables(ENDPOINT);
  const clients = createTableClients(ENDPOINT, { credential: cred });
  const nowIso = new Date().toISOString();
  const inc = {
    dedupKey: 'ID:int-1',
    title: 'Integration test incident',
    type: 'TEST',
    status: 'In Progress',
    lat: 43.2,
    lng: -75.6,
    dateFirstIso: nowIso,
  };
  const first = await upsertIncidents(clients, [inc], nowIso);
  assert.equal(first.added, 1);
  const second = await upsertIncidents(clients, [{ ...inc }], new Date().toISOString());
  assert.equal(second.added, 0);

  const row = await clients.incidents.getEntity(inc.dateFirstIso.slice(0, 7), 'ID:int-1');
  assert.equal(Number(row.pollCount), 2);
  assert.ok(row.etag);
});

test('fetchRange returns GeoJSON over real table data', async () => {
  const clients = createTableClients(ENDPOINT, { credential: cred });
  const geojson = await fetchRange(clients, { since: new Date(Date.now() - 86400e3), until: new Date() });
  assert.equal(geojson.type, 'FeatureCollection');
  assert.equal(geojson.features.length, 1);
  assert.deepEqual(geojson.features[0].geometry.coordinates, [-75.6, 43.2]);
  assert.equal(geojson.features[0].properties.dedupKey, 'ID:int-1');
});

test('lease acquire/release is ETag-safe on the meta table', async () => {
  const clients = createTableClients(ENDPOINT, { credential: cred });
  const holder = await acquireLease(clients, 60_000);
  assert.ok(holder);
  const lockRow = await clients.meta.getEntity('meta', 'lock');
  assert.equal(lockRow.holder, holder);
  await releaseLease(clients, holder);
  assert.equal(await clients.meta.getEntity('meta', 'lock').catch(() => null), null);
});

test('recordTickSuccess writes last_poll to the meta table', async () => {
  const clients = createTableClients(ENDPOINT, { credential: cred });
  await recordTickSuccess(clients, { ts: new Date().toISOString(), source: 'json', fetched: 3, added: 1, skipped: 0, warnings: [] });
  const row = await clients.meta.getEntity('meta', 'last_poll');
  assert.equal(row.fetched, 3);
  assert.equal(row.source, 'json');
});
