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
See [.tasks.md](.tasks.md) for the full queue (T8–T12 + future items). Headlines:
- **Multi-county generic 911tracker** (T11): add Onondaga/Syracuse via `https://911events.ongov.net/CADInet/app/events.jsp`; parametrize feeds per county + tag incidents with county end-to-end. Existing map BOUNDS already cover Syracuse. TINC SY zone (`tincevents.thruway.ny.gov/tincview.aspx?zone=SY`) is a live third source (`tinc-sy`, kind `tinc-html`; milepost-only rows store null coords like Onondaga). **Onondaga was removed from the map UI entirely (T24)** — its CADInet rows carry no street/area context so points aren't meaningful; ingest still stores them and the API's `?county=onondaga` filter still works for direct consumers, but the browser never renders its rows and there is no county toggle/snap logic left. Map opens centered on Utica (the original Oneida focus) and never re-frames.
- **Category heat filters** (T8 done: Police/Fire/EMS/Other chips + per-category colored heat layers; time-window buttons; T14 expanded classification so most "Other" types now sort into Police/Fire/EMS). Future: richer category classification, per-subtype detail views.
- **Basemap** (T9 done z7–z14; T10 open): dark-mode variant (CARTO dark_matter keyless) alongside light or by default; regenerate via `scripts/gen-tiles.js`.
- **Data validation** (T12): ACID-like provenance/checksums so served data matches what was live at fetch time.
- **Cloudflare CDN fronting** of the SWA origin (tiles are large and growing).
