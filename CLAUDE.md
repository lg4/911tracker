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
See [.tasks.md](.tasks.md) — all numbered tasks T8–T31 are DONE/closed inline. Shipped state:
- **Multi-county ingest (T11/T24):** three sources in `config.sources[]` — Oneida JSON feed, Onondaga CADInet HTML (Nominatim geocode with bbox-drop), TINC SY zone (`tinc-sy`, kind `tinc-html`; milepost-only rows store null coords). Incidents carry a county end-to-end; API exposes `?county=`. **Onondaga is removed from the map UI entirely (T24)** — its CADInet rows carry no street/area context so points aren't meaningful; ingest still stores them and `?county=onondaga` works for direct consumers, but the browser never renders those rows. Map opens centered on Utica (the original Oneida focus) and never re-frames.
- **Category filters (T8/T14/T29/T31):** Police/Fire/EMS/**Civil**/Other chips + per-category colored heat layers, time-window buttons, classification extracted into unit-tested `web/classify.js` (T31 widened the EMS numeric-code pattern — feed codes use a third-char alphabet of A/B/C/D/O, not just B/C/D). Remaining "Other" rows are uninterpretable CAD noise by design. Per-subtype detail views shipped (T17); recent-incident icons (T28) hand off to per-point category icons past zoom 12 (T30).
- **Basemap (T9/T10 done):** local vendored OSM tile pyramid z7–z14 plus CSS dark-mode variant of the same tiles (no second pyramid, keyless/offline); regenerate via `scripts/gen-tiles.js`. Uncovered margins outside the pyramid render per-theme — near-black in dark mode (clings to the dark tiles), pale blue-grey in light (`body.light` override).
- **Data validation (T12 done):** provenance/checksums (`prov:` audit rows, API `provenance` freshness block) so served data matches what was live at fetch time, plus the hourly backup mirror lane (see runbook "Durability").
- **Cloudflare CDN fronting** of the SWA origin — open, blocked-unattended: needs a human-owned domain/account/DNS zone, then proxy to the SWA origin (tiles are large and growing).
- **LRS→GRS storage redundancy flip** — open, cost-increasing; not taken without sign-off (runbook "Durability" documents the one-line change).
