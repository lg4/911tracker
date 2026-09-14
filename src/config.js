import 'dotenv/config';

// All runtime behavior is driven by environment variables so the poller can be tuned
// without code changes (see .env.example for defaults and explanations).
export const config = {
  // Primary structured JSON feed and HTML fallback used only to cross-check counts.
  feedUrl: process.env.FEED_URL || 'https://oneidacountyny.gov/_incidents/incidents',
  htmlFeedUrl:
    process.env.HTML_FEED_URL ||
    'https://oneidacountyny.gov/_incidents/getAcitivityFeedList/',

  // Poll cadence in ms. Default 10 min -> ~144 req/day, negligible load on the county site.
  pollIntervalMs: Number(process.env.POLL_INTERVAL_MS || 600000),

  // Identify ourselves clearly; robots.txt disallows /_incidents so we stay minimal + honest.
  userAgent:
    process.env.USER_AGENT ||
    'oneida-911-mapper/1.0 (+self-hosted public dashboard)',

  // The county reports naive local wall-clock times; Oneida County NY is America/New_York.
  timezone: 'America/New_York',

  // Plausible bounding box for Oneida County. Records outside are treated as bad data.
  bbox: { latMin: 43.0, latMax: 43.5, lngMin: -75.9, lngMax: -75.0 },

  databaseUrl:
    process.env.DATABASE_URL ||
    'postgres://oneida:oneida@localhost:5432/oneida911',

  runIngest: (process.env.RUN_INGEST ?? 'true') !== 'false',

  // HTTP timeout per request.
  fetchTimeoutMs: Number(process.env.FETCH_TIMEOUT_MS || 30000),
};
