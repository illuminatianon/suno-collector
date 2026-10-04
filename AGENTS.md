# Repository Guidelines

## Project Overview

Local Suno song archive: a passive Violentmonkey collector stores complete clip data in SQLite; a read-only Vue 3/Vuetify dark frontend browses captured songs. Capture coverage depends on what the Suno UI loads, not an automated scraper.

## Architecture & Data Flow

- `suno-collector.user.js` observes successful Fetch/XHR responses from `https://studio-api-prod.suno.com/api/feed/v3`, including single-song lookups. It clones responses without consuming application data. Attribution endpoints are not captured.
- Immutable batches of up to 20 clips persist in extension storage. `GM_xmlhttpRequest` sends `{clips: [...]}` to `POST /api/ingest`; validated acknowledgements include inserted/updated/unchanged/skipped counts and remove batches. A first-run Owned/Remixed policy without Suno User ID returns 409 so queued captures are **not** acknowledged; failed deliveries retry localhost every 15 seconds. Preserve passive capture and durable acknowledgement semantics; previously installed userscripts need the current generated script (v1.1.0+) for skipped acknowledgements.
- `server.js` uses native Node HTTP and SQLite. `songs.id` is the primary key; sorted-key canonical JSON makes identical captures no-ops. Changed data updates the same row inside an immediate transaction. Never deduplicate by title or discard unknown `raw_json` fields. `settings` stores Suno user UUID, ingest mode (`owned` default, `remixed`, `all`), timezone and separate ingress token. Policy applies only to future ingest; do not delete historical rows on settings changes. Remixed admits non-owned clips only when referenced by `cover_clip_id`/`edited_clip_id` of a known owned `metadata.is_remix` song; source-before-remix needs recapture.
- `migrations.js` owns v2 schema creation, promoted-field extraction, persona merge, and automatic v1→v2 migration. `PRAGMA user_version` tracks versions; legacy v0/v1 is snapshotted with native SQLite `backup()` (WAL-aware) before an atomic transaction. A new empty DB starts at v2 without a backup. A migration failure aborts startup. Preserve `raw_json` and song IDs exactly; promoted fields are query conveniences, and persona metadata upserts never erase known values with nulls.
- Vue obtains a process-local read token from `/api/session`, requests paginated summaries from `/api/library`, then full records from `/api/library/<id>`. Detail responses also carry a nullable merged `persona` row from `personas`; the `clip` remains the unchanged captured JSON. The persistent ingress token protects `/api/songs` exports; read tokens cannot ingest, but may edit settings via authenticated `GET/PUT /api/settings` with validated UUID/mode/timezone.
- `/api/library/timeline` returns SQLite-grouped daily counts using the saved IANA timezone (first-run seed from `TIME_ZONE` or `America/Detroit`), date bounds, and the total archive count; undated/invalid timestamps count toward the total but not daily buckets. `/api/library` accepts optional inclusive `from` and exclusive `to` (`YYYY-MM-DD` in that timezone), combined with title search and pagination. Registered `local_date` uses mutable cached `Intl.DateTimeFormat` conversion, including DST, independently of server/browser timezone. Raw timestamps remain unchanged. Timeline uses aggregate data, never a full-library clip download.
- Vue Router uses history routes `/` (library), `/sql` (query tool), and `/settings`; the server serves the built index at these exact paths for reload/deep links. `POST /api/query` accepts `{sql}` with the read token and returns `{columns, rows}` using positional arrays. It executes one result-producing statement on a separate read-only SQLite connection, supports `local_date`, and returns all rows without pagination or hidden limits. Handle strings, numbers, and nulls only; no generalized SQL type system.
- Production serves `dist/` from the loopback server. Preserve Host allowlisting, no-CORS behavior, safe static paths, and token separation.

## Key Directories

- `src/`: Vue components, Vuetify setup, and responsive styles.
- `data/`: private SQLite database and WAL/SHM files; ignored.
- `dist/`: generated production frontend; ignored.

## Development Commands

```sh
npm ci                  # Install locked dependencies
npm run build           # Generate dist/ before using the production UI
npm start               # Collector + built UI at http://127.0.0.1:4318/
npm run dev             # Separate Vite terminal; keep the backend running
npm test                # Node integration tests
node server.js --help   # Installation, API, and operational guidance
curl http://127.0.0.1:4318/health
```

No lint or formatter command is configured. Copy `.env.example` to `.env` only for server startup `PORT`, `SUNO_DB`, or **first-run** `TIME_ZONE` seed. After SQLite stores `time_zone`, edit it through `/settings`; later `.env` changes do not override it and save applies immediately. Defaults are `America/Detroit`, `4318`, and `data/songs.sqlite`. The UI reads the saved timezone from authenticated `/api/config`; never hardcode timezone labels or derive them from the browser. Vite's API proxy targets port 4318 explicitly; adjust it if changing the backend port.

## Code Conventions & Common Patterns

- ES modules, two-space indentation. Backend/userscript use semicolons; Vue source generally omits them. Follow the surrounding file. Use camelCase for functions/state; preserve incoming snake_case data fields.
- Backend uses module-level prepared statements, bound SQL parameters, explicit transactions, and HTTP status/error responses; no dependency-injection framework.
- Vue uses `<script setup>`, `ref`, `computed`, watchers, and lifecycle hooks, not a separate state store. Preserve AbortController cancellation and sequence guards against stale list/detail responses; search is debounced.
- Keep lightweight list summaries separate from full detail records. Preserve complete lyrics, unknown nested metadata, and raw JSON access.
- Register only used Vuetify components/directives in `src/main.js`. Preserve keyboard focus, retry/empty/loading states, mobile navigation, and reduced-motion styling. Only HTTP(S) metadata values become links; do not auto-load remote media.
- Use Conventional Commits exclusively, e.g. `feat: add song filters`, `fix: preserve queued captures`, `docs: update repository guidelines`.
- Commit as you go: after each completed logical change and its applicable tests/build/runtime smoke checks, create an atomic Conventional Commit before starting unrelated work. Do not wait for a separate request to commit.
- Keep a feature's implementation and regression tests together; separate independently useful changes. Stage explicit paths or hunks, never unrelated user edits. Do not commit unfinished/broken work, private data, generated output, or credentials; do not amend published history without permission.

## Important Files

- `server.js`: ingest/deduplication, authentication, API routes, startup schema initialization, static serving, built-in usage documentation. `migrations.js`: schema versions, backup/backfill, shared promoted-field/persona extraction and upsert.
- `suno-collector.user.js`: adapter template. Install the generated `/userscript.user.js`, not this placeholder-containing source; the generated script embeds a private ingress token.
- `src/App.vue` and `src/router.js`: shared navigation shell and library/SQL/Settings routes; Settings saves update the library timezone without a restart.
- `src/LibraryPage.vue`: list/search/pagination and selected-song detail. Header badges reflect actual clip flags (`metadata.is_remix`, `is_public`, `explicit`); UUID copy uses Clipboard API. Lyrics, raw positive/negative tags, and persisted/captured persona share a split detail view; remaining metadata/raw JSON stay under native disclosure. Keep responsive stacking and mobile Back behavior.
- `src/LibraryTimeline.vue`: configured-local year heatmap, day counts/tooltips, and bounded year controls. `LibraryPage.vue` applies clicked-day filters to the existing list/detail flow and explicitly formats displayed timestamps in the configured timezone. Calendar-label arithmetic deliberately uses UTC to avoid DST shifts; no chart library.
- `src/SqlQueryPage.vue`: query textarea, Run/Ctrl+Enter, all-row results table, and CSV download.
- `src/SettingsPage.vue`: UUID, capture policy and Intl-supported timezone autocomplete; settings are stored in SQLite, not browser or `.env`.
- `src/api.js`: shared session/authenticated requests; `src/csv.js` and `src/csv.test.js`: scalar CSV encoding and escaping regression tests.
- `src/MetadataValue.vue`: arbitrary value rendering and safe links; `src/style.css`: two-panel/mobile layout.
- `index.html` and `src/main.js`: frontend entry points; `vite.config.js`: Vue plugin and local API proxy.
- `package.json` / `package-lock.json`: commands and dependencies. `.env.example` documents local timezone and server settings. `.gitignore` excludes private/generated files, including `repomix-output.xml` and `.env` variants; `.env.example` is trackable. `repomix.config.json` respects these exclusions.

## Runtime/Tooling Preferences

Use **Node.js 24+ and npm**, not Bun: the server and tests depend on `node:sqlite`. Keep the npm lockfile synchronized with dependency changes. No Express, ORM, CDN dependency, or external database service is required. Never commit databases, captured private song data, credentials, or generated token-bearing userscripts.

## Testing & QA

`server.test.js`, `settings-policy.test.js`, and `migration.test.js` use `node:test` and `node:assert/strict`. They launch real servers with isolated ports and temporary SQLite databases, exercise HTTP, check persisted invariants, and clean up subprocesses/files. `migration.test.js` snapshots the private `tests/test-db.sqlite` fixture to a temporary archive before migration and checks its original checksum; skip only that fixture test if the private fixture is absent. Never run migrations against the original fixture or the user's `data/songs.sqlite`, and never commit fixture, copied DBs, or timestamped backups.

Existing checks cover full-data round trips, concurrent deduplication, update-in-place, atomic rejection, auth separation, detail retrieval, pagination, literal wildcard search, timeline aggregation, configured-local date boundaries/DST, SQL result completeness/write rejection, settings persistence and Owned/Remixed/All ingress decisions, plus scalar CSV escaping. Migration QA additionally covers fresh v2, real-legacy backfill/NULL/IDs/raw JSON/personas, WAL snapshot backups, idempotent restart, and clean rollback on failure. For backend changes run `npm test`; for frontend changes build and smoke-test desktop/mobile selection, search, settings save, pagination, and error recovery. Settings QA covers first-run 409 and queued retries, configured timezone switches, and known remix sources. SQL QA covers direct `/sql` reload, navigation, Ctrl+Enter, full results, empty/error states, and actual CSV download. Do not treat passing server/helper tests as browser validation.
