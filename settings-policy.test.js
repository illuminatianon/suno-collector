import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import net from 'node:net';
import { DatabaseSync } from 'node:sqlite';

const serverPath = fileURLToPath(new URL('./server.js', import.meta.url));
const owner = '21d3c8b1-90d2-44ff-b0d1-893e51aea902';
const stranger = 'c1efeeae-600d-4842-aa52-77e9cf57cc20';

test('capture settings gate ingress and retain only owned or known remix sources', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'suno-policy-test-'));
  const probe = net.createServer();
  probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const dbPath = join(directory, 'songs.sqlite');
  const child = spawn(process.execPath, [serverPath], { cwd: directory, env: { ...process.env, TIME_ZONE: 'America/Detroit', PORT: String(port), SUNO_DB: dbPath }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', data => { stderr += data; });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; }
    rmSync(directory, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Startup timeout: ' + stderr)), 10000);
    child.stdout.on('data', data => { if (String(data).includes('Install in Violentmonkey:')) { clearTimeout(timer); resolve(); } });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`Server exited ${code}: ${stderr}`)); });
  });
  const base = `http://127.0.0.1:${port}`;
  const readDb = new DatabaseSync(dbPath, { readOnly: true });
  t.after(() => readDb.close());
  const ingressToken = readDb.prepare("SELECT value FROM settings WHERE key='ingress_token'").get().value;
  const session = await (await fetch(base + '/api/session')).json();
  const readHeaders = { 'Content-Type': 'application/json', Authorization: `Bearer ${session.token}` };
  const ingestHeaders = { 'Content-Type': 'application/json', Authorization: `Bearer ${ingressToken}` };
  const settings = (ingest_mode, user_id = owner, time_zone = 'America/Detroit') => ({ ingest_mode, user_id, time_zone });
  const save = async value => fetch(base + '/api/settings', { method: 'PUT', headers: readHeaders, body: JSON.stringify(value) });
  const ingest = async clips => fetch(base + '/api/ingest', { method: 'POST', headers: ingestHeaders, body: JSON.stringify({ clips }) });
  const stored = id => readDb.prepare('SELECT raw_json FROM songs WHERE id=?').get(id);

  await t.test('first-run Owned with no user ID refuses ingest without acknowledging it', async () => {
    assert.deepEqual(await (await fetch(base + '/api/settings', { headers: readHeaders })).json(), { user_id: null, ingest_mode: 'owned', time_zone: 'America/Detroit' });
    const response = await ingest([{ id: 'pending', user_id: owner }]);
    assert.equal(response.status, 409);
    assert.match((await response.json()).error, /Suno User ID/);
    assert.equal(stored('pending'), undefined);
  });

  await t.test('invalid settings and unauthorized writes leave all settings intact', async () => {
    for (const value of [settings('owned', 'not-a-uuid'), settings('other'), settings('owned', owner, 'Not/A_Zone'), settings('remixed', null)]) {
      const response = await save(value);
      assert.equal(response.status, 400);
    }
    const unauthorized = await fetch(base + '/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(settings('all')) });
    assert.equal(unauthorized.status, 401);
    assert.deepEqual(await (await fetch(base + '/api/settings', { headers: readHeaders })).json(), { user_id: null, ingest_mode: 'owned', time_zone: 'America/Detroit' });
  });

  await t.test('Owned accepts matching UUID and skips strangers without deleting existing rows', async () => {
    const saved = await save(settings('owned', owner.toUpperCase()));
    assert.equal(saved.status, 200);
    assert.equal((await saved.json()).user_id, owner);
    assert.deepEqual(await (await ingest([{ id: 'owned', user_id: owner, title: 'mine' }, { id: 'foreign', user_id: stranger, title: 'theirs' }])).json(), { inserted: 1, updated: 0, unchanged: 0, skipped: 1, received: 2, unique: 2 });
    assert.equal(stored('foreign'), undefined);
    assert.equal(JSON.parse(stored('owned').raw_json).title, 'mine');
  });

  await t.test('Remixed admits only explicitly referenced non-owned sources regardless of batch order', async () => {
    assert.equal((await save(settings('remixed'))).status, 200);
    const remix = { id: 'remix', user_id: owner, metadata: { is_remix: true, cover_clip_id: 'source' } };
    const unrelatedEdit = { id: 'not-remix', user_id: owner, metadata: { is_remix: false, edited_clip_id: 'not-source' } };
    assert.deepEqual(await (await ingest([
      { id: 'source', user_id: stranger, title: 'referenced before remix' },
      { id: 'not-source', user_id: stranger },
      remix, unrelatedEdit,
      { id: 'unrelated', user_id: stranger },
    ])).json(), { inserted: 3, updated: 0, unchanged: 0, skipped: 2, received: 5, unique: 5 });
    assert.equal(stored('not-source'), undefined);
    assert.equal(stored('unrelated'), undefined);
    assert.ok(stored('source'));
    assert.deepEqual(await (await ingest([{ id: 'source-late', user_id: stranger }])).json(), { inserted: 0, updated: 0, unchanged: 0, skipped: 1, received: 1, unique: 1 });
    assert.deepEqual(await (await ingest([{ id: 'remix-two', user_id: owner, metadata: { is_remix: true, edited_clip_id: 'source-late' } }])).json(), { inserted: 1, updated: 0, unchanged: 0, skipped: 0, received: 1, unique: 1 });
    assert.deepEqual(await (await ingest([{ id: 'source-late', user_id: stranger }])).json(), { inserted: 1, updated: 0, unchanged: 0, skipped: 0, received: 1, unique: 1 });
    assert.deepEqual(await (await ingest([{ id: 'source-late', user_id: stranger }])).json(), { inserted: 0, updated: 0, unchanged: 1, skipped: 0, received: 1, unique: 1 });
    const removed = await ingest([
      { id: 'source-late', user_id: stranger, title: 'must not update after unreferenced' },
      { id: 'remix-two', user_id: owner, metadata: { is_remix: false } },
    ]);
    assert.deepEqual(await removed.json(), { inserted: 0, updated: 1, unchanged: 0, skipped: 1, received: 2, unique: 2 });
    assert.equal(JSON.parse(stored('source-late').raw_json).title, undefined);
    assert.deepEqual(await (await ingest([{ id: 'source-late', user_id: stranger, title: 'still unreferenced' }])).json(), { inserted: 0, updated: 0, unchanged: 0, skipped: 1, received: 1, unique: 1 });
  });

  await t.test('All stores any clip; later mode changes do not remove archive rows', async () => {
    assert.equal((await save(settings('all', null))).status, 200);
    assert.deepEqual(await (await ingest([{ id: 'new-stranger', user_id: stranger }])).json(), { inserted: 1, updated: 0, unchanged: 0, skipped: 0, received: 1, unique: 1 });
    assert.equal((await save(settings('owned'))).status, 200);
    assert.ok(stored('new-stranger'));
    assert.deepEqual(await (await ingest([{ id: 'new-stranger', user_id: stranger, title: 'should not update' }])).json(), { inserted: 0, updated: 0, unchanged: 0, skipped: 1, received: 1, unique: 1 });
    assert.equal(JSON.parse(stored('new-stranger').raw_json).title, undefined);
  });
});
