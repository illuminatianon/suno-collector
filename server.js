import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { initializeSchema, extractClip, preparePersonaUpsert, promotedNames } from './migrations.js';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, existsSync } from 'node:fs';
import { readFile, realpath, stat } from 'node:fs/promises';
import { resolve, dirname, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnvFile } from 'node:process';

// Usage: npm start; install http://127.0.0.1:4318/userscript.user.js in a compatible userscript extension.
// Optional .env configures the initial TIME_ZONE, SUNO_DB and PORT; existing shell values take precedence.
if (process.argv.includes('--help')) {
  console.log(`Start: npm start (Node 24+)
Install generated /userscript.user.js in a compatible userscript extension (e.g. Violentmonkey); update old v1.0.0 installs to v1.1.0.
Library UI: run npm install and npm run build, then open http://127.0.0.1:4318/.
UI development: keep npm start running, then npm run dev for Vite with the same local API.
Use Refresh to pick up newly captured songs; search matches titles, lyrics and style tags. Filters combine with search and Load more fetches 100 summaries.
Select a song for full lyrics and metadata; Full captured JSON exposes every field without loading remote media.
The UI uses an independent process-local session token from GET /api/session; it can edit settings but cannot ingest songs.
SQL UI: open /sql to run one read-only SQLite statement and download all result rows as CSV.
POST /api/query accepts {sql:"SELECT ..."} with the library read token or persistent ingress token.
Results are {columns:[...],rows:[[...]]}, preserving strings, numbers, and nulls without pagination or a hidden limit.
SELECT and CTE queries support json_extract and local_date(timestamp); archive writes are rejected.
GET /api/library?limit=100&offset=0&q=text lists songs; GET /api/library/<id> returns all clip data.
Library filters: model, major_model_version, task and status exact; user and persona substring;
visibility=public|private, remix=yes|no, min_duration/max_duration (seconds), min_plays/min_likes.
GET /api/config returns {time_zone} with the library read token or persistent ingress token.
GET/PUT /api/settings reads or saves Suno User ID, ingest mode and time zone with either bearer token.
Open /settings to set a Suno User ID and capture mode before first ingest.
Default Owned blocks delivery with HTTP 409 until an ID is saved; the extension retains the batch.
Remixed also keeps known outside source clips referenced by your owned remixes; All keeps every delivered clip.
The ingest policy applies to future deliveries only; skipped clips must be recaptured if needed later.
GET /api/library/timeline returns configured local day counts/public_count, first_date, last_date, and total (including undated songs).
Library from=YYYY-MM-DD is inclusive and to=YYYY-MM-DD is exclusive in the saved time zone; either is optional.
Date boundaries must be real calendar dates with from < to; dated queries omit unparseable/undated songs.
Then reload Suno once and browse Library manually. The adapter does not scroll or request songs.
Console prefix: [Suno collector]. Violentmonkey menu: status, pause/resume delivery, retry.
Offline captures persist in extension storage; retries contact only localhost every 15 seconds.
Configuration: optional .env in the working directory; shell values take precedence for bootstrap.
TIME_ZONE=America/Detroit (first-run seed only) SUNO_DB=./data/songs.sqlite PORT=4318
After first run, the saved time zone in SQLite wins; change it in Settings without restarting.
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
try {
  loadEnvFile();
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
function formatterFor(zone) {
  if (typeof zone !== 'string' || !zone || /^[+-]/.test(zone)) throw new RangeError('Not an IANA timezone');
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
  });
}
function initialTimeZone() {
  const zone = process.env.TIME_ZONE ?? 'America/Detroit';
  try { formatterFor(zone); }
  catch { throw new Error(`Invalid TIME_ZONE ${JSON.stringify(zone)}: expected a valid IANA timezone (for example America/Detroit or UTC)`); }
  return zone;
}
// Keep invalid first-run configuration from creating a new archive.
const firstRunZone = existsSync(resolve(process.env.SUNO_DB || 'data/songs.sqlite')) ? null : initialTimeZone();
const port = Number(process.env.PORT || 4318);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT');
const dbPath = resolve(process.env.SUNO_DB || 'data/songs.sqlite');
mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 });
const db = new DatabaseSync(dbPath);
db.exec('PRAGMA busy_timeout=5000');
await initializeSchema(db, dbPath);
db.exec('PRAGMA journal_mode=WAL');
const setting = db.prepare('SELECT value FROM settings WHERE key=?');
const storeSetting = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
const storedZone = setting.get('time_zone')?.value;
const initialZone = storedZone ?? firstRunZone ?? initialTimeZone();
let dayFormatter = formatterFor(initialZone);
db.prepare('INSERT OR IGNORE INTO settings VALUES (?, ?)').run('time_zone', initialZone);
let settings = {
  user_id: setting.get('user_id')?.value || null,
  ingest_mode: setting.get('ingest_mode')?.value ?? 'owned',
  time_zone: setting.get('time_zone').value,
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function normalizedId(value) { return typeof value === 'string' && uuid.test(value.trim()) ? value.trim().toLowerCase() : null; }
function validateSettings(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body) ||
      Object.keys(body).sort().join(',') !== 'ingest_mode,time_zone,user_id') throw new Error('Supply exactly user_id, ingest_mode and time_zone');
  const blankId = body.user_id === null || typeof body.user_id === 'string' && !body.user_id.trim();
  const userId = blankId ? null : normalizedId(body.user_id);
  if (userId === null && !blankId) throw new Error('user_id must be a UUID or null');
  if (!['owned', 'remixed', 'all'].includes(body.ingest_mode)) throw new Error('ingest_mode must be owned, remixed or all');
  if (body.ingest_mode !== 'all' && !userId) throw new Error('Enter a Suno User ID before choosing Owned or Remixed');
  if (typeof body.time_zone !== 'string' || body.time_zone !== body.time_zone.trim()) throw new Error('time_zone must be a valid IANA timezone');
  try { formatterFor(body.time_zone); }
  catch { throw new Error('time_zone must be a valid IANA timezone'); }
  return { user_id: userId, ingest_mode: body.ingest_mode, time_zone: body.time_zone };
}
function saveSettings(next) {
  const formatter = formatterFor(next.time_zone);
  db.exec('BEGIN IMMEDIATE');
  try {
    storeSetting.run('user_id', next.user_id ?? '');
    storeSetting.run('ingest_mode', next.ingest_mode);
    storeSetting.run('time_zone', next.time_zone);
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  if (settings.user_id !== next.user_id || settings.ingest_mode !== next.ingest_mode) remixSources = null;
  settings = next;
  dayFormatter = formatter;
}
db.prepare('INSERT OR IGNORE INTO settings VALUES (?, ?)').run('ingress_token', randomBytes(32).toString('hex'));
const token = db.prepare('SELECT value FROM settings WHERE key=?').get('ingress_token').value;
const readToken = randomBytes(32).toString('hex');
const queryDb = new DatabaseSync(dbPath, { readOnly: true });
const distPath = fileURLToPath(new URL('./dist/', import.meta.url));
function localDate(timestamp) {
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
  connection.function('local_date', localDate);
}
// Reject impossible stored dates; normalize to UTC before the configured local conversion.
const songDate = `CASE
  WHEN date(substr(created_at, 1, 10), '+0 days') = substr(created_at, 1, 10)
  THEN local_date(strftime('%Y-%m-%dT%H:%M:%fZ', created_at)) END`;
const libraryWhere = `(
  coalesce(title, '') LIKE :q ESCAPE '\\'
  OR json_extract(raw_json, '$.metadata.prompt') LIKE :q ESCAPE '\\'
  OR json_extract(raw_json, '$.metadata.lyrics') LIKE :q ESCAPE '\\'
  OR json_extract(raw_json, '$.metadata.lyric') LIKE :q ESCAPE '\\'
  OR json_extract(raw_json, '$.metadata.display_lyrics') LIKE :q ESCAPE '\\'
  OR json_extract(raw_json, '$.metadata.full_lyrics') LIKE :q ESCAPE '\\'
  OR json_extract(raw_json, '$.lyrics') LIKE :q ESCAPE '\\'
  OR json_extract(raw_json, '$.lyric') LIKE :q ESCAPE '\\'
  OR json_extract(raw_json, '$.prompt') LIKE :q ESCAPE '\\'
  OR json_extract(raw_json, '$.display_lyrics') LIKE :q ESCAPE '\\'
  OR json_extract(raw_json, '$.full_lyrics') LIKE :q ESCAPE '\\'
  OR coalesce(tags, '') LIKE :q ESCAPE '\\'
  OR coalesce(negative_tags, '') LIKE :q ESCAPE '\\'
)
  AND (:from IS NULL OR ${songDate} >= :from)
  AND (:to IS NULL OR ${songDate} < :to)
  AND (:model IS NULL OR model_name = :model)
  AND (:major_model_version IS NULL OR major_model_version = :major_model_version)
  AND (:task IS NULL OR task = :task)
  AND (:status IS NULL OR status = :status)
  AND (:visibility IS NULL OR is_public = :visibility)
  AND (:remix IS NULL OR is_remix = :remix)
  AND (:user IS NULL OR coalesce(user_id, '') LIKE :user ESCAPE '\\')
  AND (:persona IS NULL OR coalesce(persona_id, '') LIKE :persona ESCAPE '\\')
  AND (:min_duration IS NULL OR duration >= :min_duration)
  AND (:max_duration IS NULL OR duration <= :max_duration)
  AND (:min_plays IS NULL OR play_count >= :min_plays)
  AND (:min_likes IS NULL OR upvote_count >= :min_likes)`;
const libraryCount = db.prepare(`SELECT count(*) AS n FROM songs WHERE ${libraryWhere}`);
const totalCount = db.prepare('SELECT count(*) AS n FROM songs');
const timelineDays = db.prepare(`
  WITH dated AS MATERIALIZED (SELECT ${songDate} AS day, is_public FROM songs)
  SELECT day AS date, count(*) AS count, sum(CASE WHEN is_public = 1 THEN 1 ELSE 0 END) AS public_count
  FROM dated WHERE day IS NOT NULL
  GROUP BY day ORDER BY day ASC
`);
const libraryRows = db.prepare(`
  SELECT id, title, user_id, created_at, model_name, status, duration, tags
  FROM songs WHERE ${libraryWhere}
  ORDER BY created_at DESC, id DESC LIMIT :limit OFFSET :offset
`);
const librarySong = db.prepare('SELECT raw_json, persona_id, first_captured_at, updated_at FROM songs WHERE id=?');
const libraryPersona = db.prepare('SELECT * FROM personas WHERE id=?');
const base = `http://127.0.0.1:${port}`;
const getSong = db.prepare('SELECT raw_json FROM songs WHERE id=?');
const ownedRemixes = db.prepare('SELECT id, raw_json FROM songs WHERE lower(trim(user_id))=?');
const insert = db.prepare(`INSERT INTO songs
  (id, title, user_id, created_at, model_name, status, raw_json, first_captured_at, updated_at, ${promotedNames.join(', ')})
  VALUES (${Array(9 + promotedNames.length).fill('?').join(', ')})`);
const update = db.prepare(`UPDATE songs SET title=?, user_id=?, created_at=?, model_name=?, status=?,
  raw_json=?, updated_at=?, ${promotedNames.map(name => `${name}=?`).join(', ')} WHERE id=?`);
const upsertPersona = preparePersonaUpsert(db);
let remixSources = null;
function remixReferences(clip) {
  const refs = new Set();
  if (clip.metadata?.is_remix === true) {
    for (const key of ['cover_clip_id', 'edited_clip_id']) {
      if (typeof clip.metadata[key] === 'string' && clip.metadata[key]) refs.add(clip.metadata[key]);
    }
  }
  return refs;
}
function sourceReferences() {
  if (remixSources) return remixSources;
  const owned = new Map();
  const counts = new Map();
  for (const row of ownedRemixes.iterate(settings.user_id)) {
    const refs = remixReferences(JSON.parse(row.raw_json));
    if (refs.size) owned.set(row.id, refs);
    for (const id of refs) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return remixSources = { owned, counts };
}
function replaceReferences(cache, id, refs) {
  for (const source of cache.owned.get(id) ?? []) {
    const count = cache.counts.get(source);
    if (count === 1) cache.counts.delete(source);
    else cache.counts.set(source, count - 1);
  }
  if (refs.size) cache.owned.set(id, refs);
  else cache.owned.delete(id);
  for (const source of refs) cache.counts.set(source, (cache.counts.get(source) ?? 0) + 1);
}
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
  const counts = { inserted: 0, updated: 0, unchanged: 0, skipped: 0, received: clips.length, unique: unique.size };
  const now = new Date().toISOString();
  const owner = settings.user_id;
  const mode = settings.ingest_mode;
  const cache = mode === 'remixed' ? sourceReferences() : null;
  // Resolve references against the final state of this batch, including updates that remove a source.
  const batchRefs = cache ? new Map(cache.counts) : null;
  if (cache) {
    for (const clip of unique.values()) {
      if (normalizedId(clip.user_id) !== owner) continue;
      for (const id of cache.owned.get(clip.id) ?? []) {
        const count = batchRefs.get(id);
        if (count === 1) batchRefs.delete(id);
        else batchRefs.set(id, count - 1);
      }
      for (const id of remixReferences(clip)) batchRefs.set(id, (batchRefs.get(id) ?? 0) + 1);
    }
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const clip of unique.values()) {
      const isOwned = normalizedId(clip.user_id) === owner;
      if (mode !== 'all' && !isOwned && (mode === 'owned' || !batchRefs.has(clip.id))) {
        counts.skipped++;
        continue;
      }
      const raw = canonical(clip);
      const existing = getSong.get(clip.id);
      const fields = [text(clip.title), text(clip.user_id), text(clip.created_at), text(clip.model_name), text(clip.status)];
      if (existing?.raw_json === raw) { counts.unchanged++; continue; }
      const { fields: promoted, personaFields } = extractClip(clip);
      if (!existing) { insert.run(clip.id, ...fields, raw, now, now, ...promoted); counts.inserted++; }
      else { update.run(...fields, raw, now, ...promoted, clip.id); counts.updated++; }
      if (personaFields) upsertPersona.run(...personaFields, now);
      if (cache && isOwned) replaceReferences(cache, clip.id, remixReferences(clip));
    }
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); remixSources = null; throw error; }
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
  const isIndex = pathname === '/' || pathname === '/sql' || pathname === '/settings';
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
function literalLike(value) { return '%' + value.replace(/[\\%_]/g, '\\$&') + '%'; }
function optionalText(params, name) {
  const value = params.get(name);
  return value === null || (value.trim().length > 0 && value.length <= 200) ? value : false;
}
function durationParam(params, name) {
  const value = params.get(name);
  if (value === null) return null;
  if (!/^\d+(?:\.\d+)?$/.test(value)) return false;
  const number = Number(value);
  return Number.isFinite(number) && number <= Number.MAX_SAFE_INTEGER ? number : false;
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
    if (req.method === 'GET' && url.pathname === '/api/config') {
      if (!authorized(req, readToken) && !authorized(req)) return send(res, 401, { error: 'Bearer token required' });
      return send(res, 200, { time_zone: settings.time_zone });
    }
    if (req.method === 'GET' && url.pathname === '/api/settings') {
      if (!authorized(req, readToken) && !authorized(req)) return send(res, 401, { error: 'Bearer token required' });
      return send(res, 200, settings);
    }
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/sql' || url.pathname === '/settings' || url.pathname.startsWith('/assets/'))) {
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
        const textFilters = Object.fromEntries(['model', 'major_model_version', 'task', 'status', 'user', 'persona']
          .map(name => [name, optionalText(url.searchParams, name)]));
        const visibility = url.searchParams.get('visibility');
        const remix = url.searchParams.get('remix');
        const min_duration = durationParam(url.searchParams, 'min_duration');
        const max_duration = durationParam(url.searchParams, 'max_duration');
        const min_plays = pageInteger(url.searchParams, 'min_plays', null, 0, Number.MAX_SAFE_INTEGER);
        const min_likes = pageInteger(url.searchParams, 'min_likes', null, 0, Number.MAX_SAFE_INTEGER);
        if (Object.values(textFilters).includes(false) ||
            (visibility !== null && visibility !== 'public' && visibility !== 'private') ||
            (remix !== null && remix !== 'yes' && remix !== 'no') ||
            min_duration === false || max_duration === false ||
            (min_duration !== null && max_duration !== null && min_duration > max_duration) ||
            (url.searchParams.has('min_plays') && min_plays === null) ||
            (url.searchParams.has('min_likes') && min_likes === null)) {
          return send(res, 400, { error: 'Invalid library filter' });
        }
        const filters = {
          q: literalLike(url.searchParams.get('q') || ''), from, to,
          ...textFilters,
          user: textFilters.user === null ? null : literalLike(textFilters.user),
          persona: textFilters.persona === null ? null : literalLike(textFilters.persona),
          visibility: visibility === null ? null : Number(visibility === 'public'),
          remix: remix === null ? null : Number(remix === 'yes'),
          min_duration, max_duration, min_plays, min_likes,
        };
        return send(res, 200, {
          songs: libraryRows.all({ ...filters, limit, offset }),
          total: libraryCount.get(filters).n,
          total_songs: totalCount.get().n,
        });
      }
      let id;
      try { id = decodeURIComponent(url.pathname.slice('/api/library/'.length)); }
      catch { return send(res, 400, { error: 'Invalid song id' }); }
      const row = librarySong.get(id);
      if (!row) return send(res, 404, { error: 'Song not found' });
      const clip = JSON.parse(row.raw_json);
      const personaId = normalizedId(row.persona_id) ?? normalizedId(clip.persona?.id);
      return send(res, 200, {
        clip, first_captured_at: row.first_captured_at, updated_at: row.updated_at,
        persona: personaId ? libraryPersona.get(personaId) ?? null : null,
      });
    }
    const isQuery = req.method === 'POST' && url.pathname === '/api/query';
    const isSettings = req.method === 'PUT' && url.pathname === '/api/settings';
    if (isQuery || isSettings) {
      if (!authorized(req, readToken) && !authorized(req)) return send(res, 401, { error: 'Bearer token required' });
    } else if (!authorized(req)) return send(res, 401, { error: 'Bearer token required' });
    if (req.method === 'GET' && url.pathname === '/api/songs') {
      const limit = Number(url.searchParams.get('limit') || 100);
      if (!Number.isInteger(limit) || limit < 1 || limit > 1000) return send(res, 400, { error: 'limit must be 1..1000' });
      const rows = db.prepare('SELECT id, raw_json FROM songs WHERE id > ? ORDER BY id LIMIT ?').all(url.searchParams.get('after') || '', limit);
      return send(res, 200, { clips: rows.map(row => JSON.parse(row.raw_json)), next_after: rows.length === limit ? rows.at(-1).id : null });
    }
    if (!isQuery && !isSettings && (req.method !== 'POST' || url.pathname !== '/api/ingest')) return send(res, 404, { error: 'Not found' });
    if (!isQuery && !isSettings && settings.ingest_mode !== 'all' && !settings.user_id) {
      return send(res, 409, { error: 'Set a Suno User ID in Settings, or choose All, before delivering captured songs. Pending batches can be retried.' });
    }
    if (!(req.headers['content-type'] || '').startsWith('application/json')) return send(res, isQuery || isSettings ? 400 : 415, { error: 'application/json required' });
    const chunks = []; let bytes = 0;
    for await (const chunk of req) {
      bytes += chunk.length;
      if (bytes > 8 * 1024 * 1024) return send(res, 413, { error: 'Maximum body size is 8 MiB' });
      chunks.push(chunk);
    }
    let body;
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { return send(res, 400, { error: 'Invalid JSON' }); }
    if (isSettings) {
      let next;
      try { next = validateSettings(body); }
      catch (error) { return send(res, 400, { error: error.message }); }
      saveSettings(next);
      return send(res, 200, settings);
    }
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
