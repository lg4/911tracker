/* One-click export of exactly what is on screen (window + county/category
   filters) for journalists and analysts. Rows come from the in-memory fetch.
   Loads as a plain script in the browser (exposes window.toCsv) and stays
   require()-loadable so test/csv.test.js can unit-test the serializer. */
(function (root) {
  function toCsv(geo) {
    const esc = (v) => `"${String(v ?? '').replaceAll('"', '""')}"`;
    const cols = ['county', 'type', 'title', 'lat', 'lng', 'lastSeenAt'];
    const rows = geo.features.map((f) => [
      f.properties.county, f.properties.type, f.properties.title,
      f.geometry.coordinates[1], f.geometry.coordinates[0], f.properties.lastSeenAt,
    ].map(esc).join(','));
    // T20: CRLF row joins — Excel/WPS only honor RFC-4180 in-field newlines when
    // the line endings are CRLF; bare LF made embedded newlines read as one row.
    return [cols.join(','), ...rows].join('\r\n');
  }
  root.toCsv = toCsv;
})(typeof globalThis !== 'undefined' ? globalThis : this);
