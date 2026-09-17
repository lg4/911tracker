# Phase 2: Azure deployment — Static Web App + Functions + Table Storage

Goal: host the heatmap map on free-tier Azure with no always-running infrastructure,
replacing the self-hosted Postgres store from Phase 1.

## Architecture

```
county feed ──(timer fn, ~10 min)──▶ Azure Table Storage ◀──(query)── HTTP function
                                                          │  GeoJSON via its public URL
static map UI (Leaflet + heat layer) on SWA Free ◀───────┘
```

- **Static Web App** (Free plan): serves `web/` static files only. No linked API needed.
- **Azure Functions app** (Consumption, free tier; Node.js isolated worker, v4 runtime):
  - `ingest` — timer trigger (~every 10 min, jitter in code), reuses Phase 1
    `fetchSource.js` + `parse.js`, writes entities to Table Storage; acquires the
    single-instance lease first (see Concurrency & safety).
  - `incidents` — HTTP GET, returns a GeoJSON FeatureCollection. The map calls this
    function's own URL directly (`https://<func>.azurewebsites.net/api/incidents?...`);
    CORS header set to the SWA domain. No SWA Standard / managed-functions integration.
- **Table Storage** (storage account, pay-as-you-go): two tables, see schema below.
  Volume is tiny (tens of rows/day) → effectively $0/month.

All three resources have free tiers that cover this workload: SWA Free, Consumption
functions free grant (1M executions/mo), and table storage at cents/month scale.

## Table schema

### `incidents`

| Column | Value | Notes |
|---|---|---|
| `partitionKey` | `YYYY-MM` of `dateFirst` | heatmap queries hit one partition per month; months roll off naturally |
| `rowKey` | dedup key from Phase 1 (`ID:<sourceId>` or `TITLE:<title>`) | no `/ \ # ?` chars — safe |
| `sourceId` | number | nullable |
| `title`, `type`, `status`, `location`, `icon`, `callNumber` | string | nullable fields omitted when null |
| `departments` | JSON array string | flat property (no native arrays in tables) |
| `lat`, `lng` | number | validated against the county bbox by `parse.js` |
| `dateFirst`, `createdAt`, `lastEditedAt`, `firstSeenAt`, `lastSeenAt` | ISO-8601 UTC strings | stored as strings for simple range comparison |
| `pollCount` | number | read-modify-write each tick (tables have no atomic increment) |
| `raw` | JSON object string | original county record, re-derivable later; truncated/omitted beyond ~256 KB serialized so entities stay far under the 1 MiB limit |

Upsert semantics: `tableClient.upsertEntity(entity, 'Replace')` keyed on PK+RK —
same idempotency guarantee as the Phase 1 Postgres `ON CONFLICT`.

Month-rollover rule — **never move an entity**: pin each incident's `partitionKey`
to the `YYYY-MM` of its `dateFirst` at first sight. If `dateFirst` later crosses a
month boundary, upsert a duplicate entity into the new partition (denormalized dual
write) and keep the original row untouched; reads dedupe duplicates by `rowKey`,
keeping the entry with the newest `lastSeenAt`. This avoids cross-partition deletes
entirely (Table Storage has no cross-partition transactions), keeps `status_history`
rows consistent with their parent's pinned partition, and costs at most one extra
entity per rare boundary crossing.

### `status_history` (append-only)

| Column | Value |
|---|---|
| `partitionKey` | parent incident's pinned `YYYY-MM` partition |
| `rowKey` | `<epochMs padded to 15 digits>:<first 8 chars of sha256(status)>` |
| `incidentRowKey` | parent dedup key |
| `observedAt`, `status` | ISO string / string |

Write only when observed status differs from the current incident row's `status`
(same rule as Phase 1). Collisions are practically impossible; a duplicate write is
a harmless no-op under Replace mode.

### `meta`

Single bookkeeping table for observability: `PK='meta'`, `RK='last_poll'` →
`{ ts, source, fetched, added, skipped, warnings }` from each tick, plus an
`errors` counter that resets on success (best-effort under the lease below).

## Concurrency & safety

- **Single-instance lease**: at tick start, `ingest` acquires a lock entity
  (`PK='meta'`, `RK='lock'`). Acquisition is atomic, not read-then-write: create-only
  insert (`ifNoneMatch: '*'`); on conflict, read the holder's `expiresAt` and, if
  expired, replace via ETag compare-and-swap (`ifMatch`), looping until won or the
  tick gives up (skip). Release = delete of the lock entity on completion; crashed
  holders simply expire. Azure timer triggers do not prevent overlap when
  Consumption scales out or a run drags past its interval; single-flight makes the
  `pollCount` read-modify-write and the `meta.last_poll` write contention-free by
  construction.
- **Timeout invariant**: lease TTL must exceed the configured `functionTimeout`
  (e.g., TTL 15 min vs timeout 5 min) so a still-running tick can never be displaced
  mid-run; set both explicitly in host.json. Actual ticks take seconds even
  cold-started — large headroom.
- **Retries / self-heal**: rely on the @azure/data-tables default retry policy
  (exponential backoff for transient and throttled errors). A tick that fails after
  retries only misses incidents *resolved during* the outage window; the next
  successful tick re-fetches all live incidents from the county feed.

## HTTP API contract

```
GET /api/incidents?since=2026-09-01&until=2026-09-30&type=MVA-PD&limit=2000
```

- Resolves month partitions between `since`/`until` (defaults: last 30 days) and runs
  one partition-scoped query per month — cheap at this scale. Each query follows
  continuation tokens until an empty page or `limit` is reached (Table Storage pages
  at 1000 entities).
- Optional server-side filters: `type`, `status`; `lat`/`lng` filtering left to client.
- Response: GeoJSON `FeatureCollection`; properties mirror the entity fields.
- Errors: 400 on malformed params, 503 if the table read fails; JSON body with message.
- Function app setting `ALLOWED_ORIGIN` = SWA custom domain; explicit value in both
  environments (`*` in dev only). CORS adds no security for unauthenticated GETs on
  public data — it only shapes browser behavior.
- No auth: incidents come from the county's own public feed and the map is
  open-source by design. If free-tier abuse becomes an issue, add an optional
  shared-secret header later without breaking existing consumers.

## Repo layout changes

```
src/
  ingest/fetchSource.js   (unchanged)
  ingest/parse.js         (unchanged)
  store/tableStore.js     new — @azure/data-tables wrapper: upsertIncidents,
                          fetchMonth, appendStatusHistory, writeMeta
  functions/ingest.ts     timer trigger → runPoll + tableStore
  functions/incidents.ts  HTTP trigger → GeoJSON response
web/                      static map UI (index.html, Leaflet + leaflet.heat)
test/                     existing parse tests retained; new tableStore tests
                          against Azurite emulator tables endpoint
infra/                    bicep or azd template: storage account, functions app,
                          swa deployment wiring (GitHub integration for web/)
```

`pg` is dropped from dependencies once Phase 1's Postgres path is retired. The local
dev loop stays `npm test` (Azurite via npx) — no Azure login needed for unit work.

## Milestones

1. **M1** — `tableStore.js` + unit/integration tests on Azurite (upsert idempotency,
   rollover dual-write + read dedupe, lease acquire/release, status-history no-op dupes).
2. **M2** — timer ingestion function; deploy to Consumption plan; verify entities land
   in Table Storage and `meta.last_poll` advances. Seed the 12 rows already captured
   in local Postgres as initial data.
3. **M3** — HTTP GeoJSON function with CORS; curl-verify from outside the VNet-free
   public URL.
4. **M4** — `web/` map page (Leaflet base layer + heat overlay + time-range picker);
   deploy via SWA GitHub integration; end-to-end check in browser.
5. **M5** — infra-as-code (`infra/`) for all three resources; document ops runbook.
   Backups = storage redundancy plus a nightly full-table export to a Blob container
   (point-in-time restore); note that soft-delete alone does not protect against
   logical corruption of entity contents.

## Constraints & trade-offs accepted

- No secondary indexes or joins: queries are partition-scoped only. Fine at this scale;
  if "all-time heatmap" becomes a hot path, add an aggregate table per quarter.
- Cross-month range queries cost one request per month — negligible here.
- Functions cold starts (~hundreds of ms) are acceptable for a low-frequency dashboard.
- Politeness preserved: same ~10-min cadence, jitter, honest User-Agent as Phase 1.
- Timer triggers require the standalone Functions app (SWA managed functions are
  HTTP-only) — that is exactly what we're using, so no constraint hit.
