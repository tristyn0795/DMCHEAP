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
import { createStorage, tagOf } from './storage.js';
import { Raid } from './raid.js';
import { HubManager } from './hub.js';
import { PartyManager, GRACE_MS, RESERVE_MS } from './party.js';
import { Social } from './social.js';
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
const sessions = new Map();     // pid -> { ws, profile, spectating, lastRaid }
const profiles = new Map();     // pid -> live profile (authoritative copy while online / in raid)
const nameCache = new Map();    // pid -> name (for offline squadmates)
const tokenIndex = new Map();
const saveTimers = new Map();

function scheduleSave(p, now = false) {
  clearTimeout(saveTimers.get(p.id));
  const run = () => { saveTimers.delete(p.id); storage.save(p).catch(e => console.error('[storage] save failed', e)); };
  if (now) run(); else saveTimers.set(p.id, setTimeout(run, 1500));
}

function sendWs(ws, msg) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg)); }
function send(pid, msg) { sendWs(sessions.get(pid)?.ws, msg); }
function names(pid) { return profiles.get(pid)?.name ?? nameCache.get(pid) ?? '?'; }

// Where is this raider right now? (used by squad panels and friends lists)
function statusOf(pid, member) {
  const prof = profiles.get(pid);
  const s = sessions.get(pid);
  if (prof?.inRaid) {
    const raid = raids.get(prof.inRaid);
    const rp = raid?.players.get(pid);
    return { s: 'raid', until: raid ? Date.now() + Math.max(0, C.RAID_DURATION - raid.time) * 1000 : null, down: rp?.state === 'downed', online: !!s };
  }
  if (!s) return { s: 'offline', until: member?.offlineAt ? member.offlineAt + GRACE_MS : null };
  if (s.spectating) return { s: 'spectating' };
  const inst = hub.instanceOf(pid);
  if (inst) return { s: 'hub', inst };
  return { s: 'menu' };
}

// ------------------------------------------------------------------ deploy plumbing
function findOrCreateRaid(slots) {
  let raid = [...raids.values()].find(r => r.canJoin(slots));
  if (!raid) {
    if (raids.size >= MAX_RAIDS) throw new Error('Servers are full — try again in a minute');
    raid = new Raid(world, { onResult, onClosed });
    raids.set(raid.id, raid);
    console.log(`[raid] ${raid.id} created (${raids.size} active)`);
  }
  return raid;
}

function deployGroup(pids, party, missing = []) {
  const group = pids.map(id => sessions.get(id)).filter(s => s && !s.profile.inRaid);
  if (!group.length) throw new Error('Nobody ready to deploy');
  const raid = findOrCreateRaid(group.length + missing.length);
  const squadId = party ? `P${party.code}-${raid.id}` : `S${group[0].profile.id}`;
  for (const s of group) enterRaid(s, raid, squadId);
  const until = Date.now() + RESERVE_MS;
  for (const id of missing) {
    raid.reserve(id, squadId, until);
    send(id, { t: 'notice', text: 'Your squad deployed without you — your slot is held for 5:00. Hit JOIN SQUAD when ready.', kind: 'nudge' });
  }
  parties.afterDeploy(party, raid, squadId);
  return raid;
}

function joinRaid(pid, raid, squadId) {
  const s = sessions.get(pid);
  if (!s) throw new Error('Not connected');
  enterRaid(s, raid, squadId);
}

function enterRaid(s, raid, squadId) {
  const p = s.profile;
  hub.leave(p.id);
  parties.cancelFill(p.id);
  if (s.spectating) { raids.get(s.spectating)?.spectate(p.id, false); s.spectating = null; }
  const info = prepareDeploy(p, raid.id);
  scheduleSave(p, true);
  raid.addPlayer(p, info, s.ws, squadId);
  s.lastRaid = raid.id;
  social.notifyFriends(p.id);
}

async function onResult(pid, res, deployInfo) {
  const p = profiles.get(pid);
  if (!p) return null;
  applyRaidResult(p, res, deployInfo);
  scheduleSave(p, true);
  social.recordRecent(pid, res.met);
  parties.onRaidResult(pid, res.extracted);
  social.notifyFriends(pid);
  const s = sessions.get(pid);
  if (s) setTimeout(() => sendProfile(s), 50);
  else if (!parties.partyOf(pid)) profiles.delete(pid);
  return p.lastReport;
}

function onClosed(raid) {
  raids.delete(raid.id);
  console.log(`[raid] ${raid.id} closed after ${Math.round(raid.time)}s (${raids.size} active)`);
  for (const s of sessions.values()) if (s.spectating === raid.id) s.spectating = null;
}

// ------------------------------------------------------------------ social systems
const ctx = { sessions, profiles, raids, storage, send, names, statusOf, deployGroup, joinRaid };
const parties = new PartyManager(ctx);
const social = new Social({ ...ctx, parties });
const hub = new HubManager({
  partyOf: (pid) => parties.partyOf(pid),
  friendsOnline: (pid) => social.friendsOnline(pid),
  isReady: (pid) => parties.isReady(pid),
});
Object.assign(ctx, { parties, social, hub });

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
    return json(res, {
      online: sessions.size, raids: [...raids.values()].map(r => r.stats()), hubs: hub.stats(), parties: parties.parties.size,
      storage: storage.kind, mem: Math.round(process.memoryUsage().rss / 1e6) + 'MB',
    });
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

function sendProfile(s, notes) {
  sendWs(s.ws, { t: 'profile', profile: { ...publicProfile(s.profile), tag: tagOf(s.profile.id) }, notes });
}

wss.on('connection', (ws) => {
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
      await onLobby(s, m);
    } catch (e) {
      sendWs(ws, { t: 'err', msg: e.message ?? String(e) });
    }
  });

  ws.on('close', () => {
    if (!pid) return;
    const s = sessions.get(pid);
    if (!s || s.ws !== ws) return;
    sessions.delete(pid);
    hub.leave(pid);
    if (s.spectating) raids.get(s.spectating)?.spectate(pid, false);
    parties.onDisconnect(pid);
    social.onDisconnect(pid);
    const p = s.profile;
    p.lastSeen = Date.now();
    if (p.inRaid) {
      raids.get(p.inRaid)?.detach(pid); // character stays in the raid, vulnerable
    } else {
      scheduleSave(p, true);
      if (!parties.partyOf(pid)) profiles.delete(pid);
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
  nameCache.set(p.id, p.name);
  // one session per profile
  const old = sessions.get(p.id);
  if (old && old.ws !== ws) { sendWs(old.ws, { t: 'err', msg: 'Logged in elsewhere' }); old.ws.close(4001, 'replaced'); hub.leave(p.id); }
  if (!profiles.has(p.id)) profiles.set(p.id, p);
  p = profiles.get(p.id);
  const s = { ws, profile: p, spectating: null, lastRaid: null };
  sessions.set(p.id, s);
  sendWs(ws, { t: 'welcome', token: p.token, id: p.id, tag: tagOf(p.id) });
  social.onConnect(p.id).catch(e => console.error('[social] connect', e));
  if (p.inRaid) {
    const raid = raids.get(p.inRaid);
    if (raid && raid.reattach(p.id, ws)) { s.lastRaid = raid.id; parties.onConnect(p.id); return p.id; }
    voidRaid(p);
    notes.push('Your last raid was interrupted (server restart). Your gear was returned.');
    scheduleSave(p);
  }
  sendProfile(s, notes);
  if (!parties.onConnect(p.id)) send(p.id, { t: 'party', party: null });
  return p.id;
}

const cardOf = (p) => ({ name: p.name, level: p.level });

async function onLobby(s, m) {
  const p = s.profile;
  const pid = p.id;
  switch (m.t) {
    // ---------------- hideout economy
    case 'act': {
      if (parties.isReady(pid)) throw new Error('Unready to change your gear');
      if (parties.inFill(pid)) throw new Error('Cancel the squad search to change your gear');
      const notes = applyAction(p, m);
      scheduleSave(p);
      sendProfile(s, notes);
      return;
    }
    case 'rename': {
      p.name = sanitizeName(m.name);
      nameCache.set(pid, p.name);
      scheduleSave(p);
      sendProfile(s);
      parties.pushFor(pid);
      return;
    }
    // ---------------- squads
    case 'party_create': parties.create(pid); return;
    case 'party_join': parties.join(pid, m.code); return;
    case 'party_leave': parties.leave(pid); return;
    case 'party_kick': parties.kick(pid, String(m.id)); return;
    case 'party_promote': parties.promote(pid, String(m.id)); return;
    case 'party_ready': parties.setReady(pid, !!m.ready); return;
    case 'party_settings': parties.settings(pid, { friendsJoin: m.friendsJoin }); return;
    case 'party_nudge': parties.nudge(pid); return;
    case 'party_invite': social.invite(pid, String(m.id)); return;
    case 'deploy': parties.deploy(pid, { force: !!m.force, fill: !!m.fill }); return;
    case 'join_squad': parties.joinSquad(pid); return;
    case 'fill_cancel': parties.cancelFill(pid); return;
    // ---------------- friends
    case 'friends_list': return social.sendList(pid);
    case 'friend_add': return social.add(pid, { tag: m.tag, id: m.id });
    case 'friend_accept': return social.accept(pid, String(m.id));
    case 'friend_decline': return social.decline(pid, String(m.id));
    case 'friend_remove': return social.remove(pid, String(m.id));
    case 'join_friend': return social.joinFriend(pid, String(m.id));
    // ---------------- walkable hub
    case 'hub_enter': hub.join(pid, s.ws, cardOf(p)); parties.pushFor(pid); return;
    case 'hub_leave': hub.leave(pid); parties.pushFor(pid); return;
    case 'hin': hub.input(pid, m); return;
    case 'emote': hub.emote(pid, String(m.e)); return;
    case 'hub_chat': {
      const text = String(m.text ?? '').slice(0, 140).trim();
      if (!text) return;
      if (m.ch === 'party') {
        const party = parties.partyOf(pid);
        if (!party) throw new Error('Not in a squad');
        for (const id of party.members.keys()) send(id, { t: 'hub_chat', ch: 'party', from: p.name, text });
      } else hub.chat(pid, text);
      return;
    }
    // ---------------- spectating squadmates after death / extract
    case 'spectate': {
      const raid = raids.get(s.lastRaid);
      if (!raid) { send(pid, { t: 'spec_end' }); return; }
      const ok = raid.spectate(pid, !!m.on, s.ws, !!m.next);
      s.spectating = m.on && ok ? raid.id : null;
      if (s.spectating) hub.leave(pid);
      parties.pushFor(pid);
      return;
    }
    case 'ping': return send(pid, { t: 'pong', c: m.c });
  }
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
