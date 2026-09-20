// Regenerate the self-contained basemap tile pyramid from free OSM standard tiles.
// Replaces the earlier CARTO-rendered pyramid whose images have "API KEY REQUIRED" baked in.
// BOUNDS match web/index.html: [[42.8,-76.6],[43.6,-75.0]], z7..z12.
import { mkdirSync } from 'node:fs';
import { writeFileSync } from 'node:fs';

const WEST = -76.6, EAST = -75.0, SOUTH = 42.8, NORTH = 43.6;
const ZMIN = 7, ZMAX = 12;
const OUT = new URL('../web/tiles/', import.meta.url); // trailing slash: resolves to the tiles/ dir itself
const UA = 'o911-centralny-basemap-regen/1.0 (one-off static cache; contact lou)';

// Canonical Web-Mercator -> integer tile coords (Leaflet convention).
const lonX = (lon, z) => ((lon + 180) / 360) * Math.pow(2, z);
const latY = (lat, z) => {
  const rad = (lat * Math.PI) / 180;
  const n = Math.pow(2, z);
  return (n / (2 * Math.PI)) * (Math.PI - Math.log((1 + Math.sin(rad)) / (1 - Math.sin(rad))));
};

function* tiles() {
  for (let z = ZMIN; z <= ZMAX; z++) {
    const x0 = Math.floor(lonX(WEST, z)), x1 = Math.floor(lonX(EAST, z));
    const y0 = Math.floor(latY(NORTH, z)), y1 = Math.floor(latY(SOUTH, z));
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) yield [z, x, y];
  }
}

async function fetchTile(z, x, y) {
  const url = `https://tile.openstreetmap.org/${z}/${x}/${y}.png`;
  const dir = new URL(`${z}/${x}/`, OUT);
  mkdirSync(dir, { recursive: true }); // creates web/tiles/{z}/{x}/
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) return { ok: false, status: res.status };
  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync(new URL(`${y}.png`, dir), buf);
  return { ok: true, bytes: buf.length };
}

const all = [...tiles()];
console.log(`total tiles to fetch: ${all.length}`);
const CONC = 6; let i = 0, done = 0, failed = [];
async function worker() {
  while (i < all.length) {
    const [z, x, y] = all[i++];
    try {
      const r = await fetchTile(z, x, y);
      if (!r.ok) failed.push(`${z}/${x}/${y}:HTTP${r.status}`);
      else done++;
    } catch (e) { failed.push(`${z}/${x}/${y}:${e.message}`); }
    // polite pacing
    await new Promise((r2) => setTimeout(r2, 40));
  }
}
await Promise.all(Array.from({ length: CONC }, worker));
console.log(`done=${done} failed=${failed.length}`);
if (failed.length) console.log('FAILED:\n' + failed.join('\n'));
