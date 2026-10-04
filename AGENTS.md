# Repository Guidelines

## Project Overview

Local Suno song archive: a passive Violentmonkey collector stores complete clip data in SQLite; a read-only Vue 3/Vuetify dark frontend browses captured songs. Capture coverage depends on what the Suno UI loads, not an automated scraper.

## Architecture & Data Flow

- `suno-collector.user.js` observes successful Fetch/XHR responses from `https://studio-api-prod.suno.com/api/feed/v3`, including single-song lookups. It clones responses without consuming application data. Attribution endpoints are not captured.
- Immutable batches of up to 20 clips persist in extension storage. `GM_xmlhttpRequest` sends `{clips: [...]}` to `POST /api/ingest`; validated acknowledgements remove batches. Failed deliveries retry localhost every 15 seconds. Preserve passive capture and durable acknowledgement semantics.
- `server.js` uses native Node HTTP and SQLite. `songs.id` is the primary key; sorted-key canonical JSON makes identical captures no-ops. Changed data updates the same row inside an immediate transaction. Never deduplicate by title or discard unknown `raw_json` fields.
- Vue obtains a process-local read token from `/api/session`, requests paginated summaries from `/api/library`, then full records from `/api/library/<id>`. The persistent ingress token also protects `/api/songs` exports; read tokens cannot ingest.
- `/api/library/timeline` returns SQLite-grouped daily counts using `TIME_ZONE` (IANA timezone, default `America/Detroit`), date bounds, and the total archive count; undated/invalid timestamps count toward the total but not daily buckets. `/api/library` accepts optional inclusive `from` and exclusive `to` (`YYYY-MM-DD` in that timezone), combined with title search and pagination. A registered `local_date` SQLite function uses cached `Intl.DateTimeFormat` conversion, including DST, independently of server/browser timezone. Raw timestamps remain unchanged. Timeline uses aggregate data, never a full-library clip download.
- Vue Router uses history routes `/` (library) and `/sql` (query tool); the server serves the built index at both exact paths for reload/deep links. `POST /api/query` accepts `{sql}` with the read token and returns `{columns, rows}` using positional arrays. It executes one result-producing statement on a separate read-only SQLite connection, supports `local_date`, and returns all rows without pagination or hidden limits. Handle strings, numbers, and nulls only; no generalized SQL type system.
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

No lint or formatter command is configured. Copy `.env.example` to `.env` for local `TIME_ZONE`, `PORT`, or `SUNO_DB` settings; shell environment overrides the file. Restart the server after editing `.env` and reload the browser. Defaults are `America/Detroit`, `4318`, and `data/songs.sqlite`. The UI reads the configured timezone from authenticated `/api/config`; never hardcode timezone labels or derive them from the browser. Vite's API proxy targets port 4318 explicitly; adjust it if changing the backend port.

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

- `server.js`: schema, deduplication, authentication, API routes, static serving, built-in usage documentation.
- `suno-collector.user.js`: adapter template. Install the generated `/userscript.user.js`, not this placeholder-containing source; the generated script embeds a private ingress token.
- `src/App.vue` and `src/router.js`: shared navigation shell and library/SQL routes.
- `src/LibraryPage.vue`: list/search/pagination, selection, metadata grouping, and request state.
- `src/LibraryTimeline.vue`: configured-local year heatmap, day counts/tooltips, and bounded year controls. `LibraryPage.vue` applies clicked-day filters to the existing list/detail flow and explicitly formats displayed timestamps in the configured timezone. Calendar-label arithmetic deliberately uses UTC to avoid DST shifts; no chart library.
- `src/SqlQueryPage.vue`: query textarea, Run/Ctrl+Enter, all-row results table, and CSV download.
- `src/api.js`: shared session/authenticated requests; `src/csv.js` and `src/csv.test.js`: scalar CSV encoding and escaping regression tests.
- `src/MetadataValue.vue`: arbitrary value rendering and safe links; `src/style.css`: two-panel/mobile layout.
- `index.html` and `src/main.js`: frontend entry points; `vite.config.js`: Vue plugin and local API proxy.
- `package.json` / `package-lock.json`: commands and dependencies. `.env.example` documents local timezone and server settings. `.gitignore` excludes private/generated files, including `repomix-output.xml` and `.env` variants; `.env.example` is trackable. `repomix.config.json` respects these exclusions.

## Runtime/Tooling Preferences

Use **Node.js 24+ and npm**, not Bun: the server and tests depend on `node:sqlite`. Keep the npm lockfile synchronized with dependency changes. No Express, ORM, CDN dependency, or external database service is required. Never commit databases, captured private song data, credentials, or generated token-bearing userscripts.

## Testing & QA

`server.test.js` uses `node:test` and `node:assert/strict`. It launches the real server with an isolated port and temporary SQLite database, exercises HTTP, checks persisted invariants, and cleans up its subprocess/files. Follow that pattern; never point tests at the user's archive.

Existing checks cover full-data round trips, concurrent deduplication, update-in-place, atomic rejection, auth separation, detail retrieval, pagination, literal wildcard search, timeline aggregation, configured-local date boundaries/DST, SQL result completeness/write rejection, and scalar CSV escaping. Test timezone configuration from a temporary `.env`, shell precedence, defaults and invalid-zone startup before database creation; server `TZ` and browser timezone must not change configured date buckets. No coverage threshold or browser test suite is configured. For backend changes run `npm test`; for frontend changes build and smoke-test desktop/mobile selection, search, pagination, and error recovery. Timeline QA covers year/day selection and clearing filters; SQL QA covers direct `/sql` reload, navigation, Ctrl+Enter, full results, empty/error states, and actual CSV download. Do not treat passing server/helper tests as browser validation.
