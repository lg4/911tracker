import 'dotenv/config';

// All runtime behavior is driven by environment variables so the poller can be tuned
// without code changes (see .env.example for defaults and explanations).
export const config = {
  // Poll cadence in ms. Default 10 min -> ~144 req/day per source, negligible load.
  pollIntervalMs: Number(process.env.POLL_INTERVAL_MS || 600000),

  // Identify ourselves clearly; robots.txt disallows /_incidents on oneida so we stay minimal + honest.
  userAgent:
    process.env.USER_AGENT ||
    'oneida-911-mapper/1.0 (+self-hosted public dashboard)',

  // The counties report naive local wall-clock times; both are America/New_York.
  timezone: 'America/New_York',

  // HTTP timeout per request.
  fetchTimeoutMs: Number(process.env.FETCH_TIMEOUT_MS || 30000),

  // One source object per county. `kind` picks the parser: 'json' uses the county's
  // structured feed (with an optional htmlUrl cross-check) while 'cadinet-html' parses
  // the Onondaga CAD portal rows and geocodes them. Env vars override the defaults of
  // the historical (Oneida) fields only.
  sources: [
    {
      id: 'oneida',
      name: 'Oneida County',
      kind: 'json',
      url: process.env.FEED_URL || 'https://oneidacountyny.gov/_incidents/incidents',
      htmlUrl:
        process.env.HTML_FEED_URL ||
        'https://oneidacountyny.gov/_incidents/getAcitivityFeedList/',
      // Plausible bounding box for Oneida County. Records outside are treated as bad data.
      bbox: { latMin: 43.0, latMax: 43.5, lngMin: -75.9, lngMax: -75.0 },
    },
    {
      id: 'onondaga',
      name: 'Onondaga County',
      kind: 'cadinet-html',
      url: process.env.ONONDAGA_FEED_URL || 'https://911events.ongov.net/CADInet/app/events.jsp',
      // Geographic context appended to Nominatim queries so bare street names resolve locally.
      geocodeContext: 'Syracuse NY',
      // Covers Syracuse metro + county seats; geocode results outside are dropped.
      bbox: { latMin: 42.85, latMax: 43.35, lngMin: -76.55, lngMax: -75.9 },
    },
    {
      id: 'tinc-sy',
      name: 'TINC SY Zone (I-480/I-90 through Syracuse)',
      kind: 'tinc-html',
      url: process.env.TINC_SY_FEED_URL || 'https://tincevents.thruway.ny.gov/tincview.aspx?zone=SY',
      // Milepost-only locations carry no coordinates; the box is informational only.
      bbox: { latMin: 42.85, latMax: 43.35, lngMin: -76.55, lngMax: -75.9 },
    },
  ],

  // Nominatim (keyless) is used to geocode CAD rows that carry no coordinates.
  nominatimUrl:
    process.env.NOMINATIM_URL || 'https://nominatim.openstreetmap.org/search',
};

// Legacy single-county fields kept so existing callers/tests keep working; they point at
// the Oneida source above.
export const configLegacy = {
  feedUrl: config.sources[0].url,
  htmlFeedUrl: config.sources[0].htmlUrl,
  bbox: config.sources[0].bbox,
  timezone: config.timezone,
};
