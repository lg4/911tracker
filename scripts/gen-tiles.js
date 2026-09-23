#!/usr/bin/env node
// Regenerate the local basemap tile pyramid under web/tiles from free OSM
// standard tiles. Computes exactly the {z}/{x}/{y} tiles Leaflet requests to
// cover BOUNDS (web/index.html), so the on-disk rows line up with what
// fitBounds(BOUNDS) asks for. Idempotent: existing files are reused, stale
// files outside the computed set are removed.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '../web/tiles');
const TILE = (z, x, y) => `https://tile.openstreetmap.org/${z}/${x}/${y}.png`;
// Oneida County box — keep in sync with BOUNDS in web/index.html.
const SW = { lat: 42.8, lng: -76.6 };
const NE = { lat: 43.6, lng: -75.0 };
const ZMIN = 7;
const ZMAX = 15; // T33: full county through z14; z15 deepened ONLY around Utica + Rome (below).
// T33 selective z15: two small windows instead of the whole county — a single box would
// span nearly all of Oneida anyway (the towns sit ~80km apart), which defeats "only".
// Each window is a square of FOCUS_RADIUS tiles on each side of the town center (~15km
// across at z15, where one tile ≈ 0.9km); the rest of the county keeps its z14 ceiling.
const FOCUS_CENTERS = [
  { name: 'Utica', lat: 43.079, lng: -75.164 },
  { name: 'Rome', lat: 43.113, lng: -75.458 },
];
const FOCUS_RADIUS = 8;
function focusTiles(z) {
  const out = new Set();
  for (const c of FOCUS_CENTERS) {
    const t = tileXY(c.lat, c.lng, z);
    for (let x = t.x - FOCUS_RADIUS; x <= t.x + FOCUS_RADIUS; x++) {
      for (let y = t.y - FOCUS_RADIUS; y <= t.y + FOCUS_RADIUS; y++) {
        if (x >= 0 && y >= 0 && x < 2 ** z && y < 2 ** z) out.add(`${z}/${x}/${y}`);
      }
    }
  }
  return out;
}
// A little breathing room beyond the box edge so panning near it doesn't hit
// a gap before maxBoundsViscosity pulls back.
const PAD = 1;
const CONCURRENCY = 5;
const RETRIES = 3;
const UA = '911tracker-basemap/1.0 (one-off local tile cache; contact lg4 on github)';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function tileXY(latDeg, lngDeg, z) {
  const d = Math.pow(2, z);
  const x = Math.floor(((lngDeg + 180) / 360) * d);
  const latR = (latDeg * Math.PI) / 180;
  const mercY = Math.log(Math.tan(Math.PI / 4 + latR / 2));
  const y = Math.floor(((1 - mercY / Math.PI) / 2) * d);
  return { x, y };
}

async function fetchTile(url, file) {
  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      fs.writeFileSync(file, buf);
      return true;
    } catch (e) {
      if (attempt === RETRIES) {
        console.error(`FAIL ${path.relative(ROOT, file)}: ${e.message}`);
        return false;
      }
      await sleep(1500 * (attempt + 1)); // back off on rate-limit / transient errors
    }
  }
}

(async () => {
  const jobs = new Set();
  for (let z = ZMIN; z <= ZMAX; z++) {
    if (z >= 15) {
      // T33 selective deepening: only the Utica + Rome windows at this level.
      for (const k of focusTiles(z)) jobs.add(k);
      continue;
    }
    // Full county box through z14 — SW corner → min-x / max-y ; NE → max-x / min-y.
    const sw = tileXY(SW.lat, SW.lng, z);
    const ne = tileXY(NE.lat, NE.lng, z);
    // Pad in tile-index space so the box edge has breathing room on all sides.
    const xMin = Math.min(sw.x, ne.x) - PAD;
    const xMax = Math.max(sw.x, ne.x) + PAD;
    const yMin = Math.min(sw.y, ne.y) - PAD;
    const yMax = Math.max(sw.y, ne.y) + PAD;
    for (let x = xMin; x <= xMax; x++) {
      for (let y = yMin; y <= yMax; y++) {
        if (x >= 0 && y >= 0 && x < 2 ** z && y < 2 ** z) jobs.add(`${z}/${x}/${y}`);
      }
    }
  }
  const jobList = [...jobs];
  console.log(`${jobList.length} tiles to ensure (z${ZMIN}-z${ZMAX})`);

  let done = 0, ok = 0, reused = 0;
  const active = new Set();
  async function next() {
    while (done < jobList.length) {
      const [z, x, y] = jobList[done++].split('/');
      const rel = `${z}/${x}/${y}.png`;
      const file = path.join(ROOT, rel);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      if (fs.existsSync(file)) {
        reused++;
        continue; // reuse existing — idempotent
      }
      await fetchTile(TILE(z, x, y), file).then((r) => (ok += r ? 1 : 0));
    }
  }
  for (let i = 0; i < CONCURRENCY; i++) active.add(next());
  await Promise.all(active);
  console.log(`fetched ${ok}, reused ${reused}`);

  // Remove stale files outside the computed set so the pyramid matches BOUNDS.
  const keep = new Set([...jobs].map((k) => `${k}.png`));
  let removed = 0;
  for (const f of walkPngs(ROOT)) {
    const rel = path.relative(ROOT, f).split(path.sep).join('/');
    if (!keep.has(rel)) {
      fs.rmSync(f);
      removed++;
    }
  }
  console.log(`removed ${removed} stale tiles`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});

function* walkPngs(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walkPngs(p);
    else if (e.name.endsWith('.png')) yield p;
  }
}
