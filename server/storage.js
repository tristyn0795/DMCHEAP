// Persistence: profiles + social graph (friends, requests, recent raiders).
// Postgres when DATABASE_URL is set (Railway Postgres plugin), otherwise JSON files in DATA_DIR.
import fs from 'node:fs';
import path from 'node:path';

const RECENT_LIMIT = 20;

export async function createStorage() {
  if (process.env.DATABASE_URL) return createPg(process.env.DATABASE_URL);
  return createFileStore(process.env.DATA_DIR || path.resolve('data'));
}

export const tagOf = (id) => String(id).replace(/-/g, '').slice(-4).toUpperCase();

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
  await pool.query(`CREATE TABLE IF NOT EXISTS friends (
    a TEXT NOT NULL, b TEXT NOT NULL, since TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY (a, b))`);
  await pool.query(`CREATE TABLE IF NOT EXISTS friend_requests (
    from_id TEXT NOT NULL, to_id TEXT NOT NULL, at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY (from_id, to_id))`);
  await pool.query(`CREATE TABLE IF NOT EXISTS recent_raiders (
    pid TEXT NOT NULL, other TEXT NOT NULL, how TEXT NOT NULL, at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY (pid, other))`);
  console.log('[storage] using Postgres');
  const one = async (q, args) => (await pool.query(q, args)).rows;
  return {
    kind: 'postgres',
    async byToken(token) { return (await one('SELECT data FROM profiles WHERE token = $1', [token]))[0]?.data ?? null; },
    async byId(id) { return (await one('SELECT data FROM profiles WHERE id = $1', [id]))[0]?.data ?? null; },
    async save(p) {
      await pool.query(
        `INSERT INTO profiles (id, token, name, data, updated_at) VALUES ($1, $2, $3, $4, now())
         ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, data = EXCLUDED.data, updated_at = now()`,
        [p.id, p.token, p.name, p]);
    },
    async findByNameTag(name, tag) {
      const r = await one(`SELECT id FROM profiles WHERE lower(name) = lower($1) AND upper(right(replace(id, '-', ''), 4)) = upper($2) LIMIT 1`, [name, tag]);
      return r[0]?.id ?? null;
    },
    async cards(ids) {
      if (!ids.length) return {};
      const r = await one(`SELECT id, name, (data->>'level')::int AS level, (data->>'lastSeen')::bigint AS seen FROM profiles WHERE id = ANY($1)`, [ids]);
      return Object.fromEntries(r.map(x => [x.id, { name: x.name, level: x.level, seen: Number(x.seen) || 0 }]));
    },
    async friendsOf(id) { return (await one('SELECT b FROM friends WHERE a = $1', [id])).map(r => r.b); },
    async areFriends(a, b) { return (await one('SELECT 1 FROM friends WHERE a = $1 AND b = $2', [a, b])).length > 0; },
    async addFriends(a, b) {
      await pool.query('INSERT INTO friends (a, b) VALUES ($1, $2), ($2, $1) ON CONFLICT DO NOTHING', [a, b]);
      await pool.query('DELETE FROM friend_requests WHERE (from_id = $1 AND to_id = $2) OR (from_id = $2 AND to_id = $1)', [a, b]);
    },
    async removeFriends(a, b) { await pool.query('DELETE FROM friends WHERE (a = $1 AND b = $2) OR (a = $2 AND b = $1)', [a, b]); },
    async addRequest(from, to) { await pool.query('INSERT INTO friend_requests (from_id, to_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [from, to]); },
    async hasRequest(from, to) { return (await one('SELECT 1 FROM friend_requests WHERE from_id = $1 AND to_id = $2', [from, to])).length > 0; },
    async removeRequest(from, to) { await pool.query('DELETE FROM friend_requests WHERE from_id = $1 AND to_id = $2', [from, to]); },
    async requestsTo(id) { return (await one('SELECT from_id FROM friend_requests WHERE to_id = $1 ORDER BY at DESC LIMIT 50', [id])).map(r => r.from_id); },
    async requestsFrom(id) { return (await one('SELECT to_id FROM friend_requests WHERE from_id = $1 ORDER BY at DESC LIMIT 50', [id])).map(r => r.to_id); },
    async addRecent(pid, entries) {
      for (const e of entries) {
        await pool.query(`INSERT INTO recent_raiders (pid, other, how, at) VALUES ($1, $2, $3, now())
          ON CONFLICT (pid, other) DO UPDATE SET how = EXCLUDED.how, at = now()`, [pid, e.id, e.how]);
      }
      await pool.query(`DELETE FROM recent_raiders WHERE pid = $1 AND other NOT IN
        (SELECT other FROM recent_raiders WHERE pid = $1 ORDER BY at DESC LIMIT ${RECENT_LIMIT})`, [pid]);
    },
    async recentOf(pid) {
      const r = await one('SELECT other, how, extract(epoch from at) * 1000 AS at FROM recent_raiders WHERE pid = $1 ORDER BY at DESC LIMIT $2', [pid, RECENT_LIMIT]);
      return r.map(x => ({ id: x.other, how: x.how, at: Number(x.at) }));
    },
    async leaderboard(limit = 20) {
      return one(
        `SELECT data->>'name' AS name, (data->>'level')::int AS level, (data->'stats'->>'extracts')::int AS extracts,
                (data->'stats'->>'value')::bigint AS value
         FROM profiles ORDER BY (data->'stats'->>'value')::bigint DESC NULLS LAST LIMIT $1`, [limit]);
    },
    async close() { await pool.end(); },
  };
}

function createFileStore(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const byId = new Map();
  const tokens = new Map();
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.json') || f === 'social.json') continue;
    try {
      const p = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      byId.set(p.id, p); tokens.set(p.token, p.id);
    } catch (e) { console.warn('[storage] bad profile file', f, e.message); }
  }
  const socialFile = path.join(dir, 'social.json');
  let social = { friends: {}, requests: [], recent: {} };
  try { social = { ...social, ...JSON.parse(fs.readFileSync(socialFile, 'utf8')) }; } catch {}
  let socialTimer = null;
  const saveSocial = () => {
    clearTimeout(socialTimer);
    socialTimer = setTimeout(() => {
      fs.promises.writeFile(socialFile + '.tmp', JSON.stringify(social)).then(() => fs.promises.rename(socialFile + '.tmp', socialFile)).catch(e => console.error('[storage] social save failed', e));
    }, 500);
  };
  const fset = (id) => (social.friends[id] ??= []);
  console.log(`[storage] using files in ${dir} (${byId.size} profiles)`);
  return {
    kind: 'file',
    async byToken(token) {
      const id = tokens.get(token);
      return id ? structuredClone(byId.get(id)) : null;
    },
    async byId(id) { return byId.has(id) ? structuredClone(byId.get(id)) : null; },
    async save(p) {
      byId.set(p.id, structuredClone(p)); tokens.set(p.token, p.id);
      const file = path.join(dir, `${p.id}.json`);
      await fs.promises.writeFile(file + '.tmp', JSON.stringify(p));
      await fs.promises.rename(file + '.tmp', file);
    },
    async findByNameTag(name, tag) {
      for (const p of byId.values()) if (p.name.toLowerCase() === name.toLowerCase() && tagOf(p.id) === tag.toUpperCase()) return p.id;
      return null;
    },
    async cards(ids) {
      const out = {};
      for (const id of ids) { const p = byId.get(id); if (p) out[id] = { name: p.name, level: p.level, seen: p.lastSeen ?? 0 }; }
      return out;
    },
    async friendsOf(id) { return [...fset(id)]; },
    async areFriends(a, b) { return fset(a).includes(b); },
    async addFriends(a, b) {
      if (!fset(a).includes(b)) fset(a).push(b);
      if (!fset(b).includes(a)) fset(b).push(a);
      social.requests = social.requests.filter(r => !((r.from === a && r.to === b) || (r.from === b && r.to === a)));
      saveSocial();
    },
    async removeFriends(a, b) {
      social.friends[a] = fset(a).filter(x => x !== b);
      social.friends[b] = fset(b).filter(x => x !== a);
      saveSocial();
    },
    async addRequest(from, to) {
      if (!social.requests.some(r => r.from === from && r.to === to)) social.requests.push({ from, to, at: Date.now() });
      saveSocial();
    },
    async hasRequest(from, to) { return social.requests.some(r => r.from === from && r.to === to); },
    async removeRequest(from, to) { social.requests = social.requests.filter(r => !(r.from === from && r.to === to)); saveSocial(); },
    async requestsTo(id) { return social.requests.filter(r => r.to === id).map(r => r.from); },
    async requestsFrom(id) { return social.requests.filter(r => r.from === id).map(r => r.to); },
    async addRecent(pid, entries) {
      const list = (social.recent[pid] ??= []).filter(x => !entries.some(e => e.id === x.id));
      for (const e of entries) list.unshift({ id: e.id, how: e.how, at: Date.now() });
      social.recent[pid] = list.slice(0, RECENT_LIMIT);
      saveSocial();
    },
    async recentOf(pid) { return [...(social.recent[pid] ?? [])]; },
    async leaderboard(limit = 20) {
      return [...byId.values()]
        .map(p => ({ name: p.name, level: p.level, extracts: p.stats?.extracts ?? 0, value: p.stats?.value ?? 0 }))
        .sort((a, b) => b.value - a.value).slice(0, limit);
    },
    async close() {
      clearTimeout(socialTimer);
      try { fs.writeFileSync(socialFile, JSON.stringify(social)); } catch {}
    },
  };
}
