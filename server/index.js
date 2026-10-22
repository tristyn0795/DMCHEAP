// DMCHEAP server: static client + WebSocket game server on ONE port, which is what
// Railway's public HTTP networking expects (wss:// on 443 -> $PORT). Railway has no
// inbound UDP, so all realtime traffic is WebSocket (TCP) with permessage-deflate.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { C } from '../shared/data.js';
import { generateWorld } from '../shared/world.js';
import { createStorage } from './storage.js';
import { Raid } from './raid.js';
import {
  newProfile, sanitizeName, applyAction, publicProfile, prepareDeploy, voidRaid, applyRaidResult,
} from './profiles.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = +process.env.PORT || 3000;
const MAX_RAIDS = +process.env.MAX_RAIDS || 12;

const storage = await createStorage();
const world = generateWorld();
console.log(`[world] ${world.boxes.length} boxes, ${world.containers.length} containers`);

const raids = new Map();        // raidId -> Raid
const sessions = new Map();     // pid -> { ws, profile, party }
const profiles = new Map();     // pid -> live profile (authoritative copy while online / in raid)
const parties = new Map();      // code -> { code, leader, members: Set<pid> }
const saveTimers = new Map();

function scheduleSave(p, now = false) {
  clearTimeout(saveTimers.get(p.id));
  const run = () => { saveTimers.delete(p.id); storage.save(p).catch(e => console.error('[storage] save failed', e)); };
  if (now) run(); else saveTimers.set(p.id, setTimeout(run, 1500));
}

// ------------------------------------------------------------------ HTTP
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
const STATIC = {
  '/vendor/three.module.js': path.join(ROOT, 'node_modules/three/build/three.module.min.js'),
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  if (p === '/health') return json(res, { ok: true, raids: raids.size, online: sessions.size });
  if (p === '/api/stats') {
    return json(res, { online: sessions.size, raids: [...raids.values()].map(r => r.stats()), storage: storage.kind, mem: Math.round(process.memoryUsage().rss / 1e6) + 'MB' });
  }
  if (p === '/api/leaderboard') {
    try { return json(res, await storage.leaderboard(20)); } catch (e) { return json(res, [], 500); }
  }
  let file;
  if (STATIC[p]) file = STATIC[p];
  else if (p.startsWith('/shared/')) file = path.join(ROOT, 'shared', path.normalize(p.slice(8)).replace(/^(\.\.[/\\])+/, ''));
  else file = path.join(ROOT, 'client', path.normalize(p === '/' ? 'index.html' : p.slice(1)).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream',
      'Cache-Control': file.includes('node_modules') ? 'public, max-age=86400' : 'no-cache',
    });
    fs.createReadStream(file).pipe(res);
  });
});

function json(res, obj, code = 200) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

// ------------------------------------------------------------------ WebSocket
const wss = new WebSocketServer({
  server, path: '/ws', maxPayload: 16 * 1024,
  perMessageDeflate: { threshold: 256, zlibDeflateOptions: { level: 3 }, serverNoContextTakeover: false, clientNoContextTakeover: true },
});

function send(ws, msg) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg)); }
function sendProfile(s, notes) { send(s.ws, { t: 'profile', profile: publicProfile(s.profile), notes, party: partyView(s.party) }); }

wss.on('connection', (ws, req) => {
  let pid = null;
  let count = 0, windowStart = Date.now();
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', async (buf) => {
    const now = Date.now();
    if (now - windowStart > 1000) { windowStart = now; count = 0; }
    if (++count > 120) { if (count > 400) ws.close(4008, 'rate'); return; }
    let m;
    try { m = JSON.parse(buf); } catch { return; }
    if (!m || typeof m.t !== 'string') return;
    try {
      if (!pid) {
        if (m.t !== 'hello') return;
        pid = await onHello(ws, m);
        return;
      }
      const s = sessions.get(pid);
      if (!s || s.ws !== ws) return;
      const p = s.profile;
      if (p.inRaid) {
        const raid = raids.get(p.inRaid);
        if (raid) raid.handle(pid, m);
        return;
      }
      await onHideout(s, m);
    } catch (e) {
      send(ws, { t: 'err', msg: e.message ?? String(e) });
    }
  });

  ws.on('close', () => {
    if (!pid) return;
    const s = sessions.get(pid);
    if (!s || s.ws !== ws) return;
    sessions.delete(pid);
    leaveParty(s);
    const p = s.profile;
    if (p.inRaid) {
      raids.get(p.inRaid)?.detach(pid); // character stays in the raid, vulnerable
    } else {
      scheduleSave(p, true);
      profiles.delete(pid);
    }
  });
});

async function onHello(ws, m) {
  let p = null;
  const notes = [];
  if (m.token && typeof m.token === 'string') {
    p = profiles.get(tokenIndex.get(m.token)) ?? await storage.byToken(m.token);
  }
  if (!p) {
    p = newProfile(m.name);
    await storage.save(p);
    notes.push('Welcome to The Cheap Seats, raider. Gear up, go topside, get out alive.');
  }
  tokenIndex.set(p.token, p.id);
  // one session per profile
  const old = sessions.get(p.id);
  if (old && old.ws !== ws) { send(old.ws, { t: 'err', msg: 'Logged in elsewhere' }); old.ws.close(4001, 'replaced'); }
  if (!profiles.has(p.id)) profiles.set(p.id, p);
  p = profiles.get(p.id);
  const s = { ws, profile: p, party: null };
  sessions.set(p.id, s);
  send(ws, { t: 'welcome', token: p.token, id: p.id });
  if (p.inRaid) {
    const raid = raids.get(p.inRaid);
    if (raid && raid.reattach(p.id, ws)) return p.id;
    voidRaid(p);
    notes.push('Your last raid was interrupted (server restart). Your gear was returned.');
    scheduleSave(p);
  }
  sendProfile(s, notes);
  return p.id;
}
const tokenIndex = new Map();

async function onHideout(s, m) {
  const p = s.profile;
  switch (m.t) {
    case 'act': {
      const notes = applyAction(p, m);
      scheduleSave(p);
      sendProfile(s, notes);
      return;
    }
    case 'rename': {
      p.name = sanitizeName(m.name);
      scheduleSave(p);
      sendProfile(s);
      return;
    }
    case 'party_create': {
      leaveParty(s);
      let code;
      do { code = Math.random().toString(36).slice(2, 7).toUpperCase(); } while (parties.has(code));
      const party = { code, leader: p.id, members: new Set([p.id]) };
      parties.set(code, party);
      s.party = party;
      broadcastParty(party);
      return;
    }
    case 'party_join': {
      const party = parties.get(String(m.code ?? '').toUpperCase().trim());
      if (!party) throw new Error('No squad with that code');
      if (party.members.size >= C.MAX_SQUAD) throw new Error('Squad is full');
      leaveParty(s);
      party.members.add(p.id);
      s.party = party;
      broadcastParty(party);
      return;
    }
    case 'party_leave': {
      leaveParty(s);
      sendProfile(s);
      return;
    }
    case 'deploy': return deploy(s);
    case 'ping': return send(s.ws, { t: 'pong', c: m.c });
  }
}

function partyView(party) {
  if (!party) return null;
  return {
    code: party.code, leader: party.leader,
    members: [...party.members].map(id => {
      const ss = sessions.get(id);
      return { id, name: ss?.profile.name ?? '?', level: ss?.profile.level ?? 0, inRaid: !!ss?.profile.inRaid, online: !!ss };
    }),
  };
}
function broadcastParty(party) {
  for (const id of party.members) { const ss = sessions.get(id); if (ss) send(ss.ws, { t: 'party', party: partyView(party) }); }
}
function leaveParty(s) {
  const party = s.party;
  if (!party) return;
  party.members.delete(s.profile.id);
  s.party = null;
  if (party.members.size === 0) parties.delete(party.code);
  else {
    if (party.leader === s.profile.id) party.leader = [...party.members][0];
    broadcastParty(party);
  }
}

function deploy(s) {
  if (s.party && s.party.leader !== s.profile.id) throw new Error('Only the squad leader can deploy');
  const group = s.party
    ? [...s.party.members].map(id => sessions.get(id)).filter(x => x && !x.profile.inRaid)
    : [s];
  let raid = [...raids.values()].find(r => r.canJoin(group.length));
  if (!raid) {
    if (raids.size >= MAX_RAIDS) throw new Error('Servers are full — try again in a minute');
    raid = new Raid(world, { onResult, onClosed });
    raids.set(raid.id, raid);
    console.log(`[raid] ${raid.id} created (${raids.size} active)`);
  }
  const squadId = s.party ? 'P' + s.party.code + raid.id : 'S' + s.profile.id;
  let spawn = null;
  for (const m of group) {
    const info = prepareDeploy(m.profile, raid.id);
    scheduleSave(m.profile, true);
    const r = raid.addPlayer(m.profile, info, m.ws, squadId, spawn);
    spawn = r.spawn;
  }
}

async function onResult(pid, res, deployInfo) {
  const p = profiles.get(pid);
  if (!p) return null;
  applyRaidResult(p, res, deployInfo);
  scheduleSave(p, true);
  const s = sessions.get(pid);
  if (s) setTimeout(() => sendProfile(s), 50);
  else profiles.delete(pid);
  return p.lastReport;
}

function onClosed(raid) {
  raids.delete(raid.id);
  console.log(`[raid] ${raid.id} closed after ${Math.round(raid.time)}s (${raids.size} active)`);
}

// keepalive: drop dead sockets (Railway's proxy closes idle connections)
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 20000);

server.listen(PORT, '0.0.0.0', () => console.log(`[dmcheap] listening on :${PORT}`));

async function shutdown() {
  console.log('[dmcheap] shutting down, saving profiles');
  for (const p of profiles.values()) await storage.save(p).catch(() => {});
  await storage.close();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
