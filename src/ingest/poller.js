import { config } from '../config.js';
import { runPoll } from './fetchSource.js';
import * as store from './store.js';

// One complete polling cycle: fetch the feed, upsert into Postgres, log a JSON summary line.
export async function runOnce(pool, opts = {}) {
  const nowIso = new Date().toISOString();
  const checkHtml = opts.checkHtml ?? false;
  const { incidents, source, skipped, warnings } = await runPoll({ checkHtml });
  const r = incidents.length ? await store.upsertIncidents(pool, incidents, nowIso) : null;
  const summary = {
    ts: new Date().toISOString(),
    source,
    fetched: incidents.length,
    added: r?.added ?? 0,
    upserted: r?.upserted ?? 0,
    skipped,
    warnings,
  };
  if (!opts.quiet) console.log(JSON.stringify(summary));
  return summary;
}

// Self-rescheduling poller with a single-flight guarantee (the next tick is only scheduled
// after the previous one finishes), exponential backoff on repeated failures, and a little
// jitter so we never hammer the county site at perfectly regular intervals.
export function makePoller(pool) {
  let timer = null;
  let stopped = false;
  let errors = 0;
  let tickCount = 0;
  const crossCheckEvery = Math.max(1, Number(process.env.CROSS_CHECK_EVERY || 6));

  async function tick() {
    if (stopped) return;
    try {
      await runOnce(pool, { checkHtml: tickCount % crossCheckEvery === 0 });
      errors = 0;
    } catch (err) {
      errors += 1;
      console.error(`poll error #${errors}: ${err.message}`);
    } finally {
      tickCount += 1;
      if (!stopped) scheduleNext();
    }
  }

  function delayFor() {
    const base = config.pollIntervalMs;
    if (errors > 0) {
      const backoff = Math.min(base * 2 ** Math.min(errors, 5), 3_600_000);
      return backoff + Math.floor(Math.random() * (base / 2 || 1));
    }
    return base + Math.floor(Math.random() * ((base * 0.1) || 1));
  }

  function scheduleNext() {
    timer = setTimeout(tick, delayFor());
  }

  return {
    start() {
      tick(); // run once immediately, then chain via setTimeout
    },
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
