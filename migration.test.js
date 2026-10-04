import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createReadStream, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';

const serverPath = fileURLToPath(new URL('./server.js', import.meta.url));
const fixturePath = fileURLToPath(new URL('./tests/test-db.sqlite', import.meta.url));
const originalColumns = ['id', 'title', 'user_id', 'created_at', 'model_name', 'status', 'raw_json', 'first_captured_at', 'updated_at'];
const promotedColumns = ['major_model_version', 'duration', 'is_public', 'play_count', 'upvote_count', 'task', 'is_remix', 'persona_id', 'tags', 'negative_tags'];
const personaColumns = ['name', 'persona_type', 'root_clip_id', 'image_s3_id', 'user_handle', 'is_owned', 'is_public'];
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const cleanups = new Map();
function workspace(t) {
  const directory = mkdtempSync(join(tmpdir(), 'suno-migration-'));
  const dbPath = join(directory, 'songs.sqlite');
  const callbacks = [];
  cleanups.set(directory, callbacks);
  t.after(async () => {
    try { for (const callback of callbacks.reverse()) await callback(); }
    finally { cleanups.delete(directory); rmSync(directory, { recursive: true, force: true }); }
  });
  return { directory, dbPath, cleanup: callback => callbacks.push(callback) };
}
function database(path, options = {}) { return new DatabaseSync(path, options); }
function backups(directory) { return readdirSync(directory).filter(name => /^songs\.sqlite\.backup-.*\.sqlite$/.test(name)); }
function version(db) { return db.prepare('PRAGMA user_version').get().user_version; }
function columns(db, table) { return db.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name); }
async function digest(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
function assertV2(db) {
  assert.equal(version(db), 2);
  assert.deepEqual(columns(db, 'songs'), [...originalColumns, ...promotedColumns]);
  assert.deepEqual(columns(db, 'personas'), ['id', ...personaColumns, 'updated_at']);
  const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='songs'").all().map(row => row.name);
  for (const name of ['songs_created_at', 'songs_user_id', 'songs_is_public', 'songs_major_model_version', 'songs_task', 'songs_persona_id']) assert.ok(indexes.includes(name), name);
  assert.ok(!indexes.some(name => /tags/.test(name)), 'no tag index');
}
function createV1(db, userVersion = 1) {
  db.exec(`CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE songs (id TEXT PRIMARY KEY, title TEXT, user_id TEXT, created_at TEXT,
      model_name TEXT, status TEXT, raw_json TEXT NOT NULL CHECK(json_valid(raw_json)),
      first_captured_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE INDEX songs_created_at ON songs(created_at);
    CREATE INDEX songs_user_id ON songs(user_id);
    PRAGMA user_version=${userVersion};`);
}
function legacySong(db, clip, created = '2025-01-01T00:00:00Z', updated = '2025-01-02T00:00:00Z') {
  db.prepare(`INSERT INTO songs (${originalColumns.join(', ')}) VALUES (${originalColumns.map(() => '?').join(', ')})`)
    .run(clip.id, clip.title ?? null, clip.user_id ?? null, created, clip.model_name ?? null, clip.status ?? null,
      JSON.stringify(clip), '2025-01-01T00:00:00Z', updated);
}
async function availablePort() {
  const probe = net.createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  return port;
}
async function start(t, directory, dbPath, { failure = false } = {}) {
  const port = await availablePort();
  const child = spawn(process.execPath, [serverPath], {
    cwd: directory, env: { ...process.env, PORT: String(port), SUNO_DB: dbPath, TIME_ZONE: 'UTC' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; }
  };
  cleanups.get(directory).push(stop);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Server startup timeout: ${stdout}\n${stderr}`)), 120000);
    const ready = () => {
      if (!failure && stdout.includes('Install in Violentmonkey:')) { clearTimeout(timer); resolve(); }
    };
    child.stdout.on('data', ready);
    child.once('exit', code => {
      clearTimeout(timer);
      if (failure && code !== 0) resolve();
      else reject(new Error(`Unexpected server exit ${code}: ${stdout}\n${stderr}`));
    });
    if (stdout.includes('Install in Violentmonkey:') && !failure) { clearTimeout(timer); resolve(); }
  });
  if (failure) assert.notEqual(child.exitCode, 0, stderr);
  return { base: `http://127.0.0.1:${port}`, output: () => stdout + '\n' + stderr, stop };
}
function expectedPromotion(clip) {
  const metadata = clip.metadata && typeof clip.metadata === 'object' && !Array.isArray(clip.metadata) ? clip.metadata : {};
  const persona = clip.persona && typeof clip.persona === 'object' && !Array.isArray(clip.persona) ? clip.persona : null;
  const personaId = metadata.persona_id ?? persona?.id;
  const str = value => typeof value === 'string' ? value : null;
  const num = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
  const int = value => typeof value === 'number' && Number.isSafeInteger(value) ? value : null;
  const bool = value => typeof value === 'boolean' ? Number(value) : value === 0 || value === 1 ? value : null;
  return {
    major_model_version: str(clip.major_model_version), duration: num(metadata.duration ?? clip.duration),
    is_public: bool(clip.is_public), play_count: int(clip.play_count ?? clip.reaction?.play_count),
    upvote_count: int(clip.upvote_count), task: str(metadata.task),
    is_remix: bool(metadata.is_remix),
    persona_id: str(personaId),
    tags: str(metadata.tags ?? clip.tags), negative_tags: str(metadata.negative_tags),
  };
}

 test('real v1 archive migrates without changing the original fixture and remains current on restart',
  { skip: !existsSync(fixturePath) && 'Private tests/test-db.sqlite fixture is not present in this checkout' }, async t => {
    const fixtureHash = await digest(fixturePath);
    t.after(async () => assert.equal(await digest(fixturePath), fixtureHash, 'original fixture bytes must remain unchanged'));
    const { directory, dbPath } = workspace(t);
    const source = database(fixturePath, { readOnly: true });
    try { await backup(source, dbPath); } finally { source.close(); }
    const before = database(dbPath, { readOnly: true });
    assert.equal(version(before), 0, 'unversioned legacy schema');
    assert.equal(before.prepare('SELECT count(*) AS n FROM songs').get().n, 13078);
    before.close();
    const service = await start(t, directory, dbPath);
    assert.match(service.output(), /schema version 0.*legacy/i);
    assert.match(service.output(), /migration v1.*v2/i);
    assert.match(service.output(), /backup:/i);
    assert.match(service.output(), /migration complete.*v2/i);
    const names = backups(directory);
    assert.equal(names.length, 1, 'one durable backup before migration');
    const archive = database(join(directory, names[0]), { readOnly: true });
    const migrated = database(dbPath, { readOnly: true });
    try {
      assertV2(migrated);
      assert.equal(version(archive), 0);
      const oldRows = archive.prepare(`SELECT ${originalColumns.join(', ')} FROM songs ORDER BY created_at, id`).iterate();
      const newRows = migrated.prepare('SELECT * FROM songs ORDER BY created_at, id').iterate();
      const personas = new Map();
      let count = 0;
      let nullDurations = 0;
      for (const oldRow of oldRows) {
        const next = newRows.next();
        assert.equal(next.done, false, 'every legacy song survives');
        const row = next.value;
        for (const column of originalColumns) assert.equal(row[column], oldRow[column], `preserved ${column} of ${oldRow.id}`);
        const clip = JSON.parse(oldRow.raw_json);
        const expected = expectedPromotion(clip);
        for (const column of promotedColumns) assert.equal(row[column], expected[column], `${oldRow.id}: ${column}`);
        if (row.duration === null) nullDurations++;
        const p = clip.persona;
        if (p && typeof p === 'object' && !Array.isArray(p) && typeof p.id === 'string' && uuid.test(p.id.trim())) {
          const id = p.id.trim().toLowerCase();
          const merged = personas.get(id) ?? { id };
          for (const key of personaColumns) {
            const value = key === 'is_owned' || key === 'is_public'
              ? typeof p[key] === 'boolean' ? Number(p[key]) : p[key] === 0 || p[key] === 1 ? p[key] : null
              : typeof p[key] === 'string' ? p[key] : null;
            if (value !== null) merged[key] = value;
          }
          merged.updated_at = oldRow.updated_at;
          personas.set(id, merged);
        }
        count++;
      }
      assert.equal(newRows.next().done, true, 'no new song IDs');
      assert.equal(count, 13078);
      assert.ok(nullDurations > 0, 'missing duration stays NULL');
      assert.equal(personas.size, 13);
      const actual = migrated.prepare('SELECT * FROM personas ORDER BY id').all();
      assert.equal(actual.length, personas.size);
      for (const row of actual) {
        const expected = personas.get(row.id);
        assert.ok(expected, `unexpected persona ${row.id}`);
        for (const key of [...personaColumns, 'updated_at']) assert.equal(row[key], expected[key] ?? null, `${row.id}: ${key}`);
      }
    } finally { migrated.close(); archive.close(); }
    await service.stop();
    const again = await start(t, directory, dbPath);
    assert.match(again.output(), /schema version 2.*current/i);
    assert.equal(backups(directory).length, 1, 'restart must not repeat backup');
    await again.stop();
  });

test('fresh archive creates v2 directly and does not back up on restart', async t => {
  const { directory, dbPath } = workspace(t);
  const service = await start(t, directory, dbPath);
  assert.match(service.output(), /schema version 0.*empty/i);
  const db = database(dbPath, { readOnly: true });
  try { assertV2(db); assert.equal(db.prepare('SELECT count(*) AS n FROM songs').get().n, 0); }
  finally { db.close(); }
  assert.deepEqual(backups(directory), []);
  await service.stop();
  const again = await start(t, directory, dbPath);
  assert.match(again.output(), /schema version 2.*current/i);
  assert.deepEqual(backups(directory), []);
  await again.stop();
});

test('an unversioned populated v1 schema migrates instead of being recreated', async t => {
  const { directory, dbPath } = workspace(t);
  const db = database(dbPath);
  createV1(db, 0);
  const clip = { id: 'unversioned', title: 'Keep this song', metadata: { duration: 12.5, is_remix: false } };
  legacySong(db, clip);
  db.close();
  const service = await start(t, directory, dbPath);
  assert.match(service.output(), /schema version 0.*legacy/i);
  const migrated = database(dbPath, { readOnly: true });
  try {
    assertV2(migrated);
    const row = migrated.prepare('SELECT id, raw_json, duration, is_remix FROM songs').get();
    assert.equal(row.id, clip.id);
    assert.equal(row.raw_json, JSON.stringify(clip));
    assert.equal(row.duration, 12.5);
    assert.equal(row.is_remix, 0);
  } finally { migrated.close(); }
  assert.equal(backups(directory).length, 1);
  await service.stop();
});

test('v1 backup includes committed uncheckpointed WAL data', async t => {
  const { directory, dbPath, cleanup } = workspace(t);
  const writer = database(dbPath);
  cleanup(() => writer.close());
  createV1(writer);
  writer.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; PRAGMA wal_checkpoint(TRUNCATE)');
  legacySong(writer, { id: 'wal-only', title: 'Durable WAL song', duration: 8 });
  assert.ok(statSync(`${dbPath}-wal`).size > 0, 'committed WAL pages exist');
  assert.equal(readFileSync(dbPath).includes(Buffer.from('wal-only')), false, 'row has not reached the main database file');
  const service = await start(t, directory, dbPath);
  const db = database(dbPath, { readOnly: true });
  const names = backups(directory);
  assert.equal(names.length, 1);
  const copy = database(join(directory, names[0]), { readOnly: true });
  try {
    assertV2(db);
    assert.equal(db.prepare("SELECT duration FROM songs WHERE id='wal-only'").get().duration, 8);
    assert.equal(version(copy), 1);
    assert.equal(copy.prepare("SELECT raw_json FROM songs WHERE id='wal-only'").get().raw_json,
      JSON.stringify({ id: 'wal-only', title: 'Durable WAL song', duration: 8 }));
  } finally { copy.close(); db.close(); }
  await service.stop();
});

test('failed late-row migration rolls back columns, personas, version and song changes but retains backup', async t => {
  const { directory, dbPath } = workspace(t);
  const db = database(dbPath);
  createV1(db);
  legacySong(db, { id: 'a-first', metadata: { duration: 4 } });
  legacySong(db, { id: 'z-break', metadata: { duration: 9 } }, '2025-01-03T00:00:00Z');
  db.exec("CREATE TRIGGER reject_second BEFORE UPDATE ON songs WHEN NEW.id='z-break' BEGIN SELECT RAISE(ABORT, 'injected migration failure'); END");
  const before = db.prepare('SELECT * FROM songs ORDER BY id').all();
  const originalSchema = db.prepare("SELECT type, name, sql FROM sqlite_master ORDER BY type, name").all();
  db.close();
  const service = await start(t, directory, dbPath, { failure: true });
  assert.match(service.output(), /injected migration failure/);
  assert.match(service.output(), /backup:/i);
  const after = database(dbPath, { readOnly: true });
  const names = backups(directory);
  assert.equal(names.length, 1, 'backup retained on failure');
  const copy = database(join(directory, names[0]), { readOnly: true });
  try {
    for (const archive of [after, copy]) {
      assert.equal(version(archive), 1);
      assert.deepEqual(columns(archive, 'songs'), originalColumns);
      assert.deepEqual(archive.prepare('SELECT * FROM songs ORDER BY id').all(), before);
      assert.deepEqual(archive.prepare("SELECT type, name, sql FROM sqlite_master ORDER BY type, name").all(), originalSchema);
      assert.equal(archive.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='personas'").get().n, 0);
    }
  } finally { copy.close(); after.close(); }
});

test('unknown schemas and future versions fail before schema or settings writes', async t => {
  for (const kind of ['future', 'unknown', 'bad-current']) {
    await t.test(kind, async inner => {
      const { directory, dbPath } = workspace(inner);
      const db = database(dbPath);
      if (kind === 'future' || kind === 'bad-current') {
        createV1(db, kind === 'future' ? 3 : 2);
        legacySong(db, { id: 'keep' });
      } else db.exec('CREATE TABLE unrelated (id TEXT PRIMARY KEY);');
      const schema = db.prepare("SELECT name, sql FROM sqlite_master WHERE type IN ('table', 'index') ORDER BY name").all();
      db.close();
      const service = await start(inner, directory, dbPath, { failure: true });
      assert.match(service.output(), /unsupported.*schema/i);
      assert.deepEqual(backups(directory), []);
      const unchanged = database(dbPath, { readOnly: true });
      try {
        assert.equal(version(unchanged), kind === 'future' ? 3 : kind === 'bad-current' ? 2 : 0);
        assert.deepEqual(unchanged.prepare("SELECT name, sql FROM sqlite_master WHERE type IN ('table', 'index') ORDER BY name").all(), schema);
        if (kind !== 'unknown') assert.equal(unchanged.prepare('SELECT count(*) AS n FROM songs').get().n, 1);
      } finally { unchanged.close(); }
    });
  }
});

test('ingest promotes typed fields and merges persona without erasing known values or backfilling unchanged clips', async t => {
  const { directory, dbPath, cleanup } = workspace(t);
  const db = database(dbPath);
  createV1(db);
  const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const seed = { id: 'existing', major_model_version: 'v4', is_public: true, play_count: 0, upvote_count: 3,
    metadata: { duration: 25, tags: 'original', is_remix: false, persona_id: id },
    persona: { id, name: 'Original', persona_type: 'voice', is_owned: false, is_public: true } };
  // Insert in the opposite order of (created_at, id); nulls on the newer row must not erase known fields.
  legacySong(db, { id: 'z-later', persona: { id, persona_type: 'voice-new', is_owned: false, is_public: false } },
    '2025-01-01T00:00:00Z', '2025-01-04T00:00:00Z');
  legacySong(db, seed);
  db.close();
  const service = await start(t, directory, dbPath);
  const inspect = database(dbPath, { readOnly: true });
  cleanup(() => inspect.close());
  const token = inspect.prepare("SELECT value FROM settings WHERE key='ingress_token'").get().value;
  const base = service.base;
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const settings = await fetch(base + '/api/settings', { method: 'PUT', headers, body: JSON.stringify({ user_id: null, ingest_mode: 'all', time_zone: 'UTC' }) });
  assert.equal(settings.status, 200);
  const post = async clips => {
    const response = await fetch(base + '/api/ingest', { method: 'POST', headers, body: JSON.stringify({ clips }) });
    assert.equal(response.status, 200);
    return response.json();
  };
  const first = inspect.prepare("SELECT * FROM songs WHERE id='existing'").get();
  assert.equal(first.is_public, 1); assert.equal(first.is_remix, 0); assert.equal(first.play_count, 0);
  assert.equal(first.persona_id, id);
  const observed = inspect.prepare('SELECT name, persona_type, is_owned, is_public, updated_at FROM personas WHERE id=?').get(id);
  assert.deepEqual([observed.name, observed.persona_type, observed.is_owned, observed.is_public, observed.updated_at],
    ['Original', 'voice-new', 0, 0, '2025-01-04T00:00:00Z']);
  const changed = { id: 'existing', duration: 42, is_public: false, play_count: null, reaction: { play_count: 0 },
    upvote_count: 7, tags: 'fallback', metadata: { duration: null, tags: null, negative_tags: 'avoid', persona_id: null, is_remix: true, task: 'remix' },
    persona: { id, name: null, persona_type: 'style', is_owned: null, is_public: false } };
  assert.equal((await post([changed])).updated, 1);
  const row = inspect.prepare("SELECT * FROM songs WHERE id='existing'").get();
  assert.deepEqual(promotedColumns.map(key => row[key]), [null, 42, 0, 0, 7, 'remix', 1, id, 'fallback', 'avoid']);
  assert.equal(row.first_captured_at, first.first_captured_at);
  assert.deepEqual(JSON.parse(row.raw_json), changed);
  const persona = inspect.prepare('SELECT * FROM personas WHERE id=?').get(id);
  assert.deepEqual([persona.name, persona.persona_type, persona.is_owned, persona.is_public], ['Original', 'style', 0, 0]);
  const reordered = { metadata: changed.metadata, persona: changed.persona, reaction: changed.reaction, tags: 'fallback',
    upvote_count: 7, play_count: null, is_public: false, duration: 42, id: 'existing' };
  assert.deepEqual(await post([reordered, changed]), { inserted: 0, updated: 0, unchanged: 1, skipped: 0, received: 2, unique: 1 });
  assert.deepEqual(inspect.prepare("SELECT * FROM songs WHERE id='existing'").get(), row);
  assert.deepEqual(inspect.prepare('SELECT * FROM personas WHERE id=?').get(id), persona);
  const rejected = await fetch(base + '/api/ingest', { method: 'POST', headers, body: JSON.stringify({ clips: [
    { ...changed, persona: { id, name: 'Must not be saved' } }, { title: 'No ID' },
  ] }) });
  assert.equal(rejected.status, 400);
  assert.deepEqual(inspect.prepare("SELECT * FROM songs WHERE id='existing'").get(), row);
  assert.deepEqual(inspect.prepare('SELECT * FROM personas WHERE id=?').get(id), persona);
  const invalid = { id: 'invalid-fields', duration: 'long', is_public: 'false', play_count: '4', upvote_count: 1.5,
    metadata: { is_remix: 'false', tags: ['not', 'text'], persona_id: 'not-a-uuid' },
    persona: { id: 'not-a-uuid', name: 'Reject' } };
  assert.equal((await post([invalid])).inserted, 1);
  const noValues = inspect.prepare("SELECT * FROM songs WHERE id='invalid-fields'").get();
  for (const key of promotedColumns.filter(key => key !== 'persona_id')) assert.equal(noValues[key], null, key);
  assert.equal(noValues.persona_id, 'not-a-uuid', 'invalid captured ID remains searchable without creating a persona');
  assert.equal(inspect.prepare('SELECT count(*) AS n FROM personas').get().n, 1);
  await service.stop();
});
