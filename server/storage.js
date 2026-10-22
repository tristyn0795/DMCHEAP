// Profile persistence. Uses Postgres when DATABASE_URL is set (Railway Postgres plugin),
// otherwise JSON files under DATA_DIR (mount a Railway Volume there to persist).
import fs from 'node:fs';
import path from 'node:path';

export async function createStorage() {
  if (process.env.DATABASE_URL) return createPg(process.env.DATABASE_URL);
  return createFileStore(process.env.DATA_DIR || path.resolve('data'));
}

async function createPg(url) {
  const { default: pg } = await import('pg');
  const pool = new pg.Pool({
    connectionString: url,
    max: 5,
    ssl: /sslmode=require/.test(url) ? { rejectUnauthorized: false } : undefined,
  });
  await pool.query(`CREATE TABLE IF NOT EXISTS profiles (
    id TEXT PRIMARY KEY,
    token TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    data JSONB NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  console.log('[storage] using Postgres');
  return {
    kind: 'postgres',
    async byToken(token) {
      const r = await pool.query('SELECT data FROM profiles WHERE token = $1', [token]);
      return r.rows[0]?.data ?? null;
    },
    async save(p) {
      await pool.query(
        `INSERT INTO profiles (id, token, name, data, updated_at) VALUES ($1, $2, $3, $4, now())
         ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, data = EXCLUDED.data, updated_at = now()`,
        [p.id, p.token, p.name, p]);
    },
    async leaderboard(limit = 20) {
      const r = await pool.query(
        `SELECT data->>'name' AS name, (data->>'level')::int AS level, (data->'stats'->>'extracts')::int AS extracts,
                (data->'stats'->>'value')::bigint AS value
         FROM profiles ORDER BY (data->'stats'->>'value')::bigint DESC NULLS LAST LIMIT $1`, [limit]);
      return r.rows;
    },
    async close() { await pool.end(); },
  };
}

function createFileStore(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const byId = new Map();
  const tokens = new Map();
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    try {
      const p = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      byId.set(p.id, p); tokens.set(p.token, p.id);
    } catch (e) { console.warn('[storage] bad profile file', f, e.message); }
  }
  console.log(`[storage] using files in ${dir} (${byId.size} profiles)`);
  return {
    kind: 'file',
    async byToken(token) {
      const id = tokens.get(token);
      return id ? structuredClone(byId.get(id)) : null;
    },
    async save(p) {
      byId.set(p.id, structuredClone(p)); tokens.set(p.token, p.id);
      const file = path.join(dir, `${p.id}.json`);
      await fs.promises.writeFile(file + '.tmp', JSON.stringify(p));
      await fs.promises.rename(file + '.tmp', file);
    },
    async leaderboard(limit = 20) {
      return [...byId.values()]
        .map(p => ({ name: p.name, level: p.level, extracts: p.stats?.extracts ?? 0, value: p.stats?.value ?? 0 }))
        .sort((a, b) => b.value - a.value).slice(0, limit);
    },
    async close() {},
  };
}
