# CLAUDE.md — 911tracker (oneida-911-mapper)

Live Oneida County 911 incident map. Repo `lg4/911tracker`. Infra is Terraform-managed
(`infra/`, provider azurerm); architecture + table schema in [docs/phase2.md](docs/phase2.md),
deploy/failure-mode details in [docs/runbook.md](docs/runbook.md). Session handoff state lives in
[PLAN.md](PLAN.md).

## Layout
- `functions/incidents/index.js` — HTTP trigger `/api/incidents?since&until&type&status&limit`; returns GeoJSON FeatureCollection; explicit `JSON.stringify` + `Content-Type: application/json` (the v4/Kestrel host coerces object bodies via `.toString()`), CORS from `ALLOWED_ORIGIN`.
- `functions/ingest/index.js` — timer (`0 */10 * * * *`) polls the feed into Azure Table Storage with a lease guard.
- `src/store/tableStore.js`, `src/config.js` — tables access + env config.
- `web/` — Leaflet SPA (SWA deploy); `config.js` ships with the `REPLACE-WITH-FUNCTION-APP` placeholder, sed-substituted by CI at build time. Basemap is a local vendored OSM tile pyramid served from `/tiles/{z}/{x}/{y}.png` (no external tile API key needed).

## Working rules
No secrets exposure · one subagent/task at a time · ai-review before commit · per-task commits.

## Future improvements
- **Incident-type layer/filter for the heatmap**: add a UI control (layer toggles or filter chips) that lets users show/hide incident types on the heatmap. The API already supports `type=` on `/api/incidents` and each feature carries its type in properties, so this is mostly web-side: fetch once, then filter client-side; consider per-type color coding when filtering is active.
