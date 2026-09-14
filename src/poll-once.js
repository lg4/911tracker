// One-shot ingestion tick: connect, ensure schema, do a single poll+upsert, exit.
// Intended for cron / systemd timers or manual runs (`npm run poll:once`). Each invocation
// is independent and idempotent, so it is more crash-resilient than a long-lived loop.
import { config } from './config.js';
import * as store from './ingest/store.js';
import { runOnce } from './ingest/poller.js';

async function main() {
  const pool = store.createPool(config.databaseUrl);
  try {
    await store.initDb(pool);
    await runOnce(pool, { checkHtml: true });
    process.exitCode = 0;
  } catch (err) {
    console.error(`poll:once failed: ${err.message}`);
    process.exitCode = 1;
  } finally {
    await pool.end().catch(() => {});
  }
}

main();
