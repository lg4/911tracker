import { config, configLegacy } from '../config.js';
import { parseFeedArray, parseHtmlFallback, parseCadinet, recordToIncident, inBbox } from './parse.js';

// Minimal polite GET: sets an honest User-Agent and enforces a timeout via AbortController.
async function httpGetText(url, accept = 'application/json') {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), config.fetchTimeoutMs);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': config.userAgent, Accept: accept },
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchJsonFeed() {
  const text = await httpGetText(configLegacy.feedUrl);
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new Error(`feed returned non-JSON body: ${e.message}`);
  }
  const { incidents, skipped } = parseFeedArray(data);
  return { incidents, source: 'json', skipped };
}

export async function fetchHtmlFallback() {
  const text = await httpGetText(configLegacy.htmlFeedUrl, 'text/html');
  const rows = parseHtmlFallback(text);
  return { incidents: rows, source: 'html', skipped: 0 };
}

// Nominatim geocode for the coordinate-less CADInet feed. Cache is a plain object so
// repeat ticks never re-hit the API for an already-resolved street; misses are left as
// null lat/lng and the incident is still stored (just un-mappable). Paced ~1 req/s per
// Nominatim's usage policy.
const geoCache = new Map(); // query -> [lat, lng] | null
let lastGeoAt = 0;
async function sleep(ms) {
  if (ms > 0) await new Promise((r) => setTimeout(r, ms));
}

export async function geocodeCadinet(incidents, opts = {}, ctx = {}) {
  const cache = opts.cache ?? geoCache;
  const doFetch = opts.fetchQuery ?? defaultGeocodeQuery;
  // Append the county's metro area so bare street names ("SPRING ST") don't resolve
  // to a same-named street somewhere else in the country.
  const suffix = ctx.geocodeContext ? ` ${ctx.geocodeContext}` : '';
  let missCount = 0;
  for (const inc of incidents) {
    if (inc.lat != null && inc.lng != null) continue;
    const base = inc.location ? String(inc.location).trim() : '';
    if (!base) continue;
    const query = base + suffix;
    if (cache.has(query)) {
      const hit = cache.get(query);
      if (hit) {
        inc.lat = hit[0];
        inc.lng = hit[1];
      }
      continue;
    }
    // Respect pacing only when we are about to actually hit the network.
    const wait = 1000 - (Date.now() - lastGeoAt);
    await sleep(opts.pacingMs == null ? wait : Math.max(0, opts.pacingMs));
    try {
      const result = await doFetch(query);
      cache.set(query, result);
      lastGeoAt = Date.now();
      if (result) {
        inc.lat = result[0];
        inc.lng = result[1];
        missCount += 1;
      }
    } catch (e) {
      cache.set(query, null); // don't hammer a failing endpoint every tick
      console.warn(`geocode failed for ${query}: ${e.message}`);
    }
  }
  return missCount;
}

async function defaultGeocodeQuery(query) {
  const url = `${config.nominatimUrl}?format=json&limit=1&q=${encodeURIComponent(query)}`;
  const res = await fetch(url, { headers: { 'User-Agent': config.userAgent } });
  if (!res.ok) throw new Error(`HTTP ${res.status} from Nominatim`);
  const data = await res.json();
  const first = Array.isArray(data) ? data[0] : null;
  return first && first.lat != null ? [Number(first.lat), Number(first.lon)] : null;
}

// Poll one source by its configured kind. Returns { incidents, source, skipped, warnings }.
export async function pollSource(source, opts = {}) {
  const warnings = [];
  try {
    let rows;
    let skipped = 0;
    if (source.kind === 'cadinet-html') {
      const text = await httpGetText(source.url, 'text/html');
      ({ incidents: rows, skipped } = parseCadinet(text));
      const geocoded = await geocodeCadinet(rows, opts, { geocodeContext: source.geocodeContext });
      // Drop geocode results that land outside this county's box (same-named streets elsewhere).
      const before = rows.length;
      rows = rows.filter((r) => r.lat == null || r.lng == null || inBbox(r.lat, r.lng, source.bbox));
      if (rows.length < before) warnings.push(`${before - rows.length} row(s) dropped: geocode outside ${source.id} bbox`);
      console.log(`${source.id}: parsed ${before}, kept ${rows.length}, geocoded ${geocoded} new streets`);
    } else {
      // Oneida primary feed: structured JSON with coordinates already attached.
      const text = await httpGetText(source.url);
      let data;
      try {
        data = JSON.parse(text);
      } catch (e) {
        throw new Error(`feed returned non-JSON body: ${e.message}`);
      }
      const parsed = parseFeedArray(data);
      rows = parsed.incidents.map((rec) => recordToIncident(rec, { bbox: source.bbox }));
    }
    return {
      incidents: rows.filter(Boolean).map((inc) => ({ ...inc, county: source.id })),
      source: source.id,
      skipped,
      warnings,
    };
  } catch (err) {
    warnings.push(`${source.kind === 'cadinet-html' ? 'CADInet' : 'primary'} feed failed (${err.message})`);
    if (source.htmlUrl && source.kind !== 'cadinet-html') {
      try {
        const htmlText = await httpGetText(source.htmlUrl, 'text/html');
        const rows = parseHtmlFallback(htmlText);
        return {
          incidents: rows.map((row) => ({ ...row, county: source.id })),
          source: `${source.id}/html`,
          skipped: 0,
          warnings,
        };
      } catch (fallbackErr) {
        warnings.push(`html fallback also failed (${fallbackErr.message}); no data this tick`);
      }
    }
    return { incidents: [], source: source.id, skipped: 0, warnings };
  }
}

// One polling cycle across every configured source; a single source failing never
// cancels the others.
export async function runPoll(opts = {}) {
  const allIncidents = [];
  const warnings = [];
  for (const source of config.sources) {
    const result = await pollSource(source, opts);
    allIncidents.push(...result.incidents);
    if (result.warnings.length) warnings.push(`${source.id}: ${result.warnings.join('; ')}`);
  }
  return { incidents: allIncidents, source: 'all', skipped: 0, warnings };
}
