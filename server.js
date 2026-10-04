import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { readFile, realpath, stat } from 'node:fs/promises';
import { resolve, dirname, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// Usage: npm start; install http://127.0.0.1:4318/userscript.user.js in Violentmonkey.
// SUNO_DB and PORT override the database path and loopback port. No Suno credentials are stored.
if (process.argv.includes('--help')) {
  console.log(`Start: npm start (Node 24+)
Install in Violentmonkey: http://127.0.0.1:4318/userscript.user.js
Library UI: run npm install and npm run build, then open http://127.0.0.1:4318/.
UI development: keep npm start running, then npm run dev for Vite with the same local API.
Use Refresh to pick up newly captured songs; search matches titles and Load more fetches 100 summaries.
Select a song for full lyrics and metadata; Full captured JSON exposes every field without loading remote media.
The UI uses an independent process-local read-only token from GET /api/session.
SQL UI: open /sql to run one read-only SQLite statement and download all result rows as CSV.
POST /api/query accepts {sql:"SELECT ..."} with the library read token or persistent ingress token.
Results are {columns:[...],rows:[[...]]}, preserving strings, numbers, and nulls without pagination or a hidden limit.
SELECT and CTE queries support json_extract and detroit_date(timestamp); archive writes are rejected.
GET /api/library?limit=100&offset=0&q=title lists songs; GET /api/library/<id> returns all clip data.
GET /api/library/timeline returns America/Detroit day counts, first_date, last_date, and total (including undated songs).
Library from=YYYY-MM-DD is inclusive and to=YYYY-MM-DD is exclusive in America/Detroit; either is optional.
Date boundaries must be real calendar dates with from < to; dated queries omit unparseable/undated songs.
Then reload Suno once and browse Library manually. The adapter does not scroll or request songs.
Console prefix: [Suno collector]. Violentmonkey menu: status, pause/resume delivery, retry.
Offline captures persist in extension storage; retries contact only localhost every 15 seconds.
Configuration: SUNO_DB=./data/songs.sqlite PORT=4318
Storage: songs.id is the primary key; raw_json preserves every clip field, including metadata.prompt lyrics.
Identical JSON is a no-op; changed JSON replaces the same row. Different song IDs remain distinct.
GET /health returns a count. Authenticated GET /api/songs?limit=100&after=<id> exports full clips.
POST /api/ingest accepts {clips:[...]}, requires Content-Type: application/json and Authorization: Bearer <token>.
The persistent token is in settings under ingress_token and is embedded only in the generated install script.
Keep that script and the database private. Install on the same machine as the loopback receiver.
Only visible feed categories are captured; no claim of complete library coverage.
SQL example: SELECT title, json_extract(raw_json, '$.metadata.prompt') AS lyrics FROM songs;`);
  process.exit(0);
}
const port = Number(process.env.PORT || 4318);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT');
const dbPath = resolve(process.env.SUNO_DB || 'data/songs.sqlite');
mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 });
const db = new DatabaseSync(dbPath);
db.exec(`
  PRAGMA journal_mode=WAL;
  PRAGMA busy_timeout=5000;
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS songs (
    id TEXT PRIMARY KEY,
    title TEXT,
    user_id TEXT,
    created_at TEXT,
    model_name TEXT,
    status TEXT,
    raw_json TEXT NOT NULL CHECK(json_valid(raw_json)),
    first_captured_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS songs_created_at ON songs(created_at);
  CREATE INDEX IF NOT EXISTS songs_user_id ON songs(user_id);
`);
db.prepare('INSERT OR IGNORE INTO settings VALUES (?, ?)').run('ingress_token', randomBytes(32).toString('hex'));
const token = db.prepare('SELECT value FROM settings WHERE key=?').get('ingress_token').value;
const readToken = randomBytes(32).toString('hex');
const queryDb = new DatabaseSync(dbPath, { readOnly: true });
const distPath = fileURLToPath(new URL('./dist/', import.meta.url));
const dayFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Detroit', year: 'numeric', month: '2-digit', day: '2-digit',
});
function detroitDate(timestamp) {
  if (timestamp === null) return null;
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return null;
  let year, month, day;
  for (const part of dayFormatter.formatToParts(date)) {
    if (part.type === 'year') year = part.value;
    else if (part.type === 'month') month = part.value;
    else if (part.type === 'day') day = part.value;
  }
  return `${year.padStart(4, '0')}-${month}-${day}`;
}
for (const connection of [db, queryDb]) {
  connection.function('detroit_date', { deterministic: true }, detroitDate);
}
// Reject impossible stored dates; normalize to UTC before the explicit Detroit conversion.
const songDate = `CASE
  WHEN date(substr(created_at, 1, 10), '+0 days') = substr(created_at, 1, 10)
  THEN detroit_date(strftime('%Y-%m-%dT%H:%M:%fZ', created_at)) END`;
const libraryWhere = `coalesce(title, '') LIKE ? ESCAPE '\\'
  AND (? IS NULL OR ${songDate} >= ?)
  AND (? IS NULL OR ${songDate} < ?)`;
const libraryCount = db.prepare(`SELECT count(*) AS n FROM songs WHERE ${libraryWhere}`);
const totalCount = db.prepare('SELECT count(*) AS n FROM songs');
const timelineDays = db.prepare(`
  WITH dated AS MATERIALIZED (SELECT ${songDate} AS day FROM songs)
  SELECT day AS date, count(*) AS count
  FROM dated WHERE day IS NOT NULL
  GROUP BY day ORDER BY day ASC
`);
const libraryRows = db.prepare(`
  SELECT id, title, user_id, created_at, model_name, status,
    coalesce(json_extract(raw_json, '$.metadata.duration'), json_extract(raw_json, '$.duration')) AS duration,
    coalesce(json_extract(raw_json, '$.metadata.tags'), json_extract(raw_json, '$.tags')) AS tags
  FROM songs WHERE ${libraryWhere}
  ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?
`);
const librarySong = db.prepare('SELECT raw_json, first_captured_at, updated_at FROM songs WHERE id=?');
const base = `http://127.0.0.1:${port}`;
const getSong = db.prepare('SELECT raw_json FROM songs WHERE id=?');
const insert = db.prepare('INSERT INTO songs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
const update = db.prepare('UPDATE songs SET title=?, user_id=?, created_at=?, model_name=?, status=?, raw_json=?, updated_at=? WHERE id=?');
// Stable object ordering makes bytewise comparison independent of JSON key order.
function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value !== null && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  return JSON.stringify(value);
}
function text(value) { return typeof value === 'string' ? value : null; }
function ingest(clips) {
  if (!Array.isArray(clips) || clips.length > 1000) throw new Error('clips must be an array of at most 1000 songs');
  const unique = new Map();
  for (const clip of clips) {
    if (!clip || typeof clip !== 'object' || Array.isArray(clip) || typeof clip.id !== 'string' || !clip.id.trim() || clip.id.length > 200) throw new Error('Each clip requires a nonempty string id');
    unique.set(clip.id, clip);
  }
  const counts = { inserted: 0, updated: 0, unchanged: 0, received: clips.length, unique: unique.size };
  const now = new Date().toISOString();
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const clip of unique.values()) {
      const raw = canonical(clip);
      const existing = getSong.get(clip.id);
      const fields = [text(clip.title), text(clip.user_id), text(clip.created_at), text(clip.model_name), text(clip.status)];
      if (!existing) { insert.run(clip.id, ...fields, raw, now, now); counts.inserted++; }
      else if (existing.raw_json === raw) counts.unchanged++;
      else { update.run(...fields, raw, now, clip.id); counts.updated++; }
    }
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  return counts;
}
function authorized(req, expectedToken = token) {
  const supplied = Buffer.from(req.headers.authorization || '');
  const expected = Buffer.from(`Bearer ${expectedToken}`);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}
function send(res, status, data, contentType = 'application/json') {
  res.writeHead(status, {
    'Content-Type': contentType,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'same-origin',
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  });
  res.end(contentType === 'application/json' ? JSON.stringify(data) : data);
}
const assetTypes = {
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
};
async function serveUi(res, pathname) {
  const isIndex = pathname === '/' || pathname === '/sql';
  let relative;
  try { relative = isIndex ? 'index.html' : decodeURIComponent(pathname.slice(1)); }
  catch { return send(res, 400, { error: 'Invalid asset path' }); }
  if (relative.includes('\\') || relative.includes('\0') || relative.split('/').some(part => part === '.' || part === '..' || part === '')) {
    return send(res, 404, { error: 'Not found' });
  }
  const contentType = isIndex ? 'text/html; charset=utf-8' : assetTypes[extname(relative)];
  if (!contentType) return send(res, 404, { error: 'Not found' });
  try {
    const root = await realpath(distPath);
    const file = await realpath(resolve(root, relative));
    if (!file.startsWith(root + sep) || !(await stat(file)).isFile()) return send(res, 404, { error: 'Not found' });
    return send(res, 200, await readFile(file), contentType);
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') {
      return isIndex
        ? send(res, 503, 'Library UI is not built. Run npm install and npm run build, then reload this page.\n', 'text/plain; charset=utf-8')
        : send(res, 404, { error: 'Not found' });
    }
    throw error;
  }
}
function pageInteger(params, name, fallback, min, max) {
  const value = params.get(name);
  if (value === null) return fallback;
  if (!/^\d+$/.test(value)) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= min && number <= max ? number : null;
}
const server = http.createServer(async (req, res) => {
  // Host allowlisting prevents DNS rebinding. No CORS permission is granted to websites.
  if (![ `127.0.0.1:${port}`, `localhost:${port}` ].includes(req.headers.host)) return send(res, 403, { error: 'Invalid host' });
  const url = new URL(req.url, base);
  try {
    if (req.method === 'GET' && url.pathname === '/health') return send(res, 200, { ok: true, songs: db.prepare('SELECT count(*) AS n FROM songs').get().n });
    if (req.method === 'GET' && url.pathname === '/userscript.user.js') {
      const source = readFileSync(new URL('./suno-collector.user.js', import.meta.url), 'utf8').replaceAll('__INGRESS_TOKEN__', token).replaceAll('__INGRESS_BASE__', base);
      return send(res, 200, source, 'application/javascript; charset=utf-8');
    }
    if (req.method === 'GET' && url.pathname === '/api/session') {
      if (req.headers['sec-fetch-site'] === 'cross-site') return send(res, 403, { error: 'Cross-site session requests are forbidden' });
      return send(res, 200, { token: readToken });
    }
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/sql' || url.pathname.startsWith('/assets/'))) {
      return await serveUi(res, url.pathname);
    }
    if (req.method === 'GET' && (url.pathname === '/api/library' || url.pathname.startsWith('/api/library/'))) {
      if (!authorized(req, readToken) && !authorized(req)) return send(res, 401, { error: 'Bearer token required' });
      if (url.pathname === '/api/library/timeline') {
        const days = timelineDays.all();
        return send(res, 200, {
          days,
          first_date: days[0]?.date ?? null,
          last_date: days.at(-1)?.date ?? null,
          total: totalCount.get().n,
        });
      }
      if (url.pathname === '/api/library') {
        const limit = pageInteger(url.searchParams, 'limit', 100, 1, 200);
        const offset = pageInteger(url.searchParams, 'offset', 0, 0, Number.MAX_SAFE_INTEGER);
        if (limit === null || offset === null) return send(res, 400, { error: 'limit must be an integer 1..200; offset must be a nonnegative safe integer' });
        const from = url.searchParams.get('from');
        const to = url.searchParams.get('to');
        const validDate = value => value === null || (
          /^\d{4}-\d{2}-\d{2}$/.test(value) &&
          Number.isFinite(Date.parse(value + 'T00:00:00Z')) &&
          new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) === value
        );
        if (!validDate(from) || !validDate(to) || (from !== null && to !== null && from >= to)) {
          return send(res, 400, { error: 'from/to must be real YYYY-MM-DD calendar dates with from < to' });
        }
        const query = '%' + (url.searchParams.get('q') || '').replace(/[\\%_]/g, '\\$&') + '%';
        return send(res, 200, {
          songs: libraryRows.all(query, from, from, to, to, limit, offset),
          total: libraryCount.get(query, from, from, to, to).n,
          total_songs: totalCount.get().n,
        });
      }
      let id;
      try { id = decodeURIComponent(url.pathname.slice('/api/library/'.length)); }
      catch { return send(res, 400, { error: 'Invalid song id' }); }
      const row = librarySong.get(id);
      if (!row) return send(res, 404, { error: 'Song not found' });
      return send(res, 200, { clip: JSON.parse(row.raw_json), first_captured_at: row.first_captured_at, updated_at: row.updated_at });
    }
    const isQuery = req.method === 'POST' && url.pathname === '/api/query';
    if (isQuery) {
      if (!authorized(req, readToken) && !authorized(req)) return send(res, 401, { error: 'Bearer token required' });
    } else if (!authorized(req)) return send(res, 401, { error: 'Bearer token required' });
    if (req.method === 'GET' && url.pathname === '/api/songs') {
      const limit = Number(url.searchParams.get('limit') || 100);
      if (!Number.isInteger(limit) || limit < 1 || limit > 1000) return send(res, 400, { error: 'limit must be 1..1000' });
      const rows = db.prepare('SELECT id, raw_json FROM songs WHERE id > ? ORDER BY id LIMIT ?').all(url.searchParams.get('after') || '', limit);
      return send(res, 200, { clips: rows.map(row => JSON.parse(row.raw_json)), next_after: rows.length === limit ? rows.at(-1).id : null });
    }
    if (!isQuery && (req.method !== 'POST' || url.pathname !== '/api/ingest')) return send(res, 404, { error: 'Not found' });
    if (!(req.headers['content-type'] || '').startsWith('application/json')) return send(res, isQuery ? 400 : 415, { error: 'application/json required' });
    const chunks = []; let bytes = 0;
    for await (const chunk of req) {
      bytes += chunk.length;
      if (bytes > 8 * 1024 * 1024) return send(res, 413, { error: 'Maximum body size is 8 MiB' });
      chunks.push(chunk);
    }
    let body;
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { return send(res, 400, { error: 'Invalid JSON' }); }
    if (isQuery) {
      if (typeof body?.sql !== 'string' || !body.sql.trim() || body.sql.includes('\0')) {
        return send(res, 400, { error: 'sql must be a nonempty SQL string without null characters' });
      }
      try {
        const statement = queryDb.prepare(body.sql);
        // SQLite prepares only the first statement. Permit inert trailing comments and
        // separators, but never silently discard a second statement.
        const remaining = body.sql.slice(statement.sourceSQL.length);
        if (!/^(?:\s|;|--[^\r\n]*(?:\r?\n|$)|\/\*[\s\S]*?\*\/)*$/.test(remaining)) {
          return send(res, 400, { error: 'Run one SQL statement at a time' });
        }
        const columns = statement.columns().map(column => column.name);
        if (!columns.length) return send(res, 400, { error: 'Only read-only queries returning result columns are supported' });
        statement.setReturnArrays(true);
        const rows = statement.all();
        return send(res, 200, { columns, rows });
      } catch (error) {
        return send(res, 400, { error: error.message });
      }
    }
    try { return send(res, 200, ingest(body?.clips)); }
    catch (error) {
      if (error.message.startsWith('clips must') || error.message.startsWith('Each clip')) return send(res, 400, { error: error.message });
      throw error;
    }
  } catch (error) {
    console.error('Ingress error:', error.message);
    if (!res.headersSent) send(res, 500, { error: 'Local database error; delivery may be retried' });
  }
});
server.listen(port, '127.0.0.1', () => {
  console.log(`Collector: ${base}\nDatabase: ${dbPath}\nInstall in Violentmonkey: ${base}/userscript.user.js`);
});
function shutdown() { server.close(() => { queryDb.close(); db.close(); process.exit(0); }); }
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
