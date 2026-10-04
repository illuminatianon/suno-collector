# Suno Collector

A local archive and browser for your Suno songs. A compatible userscript extension runs the passive collector while you browse Suno normally, a Node server stores the captured data in SQLite, and a Vue 3/Vuetify dark interface lets you explore it.

## Setup

Requires **Node.js 24+**, **npm**, and a browser userscript extension that supports the script's `GM_*` APIs and `unsafeWindow` (for example, **Violentmonkey**).

```sh
npm ci
npm run build
npm start
```

Open **http://127.0.0.1:4318/** for the library.

To enable capture:

1. With the server running, open **http://127.0.0.1:4318/settings**. Enter your Suno user UUID and choose a capture mode. The default is **Owned**; until you save an ID, inbound batches receive a setup error and remain queued for retry. If your archive already has songs, the SQL page can help identify your account: `SELECT user_id, count(*) AS songs FROM songs GROUP BY user_id ORDER BY songs DESC`.
2. Open **http://127.0.0.1:4318/userscript.user.js** and install or update it using your userscript extension (Violentmonkey is one option). Existing installs of version 1.0.0 should be updated to 1.1.0 so filtered acknowledgements are handled correctly.
3. Log into Suno in that browser, then reload Suno once.
4. Browse and scroll through your Library normally.
5. Click **Refresh** in the local library to see newly captured songs.

Install the script from the running server, not the checked-in template. The generated script contains your local ingress token. The browser and receiver must run on the same machine.

## How capture works

The script passively observes Suno's `/api/feed/v3` Fetch/XHR responses, including single-song lookups. It copies the returned clip objects without consuming the application's response. It does **not** scroll automatically, replay requests, or download audio.

Captured batches are queued in the userscript extension's storage and sent to the localhost ingress endpoint. Failed deliveries retry every 15 seconds; acknowledged batches are removed. The userscript menu provides status, pause/resume delivery, and manual retry. Browser console messages start with `[Suno collector]`.

**Capture modes** affect only future deliveries; changing them never deletes stored songs:

- **Owned** (default): store clips whose `user_id` matches the saved Suno UUID.
- **Remixed**: store owned clips plus outside source clips explicitly referenced by an owned remix (`metadata.is_remix` with `cover_clip_id` or `edited_clip_id`). A source seen before its remix is known must be captured again; the server does not retroactively fetch songs.
- **All**: store every delivered clip. You may leave the Suno user ID blank in this mode.

Acknowledgements distinguish inserted, updated, unchanged, and skipped clips. A setup error does **not** acknowledge a batch, so the extension keeps it queued. Skipped clips are not retained for later reevaluation.

SQLite stores one record per song ID in `data/songs.sqlite`:

- Identical captures are no-ops.
- Changed data updates the existing record.
- Different IDs remain separate, even if titles or lyrics match.
- `raw_json` preserves the complete clip, including lyrics, styles, generation settings, URLs, and unknown fields.

The server records `first_captured_at` and `updated_at` as UTC ISO timestamps (`new Date().toISOString()`). It preserves each clip's `created_at` **exactly as received**, both in its indexed column and in `raw_json`: Suno commonly supplies UTC `Z` timestamps, but an offset-bearing value is not rewritten. Changing the saved timezone affects only date grouping, filtering, and display; it never changes stored timestamps.

Capture is limited to responses the Suno UI actually loads. Hidden categories and filters can affect coverage; the archive is not automatically guaranteed to contain every song. Separate attribution responses are not currently captured.

## Schema and backups

The database uses SQLite `PRAGMA user_version` (current version: **2**). On startup, a new archive is created directly at v2. An existing legacy v1 archive is backed up with SQLite's snapshot API—including committed WAL data—before an atomic migration. The backup has a timestamped `.backup-…sqlite` filename beside the database. Startup logs the detected version, backup path, migration progress, or that the schema is current; a failed migration rolls back and stops the server. Backups contain private song data; keep them local.

V2 promotes `major_model_version`, `duration`, `is_public`, `play_count`, `upvote_count`, `task`, `is_remix`, `persona_id`, `tags`, and `negative_tags` into queryable `songs` columns. Missing values stay `NULL`; the complete, unchanged `raw_json` remains the canonical archive. Future captures update promoted fields alongside it. A `personas` table collects available persona metadata by UUID, retaining known values when later clips omit them. These columns and the persona table are available through the SQL query tool.

## Library and timeline

The **Songs** view provides title search and a newest-first list. Selecting a song opens a detail panel with title, UUID copy button, creation date, captured play/like counts, and badges for known Remix/Public/Private/Explicit attributes. Zero counts display as zero; missing counts are omitted. Lyrics are the main column; positive/negative tags and persona details sit alongside them (stacked below on mobile). Small copy icons beside each tag label copy the captured text exactly, including line breaks; icons are disabled when no tags were captured. Persona info uses merged SQLite metadata when available and otherwise the captured clip object. Expand **More metadata** or **Full captured JSON** to inspect the remaining fields.

The **Timeline** view shows daily creation counts as a calendar heatmap. Select a day to filter the same song list, use previous/next to change years, or clear the date filter to return to the full list.

Timeline grouping, date filters, and formatted timestamps use the timezone saved in **Settings** (including daylight saving time). On first run only, the server copies `TIME_ZONE` from `.env` into the existing SQLite `settings` table; if unset, the initial value is **America/Detroit**. After that, use the Settings page to change the timezone without restarting or rebuilding. The UI fetches the active timezone from the server; raw timestamps remain unchanged in the database and JSON. Undated or invalid timestamps count toward the archive total but do not appear in daily buckets.

## SQL query tool

Open **http://127.0.0.1:4318/sql**, or use the **SQL query** navigation link.

Enter a read-only query, click **Run query**, or press **Ctrl+Enter** (**Cmd+Enter** on Mac). Results appear in a table and can be downloaded as CSV. All returned rows are loaded; add `LIMIT` yourself if desired. The tool handles strings, numbers, and nulls, reports SQL errors, and rejects archive writes.

SQLite JSON functions and `local_date(timestamp)` (using the configured timezone) are available. For example:

```sql
SELECT local_date(created_at) AS day, count(*) AS clips
FROM songs
WHERE created_at IS NOT NULL
GROUP BY day
ORDER BY clips DESC, day DESC
LIMIT 30;
```

Large results or expensive queries can slow the local server and browser.

## Development and configuration

```sh
npm start               # Backend and built frontend
npm run dev             # Vite frontend; keep the backend running separately
npm run build           # Rebuild production frontend
npm test                # Isolated API/SQLite and CSV tests
node server.js --help   # API and installation details
```

Use **http://127.0.0.1:4318/settings** to edit Suno User ID, capture mode, and timezone. The timezone control lists names from `Intl.supportedValuesOf('timeZone')` and also supports UTC. Settings persist in the database's existing `settings` table.

`.env` is optional for server startup. `TIME_ZONE` is a **first-run bootstrap only**: it seeds the saved timezone if none exists, and later edits to the environment do not override the saved value. Shell environment variables override `.env` when that initial value is read. Changing the saved timezone needs neither a schema migration nor a frontend rebuild.

- `TIME_ZONE`: first-run timezone seed; default `America/Detroit`. After initial setup, change the timezone in-app.
- `PORT`: server port, default `4318`.
- `SUNO_DB`: SQLite path, default `data/songs.sqlite`.

Vite's API proxy targets port 4318 in `vite.config.js`; update it if changing the backend port. Reinstall the generated userscript if its receiver URL or ingress token changes.

The server binds only to `127.0.0.1`. Keep the database and generated userscript private: they contain captured song data and/or the local ingress token. Database files, `data/`, dependencies, build output, `.env` files, and `repomix-output.xml` are excluded from Git.
