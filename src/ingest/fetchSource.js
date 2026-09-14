import { config } from '../config.js';
import { parseFeedArray, parseHtmlFallback } from './parse.js';

// Minimal polite GET: sets an honest User-Agent and enforces a timeout via AbortController.
async function httpGetText(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), config.fetchTimeoutMs);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': config.userAgent, Accept: 'application/json' },
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchJsonFeed() {
  const text = await httpGetText(config.feedUrl);
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
  const text = await httpGetText(config.htmlFeedUrl);
  const rows = parseHtmlFallback(text);
  return { incidents: rows, source: 'html', skipped: 0 };
}

// One polling cycle. Primary = structured JSON feed. If that fails we degrade to the HTML
// fallback so we still capture points rather than losing the tick entirely.
// opts.checkHtml optionally cross-checks counts against the HTML feed (extra request).
export async function runPoll(opts = {}) {
  const warnings = [];
  try {
    const primary = await fetchJsonFeed();
    if (opts.checkHtml) {
      try {
        const htext = await httpGetText(config.htmlFeedUrl);
        const htmlCount = parseHtmlFallback(htext).length;
        const jsonCount = primary.incidents.length;
        if (Math.abs(htmlCount - jsonCount) > Math.max(2, jsonCount * 0.5)) {
          warnings.push(`json/html count mismatch: json=${jsonCount} html=${htmlCount}`);
        }
      } catch (e) {
        warnings.push(`html cross-check failed (ignored): ${e.message}`);
      }
    }
    return { ...primary, warnings };
  } catch (err) {
    warnings.push(`primary JSON feed failed (${err.message}); using HTML fallback`);
    const fallback = await fetchHtmlFallback();
    return { ...fallback, warnings };
  }
}
