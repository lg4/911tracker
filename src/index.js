import { config } from './config.js';
import * as store from './ingest/store.js';
import { makePoller } from './ingest/poller.js';

async function main() {
  let pool;
  try {
    pool = store.createPool(config.databaseUrl);
    await store.initDb(pool);
    console.log('db ready');

    if (!config.runIngest) {
      console.log('RUN_INGEST=false -> idle. Use `npm run poll:once` for a single tick.');
      return; // keep process alive so the container stays up; close db on signal below
    }

    const poller = makePoller(pool);
    poller.start();

    const shutdown = async (sig) => {
      console.log(`received ${sig}, stopping`);
      await poller.stop();
      await pool.end();
      process.exit(0);
    };
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
  } catch (err) {
    console.error('fatal:', err.message || err);
    if (pool) await pool.end().catch(() => {});
    process.exit(1);
  }
}

main();
