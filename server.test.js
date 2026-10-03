import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import net from 'node:net';
import { DatabaseSync } from 'node:sqlite';

 test('real SQLite ingress preserves full data and never creates duplicate songs', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'suno-test-'));
  const probe = net.createServer();
  probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const dbPath = join(directory, 'songs.sqlite');
  const child = spawn(process.execPath, ['server.js'], { env: { ...process.env, PORT: String(port), SUNO_DB: dbPath }, stdio: ['ignore', 'pipe', 'pipe'] });
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
