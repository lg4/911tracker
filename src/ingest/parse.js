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

export function inBbox(lat, lng, bbox) {
  const b = bbox ?? config.sources[0].bbox;
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
// missing an identity or have coordinates outside the given county's bbox (defaults to
// the historical Oneida box). `county` tags the row so multi-county data stays separable.
export function recordToIncident(record, opts = {}) {
  if (!record || typeof record !== 'object') return null;

  const lat = numOrNull(record.Lat);
  const lng = numOrNull(record.Lng);
  if (lat == null || lng == null || !inBbox(lat, lng, opts.bbox)) return null;

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

// Parse one raw record shaped like a CAD portal row (Onondaga's "all active events" page):
// no coordinates, no stable ID — identity comes from date + street. Fields map onto the
// same incident shape; lat/lng stay null until the geocoding step fills them. Returns
// null when the row has neither a usable time nor address.
export function cadinetRowToIncident(row, opts = {}) {
  if (!row || typeof row !== 'object') return null;
  const street = [row.streetPre, row.streetName, row.streetType].filter(Boolean).join(' ').trim();
  const cross = [row.cross1, row.cross2].filter(Boolean).join(' & ').trim() || null;
  const title = [street, cross ? `x ${cross}` : null, row.compliment]
    .filter(Boolean)
    .join(' ')
    .trim() || null;
  if (!title && !row.timeIso) return null;

  // No per-incident ID in this feed: dedup on wall-clock minute + normalized street so a
  // re-scrape of the same event maps to the same rowKey across ticks.
  const slug = street.toLowerCase().replace(/[^a-z0-9]+/g, '');
  const key = `${(row.timeIso ?? '').slice(5, 16)}:${slug || (title ? title.toLowerCase() : '')}`;

  return {
    dedupKey: title ? `TITLE:${key}` : `CAD:${key}`,
    sourceId: null,
    title,
    type: row.type ? String(row.type).toUpperCase() : null,
    status: 'Active', // the portal only lists active events; closed ones disappear
    departments: row.agency ? [row.agency.trim()] : [],
    location: title,
    lat: null,
    lng: null,
    icon: null,
    callNumber: null,
    dateFirstIso: row.timeIso,
    createdAtIso: row.timeIso,
    lastEditedAtIso: null,
    raw: row.raw ?? null,
  };
}

// Parse the Onondaga CAD "all active events" table (IBM JSF markup, ISO-8859-1). Rows are
// keyed off span id patterns so they survive cosmetic CSS drift; malformed rows are
// counted as skipped, never thrown. Times are MM/DD/YY HH:MM America/New_York wall clock.
export function parseCadinet(html) {
  const $ = cheerio.load(String(html));
  let skipped = 0;
  const incidents = [];
  $('table.dataTableEx tbody tr').each((_, trEl) => {
    const $tr = $(trEl);
    const cells = $tr.find('td');
    if (cells.length < 6) return; // header/foot rows have fewer columns
    const textOf = (idSuffix) =>
      $tr.find(`span[id*="${idSuffix.replace(/:/g, '')}"]`).map((_, s) => $(s).text()).get().join('').trim() || null;
    const timeMatch = String(textOf('mmdd') ?? '').match(/^(\d{2})\/(\d{2})\/(\d{2})\s+(\d{2}):(\d{2})$/);
    const timeIso = timeMatch
      ? normalizeTimestamp(`20${timeMatch[3]}-${timeMatch[1]}-${timeMatch[2]} ${timeMatch[4]}:${timeMatch[5]}:00`)
      : null;
    const row = cadinetRowToIncident({
      agency: textOf(':text7'),
      timeIso,
      type: textOf('typ_desc'),
      streetPre: textOf('edirpre'),
      streetName: textOf('efeanme'),
      streetType: textOf('efeatyp'),
      compliment: textOf('ecompl'),
      cross1: textOf('xstreet1'),
      cross2: textOf('xstreet2'),
      raw: $tr.text().replace(/\s+/g, ' ').trim(),
    });
    if (row) incidents.push(row);
    else skipped += 1;
  });
  return { incidents, skipped };
}

// Resolve a year-less "M/D hh:mm AM|PM" cell against the page's year-bearing "as of ... M/D/YYYY"
// footer. Rows are assumed to sit in the footer's calendar year; one that lands AFTER the as-of
// moment is attributed to the prior year (the zone keeps a rolling list that spans New Year's).
// With no footer we fall back to the current year. Returns ISO UTC or null on unparseable input.
export function tincTimeToIso(m, d, h, min, meridiem, refDateTime) {
  const base = refDateTime ?? DateTime.now().setZone(config.timezone);
  // Luxon's fromObject takes no meridiem unit; fold AM/PM into a 24-hour clock value.
  const hour24 = h % 12 + (String(meridiem).toUpperCase() === 'PM' ? 12 : 0);
  let dt = DateTime.fromObject(
    { month: m, day: d, hour: hour24, minute: min, year: base.year },
    { zone: config.timezone }
  );
  if (dt > base) dt = dt.minus({ years: 1 });
  return dt.isValid ? dt.toUTC().toISO() : null;
}

// Parse the TINC SY-zone event table (plain-GET HTML, no postback). Columns per row:
// Call# | M/D hh:mm AM|PM (no year) | Call Type | MP milepost. Locations are mileposts only —
// not geocodable — so rows carry null lat/lng and follow the Onondaga precedent (stored + API-
// filterable via ?county=, never rendered in the browser). Dedup keys off the zero-padded call
// number so a re-scrape of the same event maps to the same rowKey across ticks. Malformed rows
// are counted as skipped, never thrown.
export function parseTinc(html) {
  const $ = cheerio.load(String(html));
  // Footer: "... Incidents, as of 4:27:40 AM EST 9/23/2026" supplies the reference datetime.
  const asOfMatch = String($.root().text()).match(
    /as of\s+[\d:]+\s+(?:AM|PM)\b[^0-9]*(\d{1,2})\/(\d{1,2})\/(\d{4})/i
  );
  const refDateTime = asOfMatch
    ? DateTime.fromObject(
        { month: +asOfMatch[1], day: +asOfMatch[2], year: +asOfMatch[3] },
        { zone: config.timezone }
      )
    : null;

  let skipped = 0;
  const incidents = [];
  $('table tbody tr').each((_, trEl) => {
    const cells = $(trEl).find('td');
    if (cells.length < 4) return; // header/foot rows have fewer columns
    const callNumber = cells.eq(0).text().trim() || null;
    const typeText = cells.eq(2).text().replace(/\s+/g, ' ').trim().toUpperCase() || null;
    const location = cells.eq(3).text().replace(/\s+/g, ' ').trim() || null;
    const t = String(cells.eq(1).text()).match(/(\d{1,2})\/(\d{1,2})\s+(\d{1,2}):(\d{2})\s*(AM|PM)/i);
    const dateFirstIso = t
      ? tincTimeToIso(+t[1], +t[2], +t[3], +t[4], t[5].toUpperCase(), refDateTime)
      : null;
    if (!callNumber && !dateFirstIso) {
      skipped += 1;
      return;
    }
    incidents.push({
      dedupKey: callNumber ? `TINC:${callNumber}` : `TINC-TS:${(dateFirstIso ?? '').slice(5, 16)}:${typeText ?? ''}`,
      sourceId: null,
      title: [typeText, location].filter(Boolean).join(' — ') || null,
      type: typeText,
      status: 'Active', // the zone page only lists active events; closed ones disappear
      departments: [],
      location,
      lat: null,
      lng: null,
      icon: null,
      callNumber,
      dateFirstIso,
      createdAtIso: dateFirstIso,
      lastEditedAtIso: null,
      raw: String($(trEl).text()).replace(/\s+/g, ' ').trim() || null,
    });
  });
  return { incidents, skipped };
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
