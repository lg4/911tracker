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

## Secrets map (never print these)

| Secret | Where | Used by |
|---|---|---|
| `AZURE_CLIENT_SECRET` | GH secret | deploy-functions SP login |
| `SWA_CLI_DEPLOYMENT_TOKEN` | GH secret (= SWA deployment token / terraform `static_site_api_key`) | deploy-web CLI publish |
| storage connection string | Function App setting + local `.env` | table access |
