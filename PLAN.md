# PLAN — oneida-911-mapper Azure migration (Phase 2 M5)

Session handoff doc. Repo `github.com/lg4/911tracker` @ main. All infra is Terraform-managed (`infra/`, provider azurerm 4.81.0). Details also in `docs/phase2.md`; this file tracks live session state.

## Live resources (all applied; TF state in `infra/.terraform`)

| Resource | Name / value | Notes |
|---|---|---|
| RG | `oneida911` (eastus) | |
| Storage | `o911tse10tr1` (eastus) | tables endpoint `https://o911tse10tr1.table.core.windows.net/`; tables `incidents` (355 seeded rows), `statusHistory`, `meta` |
| Function App | `o911func-e10tr1` (eastus, Linux consumption Y1, node ~4) | app settings: `FUNCTIONS_WORKER_RUNTIME=node`, `AZURE_TABLES_CONNECTION_STRING` (raw connection string), `ALLOWED_ORIGIN=https://o911map-e10tr1.azurestaticapps.net` ← **WRONG, see below** |
| Static Web App | resource name `o911map-e10tr1` (eastus2, Free) | recreated once (old instance was broken for deploys). **Real public URL = `defaultHostname`: `salmon-smoke-0f761930f.5.azurestaticapps.net` — NOT the name-derived `o911map-e10tr1.azurestaticapps.net` (that host 404s forever).** Content IS live on the real host (verified 200 + app HTML). |

Terraform outputs: `function_app_name/url`, `tables_endpoint`, `tables_connection_string` (sensitive), `static_site_api_key` (sensitive; = Azure `properties.apiKey` = SWA deployment token), `static_site_url` (**name-derived guess — do not trust it**; use `az staticwebapp show -g oneida911 -n o911map-e10tr1 --query properties.defaultHostname`).

## GitHub Actions state (both workflows in `.github/workflows/`)

- **deploy-web.yml — WORKING.** Flow: checkout → sed `REPLACE-WITH-FUNCTION-APP`→`${{ vars.FUNCTION_APP_NAME }}` in `web/config.js` → `npx @azure/static-web-apps-cli@latest deploy --app-location web --output-location web --env production` with env `SWA_CLI_DEPLOYMENT_TOKEN=$secrets.AZURE_SWA_API_TOKEN`. Last run GREEN. `web/staticwebapp.config.json` exists (SPA fallback rewrite to /index.html) and is required for the CLI deploy to pick up artifacts.
- **deploy-functions.yml — AUTH FIXED, DEPLOY STILL FAILING.** Stages `dist/` bundle (`functions/*` incl. new `host.json`, selected `src/**` files, package.json+lock), `npm ci`, then explicit `az login --service-principal` step (secret via `env:` block — inline `${{ secrets.* }}` mangles shell-special chars) + `Azure/functions-action@v1` `package=dist`. Login now succeeds; upload succeeds; fails at post-deploy sync-trigger with "Function app may have malformed content… inspect the package from WEBSITE_RUN_FROM_PACKAGE". `WEBSITE_RUN_FROM_PACKAGE` app setting does not exist on this app (it deploys via scm/wwwroot directly).

### GH vars/secrets (repo lg4/911tracker)
- Vars: `AZURE_CLIENT_ID`=6486cdee-3bcf-420b-a646-6bb75db3eaed (SP `oneida911-gh-deploy`), `AZURE_TENANT_ID`=020202da…, `AZURE_SUBSCRIPTION_ID`=1cf1e547-e60e-4715-9fb5-4ed4385fa18d, `FUNCTION_APP_NAME`=o911func-e10tr1.
- Secrets: `AZURE_CLIENT_SECRET` (synced to live SP password as of last reset; validated locally before setting), `AZURE_SWA_API_TOKEN` (= fresh site api_key, no trailing newline).
- MI `gh-oneida911-deploy` + federated creds exist but OIDC fails AADSTS70025 (app object not synced to Graph) — SP auth is the working path.

## Pitfalls learned (do not relearn)

1. **SWA public URL**: name-derived `<name>.azurestaticapps.net` does NOT serve; use `defaultHostname`. All "deploy succeeded but 404" symptoms were this.
2. **`az ad sp credential reset` emits JSON** (`{appId,password(40 chars),tenant}`); capture `.password`, never raw tsv. New password needs ~1–2 min Graph propagation before it authenticates. Each reset invalidates all prior passwords — do exactly one reset per secret update, verify local `az login --service-principal` first.
3. SWA CLI v2: `swa deploy <dir>` alone → "Current directory cannot be identical to or contained within artifact folders"; use explicit `--app-location X --output-location X` from a parent dir. The old `azure/static-web-apps-deploy@v1` action has server-side "deployment_action was not provided" bug for api-token publishes.
4. Secrets set via heredoc/echo gain trailing newlines → corrupt tokens (this caused the phantom "invalid deployment_token"). Always `printf '%s' "$VAL" | gh secret set NAME`.
5. `azure/login@v3` action ignored `auth-type` and forced OIDC — replaced with plain `az login --service-principal`; pass secret through an `env:` block.
6. Provider 4.x: use `azurerm_linux_function_app` (+`site_config {}`) / `azurerm_static_web_app` (+computed `api_key`, `ignore_changes=[repository_branch,repository_url]`). Registry docs confirm api-key CI deploys mutate repository_* fields.
7. Function bundle needs root `host.json` (`{"version":"2.0"}`) — added at `functions/host.json` (auto-included by staging). Did NOT fix the sync error; see open issues.
8. az CLI version here: no `staticwebapp env*` subcommands, `ad sp credential reset` (singular), `--id` required, `-u/--uri` for `az rest`.

## Done this session (latest)

- Verified all prior open items are resolved live: functions deploys green (root cause was empty `linuxFxVersion` → REST PUT `node|22`, see `.tasks.md` T1/UNBRICK), `/api/incidents` returns GeoJSON + pinned CORS (`Access-Control-Allow-Origin: https://salmon-smoke-0f761930f.5.azurestaticapps.net` on GET+OPTIONS — ALLOWED_ORIGIN already correct; §2 not needed), ingest E2E confirmed via `meta.last_poll` (2026-09-21T00:40Z, fetched:9 added:1). Ingest runs entirely in Azure (timer function → Table Storage); local Postgres/container only survives as the one-off seeder.
- **T9 deeper zoom (in progress)**: `scripts/gen-tiles.js` ZMAX 12→14, regenerated pyramid z7–z14 (5710 tiles, 60M; OSM standard), `web/index.html` maxNativeZoom→14. Staged; ai-review before commit. New tasks queued: T8 type filter, T10 dark basemap.

## Done this session

- tableStore fixed for @azure/data-tables v13 API + real-Azurite integration suite green (22/22); create-tables bootstrap script run; **355 incidents seeded** from local Postgres into Azure Table Storage.
- Terraform infra applied end-to-end; broken SWA deleted + recreated same name.
- deploy-web workflow green; app HTML verified live on real host.
- functions auth chain fully working in CI up to the sync-trigger failure.
- Committed: all of the above incl. `docs/phase2.md` M5 section, `functions/host.json`, `web/staticwebapp.config.json`.
- **Self-contained central-NY map** (commit `547fc47`): vendored Leaflet 1.9.4 + leaflet-heat into `web/vendor/`; pre-rendered bounded Carto dark tile pyramid (central-NY box ~42.8–43.6N / −76.6..−75.0W, z7–z12 = 388 PNGs) into `web/tiles/{z}/{x}/{y}.png`; rewrote `web/index.html` to local assets + local `L.tileLayer('/tiles/...')` with `maxBounds` + no world wrap. Deploy-web green; verified live (all assets 200). Render script kept at `/tmp/opencode/render_tiles.py` (re-run idempotent if tiles ever need regenerating).

## Impeccable critique — web/index.html fixes (chosen this session; NOT yet started)

From `/impeccable critique web/` (run `web-index-html` @ 2026-09-21T21-58-52Z, score **27/40** up from prior 20/40). Snapshot: `.impeccable/critique/2026-09-21T21-58-52Z__web-index-html.md`. User confirmed all three decisions below. All changes land in `web/index.html` (+ `web/config.js` only if needed), doctrine-safe per DESIGN.md (no shadow/motion/webfont; category hues as signal only).

**Per-task commits + ai-review before each push for CI deploy (user's explicit rule).** Suggested command territory = `/impeccable polish`; re-run `/impeccable critique web/` afterward to confirm >27 holds.

- [ ] **P1-1 → exclusive-select chips.** Click a chip = show ONLY that category; `All` resets to all-visible; drop the strikethrough hide encoding; update `aria-pressed` so it mirrors "is this the sole visible category" (not "hidden"). Every common resident query becomes one tap.
- [ ] **P1-2 → full shareability stack.** (a) Sync `since/until/category/counties` into URL query params and read them back on load; (b) silent ~5-min auto-refetch with a status-line tick (respect existing `aria-live` region); (c) one-click **Copy JSON / CSV** of the current window+filters using the live GeoJSON data already in memory. Serves the journalist audience (Mara).
- [ ] **P1-3 → preserve category filters across refetches.** Stop `buildChips()` from unconditionally calling `hiddenCats.clear()` — keep hidden categories when they still exist in the new window, matching how county visibility already survives. (Bundled with P1-1.)
- [ ] **P2-4 → make errors visually distinct.** Add an error class shifting color/border statically (no motion) so failure text no longer reads as healthy muted status. Reuse fire-red hue as signal.
- [ ] **P2-5 → mobile ergonomics.** Add a breakpoint: bump control padding/tap height to ≥40px for chips (~24px), date inputs (~26px), buttons (~28px); collapse the credit line at 360px widths so "Update map" isn't pushed below the fold before the map.

Order suggestion: P1-1 + P1-3 together (same chip code path) → P1-2 → P2-4 → P2-5. Each is its own commit; ai-review before pushing each for CI deploy.

## Open / next steps (in order)

### 1. ~~Functions "malformed content" sync failure~~ — **DONE** (see .tasks.md T1/UNBRICK: root cause was empty `linuxFxVersion`, fixed via REST PUT `node|22`; deploy-functions.yml green; endpoint live with GeoJSON + pinned CORS).

### 2. ~~ALLOWED_ORIGIN fix~~ — **DONE / not needed**: live app setting already serves `Access-Control-Allow-Origin: https://salmon-smoke-0f761930f.5.azurestaticapps.net` (verified on GET + OPTIONS preflight). If infra drift ever resets it, set `infra/main.tf` ALLOWED_ORIGIN to `azurerm_static_web_app.web.default_host_name`.

### 3. ~~Self-contained central-NY map~~ — **DONE** (commit `547fc47`; deploy-web run `35461879565` green; verified live on `salmon-smoke-0f761930f.5.azurestaticapps.net`: `/vendor/leaflet.js|css`, `/vendor/leaflet-heat.js`, `/tiles/10/296/375.png` all 200, index.html references local assets only)

User requirements (confirmed this session):
- **(a) Region-limited view**: show only New York State / central-NY region — set `maxBounds` to the NYS box, disable world wrapping (`worldCopyJump:false`, `noWrap:true`), so you can't pan off into other states/the world.
- **(b) Zero external calls — store the map in the app**: vendor `leaflet.js`+`leaflet.css`+`leaflet-heat.js` locally under `web/vendor/`; replace the live tile server with **static pre-rendered tiles** for exactly the bounded NYS/central-NY box at a small zoom range (~z7–z12), stored as PNGs under `web/tiles/{z}/{x}/{y}.png` and served by SWA statically → point `L.tileLayer` at `/tiles/{z}/{x}/{y}.png`. Keep attribution line (© OSM contributors / CARTO). Result: no runtime dependency on unpkg or cartocdn.

DECISIONS CONFIRMED (user): interactive Leaflet tile-pyramid (keep pan/zoom); region = central-NY focus box (~42.8–43.6N, −76.6..−75.0W). Pre-render bounded PNG tiles at ~z7–z12 → `web/tiles/{z}/{x}/{y}.png`; vendor leaflet.js/css + leaflet-heat.js into `web/vendor/`; point `L.tileLayer` at local `/tiles/...`; `maxBounds` to the box + `worldCopyJump:false` / `noWrap:true`. Keep attribution line. Redeploy via green deploy-web; AI-review pass (§5).

### 4. Verify ingest end-to-end
- After functions deploy is green: wait for next timer tick (~10 min cadence), confirm new rows land in `incidents` table + `meta.last_poll` advances (query via `src/store/tableStore.js` helpers or az tables). Then curl `/api/incidents` GeoJSON + `access-control-allow-origin` header with `Origin: https://salmon-smoke-0f761930f.5.azurestaticapps.net`. Browser-check the deployed map on the real URL.

### 5. AI subagent review of both live endpoints (functions + web) — user wants an ai-review pass after each completed to-do.

### 6. Wrap-up
- Update `docs/runbook.md` / phase2 M5 section with real SWA URL, SP-auth model, pitfalls list above. Retire local Postgres path: drop `pg` dep, stop docker db/ingest containers, remove local dev references. Final commit.

## Resume checklist — current session to-do (in priority order)

> Restart-safe handoff. Statuses as of last update this session. §3 below is DONE; remove from list when renumbering.

- [x] **HIGH** ~~Impeccable critique fixes on `web/index.html`~~ — DONE this session across per-task commits (exclusive chips, reset fix, fetch-error state, mobile tap targets ≥40px, header grouping + day-window aria-pressed, category isolation "Only …" label flip, help surface + heat legend + chip-row hint = T16, tab-title freshness leak). Critique snapshot `.impeccable/critique/2026-09-22T03-57-10Z__web.md`; remaining notes folded into T8/T12/T17 in .tasks.md. §1 malformed-content and §2 ALLOWED_ORIGIN are DONE/not-needed (see lines above) — no duplicate entries kept here.
- [x] **MED** Self-contained central-NY map (§3) — DONE this session (see Done-this-session bullet + commit `547fc47`).
- [x] **MED** ~~Verify ingest end-to-end~~ — DONE this session: `meta.last_poll` advanced to 2026-09-21T00:40Z (added:1, fetched:9); `/api/incidents` returns live GeoJSON + pinned CORS header. Ingest runs fully from the Azure function app → Table Storage; no local container/Postgres in the path.
- [ ] **LOW** AI subagent review of both live endpoints (functions + web) — §5, run after each completed to-do.
- [ ] **LOW** Wrap-up (§6): update `docs/runbook.md` / phase2 M5 with real SWA URL + SP-auth model + pitfalls above; retire local Postgres path (drop `pg` dep, stop docker db/ingest containers, remove local dev refs); final commit.

## Local environment notes
- terraform at `~/.local/bin/terraform`; az CLI logged in as user (ljg426@gmail.com / lou@lg4tech.com), default subscription LG4 Dev PAYG (1cf1e547…). Scratch dirs: `/tmp/opencode/swa-cli` (installed @azure/static-web-apps-cli 2.0.10), `/tmp/opencode/swa-test*`, `/home/lou/.swa` (CLI state). No secrets stored locally anymore (files cleaned).
