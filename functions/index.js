// Entry point for the Node v4 programming model (package.json "main").
// Importing each function module registers its trigger on the shared `app` object;
// there are no per-function default exports anymore.
import './incidents/index.js';
import './ingest/index.js';
