# Ops runbook — oneida-911-mapper

Live resources, deploy mechanics, and failure modes. Architecture and table schema:
[phase2.md](./phase2.md).

## Resources (Terraform-managed in `infra/`, state uncommitted in `infra/.terraform`)

| Resource | Name | Region | Notes |
|---|---|---|---|
| Resource group | `oneida911` | eastus | |
| Storage account | `o911tse10tr1` | eastus | tables endpoint `https://o911tse10tr1.table.core.windows.net`; tables `incidents`, `statusHistory`, `meta` via `scripts/create-tables.js` |
| Function App | `o911func-e10tr1` | eastus | Linux consumption Y1, node ~4 worker; app settings `FUNCTIONS_WORKER_RUNTIME=node`, `AZURE_TABLES_CONNECTION_STRING`, `ALLOWED_ORIGIN=https://salmon-smoke-0f761930f.5.azurestaticapps.net` |
| Static Web App | `o911map-e10tr1` | eastus2 | Free tier; **public URL is the default host** `https://salmon-smoke-0f761930f.5.azurestaticapps.net` — the name-derived `o911map-e10tr1.azurestaticapps.net` 404s forever on this setup and must not be used for CORS or links |

Local dev loop: `npm test` (node --test; tableStore tests spawn Azurite). No Azure login needed.

## Durability — mirror-table backup lane (T12b)

The tables are **LRS** (locally-redundant storage) with no geo-replication today. As a zero-new-tier
mitigation, an hourly timer (`functions/backup`, schedule `5 */1 * * * *`) copies every row of
`incidents` + `status_history` into sibling archive tables in the **same storage account**:
`incidentsArchive` / `statusHistoryArchive`. The copy is lease-guarded like ingest (multi-instance
consumption plans never double-copy), each run stamps `meta`/`last_backup`, and failures land in
`recordTickFailure` (`backup: …`). Because Replace-mode re-runs are idempotent, a partial round
self-heals on the next tick — the archive can only lag, it cannot corrupt live data (it never feeds
back into the read path).

**Freshness check:** query `meta`/`last_backup`; its `ts` should be within ~1h. A stale pointer is
the failure to investigate (check function app logs for `backup:` entries).

**Restore procedure** (after a table-level loss or a bad app-side write):
1. Drop/recreate the damaged live table(s) via `scripts/create-tables.js` (idempotent).
2. Copy rows back from the corresponding archive table (`incidentsArchive` → `incidents`, etc.) —
   same PK/RK scheme, so it's a straight per-row upsert; script it with `TableClient.listEntities` +
   `upsertEntity(entity, 'Replace')` exactly as `copyTableToArchive` does, stripping `_etag`.
3. Re-ingest catches up within one 10-min poll; verify `meta`/`last_poll` advances again.

**Known limitation:** the archive shares fate with the storage account (same LRS tier), so this
guards table-level and application-level loss, **not** an account outage. Recommended follow-up:
flip `account_replication_type` to `GRS` in `infra/main.tf` (cost increase on the storage account)
for availability-level durability against a full-account regional outage.

## Deploying functions (.github/workflows/deploy-functions.yml)

The workflow stages a self-contained bundle into `dist/`: `functions/*`, referenced
`src/**` files, package manifests, with `host.json` at the bundle **root** (the nested
copy inside `functions/` does not satisfy the runtime's scan under run-from-package),
runs `npm ci`, then deploys via `Azure/functions-action@v1` with `package=dist`.

Auth is service principal `oneida911-gh-deploy` (Contributor on the RG) using GH vars
`AZURE_CLIENT_ID` / `AZURE_TENANT_ID` / `AZURE_SUBSCRIPTION_ID` + secret
`AZURE_CLIENT_SECRET`; var `FUNCTION_APP_NAME`. A user-assigned MI
(`gh-oneida911-deploy`) exists for a future OIDC migration but its app registration was
never synced into Microsoft Graph (`AADSTS70025`); do not switch back without fixing that.

Two operational gotchas:

1. **RBAC → WEBSITE_RUN_FROM_PACKAGE.** Because auth is RBAC and the plan is Linux
   consumption, the action deploys by pointing `WEBSITE_RUN_FROM_PACKAGE` at an SAS URL
   of the zipped bundle — it does not push to wwwroot. The app must be able to load the
   new package; if the runtime can't, sync-trigger fails and the deploy errors out while
   the *old* package stays live (fail-safe: nothing breaks until the next good deploy).
2. **The path filter excludes the workflow file itself.** Pushes touching only
   `.github/workflows/deploy-functions.yml` trigger no run. Dispatch manually after such
   changes: `gh workflow run deploy-functions.yml --ref main`.

## Failure mode: "Function app may have malformed content"

Symptom: deploy function step ends with

```
Sync Trigger Functionapp : Failed to perform sync trigger on function app. Function app
may have malformed content. Please manually restart your function app and inspect the
package from WEBSITE_RUN_FROM_PACKAGE.
```

Diagnosis order (all verified as dead-ends or fixes in September 2026):

1. **Check the staging layout** first — reproduce locally (`mkdir dist`, copy per the
   workflow, `npm ci`) and confirm `host.json` sits at the zip root alongside
   `package.json`. A missing root `host.json` under RBAC/run-from-package produces exactly
   this error; commit 86239f0 fixed the workflow to put it there.
2. If the bundle is correct and the error persists across commits, the app's runtime is
   likely stuck on a stale `WEBSITE_RUN_FROM_PACKAGE` value and keeps failing its scan of
   it. The error message's own remedy applies: **restart the Function App manually**
   (`az functionapp restart --name o911func-e10tr1 --resource-group oneida911`, or Portal →
   Restart). After the restart, re-dispatch the last green-intent deploy.
3. Do not "fix" by moving back to wwwroot deploys — with RBAC auth that path isn't
   available; keep the SP-auth + run-from-package pipeline working.

## Code conventions (learned the hard way)

- Functions use the **Node v4 programming model**: register programmatically via
  `import { app } from '@azure/functions'` then `app.http(...)` / `app.timer(...)`. No
  `function.json` files; entry point is `"main": "functions/index.js"` in package.json.
  Under v4, `req.query` is a `URLSearchParams` — convert with
  `Object.fromEntries(req.query)`.
- Timer schedule strings are 6-field cron (`{sec} {min} {hour} {dom} {month} {dow}`);
  ingest runs `0 */10 * * * *`.
- Single-instance safety lives in Table Storage: acquire the lease entity before polling,
  release in `finally`; lease TTL (15 min) must stay above the function timeout.

## Basemap caveat (by design)

The basemap is a local vendored OSM tile pyramid served from `/tiles/{z}/{x}/{y}.png` — dark mode
is pure-CSS tile inversion of those tiles, light mode serves the raw unstyled pyramid as-is. Light
mode therefore looks plainer than typical styled basemaps; that's a consequence of the keyless /
offline constraint, not a rendering bug. Regenerate the pyramid via `scripts/gen-tiles.js`.

## Cloudflare CDN fronting — human cutover checklist (blocked-unattended item)

Blocked overnight by design: no owned domain, no Cloudflare account/API token locally, and no DNS
zones in the subscription. When a human takes this on, follow in order; nothing here touches the
live path until step 6 flips DNS.

1. **Create** a Cloudflare account and add an owned zone for a domain you control (free tier is
   enough). Do not point it at the default `*.azurestaticapps.net` hostname — CF cannot take that
   over; the app has no custom domain today.
2. **Add CF records** for the subdomain(s) serving the map (e.g. `map.example.com`), all proxy
   enabled ("orange cloud"), pointing at the SWA origin
   `salmon-smoke-0f761930f.5.azurestaticapps.net`.
3. **Verify the origin works through CF**: browse via the new hostname; confirm `/tiles/{z}/{x}/{y}.png`,
   the SPA index, and `https://o911func-e10tr1.azurewebsites.net/api/incidents` are all reachable
   from the browser. CORS already allows the configured `ALLOWED_ORIGIN` — if the API base moves to
   the new domain, update `web/config.js`'s function-app URL *and* the function's `ALLOWED_ORIGIN`
   setting together, then re-deploy both lanes (`deploy-web` + `deploy-functions`).
4. **Cache rules**: set a long TTL on `/tiles/` (immutable content per z/x/y; add `no-cache` or short
   TTL only if you ever regenerate the pyramid in place); keep the SPA index and `/api/*` uncached
   or very short so data freshness is never masked by CDN cache.
5. **Prefetch/warm** the tile pyramid once after cutover so first paint isn't cold-origin bound.
6. **Flip DNS** for the zone to Cloudflare nameservers only after steps 2–5 verify cleanly, then
   monitor one ingest tick and one map load end-to-end before declaring done.

## Secrets map (never print these)

| Secret | Where | Used by |
|---|---|---|
| `AZURE_CLIENT_SECRET` | GH secret | deploy-functions SP login |
| `SWA_CLI_DEPLOYMENT_TOKEN` | GH secret (= SWA deployment token / terraform `static_site_api_key`) | deploy-web CLI publish |
| storage connection string | Function App setting + local `.env` | table access |
