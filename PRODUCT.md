# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Primary users, equally weighted:

- **Local residents** of/near Oneida County (Utica, NY) who open the map on a phone to see current police/fire/EMS activity near them. Job: "what's happening around me right now?" — checked quickly, in passing, often mobile.
- **Journalists & researchers** tracking 911 call volume and patterns over time. Job: filter by type/time/county and understand trends across weeks or months.

## Product Purpose

A live public map of 911 incidents for Oneida County, New York, fed from the county's CADInet feed (~every 10 minutes). It exists because this data lives behind an obscure government page with no usable interface. Success: a trustworthy at-a-glance view — open it, see current incidents near you within seconds; freshness and position accuracy matter most. The history views exist so the same store serves trend analysis without a separate product.

Roadmap: multi-county generic 911tracker (Onondaga/Syracuse next, then TINC SY zone as another source), so "Oneida" becomes one instance of a repeatable pattern.

## Positioning

The mechanism no neighboring product can truthfully copy: direct ingestion of the county's own CADInet event feed into queryable GeoJSON, refreshed ~every 10 minutes, with every incident traceable to its original record (dedup keys, raw payloads, first-seen timestamps). Commercial 911 trackers scrape third-party aggregators; this is the primary source, mirrored publicly.

## Operating Context

- Runs on free-tier Azure: Static Web App (`web/` Leaflet SPA) + Node.js v4 Functions (`functions/incidents` HTTP API, `functions/ingest` timer) + Table Storage. No always-running infrastructure.
- Map calls the function's public URL directly; CORS pinned to the SWA domain.
- Basemap is a locally vendored OSM tile pyramid (`/tiles/{z}/{x}/{y}.png`, z7–z14) — works offline of any external tile API key; that is a real feature for a low-budget project.
- Deploy is Terraform-managed (`infra/`, azurerm provider); ops detail in docs/runbook.md.
- Data volume is tiny (tens of rows/day); months roll off by partition key naturally.

## Capabilities and Constraints

Confirmed functionality:

- Live incident points + per-category heat layers (Police/Fire/EMS/Other chips), time-window buttons, category classification tuned so most "Other" types sort into Police/Fire/EMS.
- Onondaga County ingests but ships **hidden from the map by default** (T15): its CADInet rows carry no street/area context so points aren't meaningful; a toggle brings them back.
- Map opens centered on Utica at zoom 9 (the original Oneida focus).
- `GET /api/incidents?since&until&type&status&limit` returns GeoJSON FeatureCollection.

Constraints:

- Free-tier budget — no paid services; everything must stay near $0/month.
- No secrets in the repo; function keys/env only via Azure config.
- Onondaga data lacks location context end-to-end until the feed itself improves.
- T8–T12 task queue (category refinement, dark basemap, data provenance/checksums, Cloudflare CDN fronting) lives in .tasks.md.

Terminology: incidents are deduped by `ID:<sourceId>` or `TITLE:<title>` row key; partitioned by YYYY-MM of first sighting; month rollover duplicates entities rather than moving them.

## Evidence on Hand

- Real live county feed (Oneida CADInet) and real stored incident history in Table Storage — no fabricated data anywhere.
- docs/phase2.md (architecture + table schema), docs/runbook.md (deploy/failure modes), PLAN.md (session handoff state), .tasks.md (full task queue).
- Absences future work must not fabricate: no testimonials, no user counts, no "trusted by" claims, no press coverage. The only proof is that it works against the primary source.

## Product Principles

1. **Primary source over aggregation** — always ingest from the county's own feed; never degrade to third-party mirrors.
2. **Freshness is the product** — a stale map is a broken product; 10-minute cadence and visible last-updated state matter more than polish.
3. **Zero-budget durability** — every feature decision runs through "does this stay free-tier?" before aesthetics.
4. **Provenance over presentation** — served data must be traceable to what was live at fetch time (checksums/provenance is queued, T12); never present derived data as raw.
5. **One pattern, many counties** — build toward generic per-county parametrization, not Oneida-specific hacks.
