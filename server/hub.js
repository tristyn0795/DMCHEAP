// Walkable hub instances. Light-weight: 10 Hz position relay, emotes and chat, no combat.
// Placement: your party's instance first, then a friend's, then the fullest open one.
import { C } from '../shared/data.js';
import { resolveCircle } from '../shared/world.js';
import { HUB, generateHub, EMOTES } from '../shared/hubmap.js';

const r2 = v => Math.round(v * 100) / 100;

class HubRoom {
  constructor(id, mgr) {
    this.id = id;
    this.mgr = mgr;
    this.players = new Map(); // pid -> hp
    this.nextNid = 1;
    this.world = generateHub();
    this.interval = setInterval(() => this.tick(), 1000 / HUB.TICK);
  }
  get size() { return this.players.size; }

  add(pid, ws, card) {
    const a = Math.random() * Math.PI * 2, r = Math.random() * HUB.SPAWN.r;
    const p = {
      pid, ws, nid: this.nextNid++, name: card.name, level: card.level,
      x: HUB.SPAWN.x + Math.cos(a) * r, z: HUB.SPAWN.z + Math.sin(a) * r, yaw: Math.PI, moving: false, crouch: false,
      emote: null, emoteAt: 0, budget: 1, lastWall: performance.now() / 1000,
    };
    // spawn next to a party member if one is here
    const mate = [...this.players.values()].find(o => this.mgr.sameParty(o.pid, pid));
    if (mate) { p.x = mate.x + (Math.random() - 0.5) * 2; p.z = mate.z + (Math.random() - 0.5) * 2; }
    [p.x, p.z] = resolveCircle(this.world, p.x, p.z, C.PLAYER_RADIUS);
    this.players.set(pid, p);
    const roster = [...this.players.values()].map(o => this.card(o));
    this.send(p, { t: 'hub_start', inst: this.id, nid: p.nid, x: p.x, z: p.z, yaw: p.yaw, players: roster });
    this.broadcast({ t: 'hub_add', p: this.card(p) }, o => o !== p);
    return p;
  }
  card(o) { return { nid: o.nid, pid: o.pid, name: o.name, level: o.level }; }

  remove(pid) {
    const p = this.players.get(pid);
    if (!p) return;
    this.players.delete(pid);
    this.broadcast({ t: 'hub_rm', nid: p.nid });
  }

  send(p, m) { if (p.ws && p.ws.readyState === 1) p.ws.send(JSON.stringify(m)); }
  broadcast(m, filter) {
    const s = JSON.stringify(m);
    for (const p of this.players.values()) if ((!filter || filter(p)) && p.ws?.readyState === 1) p.ws.send(s);
  }

  input(pid, m) {
    const p = this.players.get(pid);
    if (!p) return;
    let nx = +m.x, nz = +m.z;
    if (!Number.isFinite(nx) || !Number.isFinite(nz)) return;
    if (Number.isFinite(+m.yaw)) p.yaw = +m.yaw;
    p.crouch = !!m.c;
    const wall = performance.now() / 1000;
    p.budget = Math.min(2, p.budget + C.SPRINT_SPEED * Math.min(0.5, wall - p.lastWall) * 1.25);
    p.lastWall = wall;
    const dx = nx - p.x, dz = nz - p.z, d = Math.hypot(dx, dz);
    let corrected = false;
    if (d > p.budget) { nx = p.x + dx / d * p.budget; nz = p.z + dz / d * p.budget; corrected = true; }
    const [rx, rz] = resolveCircle(this.world, nx, nz, C.PLAYER_RADIUS);
    if (Math.hypot(rx - nx, rz - nz) > 0.3) corrected = true;
    const moved = Math.hypot(rx - p.x, rz - p.z);
    p.budget = Math.max(0, p.budget - moved);
    p.moving = moved > 0.02;
    if (p.moving && p.emote) p.emote = null;
    p.x = rx; p.z = rz;
    if (corrected) this.send(p, { t: 'hub_pos', x: r2(p.x), z: r2(p.z) });
  }

  emote(pid, e) {
    const p = this.players.get(pid);
    if (!p || !EMOTES.includes(e)) return;
    p.emote = e; p.emoteAt = Date.now();
  }

  chat(pid, text) {
    const p = this.players.get(pid);
    if (!p) return;
    this.broadcast({ t: 'hub_chat', ch: 'hub', from: p.name, nid: p.nid, text });
  }

  tick() {
    if (!this.players.size) return;
    const list = [];
    for (const p of this.players.values()) {
      if (p.emote && Date.now() - p.emoteAt > 8000) p.emote = null;
      const flags = (p.moving ? 1 : 0) | (p.crouch ? 2 : 0) | (this.mgr.isReady(p.pid) ? 4 : 0);
      list.push([p.nid, r2(p.x), r2(p.z), r2(p.yaw), flags, p.emote ? EMOTES.indexOf(p.emote) : -1]);
    }
    const msg = JSON.stringify({ t: 'hub_s', p: list });
    for (const p of this.players.values()) if (p.ws?.readyState === 1) p.ws.send(msg);
  }

  close() { clearInterval(this.interval); }
}

export class HubManager {
  constructor({ partyOf, friendsOnline, isReady }) {
    this.rooms = new Map();
    this.where = new Map(); // pid -> room id
    this.nextId = 1;
    this.partyOf = partyOf;           // pid -> party | null
    this.friendsOnline = friendsOnline; // pid -> Set of friend pids currently online (cached)
    this.isReadyFn = isReady;
  }
  sameParty(a, b) { const pa = this.partyOf(a); return !!pa && pa === this.partyOf(b); }
  isReady(pid) { return this.isReadyFn(pid); }

  join(pid, ws, card) {
    this.leave(pid);
    const room = this.pick(pid);
    room.add(pid, ws, card);
    this.where.set(pid, room.id);
    return room;
  }

  pick(pid) {
    const open = [...this.rooms.values()].filter(r => r.size < HUB.CAP);
    const party = this.partyOf(pid);
    if (party) {
      for (const m of party.members.keys()) {
        const r = this.rooms.get(this.where.get(m));
        if (r && r.size < HUB.CAP) return r;
      }
    }
    const friends = this.friendsOnline(pid);
    if (friends?.size) {
      for (const f of friends) {
        const r = this.rooms.get(this.where.get(f));
        if (r && r.size < HUB.CAP) return r;
      }
    }
    // fill the fullest open room (keeps hubs lively), leave a little headroom for parties
    open.sort((a, b) => b.size - a.size);
    const best = open.find(r => r.size < HUB.CAP - 3) ?? open[0];
    if (best) return best;
    const room = new HubRoom('H' + this.nextId++, this);
    this.rooms.set(room.id, room);
    return room;
  }

  leave(pid) {
    const id = this.where.get(pid);
    if (!id) return;
    this.where.delete(pid);
    const room = this.rooms.get(id);
    if (!room) return;
    room.remove(pid);
    if (room.size === 0) { room.close(); this.rooms.delete(id); }
  }

  room(pid) { return this.rooms.get(this.where.get(pid)); }
  input(pid, m) { this.room(pid)?.input(pid, m); }
  emote(pid, e) { this.room(pid)?.emote(pid, e); }
  chat(pid, text) { this.room(pid)?.chat(pid, text); }
  instanceOf(pid) { return this.where.get(pid) ?? null; }
  stats() { return [...this.rooms.values()].map(r => ({ id: r.id, players: r.size })); }
}
