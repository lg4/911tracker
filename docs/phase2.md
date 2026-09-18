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
entirely (Table Storage has no cross-partition transactions), keeps `statusHistory`
rows consistent with their parent's pinned partition, and costs at most one extra
entity per rare boundary crossing.

### `statusHistory` (append-only)

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

## M5 deployment state (live on Azure, Terraform-managed in `infra/`)

All resources deployed; state lives in `infra/.terraform` (uncommitted).

| Resource | Name | Region | Notes |
|---|---|---|---|
| Resource group | `oneida911` | eastus | |
| Storage account | `o911tse10tr1` | eastus | tables endpoint `https://o911tse10tr1.table.core.windows.net`; tables `incidents`, `statusHistory`, `meta` created via `scripts/create-tables.js` |
| Function App | `o911func-e10tr1` | eastus | Linux consumption Y1, node ~4; app settings: `FUNCTIONS_WORKER_RUNTIME=node`, `AZURE_TABLES_CONNECTION_STRING` (raw primary connection string — `createTableClients` parses it), `ALLOWED_ORIGIN=https://o911map-e10tr1.azurestaticapps.net` |
| Static Web App | `o911map-e10tr1` | **eastus2** | SWA is unavailable in eastus; Free tier. Deployment token = terraform output `static_site_api_key` (= Azure `properties.apiKey`), stored as GH secret `AZURE_SWA_API_TOKEN` |

Data seeded: 355 incidents from local Postgres (`scripts/seed-to-tables.js`).

### GitHub Actions deploys

- `deploy-functions.yml`: stages a bundle (`functions/*` + referenced `src/**` files + package manifests) into `dist/`, `npm ci`, then `Azure/functions-action@v1` with `package=dist`. Auth: service principal `oneida911-gh-deploy` (Contributor on the RG) via `azure/login@v3` `auth-type: service-principal` (GH secrets `AZURE_CLIENT_ID`/`AZURE_TENANT_ID`/`AZURE_SUBSCRIPTION_ID`/`AZURE_CLIENT_SECRET`; var `FUNCTION_APP_NAME`). A managed identity `gh-oneida911-deploy` exists with federated credentials for a future OIDC migration, but its app object was not synced to Graph and OIDC failed with AADSTS70025 — SP auth is the working path today.
- `deploy-web.yml`: seds `REPLACE-WITH-FUNCTION-APP` in `web/config.js`, then deploys with the SWA CLI (`npx @azure/static-web-apps-cli deploy web --env production`) using `SWA_CLI_DEPLOYMENT_TOKEN`. The `azure/static-web-apps-deploy@v1` action has a server-side "deployment_action was not provided" bug for api-token publishes; do not switch back without re-testing.

### Known pitfalls learned the hard way

- `azurerm_function_app` / `azurerm_static_site` are deprecated in provider 4.x — use `azurerm_linux_function_app` (needs `service_plan_id`, `functions_extension_version`, empty `site_config {}`) and `azurerm_static_web_app` (has computed `api_key`; add `ignore_changes = [repository_branch, repository_url]` since token deploys mutate those).
- `@azure/data-tables` v13 API: `getEntity(partitionKey, rowKey)` and `deleteEntity(pk, rk, {etag})` take positional identifiers; there is no `queryEntities` or `replaceEntity` — use `listEntities({queryOptions:{filter}})` (paged iterator) and `updateEntity(entity,'Replace',{etag})`. Reads expose `.etag` (not `_etag`).
- OData filters must address the case-sensitive system columns `PartitionKey`/`RowKey`; custom props keep their casing (`dateFirst ge '...'`). No `$select` in `fetchRange` — partitions are tiny and full entities avoid case-normalization divergence between service and test fakes.
- Azurite rejects underscored table names → Azure tables are `incidents`/`statusHistory`/`meta` (Postgres keeps `incident_status_history`).
- The JS SDK does not accept .NET-style semicolon connection strings directly; `createTableClients` parses them into endpoint + `AzureNamedKeyCredential` (the ESM export name — `TablesSharedKeyCredential` is not exported).
- Unit-test fakes model the exact v13 call shapes (including dual-cased key storage); `test/tablestore.azurite.test.js` runs the real SDK against a spawned Azurite (TLS via self-signed cert, test-only relaxed validation) so fake drift cannot hide again.

### Outstanding at session handoff

- [ ] Confirm last deploy-functions run green after `auth-type: service-principal` fix
- [ ] SWA CLI reported "deployment_token provided was invalid" though token matches live `properties.apiKey` — re-trigger web deploy; if still failing, run the CLI locally with the token to capture the real error
- [ ] Verify timer ingest tick lands rows + `meta.last_poll` advances (check `meta` table / function logs)
- [ ] Curl `https://o911func-e10tr1.azurewebsites.net/api/incidents?since=...` for GeoJSON + CORS headers
- [ ] Browser-check the deployed map end-to-end
- [ ] Ops runbook section; retire local Postgres path (drop `pg`, stop docker db/ingest containers)
