import { backup } from 'node:sqlite';
import { existsSync } from 'node:fs';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const string = value => typeof value === 'string' ? value : null;
const number = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
const integer = value => typeof value === 'number' && Number.isSafeInteger(value) ? value : null;
const boolean = value => typeof value === 'boolean' ? Number(value) : value === 0 || value === 1 ? value : null;
const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : null;
const columns = {
  major_model_version: 'TEXT', duration: 'REAL', is_public: 'INTEGER', play_count: 'INTEGER',
  upvote_count: 'INTEGER', task: 'TEXT', is_remix: 'INTEGER', persona_id: 'TEXT',
  tags: 'TEXT', negative_tags: 'TEXT',
};
export const promotedNames = Object.keys(columns);

export function extractClip(clip) {
  const metadata = object(clip.metadata) ?? {};
  const persona = object(clip.persona);
  // Preserve the captured ID in songs; only persona objects require a usable UUID for the persona table.
  const personaId = string(metadata.persona_id) ?? string(persona?.id);
  const fields = [
    string(clip.major_model_version), number(metadata.duration ?? clip.duration), boolean(clip.is_public),
    integer(clip.play_count ?? object(clip.reaction)?.play_count),
    integer(clip.upvote_count),
    string(metadata.task), boolean(metadata.is_remix),
    personaId, string(metadata.tags ?? clip.tags), string(metadata.negative_tags),
  ];
  const objectId = string(persona?.id);
  const validObjectId = objectId && uuid.test(objectId.trim()) ? objectId.trim().toLowerCase() : null;
  const personaFields = validObjectId ? [validObjectId, string(persona.name), string(persona.persona_type), string(persona.root_clip_id),
    string(persona.image_s3_id), string(persona.user_handle), boolean(persona.is_owned), boolean(persona.is_public)] : null;
  return { fields, personaFields };
}

export function preparePersonaUpsert(db) {
  return db.prepare(`INSERT INTO personas
    (id, name, persona_type, root_clip_id, image_s3_id, user_handle, is_owned, is_public, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
    name=COALESCE(excluded.name, personas.name),
    persona_type=COALESCE(excluded.persona_type, personas.persona_type),
    root_clip_id=COALESCE(excluded.root_clip_id, personas.root_clip_id),
    image_s3_id=COALESCE(excluded.image_s3_id, personas.image_s3_id),
    user_handle=COALESCE(excluded.user_handle, personas.user_handle),
    is_owned=COALESCE(excluded.is_owned, personas.is_owned),
    is_public=COALESCE(excluded.is_public, personas.is_public),
    updated_at=excluded.updated_at`);
}

function createV2(db) {
  db.exec(`CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE songs (
      id TEXT PRIMARY KEY, title TEXT, user_id TEXT, created_at TEXT, model_name TEXT,
      status TEXT, raw_json TEXT NOT NULL CHECK(json_valid(raw_json)),
      first_captured_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      ${Object.entries(columns).map(([name, type]) => `${name} ${type}`).join(', ')}
    );`);
  createSupplemental(db);
}
function createSupplemental(db) {
  db.exec(`CREATE TABLE personas (
    id TEXT PRIMARY KEY, name TEXT, persona_type TEXT, root_clip_id TEXT,
    image_s3_id TEXT, user_handle TEXT, is_owned INTEGER, is_public INTEGER,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS songs_created_at ON songs(created_at);
  CREATE INDEX IF NOT EXISTS songs_user_id ON songs(user_id);
  CREATE INDEX IF NOT EXISTS songs_is_public ON songs(is_public);
  CREATE INDEX IF NOT EXISTS songs_major_model_version ON songs(major_model_version);
  CREATE INDEX IF NOT EXISTS songs_task ON songs(task);
  CREATE INDEX IF NOT EXISTS songs_persona_id ON songs(persona_id);`);
}
function schemaState(db) {
  const names = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map(row => row.name);
  if (!names.length) return 'empty';
  if (!names.includes('songs') || !names.includes('settings') || names.some(name => !['songs', 'settings', 'personas'].includes(name))) return 'unknown';
  const songColumns = db.prepare('PRAGMA table_info(songs)').all().map(row => row.name);
  const old = ['id', 'title', 'user_id', 'created_at', 'model_name', 'status', 'raw_json', 'first_captured_at', 'updated_at'];
  if (songColumns.join(',') === old.join(',') && !names.includes('personas')) return 'legacy';
  if (songColumns.join(',') === [...old, ...promotedNames].join(',') && names.includes('personas')) return 'current';
  return 'unknown';
}

export async function initializeSchema(db, dbPath) {
  const version = db.prepare('PRAGMA user_version').get().user_version;
  const state = schemaState(db);
  console.log(`[Suno collector] Database schema version ${version} (${state})`);
  if (version > 2 || version < 0 || state === 'unknown' ||
      version === 1 && state !== 'legacy' || version === 2 && state !== 'current' ||
      version === 0 && state === 'current' || version === 0 && state === 'legacy' && !existsSync(dbPath)) {
    throw new Error(`Unsupported database schema: version ${version}, ${state}`);
  }
  if (version === 2) { console.log('[Suno collector] Database schema current (v2)'); return; }
  if (state === 'empty') {
    if (version !== 0) throw new Error(`Unsupported empty database schema version ${version}`);
    db.exec('BEGIN IMMEDIATE');
    try { createV2(db); db.exec('PRAGMA user_version=2'); db.exec('COMMIT'); }
    catch (error) { db.exec('ROLLBACK'); throw error; }
    console.log('[Suno collector] Created database schema v2');
    return;
  }
  console.log('[Suno collector] Starting schema migration v1 → v2');
  const stamp = `${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}`;
  let backupPath;
  for (let n = 0; ; n++) {
    const candidate = `${dbPath}.backup-${stamp}${n ? `-${n}` : ''}.sqlite`;
    if (!existsSync(candidate)) { backupPath = candidate; break; }
  }
  console.log(`[Suno collector] Database backup: ${backupPath}`);
  await backup(db, backupPath);
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const [name, type] of Object.entries(columns)) db.exec(`ALTER TABLE songs ADD COLUMN ${name} ${type}`);
    createSupplemental(db);
    const update = db.prepare(`UPDATE songs SET ${promotedNames.map(name => `${name}=?`).join(', ')} WHERE id=?`);
    const upsert = preparePersonaUpsert(db);
    for (const row of db.prepare('SELECT id, raw_json, updated_at FROM songs ORDER BY created_at ASC, id ASC').iterate()) {
      const { fields, personaFields } = extractClip(JSON.parse(row.raw_json));
      update.run(...fields, row.id);
      if (personaFields) upsert.run(...personaFields, row.updated_at);
    }
    db.exec('PRAGMA user_version=2');
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  console.log('[Suno collector] Schema migration complete: v2');
}
