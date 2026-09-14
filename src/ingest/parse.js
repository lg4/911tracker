import { DateTime } from 'luxon';
import * as cheerio from 'cheerio';
import { config } from '../config.js';

const TS_FORMAT = 'yyyy-MM-dd HH:mm:ss';

// Convert the county's naive America/New_York wall-clock string ("2026-09-14 09:52:41")
// into ISO-8601 UTC. Luxon handles DST automatically (EDT/EST) via the IANA zone.
export function normalizeTimestamp(value) {
  if (typeof value !== 'string' || value.length === 0) return null;
  const dt = DateTime.fromFormat(value.trim(), TS_FORMAT, {
    zone: config.timezone,
  });
  if (!dt.isValid) return null;
  return dt.toUTC().toISO(); // e.g. "2026-09-14T13:52:41.000Z"
}

export function numOrNull(value) {
  const n = typeof value === 'number' ? value : parseFloat(value);
  return Number.isFinite(n) ? n : null;
}

export function inBbox(lat, lng) {
  const b = config.bbox;
  return lat >= b.latMin && lat <= b.latMax && lng >= b.lngMin && lng <= b.lngMax;
}

// Split a comma-separated department list into clean tokens.
export function splitDepartments(value) {
  if (typeof value !== 'string') return [];
  return value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

// Map one raw county record to a normalized incident. Returns null for records that are
// missing an identity or have coordinates outside the plausible Oneida County box.
export function recordToIncident(record) {
  if (!record || typeof record !== 'object') return null;

  const lat = numOrNull(record.Lat);
  const lng = numOrNull(record.Lng);
  if (lat == null || lng == null || !inBbox(lat, lng)) return null;

  const sourceId =
    record.ID != null && !Number.isNaN(Number(record.ID))
      ? Number(record.ID)
      : null;
  const title = typeof record.Title === 'string' ? record.Title : null;
  if (sourceId == null && title == null) return null;

  return {
    dedupKey: sourceId != null ? `ID:${sourceId}` : `TITLE:${title}`,
    sourceId,
    title,
    type: typeof record.Type === 'string' ? record.Type : null,
    status: typeof record.Status === 'string' ? record.Status : null,
    departments: splitDepartments(record.Departments),
    location:
      typeof record.Location === 'string'
        ? record.Location
        : typeof record.LocationWithoutStreetNum === 'string'
          ? record.LocationWithoutStreetNum
          : null,
    lat,
    lng,
    icon: typeof record.Icon === 'string' ? record.Icon : null,
    callNumber:
      typeof record.CallNumber === 'string' ? record.CallNumber : null,
    dateFirstIso: normalizeTimestamp(record.Date),
    createdAtIso: normalizeTimestamp(record.Created),
    lastEditedAtIso: normalizeTimestamp(record.LastEdited),
    // Keep the original record so we can re-derive fields later if parsing changes.
    raw: record,
  };
}

// Parse the JSON feed body into valid incidents. Accepts a bare array or an object with
// an `incidents` array. Bad records are counted as skipped, never thrown.
export function parseFeedArray(json) {
  const arr = Array.isArray(json)
    ? json
    : json && Array.isArray(json.incidents)
      ? json.incidents
      : [];
  let skipped = 0;
  const incidents = [];
  for (const r of arr) {
    const inc = recordToIncident(r);
    if (inc) incidents.push(inc);
    else skipped += 1;
  }
  return { incidents, skipped };
}

// Minimal extraction from the HTML fallback feed, used only to cross-check that the two
// sources agree on roughly how many active incidents there are. Keyed off the .viewOnMap
// anchors (the page is not reliably wrapped in <table>/<tr>), with duplicate mobile/desktop
// anchors collapsed by coordinates. Best-effort: markup drift yields fewer rows, never a crash.
export function parseHtmlFallback(html) {
  try {
    const $ = cheerio.load(String(html));
    const seen = new Set();
    const out = [];
    $('a.viewOnMap[data-lat][data-lng]').each((_, el) => {
      const a = $(el);
      const lat = numOrNull(a.attr('data-lat'));
      const lng = numOrNull(a.attr('data-lng'));
      if (lat == null || lng == null || !inBbox(lat, lng)) return;
      const key = `${lat.toFixed(6)},${lng.toFixed(6)}`;
      if (seen.has(key)) return; // collapse the paired mobile + desktop anchors
      seen.add(key);
      let title = null;
      const row = a.closest('tr');
      if (row.length) {
        title = row.find('td').first().find('div').first().text().trim() || null;
      }
      out.push({ dedupKey: title ? `TITLE:${title}` : `HTML:${key}`, title, lat, lng });
    });
    return out;
  } catch {
    return [];
  }
}
