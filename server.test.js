import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import net from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

 test('real SQLite ingress preserves full data and never creates duplicate songs', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'suno-test-'));
  const probe = net.createServer();
  probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const dbPath = join(directory, 'songs.sqlite');
  const child = spawn(process.execPath, ['server.js'], { env: { ...process.env, TIME_ZONE: 'America/Detroit', PORT: String(port), SUNO_DB: dbPath }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', data => { stderr += data; });
  t.after(async () => {
    if (child.exitCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; }
    rmSync(directory, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Server startup timeout: ' + stderr)), 10000);
    child.stdout.on('data', data => { if (String(data).includes('Install in Violentmonkey:')) { clearTimeout(timer); resolve(); } });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`Server exited ${code}: ${stderr}`)); });
  });
  const base = `http://127.0.0.1:${port}`;
  const readDb = new DatabaseSync(dbPath);
  const token = readDb.prepare("SELECT value FROM settings WHERE key='ingress_token'").get().value;
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
  const post = clips => fetch(base + '/api/ingest', { method: 'POST', headers, body: JSON.stringify({ clips }) });
  const clip = { id: 'song-1', title: 'Full song', metadata: { prompt: '[intro]\nLyrics with unicode: café 🎵\n[outro]', tags: 'synthwave', control_sliders: { style_weight: 0.66 }, nested: [1, null, { extra: true }] }, audio_url: 'https://example.invalid/audio', unknown_future_field: { keep: 'everything' } };
  await t.test('complete nested data round-trips', async () => {
    assert.deepEqual(await (await post([clip])).json(), { inserted: 1, updated: 0, unchanged: 0, received: 1, unique: 1 });
    const response = await fetch(base + '/api/songs', { headers });
    assert.deepEqual((await response.json()).clips, [clip]);
  });
  await t.test('reordered JSON and repeated IDs are no-ops, including concurrent deliveries', async () => {
    const reordered = { unknown_future_field: clip.unknown_future_field, audio_url: clip.audio_url, metadata: { ...clip.metadata, nested: clip.metadata.nested }, title: clip.title, id: clip.id };
    const responses = await Promise.all(Array.from({ length: 8 }, () => post([reordered, clip])));
    for (const response of responses) assert.deepEqual(await response.json(), { inserted: 0, updated: 0, unchanged: 1, received: 2, unique: 1 });
    assert.equal(readDb.prepare('SELECT count(*) AS n FROM songs').get().n, 1);
  });
  await t.test('changes replace the same row and retain original capture time', async () => {
    const before = readDb.prepare('SELECT first_captured_at FROM songs').get().first_captured_at;
    const changed = { ...clip, title: 'Renamed', metadata: { ...clip.metadata, prompt: 'New lyrics' } };
    assert.equal((await (await post([changed])).json()).updated, 1);
    assert.deepEqual((await (await fetch(base + '/api/songs', { headers })).json()).clips, [changed]);
    assert.equal(readDb.prepare('SELECT count(*) AS n FROM songs').get().n, 1);
    assert.equal(readDb.prepare('SELECT first_captured_at FROM songs').get().first_captured_at, before);
  });
  await t.test('invalid batch is atomic and unauthenticated writes are rejected', async () => {
    assert.equal((await post([{ id: 'should-not-exist' }, { title: 'missing id' }])).status, 400);
    assert.equal(readDb.prepare('SELECT count(*) AS n FROM songs').get().n, 1);
    assert.equal((await fetch(base + '/api/ingest', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ clips: [clip] }) })).status, 401);
  });
  await t.test('library read token cannot mutate and detail preserves nested metadata', async () => {
    const session = await (await fetch(base + '/api/session')).json();
    const readHeaders = { Authorization: `Bearer ${session.token}`, 'Content-Type': 'application/json' };
    assert.notEqual(session.token, token);
    assert.equal((await fetch(base + '/api/library')).status, 401);
    assert.equal((await fetch(base + '/api/ingest', { method: 'POST', headers: readHeaders, body: JSON.stringify({ clips: [{ id: 'forbidden' }] }) })).status, 401);
    const detail = await (await fetch(base + '/api/library/song-1', { headers: readHeaders })).json();
    assert.deepEqual(detail.clip, { ...clip, title: 'Renamed', metadata: { ...clip.metadata, prompt: 'New lyrics' } });
    assert.equal(detail.first_captured_at, readDb.prepare('SELECT first_captured_at FROM songs WHERE id=?').get('song-1').first_captured_at);
    assert.equal((await fetch(base + '/api/library/missing', { headers: readHeaders })).status, 404);
    assert.equal((await fetch(base + '/api/session', { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  });
  await t.test('library pagination is newest first, distinct IDs survive, search treats wildcards literally', async () => {
    await post([
      { id: 'library-a', title: 'Mix 100%_Pure', created_at: '2025-01-01T00:00:00Z', metadata: { duration: 123.4, tags: 'EDM' } },
      { id: 'library-b', title: 'Same title', created_at: '2026-01-01T00:00:00Z' },
      { id: 'library-c', title: 'Same title', created_at: '2026-01-01T00:00:00Z' },
      { id: 'library-d', title: 'Mix 100XXPure', created_at: '2024-01-01T00:00:00Z' }
    ]);
    const session = await (await fetch(base + '/api/session')).json();
    const readHeaders = { Authorization: `Bearer ${session.token}` };
    const get = path => fetch(base + path, { headers: readHeaders });
    const page1 = await (await get('/api/library?limit=1')).json();
    const page2 = await (await get('/api/library?limit=1&offset=1')).json();
    assert.equal(page1.songs[0].id, 'library-c');
    assert.equal(page2.songs[0].id, 'library-b');
    assert.equal(page1.total, 5);
    const matches = await (await get('/api/library?q=' + encodeURIComponent('%_'))).json();
    assert.equal(matches.total, 1);
    assert.equal(matches.total_songs, 5);
    assert.equal(matches.songs[0].id, 'library-a');
    assert.equal(matches.songs[0].duration, 123.4);
    assert.equal(matches.songs[0].tags, 'EDM');
    for (const query of ['limit=0', 'limit=201', 'offset=-1', 'offset=1.5']) {
      assert.equal((await get('/api/library?' + query)).status, 400);
    }
  });
  readDb.close();
});

test('Detroit timeline and date-filtered library agree for an isolated archive', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'suno-timeline-test-'));
  const probe = net.createServer();
  probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const dbPath = join(directory, 'songs.sqlite');
  const child = spawn(process.execPath, ['server.js'], { env: { ...process.env, TIME_ZONE: 'America/Detroit', TZ: 'Asia/Tokyo', PORT: String(port), SUNO_DB: dbPath }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', data => { stderr += data; });
  let readDb;
  t.after(async () => {
    readDb?.close();
    if (child.exitCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; }
    rmSync(directory, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Server startup timeout: ' + stderr)), 10000);
    child.stdout.on('data', data => { if (String(data).includes('Install in Violentmonkey:')) { clearTimeout(timer); resolve(); } });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`Server exited ${code}: ${stderr}`)); });
  });
  const base = `http://127.0.0.1:${port}`;
  readDb = new DatabaseSync(dbPath);
  const token = readDb.prepare("SELECT value FROM settings WHERE key='ingress_token'").get().value;
  const ingressHeaders = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
  const session = await (await fetch(base + '/api/session')).json();
  const readHeaders = { Authorization: `Bearer ${session.token}` };
  const get = path => fetch(base + path, { headers: readHeaders });
  const library = async query => {
    const response = await get('/api/library?' + query);
    assert.equal(response.status, 200);
    return response.json();
  };

  await t.test('timeline uses existing read authorization and handles an empty archive', async () => {
    assert.equal((await fetch(base + '/api/library/timeline')).status, 401);
    assert.equal((await fetch(base + '/api/library/timeline', { headers: { Authorization: 'Bearer incorrect' } })).status, 401);
    assert.equal((await fetch(base + '/api/library?from=2024-01-01')).status, 401);
    const expected = { days: [], first_date: null, last_date: null, total: 0 };
    assert.deepEqual(await (await get('/api/library/timeline')).json(), expected);
    assert.deepEqual(await (await fetch(base + '/api/library/timeline', { headers: ingressHeaders })).json(), expected);
  });

  const clips = [
    { id: 'year-before', title: 'Year end', created_at: '2024-01-01T04:59:59Z' },
    { id: 'year-after', title: 'Year start', created_at: '2024-01-01T05:00:00Z' },
    { id: 'offset-back', title: 'Detroit previous year', created_at: '2024-01-01T04:30:00+01:00' },
    { id: 'leap-before', title: 'Pulse', created_at: '2024-02-29T04:59:59.999Z' },
    { id: 'leap-start', title: 'Pulse', created_at: '2024-02-29T05:00:00Z' },
    { id: 'leap-late', title: 'Pulse', created_at: '2024-03-01T04:59:59.999Z' },
    { id: 'offset-forward', title: 'Detroit following day', created_at: '2024-02-29T23:30:00-06:00' },
    { id: 'march-start', title: 'March', created_at: '2024-03-01T05:00:00Z' },
    { id: 'null-date', title: 'Unknown', created_at: null },
    { id: 'missing-date', title: 'Unknown' },
    { id: 'malformed-date', title: 'Unknown', created_at: 'not-a-timestamp' },
    { id: 'invalid-date', title: 'Unknown', created_at: '2024-02-30T00:00:00Z' },
  ];
  const response = await fetch(base + '/api/ingest', { method: 'POST', headers: ingressHeaders, body: JSON.stringify({ clips }) });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).inserted, clips.length);

  await t.test('aggregation returns ordered Detroit dates independently of server timezone', async () => {
    const timeline = await (await get('/api/library/timeline')).json();
    assert.deepEqual(timeline, {
      days: [
        { date: '2023-12-31', count: 2 },
        { date: '2024-01-01', count: 1 },
        { date: '2024-02-28', count: 1 },
        { date: '2024-02-29', count: 2 },
        { date: '2024-03-01', count: 2 },
      ],
      first_date: '2023-12-31',
      last_date: '2024-03-01',
      total: 12,
    });
    for (const day of timeline.days) {
      const next = new Date(day.date + 'T00:00:00Z');
      next.setUTCDate(next.getUTCDate() + 1);
      const page = await library(`from=${day.date}&to=${next.toISOString().slice(0, 10)}`);
      assert.equal(page.total, day.count);
      assert.equal(page.total_songs, 12);
    }
    const yearEnd = await library('from=2023-12-31&to=2024-01-01');
    assert.deepEqual(yearEnd.songs.map(song => song.id).sort(), ['offset-back', 'year-before']);
    const march = await library('from=2024-03-01&to=2024-03-02');
    assert.deepEqual(march.songs.map(song => song.id).sort(), ['march-start', 'offset-forward']);
  });

  await t.test('optional boundaries exclude unknown dates only when filtering', async () => {
    assert.deepEqual((await library('to=2024-01-01')).songs.map(song => song.id).sort(), ['offset-back', 'year-before']);
    assert.deepEqual((await library('from=2024-03-01')).songs.map(song => song.id).sort(), ['march-start', 'offset-forward']);
    const all = await library('');
    assert.equal(all.total, 12);
    assert.equal(all.total_songs, 12);
    assert.deepEqual(all.songs.map(song => song.id).sort(), clips.map(clip => clip.id).sort());
    const unknown = await library('q=Unknown');
    assert.equal(unknown.total, 4);
    assert.equal((await library('q=Unknown&from=2024-01-01')).total, 0);
    assert.deepEqual(await library('from=2025-01-01&to=2025-01-02'), { songs: [], total: 0, total_songs: 12 });
  });

  await t.test('date and title filters compose with newest-first pagination and stable totals', async () => {
    const query = 'from=2024-02-28&to=2024-03-01&q=Pulse&limit=1';
    const first = await library(query);
    const second = await library(query + '&offset=1');
    const third = await library(query + '&offset=2');
    assert.deepEqual([first.songs[0].id, second.songs[0].id, third.songs[0].id], ['leap-late', 'leap-start', 'leap-before']);
    for (const page of [first, second, third]) {
      assert.equal(page.total, 3);
      assert.equal(page.total_songs, 12);
    }
    assert.deepEqual((await library(query + '&offset=3')).songs, []);
    assert.deepEqual((await library('from=2024-02-29&to=2024-03-01')).songs.map(song => song.id), ['leap-late', 'leap-start']);
  });

  await t.test('calendar validation rejects malformed, impossible, equal and reversed ranges', async () => {
    for (const query of [
      'from=', 'to=', 'from=2024-2-29', 'to=2024-02-29T00:00:00Z',
      'from=2023-02-29', 'to=1900-02-29', 'from=2100-02-29',
      'from=2024-02-30', 'to=2024-04-31', 'from=2024-00-01', 'to=2024-13-01',
      'from=2024-01-00', 'to=not-a-date',
      'from=2024-02-29&to=2024-02-29', 'from=2024-03-01&to=2024-02-29',
    ]) {
      assert.equal((await get('/api/library?' + query)).status, 400, query);
    }
    assert.equal((await library('from=2000-02-29&to=2000-03-01')).total, 0);
  });

  await t.test('Detroit midnight and 23/25-hour DST days agree across aggregation and filtering', async () => {
    const samples = [
      { id: 'spring-before', created_at: '2024-03-10T04:59:59.999Z' },
      { id: 'spring-start', created_at: '2024-03-10T05:00:00Z' },
      { id: 'spring-gap-before', created_at: '2024-03-10T06:59:59.999Z' },
      { id: 'spring-gap-after', created_at: '2024-03-10T07:00:00Z' },
      { id: 'spring-last', created_at: '2024-03-11T03:59:59.999Z' },
      { id: 'spring-next', created_at: '2024-03-11T04:00:00Z' },
      { id: 'fall-before', created_at: '2024-11-03T03:59:59.999Z' },
      { id: 'fall-start', created_at: '2024-11-03T04:00:00Z' },
      { id: 'fall-hour-first', created_at: '2024-11-03T05:30:00Z' },
      { id: 'fall-hour-second', created_at: '2024-11-03T06:30:00Z' },
      { id: 'fall-last', created_at: '2024-11-04T04:59:59.999Z' },
      { id: 'fall-next', created_at: '2024-11-04T05:00:00Z' },
    ];
    const response = await fetch(base + '/api/ingest', { method: 'POST', headers: ingressHeaders, body: JSON.stringify({ clips: samples }) });
    assert.equal(response.status, 200);
    const timeline = await (await get('/api/library/timeline')).json();
    const cases = [
      ['2024-03-09', '2024-03-10', ['spring-before']],
      ['2024-03-10', '2024-03-11', ['spring-gap-after', 'spring-gap-before', 'spring-last', 'spring-start']],
      ['2024-03-11', '2024-03-12', ['spring-next']],
      ['2024-11-02', '2024-11-03', ['fall-before']],
      ['2024-11-03', '2024-11-04', ['fall-hour-first', 'fall-hour-second', 'fall-last', 'fall-start']],
      ['2024-11-04', '2024-11-05', ['fall-next']],
    ];
    for (const [from, to, ids] of cases) {
      const page = await library(`from=${from}&to=${to}`);
      assert.deepEqual(page.songs.map(song => song.id).sort(), ids, from);
      assert.equal(timeline.days.find(day => day.date === from).count, ids.length, from);
    }
    assert.equal(timeline.total, clips.length + samples.length);
  });
});

test('authenticated SQL queries return full read-only results and SQL deep links serve the UI', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'suno-query-test-'));
  const probe = net.createServer();
  probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const dbPath = join(directory, 'songs.sqlite');
  const serverPath = join(directory, 'server.mjs');
  copyFileSync(new URL('./server.js', import.meta.url), serverPath);
  mkdirSync(join(directory, 'dist'));
  const index = '<!doctype html><title>Isolated library UI</title><div id="app"></div>';
  writeFileSync(join(directory, 'dist', 'index.html'), index);
  const child = spawn(process.execPath, [serverPath], { cwd: directory, env: { ...process.env, TIME_ZONE: 'America/Detroit', TZ: 'Asia/Tokyo', PORT: String(port), SUNO_DB: dbPath }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', data => { stderr += data; });
  let readDb;
  t.after(async () => {
    readDb?.close();
    if (child.exitCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; }
    rmSync(directory, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Server startup timeout: ' + stderr)), 10000);
    child.stdout.on('data', data => { if (String(data).includes('Install in Violentmonkey:')) { clearTimeout(timer); resolve(); } });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`Server exited ${code}: ${stderr}`)); });
  });
  const base = `http://127.0.0.1:${port}`;
  readDb = new DatabaseSync(dbPath, { readOnly: true });
  const token = readDb.prepare("SELECT value FROM settings WHERE key='ingress_token'").get().value;
  const ingressHeaders = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
  const session = await (await fetch(base + '/api/session')).json();
  const readHeaders = { 'Content-Type': 'application/json', Authorization: `Bearer ${session.token}` };
  const query = (sql, headers = readHeaders) => fetch(base + '/api/query', { method: 'POST', headers, body: JSON.stringify({ sql }) });

  await t.test('exact application routes share the index without masking missing API or asset routes', async () => {
    for (const path of ['/', '/sql']) {
      const response = await fetch(base + path);
      assert.equal(response.status, 200);
      assert.match(response.headers.get('content-type'), /^text\/html/);
      assert.equal(await response.text(), index);
    }
    for (const path of ['/sql/missing', '/api/missing', '/assets/missing.js']) {
      const response = await fetch(base + path, { headers: ingressHeaders });
      assert.equal(response.status, 404);
      assert.deepEqual(await response.json(), { error: 'Not found' });
    }
  });

  await t.test('read and ingress tokens authorize SQL but absent and incorrect tokens do not', async () => {
    for (const headers of [{ 'Content-Type': 'application/json' }, { 'Content-Type': 'application/json', Authorization: 'Bearer incorrect' }]) {
      assert.equal((await query('SELECT 1', headers)).status, 401);
    }
    for (const headers of [readHeaders, ingressHeaders]) {
      const response = await query('SELECT 0 AS zero, 1.5 AS fraction, \'café 🎵\' AS text, NULL AS absent', headers);
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { columns: ['zero', 'fraction', 'text', 'absent'], rows: [[0, 1.5, 'café 🎵', null]] });
    }
  });

  const clips = Array.from({ length: 251 }, (_, i) => ({
    id: `query-${String(i).padStart(3, '0')}`,
    title: `Song ${i}`,
    created_at: i < 125 ? '2024-03-10T04:59:59Z' : '2024-03-10T05:00:00Z',
    metadata: { duration: i + 0.5, prompt: 'Lyrics café 🎵' },
  }));
  const ingested = await fetch(base + '/api/ingest', { method: 'POST', headers: ingressHeaders, body: JSON.stringify({ clips }) });
  assert.equal(ingested.status, 200);
  assert.equal((await ingested.json()).inserted, 251);

  await t.test('all rows retain column order and duplicate column names without a hidden result cap', async () => {
    const response = await query('SELECT id AS value, title AS value, json_extract(raw_json, \'$.metadata.duration\') AS duration, NULL AS absent FROM songs ORDER BY id');
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      columns: ['value', 'value', 'duration', 'absent'],
      rows: clips.map((clip, i) => [clip.id, clip.title, i + 0.5, null]),
    });
    const empty = await query('SELECT id, title FROM songs WHERE 0');
    assert.equal(empty.status, 200);
    assert.deepEqual(await empty.json(), { columns: ['id', 'title'], rows: [] });
  });

  await t.test('CTEs combine JSON extraction and Detroit aggregation independently of server timezone', async () => {
    const response = await query(`-- leading comment
      WITH dated AS (
        SELECT local_date(created_at) AS day, json_extract(raw_json, '$.metadata.duration') AS duration
        FROM songs
      )
      SELECT day, count(*) AS songs, sum(duration) AS duration FROM dated GROUP BY day ORDER BY day;
      /* trailing comment */ -- another comment`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      columns: ['day', 'songs', 'duration'],
      rows: [['2024-03-09', 125, 7812.5], ['2024-03-10', 126, 23688]],
    });
  });

  await t.test('invalid input, invalid SQL and additional statements return helpful errors', async () => {
    for (const sql of [undefined, null, 1, '', '  ', 'SELECT \0 1', 'SELEC title FROM songs', 'SELECT missing FROM songs', 'SELECT 1; SELECT 2', 'SELECT 1; /* comment */ DELETE FROM songs']) {
      const response = await query(sql);
      assert.equal(response.status, 400, String(sql));
      assert.match((await response.json()).error, /\S/);
    }
    const malformed = await fetch(base + '/api/query', { method: 'POST', headers: readHeaders, body: '{' });
    assert.equal(malformed.status, 400);
    assert.deepEqual(await malformed.json(), { error: 'Invalid JSON' });
    const missingTable = await query('SELECT * FROM absent_table');
    assert.equal(missingTable.status, 400);
    assert.match((await missingTable.json()).error, /no such table: absent_table/);
  });

  await t.test('writes cannot change stored songs or schema and later reads still work', async () => {
    const before = readDb.prepare('SELECT * FROM songs ORDER BY id').all();
    for (const sql of [
      'DELETE FROM songs',
      "UPDATE songs SET title='destroyed'",
      'DROP TABLE songs',
      "INSERT INTO songs SELECT 'forbidden', title, user_id, created_at, model_name, status, raw_json, first_captured_at, updated_at FROM songs LIMIT 1",
      'PRAGMA user_version=99',
      'BEGIN TRANSACTION',
      "ATTACH DATABASE ':memory:' AS scratch",
    ]) {
      const response = await query(sql);
      assert.equal(response.status, 400, sql);
      assert.match((await response.json()).error, /readonly|read-only/i);
    }
    assert.deepEqual(readDb.prepare('SELECT * FROM songs ORDER BY id').all(), before);
    assert.equal(readDb.prepare('PRAGMA user_version').get().user_version, 0);
    const response = await query('SELECT count(*) AS songs FROM songs');
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { columns: ['songs'], rows: [[251]] });
    const library = await fetch(base + '/api/library?limit=1', { headers: readHeaders });
    assert.equal(library.status, 200);
    assert.equal((await library.json()).total, 251);
  });
});

test('runtime timezone configuration controls API dates and fails before database side effects', async t => {
  const serverPath = fileURLToPath(new URL('./server.js', import.meta.url));
  async function launch(t, { fileZone, shellZone, invalid = false, envDirectory = false } = {}) {
    const directory = mkdtempSync(join(tmpdir(), 'suno-zone-test-'));
    if (envDirectory) mkdirSync(join(directory, '.env'));
    else if (fileZone !== undefined) writeFileSync(join(directory, '.env'), `TIME_ZONE=${fileZone}\n`);
    const probe = net.createServer();
    probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
    const port = probe.address().port;
    await new Promise(resolve => probe.close(resolve));
    const dbPath = join(directory, 'archive', 'songs.sqlite');
    const env = { ...process.env, TZ: 'Asia/Tokyo', PORT: String(port), SUNO_DB: dbPath };
    delete env.TIME_ZONE;
    if (shellZone !== undefined) env.TIME_ZONE = shellZone;
    const child = spawn(process.execPath, [serverPath], { cwd: directory, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', data => { stderr += data; });
    t.after(async () => {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit');
        child.kill();
        await exited;
      }
      rmSync(directory, { recursive: true, force: true });
    });
    const outcome = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error('Server startup timeout: ' + stderr));
      }, 10000);
      child.stdout.on('data', data => {
        if (String(data).includes('Install in Violentmonkey:')) {
          clearTimeout(timer);
          resolve({ started: true });
        }
      });
      child.once('exit', code => { clearTimeout(timer); resolve({ started: false, code }); });
      child.once('error', error => { clearTimeout(timer); reject(error); });
    });
    if (invalid) {
      assert.equal(outcome.started, false, stderr);
      assert.notEqual(outcome.code, 0);
      assert.equal(existsSync(join(directory, 'archive')), false);
      return { stderr };
    }
    assert.equal(outcome.started, true, stderr);
    const base = `http://127.0.0.1:${port}`;
    const readDb = new DatabaseSync(dbPath, { readOnly: true });
    const token = readDb.prepare("SELECT value FROM settings WHERE key='ingress_token'").get().value;
    readDb.close();
    const session = await (await fetch(base + '/api/session')).json();
    const readHeaders = { Authorization: `Bearer ${session.token}`, 'Content-Type': 'application/json' };
    const ingressHeaders = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    const get = path => fetch(base + path, { headers: readHeaders });
    return { base, get, readHeaders, ingressHeaders };
  }

  for (const zone of ['UTC', 'America/Los_Angeles']) {
    await t.test(`.env ${zone} drives aggregation, inclusive/exclusive filters and local_date`, async t => {
      const { base, get, readHeaders, ingressHeaders } = await launch(t, { fileZone: zone });
      for (const headers of [readHeaders, ingressHeaders]) {
        const config = await fetch(base + '/api/config', { headers });
        assert.equal(config.status, 200);
        assert.deepEqual(await config.json(), { time_zone: zone });
      }
      for (const headers of [{}, { Authorization: 'Bearer incorrect' }]) {
        assert.equal((await fetch(base + '/api/config', { headers })).status, 401);
      }
      const clips = [
        { id: 'before-midnight', created_at: '2024-03-10T07:59:59Z' },
        { id: 'after-midnight', created_at: '2024-03-10T08:00:00Z' },
        { id: 'after-dst', created_at: '2024-03-11T07:00:00Z' },
        { id: 'undated' },
      ];
      const response = await fetch(base + '/api/ingest', { method: 'POST', headers: ingressHeaders, body: JSON.stringify({ clips }) });
      assert.equal(response.status, 200);
      const days = zone === 'UTC'
        ? [{ date: '2024-03-10', count: 2 }, { date: '2024-03-11', count: 1 }]
        : [{ date: '2024-03-09', count: 1 }, { date: '2024-03-10', count: 1 }, { date: '2024-03-11', count: 1 }];
      assert.deepEqual(await (await get('/api/library/timeline')).json(), {
        days, first_date: days[0].date, last_date: days.at(-1).date, total: 4,
      });
      const filtered = await (await get('/api/library?from=2024-03-10&to=2024-03-11')).json();
      assert.deepEqual(filtered.songs.map(song => song.id).sort(),
        zone === 'UTC' ? ['after-midnight', 'before-midnight'] : ['after-midnight']);
      assert.equal(filtered.total, zone === 'UTC' ? 2 : 1);
      const sql = await fetch(base + '/api/query', {
        method: 'POST', headers: readHeaders,
        body: JSON.stringify({ sql: 'SELECT local_date(created_at) AS day, count(*) AS n FROM songs WHERE created_at IS NOT NULL GROUP BY day ORDER BY day' }),
      });
      assert.equal(sql.status, 200);
      assert.deepEqual(await sql.json(), { columns: ['day', 'n'], rows: days.map(day => [day.date, day.count]) });
      const detail = await (await get('/api/library/before-midnight')).json();
      assert.equal(detail.clip.created_at, clips[0].created_at);
    });
  }

  for (const settings of [
    { name: 'absent .env defaults to Detroit', expected: 'America/Detroit' },
    { name: 'shell timezone overrides .env', fileZone: 'America/Los_Angeles', shellZone: 'UTC', expected: 'UTC' },
    { name: 'valid aliases retain their configured spelling', fileZone: 'US/Pacific', expected: 'US/Pacific' },
    { name: 'shell timezone overrides an invalid file value', fileZone: 'Not/A_Timezone', shellZone: 'UTC', expected: 'UTC' },
  ]) {
    await t.test(settings.name, async t => {
      const { get } = await launch(t, settings);
      assert.deepEqual(await (await get('/api/config')).json(), { time_zone: settings.expected });
    });
  }
  for (const fileZone of ['', 'Not/A_Timezone', '+03:00']) {
    await t.test(`invalid timezone ${JSON.stringify(fileZone)} does not create a database`, async t => {
      const { stderr } = await launch(t, { fileZone, invalid: true });
      assert.match(stderr, /Invalid TIME_ZONE.*valid IANA timezone/);
    });
  }
  for (const shellZone of ['', 'Not/A_Timezone']) {
    await t.test(`invalid shell timezone ${JSON.stringify(shellZone)} is not replaced by .env`, async t => {
      const { stderr } = await launch(t, { fileZone: 'UTC', shellZone, invalid: true });
      assert.match(stderr, /Invalid TIME_ZONE.*valid IANA timezone/);
    });
  }
  await t.test('an unreadable .env is not treated as an absent file', async t => {
    const { stderr } = await launch(t, { envDirectory: true, invalid: true });
    assert.match(stderr, /EISDIR|directory|Contents of '.env' should be a valid string/i);
  });
});
