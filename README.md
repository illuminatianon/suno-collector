# Suno Collector

A local archive and browser for your Suno songs. A Violentmonkey script captures song data while you browse Suno normally, a Node server stores it in SQLite, and a Vue 3/Vuetify dark interface lets you explore it.

## Setup

Requires **Node.js 24+**, **npm**, and **Violentmonkey** in your browser.

```sh
npm ci
npm run build
npm start
```

Open **http://127.0.0.1:4318/** for the library.

To enable capture:

1. With the server running, open **http://127.0.0.1:4318/userscript.user.js** and install it in Violentmonkey.
2. Log into Suno in that browser, then reload Suno once.
3. Browse and scroll through your Library normally.
4. Click **Refresh** in the local library to see newly captured songs.

Install the script from the running server, not the checked-in template. The generated script contains your local ingress token. The browser and receiver must run on the same machine.

## How capture works

The script passively observes Suno's `/api/feed/v3` Fetch/XHR responses, including single-song lookups. It copies the returned clip objects without consuming the application's response. It does **not** scroll automatically, replay requests, or download audio.

Captured batches are queued in Violentmonkey storage and sent to the localhost ingress endpoint. Failed deliveries retry every 15 seconds; acknowledged batches are removed. The script menu provides status, pause/resume delivery, and manual retry. Browser console messages start with `[Suno collector]`.

SQLite stores one record per song ID in `data/songs.sqlite`:

- Identical captures are no-ops.
- Changed data updates the existing record.
- Different IDs remain separate, even if titles or lyrics match.
- `raw_json` preserves the complete clip, including lyrics, styles, generation settings, URLs, and unknown fields.

Capture is limited to responses the Suno UI actually loads. Hidden categories and filters can affect coverage; the archive is not automatically guaranteed to contain every song. Separate attribution responses are not currently captured.

## Library and timeline

The **Songs** view provides title search, a newest-first list, and a detail panel with complete captured metadata.

The **Timeline** view shows daily creation counts as a calendar heatmap. Select a day to filter the same song list, use previous/next to change years, or clear the date filter to return to the full list.

Timeline grouping, date filters, and formatted timestamps use **America/Detroit**, including daylight saving time. Original timestamps remain unchanged in the database and raw JSON. Undated or invalid timestamps count toward the archive total but do not appear in daily buckets.

## SQL query tool

Open **http://127.0.0.1:4318/sql**, or use the **SQL query** navigation link.

Enter a read-only query, click **Run query**, or press **Ctrl+Enter** (**Cmd+Enter** on Mac). Results appear in a table and can be downloaded as CSV. All returned rows are loaded; add `LIMIT` yourself if desired. The tool handles strings, numbers, and nulls, reports SQL errors, and rejects archive writes.

SQLite JSON functions and the Detroit date helper are available. For example:

```sql
SELECT detroit_date(created_at) AS day, count(*) AS clips
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

Set configuration through shell environment variables:

- `PORT`: server port, default `4318`.
- `SUNO_DB`: SQLite path, default `data/songs.sqlite`.

Vite's API proxy targets port 4318 in `vite.config.js`; update it if changing the backend port. Reinstall the generated userscript if its receiver URL or ingress token changes.

The server binds only to `127.0.0.1`. Keep the database and generated userscript private: they contain captured song data and/or the local ingress token. Database files, `data/`, dependencies, build output, `.env` files, and `repomix-output.xml` are excluded from Git.
