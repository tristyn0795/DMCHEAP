// Authoritative raid simulation: movement validation, hitscan combat with lag compensation,
// CHEAP machine + Rustline merc AI, stealth/noise, loot, keys, extraction, downed/revive, bounties.
import {
  C, ITEMS, WEAPONS, ENEMIES, POIS, LOOT_TABLES, CONTAINER_ROLLS, RARITY, HEADSHOT_MULT,
  makeStack, addToStacks, countItem, removeItem, skillRank, sellPrice,
} from '../shared/data.js';
import {
  mulberry32, randRange, randInt, pick, resolveCircle, raycast, lineOfSight, rayCylinder, raySphere,
  poiAt, EXTRACT_SITES, HATCH_SITES, SPAWN_SITES,
} from '../shared/world.js';

export const ENEMY_KEYS = Object.keys(ENEMIES);
export const WEAPON_KEYS = Object.keys(WEAPONS);
const DT = 1 / C.TICK_RATE;
const HISTORY = 24; // ~1.2s of lag-compensation history
const r2 = v => Math.round(v * 100) / 100;
const r1 = v => Math.round(v * 10) / 10;

let raidCounter = 1;

export class Raid {
  constructor(world, hooks) {
    this.id = 'R' + (raidCounter++).toString(36) + Math.random().toString(36).slice(2, 6);
    this.seed = (Math.random() * 2 ** 31) | 0;
    this.rng = mulberry32(this.seed);
    this.world = world;
    this.hooks = hooks; // { onResult(pid, result), onClosed(raid) }
    this.time = 0;
    this.tickNo = 0;
    this.players = new Map();     // pid -> player
    this.enemies = new Map();     // eid -> enemy
    this.nextNid = 1;
    this.nextEid = 1;
    this.doorOpen = {};
    this.grenades = [];
    this.strikes = [];
    this.closed = false;
    this.everJoined = false;
    this.usedSpawns = new Set();

    // containers: static (from world gen) + dynamic (bodies, wrecks, dropped bags)
    this.containers = new Map();
    for (const c of world.containers) {
      this.containers.set(c.id, { ...c, items: this.rollLoot(c.type, c.threat), opened: false, dyn: false });
    }
    this.nextCid = 10000;

    // extraction: 3 of 6 sites open per raid; two close early (DMZ radiation / Arc timers)
    const sites = [...EXTRACT_SITES].sort(() => this.rng() - 0.5).slice(0, 3);
    const closeAt = [C.RAID_DURATION - 6 * 60, C.RAID_DURATION - 3 * 60, C.RAID_DURATION];
    this.extracts = sites.map((s, i) => ({ ...s, state: 'idle', t: 0, closeAt: closeAt[i], closed: false, caller: null }));
    this.hatches = HATCH_SITES.map(h => ({ ...h, used: false }));

    this.spawnInitialEnemies();
    this.interval = setInterval(() => this.safeTick(), 1000 / C.TICK_RATE);
  }

  w() { this.world.doorOpen = this.doorOpen; return this.world; }

  get activeCount() {
    let n = 0;
    for (const p of this.players.values()) if (p.state === 'alive' || p.state === 'downed') n++;
    return n;
  }
  canJoin(n) {
    return !this.closed && this.time < C.JOIN_WINDOW && this.players.size + n <= C.MAX_PLAYERS_PER_RAID;
  }

  // ------------------------------------------------------------------ loot
  rollLoot(type, threat = 1) {
    const table = LOOT_TABLES[type];
    if (!table) return [];
    const [a, b] = CONTAINER_ROLLS[type] ?? [1, 2];
    const n = randInt(this.rng, a, b);
    const items = [];
    for (let i = 0; i < n; i++) {
      let total = 0;
      const weights = table.map(([id, wgt]) => {
        const ord = RARITY[ITEMS[id].rarity].order;
        const w = wgt * (1 + (threat - 1) * 0.3 * ord);
        total += w; return w;
      });
      let roll = this.rng() * total, k = 0;
      while (roll > weights[k]) { roll -= weights[k]; k++; }
      const [id, , [qa, qb]] = table[Math.min(k, table.length - 1)];
      addToStacks(items, makeStack(id, randInt(this.rng, qa, qb)));
    }
    return items;
  }

  addDynContainer(kind, name, x, z, items) {
    const c = { id: this.nextCid++, type: kind, name, x: r2(x), y: 0, z: r2(z), items, opened: true, dyn: true, threat: 1 };
    this.containers.set(c.id, c);
    this.broadcast({ t: 'cont_add', c: { id: c.id, type: kind, name, x: c.x, z: c.z } });
    return c;
  }

  // ------------------------------------------------------------------ enemies
  spawnInitialEnemies() {
    const comp = {
      1: ['gnat', 'gnat', 'tick', 'merc', 'tick'],
      2: ['gnat', 'gnat', 'tick', 'merc', 'merc', 'squealer', 'tick'],
      3: ['gnat', 'merc', 'merc', 'tick', 'squealer', 'sentry', 'gnat', 'merc'],
      4: ['merc', 'merc', 'sentry', 'sentry', 'gnat', 'squealer', 'tick', 'merc', 'gnat'],
      5: ['sentry', 'sentry', 'merc', 'merc', 'merc', 'gnat', 'squealer', 'tick'],
    };
    for (const poi of POIS) {
      const count = 3 + poi.threat * 3;
      poi._initial = count;
      for (let i = 0; i < count; i++) this.spawnEnemyAtPoi(pick(this.rng, comp[poi.threat]), poi);
      if (poi.boss) this.spawnEnemy(poi.boss, poi.x, poi.z, poi.id);
    }
    // roaming gnat patrols between POIs
    for (let i = 0; i < 8; i++) {
      const a = pick(this.rng, POIS);
      const e = this.spawnEnemy('gnat', a.x + randRange(this.rng, -20, 20), a.z + randRange(this.rng, -20, 20), null);
      e.roam = true;
    }
  }

  spawnEnemyAtPoi(type, poi) {
    const a = randRange(this.rng, 0, Math.PI * 2), r = randRange(this.rng, 3, poi.r);
    return this.spawnEnemy(type, poi.x + Math.cos(a) * r, poi.z + Math.sin(a) * r, poi.id);
  }

  spawnEnemy(type, x, z, poiId) {
    if (this.enemies.size > 140) return null;
    const d = ENEMIES[type];
    const w = this.w();
    if (!d.fly) [x, z] = resolveCircle(w, x, z, Math.max(0.4, Math.min(d.radius, 1.2)), 0, 2);
    const e = {
      id: this.nextEid++, type, d, x, z, y: d.fly || 0, yaw: this.rng() * Math.PI * 2,
      hp: d.hp, state: 'patrol', target: null, home: { x, z }, poi: poiId,
      aware: new Map(), lastShot: 0, inv: null, lostT: 0, wander: null, alarmT: 0, alarmCd: 0,
      hist: [], seenT: 0, barrageT: 6, strafe: this.rng() < 0.5 ? 1 : -1, percOff: this.nextEid % 4,
      weapon: type === 'merc' ? (this.rng() < 0.6 ? 'ranger' : 'buzz') : null,
    };
    this.enemies.set(e.id, e);
    return e;
  }

  // ------------------------------------------------------------------ players
  addPlayer(profile, deploy, ws, squadId, spawnHint) {
    const sp = spawnHint ?? this.pickSpawn();
    const p = {
      id: profile.id, nid: this.nextNid++, name: profile.name, squad: squadId, ws,
      x: sp.x + randRange(this.rng, -2, 2), z: sp.z + randRange(this.rng, -2, 2), yaw: 0, pitch: 0,
      crouch: false, sprint: false, ads: false, moving: false,
      skills: { ...profile.skills }, level: profile.level,
      state: 'alive', downHp: 0, bleed: 0, selfRevivable: false,
      inv: structuredClone(deploy.loadout), active: deploy.loadout.primary ? 'primary' : 'secondary',
      stamina: C.STAMINA_MAX, reloadUntil: 0, lastShot: -10, action: null, moveBudget: 0.5,
      kills: { total: 0 }, pkills: 0, xp: 0, visited: new Set(), wanted: false, bounty: 0,
      hist: [], lastPosWall: performance.now() / 1000, noiseT: 0, awareness: 0, invDirty: true, openCont: null,
      deployInfo: deploy, joinedAt: this.time, msgCount: 0, msgWindow: 0, lastHitBy: null,
    };
    p.maxHp = C.BASE_HP + 10 * skillRank(p, 'tough');
    p.hp = p.maxHp;
    [p.x, p.z] = resolveCircle(this.w(), p.x, p.z, C.PLAYER_RADIUS);
    p.yaw = Math.atan2(p.x, p.z); // face roughly toward map centre
    this.players.set(p.id, p);
    this.everJoined = true;
    this.sendStart(p);
    return { player: p, spawn: sp };
  }

  pickSpawn() {
    const free = SPAWN_SITES.filter((s, i) => !this.usedSpawns.has(i));
    const list = free.length ? free : SPAWN_SITES;
    // prefer spawns far from active players
    let best = list[0], bd = -1;
    for (const s of list) {
      let md = Infinity;
      for (const p of this.players.values()) if (p.state === 'alive') md = Math.min(md, Math.hypot(p.x - s.x, p.z - s.z));
      let ex = Infinity;
      for (const e of this.extracts) ex = Math.min(ex, Math.hypot(e.x - s.x, e.z - s.z));
      const score = Math.min(md, 200) + this.rng() * 40 - (ex < 110 ? (110 - ex) * 3 : 0);
      if (score > bd) { bd = score; best = s; }
    }
    this.usedSpawns.add(SPAWN_SITES.indexOf(best));
    return best;
  }

  reattach(pid, ws) {
    const p = this.players.get(pid);
    if (!p || (p.state !== 'alive' && p.state !== 'downed')) return false;
    p.ws = ws;
    p.invDirty = true;
    this.sendStart(p);
    return true;
  }

  detach(pid) {
    const p = this.players.get(pid);
    if (p) p.ws = null;
  }

  sendStart(p) {
    const squad = [...this.players.values()].filter(o => o.squad === p.squad).map(o => ({ nid: o.nid, name: o.name }));
    const names = [...this.players.values()].map(o => [o.nid, o.name]);
    this.send(p, {
      t: 'raid_start', raid: this.id, nid: p.nid, x: p.x, z: p.z, yaw: p.yaw, time: this.time, duration: C.RAID_DURATION,
      extracts: this.extracts.map(e => ({ id: e.id, name: e.name, x: e.x, z: e.z, state: e.state, t: e.t, closeAt: e.closeAt, closed: e.closed })),
      hatches: this.hatches.map(h => ({ id: h.id, x: h.x, z: h.z, used: h.used })),
      doors: this.doorOpen, squad, names,
      opened: [...this.containers.values()].filter(c => c.opened && !c.dyn).map(c => c.id),
      dyn: [...this.containers.values()].filter(c => c.dyn).map(c => ({ id: c.id, type: c.type, name: c.name, x: c.x, z: c.z })),
      hp: p.hp, maxHp: p.maxHp,
    });
    this.sendInv(p);
  }

  send(p, msg) {
    if (p.ws && p.ws.readyState === 1) p.ws.send(JSON.stringify(msg));
  }
  broadcast(msg, filter) {
    const s = JSON.stringify(msg);
    for (const p of this.players.values()) {
      if (!p.ws || p.ws.readyState !== 1) continue;
      if (p.state !== 'alive' && p.state !== 'downed') continue;
      if (filter && !filter(p)) continue;
      p.ws.send(s);
    }
  }
  broadcastNear(x, z, range, msg) {
    this.broadcast(msg, p => Math.hypot(p.x - x, p.z - z) < range);
  }
  msg(p, text, kind = 'info') { this.send(p, { t: 'msg', text, kind }); }

  sendInv(p) {
    p.invDirty = false;
    this.send(p, { t: 'inv', inv: p.inv, active: p.active, packCap: this.packCap(p), safeCap: this.safeCap(p) });
  }
  packCap(p) { return (p.inv.rig ? ITEMS[p.inv.rig.id].slots : 4) + skillRank(p, 'pack_mule'); }
  safeCap(p) { return p.inv.rig ? ITEMS[p.inv.rig.id].safe : 0; }
  shieldCap(p) {
    const s = p.inv.shield; if (!s) return 0;
    return Math.round(ITEMS[s.id].cap * (1 + 0.1 * skillRank(p, 'shield_tech')));
  }
  speedMult(p) {
    let m = 1 + 0.03 * skillRank(p, 'fleet');
    if (p.inv.rig) m *= ITEMS[p.inv.rig.id].speed;
    if (p.inv.shield) m *= ITEMS[p.inv.shield.id].speed;
    return m;
  }
  weapon(p) { return p.inv[p.active]; }
  alive(p) { return p.state === 'alive'; }
  inRaid(p) { return p.state === 'alive' || p.state === 'downed'; }
  eyeY(p) { return p.state === 'downed' ? 0.5 : p.crouch ? C.EYE_CROUCH : C.EYE_STAND; }

  // ------------------------------------------------------------------ message handling
  handle(pid, m) {
    const p = this.players.get(pid);
    if (!p || !this.inRaid(p) || this.closed) return;
    this.w();
    switch (m.t) {
      case 'in': return this.onInput(p, m);
      case 'fire': return this.onFire(p, m);
      case 'reload': return this.onReload(p);
      case 'swap': {
        if (p.state !== 'alive' || p.action) return;
        const slot = m.slot === 'secondary' ? 'secondary' : 'primary';
        if (p.inv[slot] && p.active !== slot) { p.active = slot; p.reloadUntil = 0; p.invDirty = true; }
        return;
      }
      case 'use': return this.onUse(p, String(m.id));
      case 'throw': return this.onThrow(p, m);
      case 'interact': return this.onInteract(p, m);
      case 'take': return this.onTake(p, m);
      case 'put': return this.onPut(p, m);
      case 'invmove': return this.onInvMove(p, m);
      case 'close_loot': p.openCont = null; return;
      case 'cancel': p.action = null; return;
      case 'chat': {
        const text = String(m.text ?? '').slice(0, 140);
        if (!text.trim()) return;
        const ch = m.ch === 'prox' ? 'prox' : 'squad';
        const out = { t: 'chat', ch, from: p.name, text };
        if (ch === 'squad') this.broadcast(out, o => o.squad === p.squad);
        else this.broadcast(out, o => Math.hypot(o.x - p.x, o.z - p.z) < C.PROX_CHAT_RANGE);
        return;
      }
      case 'ping': {
        const x = +m.x, z = +m.z;
        if (Number.isFinite(x) && Number.isFinite(z)) this.broadcast({ t: 'ping', nid: p.nid, x: r1(x), z: r1(z), y: r1(+m.y || 0) }, o => o.squad === p.squad);
        return;
      }
    }
  }

  onInput(p, m) {
    let nx = +m.x, nz = +m.z;
    if (!Number.isFinite(nx) || !Number.isFinite(nz)) return;
    p.yaw = Number.isFinite(+m.yaw) ? +m.yaw : p.yaw;
    p.pitch = Math.max(-1.4, Math.min(1.4, Number.isFinite(+m.pitch) ? +m.pitch : 0));
    const downed = p.state === 'downed';
    p.crouch = !!m.c && !downed;
    p.ads = !!m.a && !downed;
    const wantSprint = !!m.s && !p.crouch && !p.ads && !downed && p.stamina > 1;
    const wall = performance.now() / 1000;
    const dtSince = Math.min(0.5, Math.max(0, wall - p.lastPosWall));
    p.lastPosWall = wall;
    const maxSpeed = downed ? C.DOWNED_SPEED : (wantSprint ? C.SPRINT_SPEED : C.WALK_SPEED) * this.speedMult(p);
    // movement budget: accrues at max speed (+25% jitter tolerance), capped so bursts after lag stay small
    p.moveBudget = Math.min(2.0, p.moveBudget + maxSpeed * dtSince * 1.25);
    const allowed = p.moveBudget;
    let dx = nx - p.x, dz = nz - p.z;
    let dist = Math.hypot(dx, dz);
    let corrected = false;
    if (dist > allowed) { nx = p.x + dx / dist * allowed; nz = p.z + dz / dist * allowed; corrected = true; dist = allowed; }
    // anti-tunnelling: segment must not cross a blocking box at knee height
    if (dist > 0.05) {
      const w = this.world;
      const hit = raycast(w, p.x, 0.5, p.z, (nx - p.x) / dist, 0, (nz - p.z) / dist, dist + C.PLAYER_RADIUS * 0.5);
      if (hit.box >= 0 && hit.t < dist - 0.05) {
        const t = Math.max(0, hit.t - C.PLAYER_RADIUS);
        nx = p.x + (nx - p.x) / dist * t; nz = p.z + (nz - p.z) / dist * t; corrected = true;
      }
    }
    const [rx, rz] = resolveCircle(this.world, nx, nz, C.PLAYER_RADIUS, 0, 1.8);
    if (Math.hypot(rx - nx, rz - nz) > 0.3) corrected = true;
    p.moveBudget = Math.max(0, p.moveBudget - Math.hypot(rx - p.x, rz - p.z));
    p.moving = Math.hypot(rx - p.x, rz - p.z) > 0.02;
    p.sprint = wantSprint && p.moving;
    p.x = rx; p.z = rz;
    if (corrected) this.send(p, { t: 'pos', x: r2(p.x), z: r2(p.z) });
    // revive/hatch/search are cancelled by walking away
    if (p.action && p.action.anchor && Math.hypot(p.x - p.action.anchor.x, p.z - p.action.anchor.z) > 1.5) {
      p.action = null; this.send(p, { t: 'action', a: null });
    }
    const poi = poiAt(p.x, p.z);
    if (poi) p.visited.add(poi.id);
  }

  onFire(p, m) {
    if (p.state !== 'alive' || p.action?.blocksFire) return;
    const s = this.weapon(p);
    if (!s) return;
    const W = WEAPONS[s.id];
    if (this.time < p.reloadUntil) return;
    const interval = 60 / W.rpm;
    if (this.time - p.lastShot < interval * 0.75) return;
    if (s.mag <= 0) return;
    if (p.sprint) return;
    s.mag--;
    p.lastShot = this.time;
    const dirs = Array.isArray(m.d) ? m.d.slice(0, W.pellets) : [];
    const ox = p.x, oy = this.eyeY(p), oz = p.z;
    const rt = Math.max(this.time - 0.35, Math.min(this.time, +m.rt || this.time));
    const tracers = [];
    for (const d of dirs) {
      if (!Array.isArray(d) || d.length !== 3) continue;
      let [dx, dy, dz] = d.map(Number);
      const len = Math.hypot(dx, dy, dz);
      if (!Number.isFinite(len) || len < 1e-6) continue;
      dx /= len; dy /= len; dz /= len;
      const end = this.hitscan(p, ox, oy, oz, dx, dy, dz, W, rt);
      tracers.push([r1(end[0]), r1(end[1]), r1(end[2])]);
    }
    this.emitNoise(p.x, p.z, W.noise, p);
    this.broadcastNear(p.x, p.z, C.AOI_RANGE, { t: 'fx', k: 'shot', nid: p.nid, w: s.id, o: [r1(ox), r1(oy), r1(oz)], e: tracers });
  }

  // Lag-compensated hitscan: rewind other players/enemies to the client's render time.
  hitscan(shooter, ox, oy, oz, dx, dy, dz, W, rt) {
    const maxT = W.range * 2;
    const world = raycast(this.world, ox, oy, oz, dx, dy, dz, maxT);
    let best = world.t, hit = null;
    for (const o of this.players.values()) {
      if (o === shooter || !this.inRaid(o)) continue;
      if (o.squad === shooter.squad) continue; // no friendly fire
      const pos = this.rewind(o, rt);
      if (Math.hypot(pos.x - ox, pos.z - oz) > best + 2) continue;
      const downed = o.state === 'downed';
      const top = downed ? 0.7 : pos.c ? 1.0 : 1.45;
      const headY = downed ? -10 : pos.c ? 1.18 : 1.62;
      const th = raySphere(ox, oy, oz, dx, dy, dz, pos.x, headY, pos.z, 0.25, best);
      if (th >= 0 && th < best) { best = th; hit = { kind: 'player', o, head: true }; }
      const tb = rayCylinder(ox, oy, oz, dx, dy, dz, pos.x, pos.z, 0.42, 0, top, best);
      if (tb >= 0 && tb < best) { best = tb; hit = { kind: 'player', o, head: false }; }
    }
    for (const e of this.enemies.values()) {
      const pos = this.rewind(e, rt);
      if (Math.hypot(pos.x - ox, pos.z - oz) > best + 4) continue;
      if (e.d.human) {
        const th = raySphere(ox, oy, oz, dx, dy, dz, pos.x, 1.62, pos.z, 0.25, best);
        if (th >= 0 && th < best) { best = th; hit = { kind: 'enemy', e, head: true }; }
        const tb = rayCylinder(ox, oy, oz, dx, dy, dz, pos.x, pos.z, 0.42, 0, 1.45, best);
        if (tb >= 0 && tb < best) { best = tb; hit = { kind: 'enemy', e, head: false }; }
      } else {
        const cy = this.enemyCenterY(e, pos.y);
        if (e.d.weakpoint) {
          const fx = -Math.sin(e.yaw), fz = -Math.cos(e.yaw);
          const tw = raySphere(ox, oy, oz, dx, dy, dz, pos.x - fx * e.d.weakpoint, cy + 0.9, pos.z - fz * e.d.weakpoint, 0.75, best);
          if (tw >= 0 && tw < best) { best = tw; hit = { kind: 'enemy', e, head: true }; }
        }
        const t = raySphere(ox, oy, oz, dx, dy, dz, pos.x, cy, pos.z, e.d.radius, best);
        if (t >= 0 && t < best) { best = t; hit = { kind: 'enemy', e, head: false }; }
      }
    }
    if (hit) {
      const fall = best <= W.range ? 1 : Math.max(0.5, 1 - (best - W.range) / W.range * 0.5);
      let dmg = W.dmg * fall;
      if (hit.kind === 'player') {
        if (hit.head) dmg *= HEADSHOT_MULT;
        const res = this.damagePlayer(hit.o, dmg, { kind: 'player', p: shooter, x: ox, z: oz });
        this.send(shooter, { t: 'hit', k: res.killed ? 'kill' : hit.head ? 'head' : res.shield ? 'shield' : 'body', d: Math.round(dmg) });
      } else {
        const e = hit.e;
        if (hit.head) dmg *= e.d.human ? HEADSHOT_MULT : 2;
        if (e.d.frontArmor) {
          const ang = Math.atan2(ox - e.x, oz - e.z);
          const facing = Math.cos(ang - (e.yaw + Math.PI));
          if (facing > 0.3) dmg *= e.d.frontArmor;
        }
        const killed = this.damageEnemy(e, dmg, shooter);
        this.send(shooter, { t: 'hit', k: killed ? 'kill' : hit.head ? 'weak' : 'body', d: Math.round(dmg) });
      }
    }
    return [ox + dx * best, oy + dy * best, oz + dz * best];
  }

  enemyCenterY(e, y = e.y) {
    if (e.d.fly) return y;
    if (e.type === 'sentry') return 1.3;
    if (e.type === 'warden') return 3.2;
    return e.d.radius;
  }

  rewind(ent, t) {
    const h = ent.hist;
    if (!h.length || t >= h[h.length - 1][0]) return { x: ent.x, y: ent.y ?? 0, z: ent.z, c: ent.crouch };
    for (let i = h.length - 1; i > 0; i--) {
      const a = h[i - 1], b = h[i];
      if (a[0] <= t && t <= b[0]) {
        const k = (t - a[0]) / Math.max(1e-6, b[0] - a[0]);
        return { x: a[1] + (b[1] - a[1]) * k, y: a[2] + (b[2] - a[2]) * k, z: a[3] + (b[3] - a[3]) * k, c: b[4] };
      }
    }
    const a = h[0];
    return { x: a[1], y: a[2], z: a[3], c: a[4] };
  }

  onReload(p) {
    if (p.state !== 'alive' || p.action) return;
    const s = this.weapon(p);
    if (!s || this.time < p.reloadUntil) return;
    const W = WEAPONS[s.id];
    if (s.mag >= W.mag || countItem(p.inv.pack, W.ammo) <= 0) return;
    const t = W.reload * (1 - 0.08 * skillRank(p, 'quick_hands'));
    p.reloadUntil = this.time + t;
    p.reloading = { slot: p.active, until: p.reloadUntil };
    this.send(p, { t: 'action', a: 'reload', dur: t });
  }

  finishReload(p) {
    const r = p.reloading; p.reloading = null;
    const s = p.inv[r.slot];
    if (!s) return;
    const W = WEAPONS[s.id];
    const need = W.mag - s.mag;
    const have = countItem(p.inv.pack, W.ammo);
    const take = Math.min(need, have);
    if (take > 0) { removeItem(p.inv.pack, W.ammo, take); s.mag += take; }
    p.invDirty = true;
  }

  onUse(p, id) {
    const it = ITEMS[id];
    if (!it || it.type !== 'med' || p.action) return;
    const fromPack = countItem(p.inv.pack, id) > 0;
    const fromSafe = !fromPack && countItem(p.inv.safe, id) > 0;
    if (!fromPack && !fromSafe) return this.msg(p, `No ${it.name}`);
    if (p.state === 'downed' && !it.selfRevive) return;
    if (p.state === 'alive' && it.selfRevive) return this.msg(p, 'Tourniquets are used while downed');
    if (it.heal && p.hp >= p.maxHp) return this.msg(p, 'Already at full health');
    if (it.recharge && (!p.inv.shield || p.inv.shield.charge >= this.shieldCap(p))) return this.msg(p, p.inv.shield ? 'Shield already full' : 'No shield equipped');
    const dur = (it.use ?? 5) * (1 - 0.08 * skillRank(p, 'quick_hands'));
    p.action = { k: 'use', id, until: this.time + dur, blocksFire: true };
    p.reloadUntil = 0; p.reloading = null;
    this.send(p, { t: 'action', a: 'use', id, dur });
  }

  finishUse(p, id) {
    const it = ITEMS[id];
    const arr = countItem(p.inv.pack, id) > 0 ? p.inv.pack : p.inv.safe;
    if (!removeItem(arr, id, 1)) return;
    if (it.heal) p.hp = Math.min(p.maxHp, p.hp + it.heal * (1 + 0.15 * skillRank(p, 'medic')));
    if (it.recharge && p.inv.shield) p.inv.shield.charge = Math.min(this.shieldCap(p), p.inv.shield.charge + it.recharge * (1 + 0.15 * skillRank(p, 'medic')));
    if (it.selfRevive && p.state === 'downed') this.revive(p, null);
    p.invDirty = true;
  }

  onThrow(p, m) {
    if (p.state !== 'alive' || p.action) return;
    const id = String(m.id);
    const it = ITEMS[id];
    if (!it || it.type !== 'grenade') return;
    if (!removeItem(p.inv.pack, id, 1)) return this.msg(p, `No ${it.name}`);
    p.invDirty = true;
    let [dx, dy, dz] = Array.isArray(m.d) ? m.d.map(Number) : [0, 0, -1];
    const len = Math.hypot(dx, dy, dz) || 1;
    dx /= len; dy /= len; dz /= len;
    const v = 17;
    this.grenades.push({
      id: Math.random().toString(36).slice(2, 7), kind: id, owner: p, x: p.x + dx * 0.6, y: this.eyeY(p), z: p.z + dz * 0.6,
      vx: dx * v, vy: dy * v + 4, vz: dz * v, fuse: id === 'frag' ? 2.4 : 1.2, lureT: 0, active: false,
    });
  }

  onInteract(p, m) {
    if (p.action) return;
    const kind = m.k;
    if (kind === 'revive') {
      if (p.state !== 'alive') return;
      const o = [...this.players.values()].find(x => x.nid === m.nid);
      if (!o || o.state !== 'downed' || o.squad !== p.squad) return;
      if (Math.hypot(o.x - p.x, o.z - p.z) > C.INTERACT_RANGE) return;
      p.action = { k: 'revive', target: o, until: this.time + C.REVIVE_TIME, anchor: { x: p.x, z: p.z }, blocksFire: true };
      this.send(p, { t: 'action', a: 'revive', dur: C.REVIVE_TIME });
      this.msg(o, `${p.name} is reviving you`);
      return;
    }
    if (p.state !== 'alive') return;
    if (kind === 'cont') {
      const c = this.containers.get(m.id | 0);
      if (!c || Math.hypot(c.x - p.x, c.z - p.z) > C.INTERACT_RANGE + 0.6) return;
      if (c.opened) { this.openLoot(p, c); return; }
      const dur = C.SEARCH_TIME * (1 - 0.2 * skillRank(p, 'scavenger')) * (c.type === 'safe' || c.type === 'cache' ? 1.8 : 1);
      p.action = { k: 'search', c, until: this.time + dur, anchor: { x: p.x, z: p.z } };
      this.emitNoise(p.x, p.z, 8, p);
      this.send(p, { t: 'action', a: 'search', dur });
      return;
    }
    if (kind === 'door') {
      const d = this.world.doors.find(x => x.id === m.id);
      if (!d || this.doorOpen[d.id] || Math.hypot(d.x - p.x, d.z - p.z) > 3.2) return;
      const arr = countItem(p.inv.pack, d.key) > 0 ? p.inv.pack : countItem(p.inv.safe, d.key) > 0 ? p.inv.safe : null;
      if (!arr) return this.msg(p, `Locked. Needs ${ITEMS[d.key].name}`, 'warn');
      removeItem(arr, d.key, 1);
      p.invDirty = true;
      this.doorOpen[d.id] = true;
      this.broadcast({ t: 'door', id: d.id, open: true });
      this.msg(p, 'Vault unlocked');
      return;
    }
    if (kind === 'extract') {
      const ex = this.extracts.find(e => e.id === m.id);
      if (!ex || Math.hypot(ex.x - p.x, ex.z - p.z) > C.EXTRACT_RADIUS) return;
      if (ex.closed) return this.msg(p, 'This extraction is closed', 'warn');
      if (ex.state === 'called') return this.msg(p, `Lift arriving in ${Math.ceil(ex.t)}s — hold the zone`);
      if (ex.state === 'cooldown') return this.msg(p, `Lift cycling, ready in ${Math.ceil(ex.t)}s`);
      ex.state = 'called'; ex.t = C.EXTRACT_COUNTDOWN; ex.caller = p.name;
      this.broadcast({ t: 'extract', id: ex.id, state: ex.state, tt: ex.t, by: p.name });
      this.emitNoise(ex.x, ex.z, 120, null, true);
      this.extractSwarm(ex, p);
      return;
    }
    if (kind === 'hatch') {
      const h = this.hatches.find(x => x.id === m.id);
      if (!h || h.used || Math.hypot(h.x - p.x, h.z - p.z) > C.INTERACT_RANGE) return;
      if (countItem(p.inv.pack, 'hatch_key') + countItem(p.inv.safe, 'hatch_key') <= 0) return this.msg(p, 'Raider hatch sealed. Needs a Hatch Key', 'warn');
      p.action = { k: 'hatch', h, until: this.time + C.HATCH_TIME, anchor: { x: p.x, z: p.z }, blocksFire: true };
      this.send(p, { t: 'action', a: 'hatch', dur: C.HATCH_TIME });
    }
  }

  openLoot(p, c) {
    p.openCont = c.id;
    if (!c.opened) {
      c.opened = true;
      if (!c.dyn) this.broadcast({ t: 'cont_open', id: c.id });
    }
    this.send(p, { t: 'loot', id: c.id, type: c.type, name: c.name ?? null, items: c.items });
  }

  refreshLoot(c) {
    for (const o of this.players.values()) if (o.openCont === c.id) this.send(o, { t: 'loot', id: c.id, type: c.type, name: c.name ?? null, items: c.items });
    if (c.dyn && c.items.length === 0 && c.type === 'bag') {
      this.containers.delete(c.id);
      this.broadcast({ t: 'cont_rm', id: c.id });
    }
  }

  onTake(p, m) {
    if (p.state !== 'alive') return;
    const c = this.containers.get(m.id | 0);
    if (!c || !c.opened || Math.hypot(c.x - p.x, c.z - p.z) > C.INTERACT_RANGE + 1) return;
    const i = m.i | 0;
    const s = c.items[i];
    if (!s) return;
    const it = ITEMS[s.id];
    const to = m.to;
    if (to === 'equip' && ['weapon', 'shield', 'rig'].includes(it.type)) {
      let slot = it.type === 'shield' ? 'shield' : it.type === 'rig' ? 'rig' : (!p.inv.primary ? 'primary' : !p.inv.secondary ? 'secondary' : p.active);
      const prev = p.inv[slot];
      c.items.splice(i, 1);
      p.inv[slot] = s;
      if (prev) c.items.push(prev);
      if (slot === 'rig') {
        const cap = this.packCap(p), sc = this.safeCap(p);
        while (p.inv.pack.length > cap) c.items.push(p.inv.pack.pop());
        while (p.inv.safe.length > sc) c.items.push(p.inv.safe.pop());
      }
      if (slot === 'shield' && s.charge > this.shieldCap(p)) s.charge = this.shieldCap(p);
      if (!p.inv[p.active]) p.active = slot === 'secondary' ? 'secondary' : 'primary';
    } else {
      const toSafe = to === 'safe';
      if (toSafe && ['weapon', 'shield', 'rig'].includes(it.type)) return this.msg(p, 'Weapons and gear cannot go in the safe pocket');
      const arr = toSafe ? p.inv.safe : p.inv.pack;
      const cap = toSafe ? this.safeCap(p) : this.packCap(p);
      const left = addToStacks(arr, { ...s }, cap);
      if (left === s.qty) return this.msg(p, toSafe ? 'Safe pocket full' : 'Backpack full', 'warn');
      if (left > 0) s.qty = left; else c.items.splice(i, 1);
      if (s.id === 'warden_heart' || RARITY[it.rarity].order >= 3) p.xp += 40;
      else p.xp += 5;
    }
    p.invDirty = true;
    this.refreshLoot(c);
  }

  onPut(p, m) {
    if (p.state !== 'alive') return;
    const from = ['pack', 'safe', 'primary', 'secondary', 'shield', 'rig'].includes(m.from) ? m.from : null;
    if (!from) return;
    let s;
    if (from === 'pack' || from === 'safe') {
      s = p.inv[from][m.i | 0];
      if (!s) return;
      p.inv[from].splice(m.i | 0, 1);
    } else {
      s = p.inv[from];
      if (!s) return;
      p.inv[from] = null;
      if (from === 'rig') {
        while (p.inv.pack.length > this.packCap(p)) this.dropStack(p, p.inv.pack.pop());
        while (p.inv.safe.length > this.safeCap(p)) this.dropStack(p, p.inv.safe.pop());
      }
      if (from === p.active) p.active = p.inv.primary ? 'primary' : 'secondary';
    }
    let c = m.id != null ? this.containers.get(m.id | 0) : null;
    if (c && Math.hypot(c.x - p.x, c.z - p.z) > C.INTERACT_RANGE + 1) c = null;
    if (c) { c.items.push(s); this.refreshLoot(c); } else this.dropStack(p, s);
    p.invDirty = true;
  }

  dropStack(p, s) {
    // merge into a nearby bag or create one
    let bag = null;
    for (const c of this.containers.values()) if (c.type === 'bag' && Math.hypot(c.x - p.x, c.z - p.z) < 1.5) { bag = c; break; }
    if (!bag) bag = this.addDynContainer('bag', 'Dropped bag', p.x, p.z, []);
    bag.items.push(s);
    this.refreshLoot(bag);
  }

  onInvMove(p, m) {
    if (p.state !== 'alive') return;
    // move between pack and safe pocket, or equip weapon from pack
    const from = m.from === 'safe' ? 'safe' : 'pack';
    const s = p.inv[from][m.i | 0];
    if (!s) return;
    const it = ITEMS[s.id];
    if (m.to === 'equip' && ['weapon', 'shield', 'rig'].includes(it.type)) {
      const slot = it.type === 'weapon' ? (!p.inv.primary ? 'primary' : !p.inv.secondary ? 'secondary' : p.active) : it.type;
      p.inv[from].splice(m.i | 0, 1);
      const prev = p.inv[slot];
      p.inv[slot] = s;
      if (prev) { if (addToStacks(p.inv.pack, prev, this.packCap(p)) > 0) this.dropStack(p, prev); }
      if (slot === 'rig') {
        while (p.inv.pack.length > this.packCap(p)) this.dropStack(p, p.inv.pack.pop());
        while (p.inv.safe.length > this.safeCap(p)) this.dropStack(p, p.inv.safe.pop());
      }
    } else {
      const to = from === 'pack' ? 'safe' : 'pack';
      if (to === 'safe' && ['weapon', 'shield', 'rig'].includes(it.type)) return this.msg(p, 'Weapons and gear cannot go in the safe pocket');
      const cap = to === 'safe' ? this.safeCap(p) : this.packCap(p);
      const left = addToStacks(p.inv[to], { ...s }, cap);
      if (left === s.qty) return this.msg(p, 'No room', 'warn');
      if (left > 0) s.qty = left; else p.inv[from].splice(m.i | 0, 1);
    }
    p.invDirty = true;
  }

  // ------------------------------------------------------------------ damage
  damagePlayer(o, amount, src) {
    if (!this.inRaid(o)) return {};
    let shieldHit = false;
    if (o.state === 'downed') {
      o.downHp -= amount;
      if (o.downHp <= 0) { this.kill(o, src); return { killed: true }; }
      return {};
    }
    const sh = o.inv.shield;
    let hpDmg = amount;
    if (sh && sh.charge > 0) {
      const absorb = Math.min(sh.charge, amount * ITEMS[sh.id].absorb);
      sh.charge = Math.max(0, sh.charge - absorb);
      hpDmg = amount - absorb;
      shieldHit = true;
    }
    o.hp -= hpDmg;
    o.lastHitBy = src.kind === 'player' ? src.p : null;
    this.send(o, { t: 'dmg', x: r1(src.x ?? o.x), z: r1(src.z ?? o.z), d: Math.round(amount) });
    if (o.action && o.action.k === 'search') o.action = null;
    if (o.hp <= 0) {
      o.hp = 0;
      const mates = [...this.players.values()].some(x => x !== o && x.squad === o.squad && x.state === 'alive');
      const hasTq = countItem(o.inv.pack, 'tourniquet') + countItem(o.inv.safe, 'tourniquet') > 0;
      if (mates || hasTq) {
        o.state = 'downed'; o.downHp = C.DOWNED_HP; o.bleed = C.BLEEDOUT; o.action = null; o.reloading = null;
        o.downedBy = src;
        this.send(o, { t: 'downed', bleed: C.BLEEDOUT, canSelf: hasTq });
        this.broadcast({ t: 'feed', text: `${src.kind === 'player' ? src.p.name : src.name ?? 'CHEAP'} downed ${o.name}` }, x => x.squad === o.squad || (src.kind === 'player' && x === src.p));
        return { downed: true, shield: shieldHit };
      }
      this.kill(o, src);
      return { killed: true };
    }
    return { shield: shieldHit };
  }

  revive(o, by) {
    o.state = 'alive'; o.hp = 30; o.downHp = 0; o.action = null;
    this.send(o, { t: 'revived' });
    if (by) by.xp += 100;
    this.broadcast({ t: 'feed', text: by ? `${by.name} revived ${o.name}` : `${o.name} got back up` }, x => x.squad === o.squad);
  }

  kill(o, src, cause) {
    if (!this.inRaid(o)) return;
    o.state = 'dead';
    o.action = null;
    const killer = src?.kind === 'player' ? src.p : (o.downedBy?.kind === 'player' ? o.downedBy.p : null);
    const items = [];
    for (const k of ['primary', 'secondary', 'shield', 'rig']) if (o.inv[k]) items.push(o.inv[k]);
    items.push(...o.inv.pack);
    this.addDynContainer('body', `${o.name}'s body`, o.x, o.z, items);
    const safe = o.inv.safe;
    o.inv = { primary: null, secondary: null, shield: null, rig: null, pack: [], safe };
    if (killer && killer !== o) {
      killer.pkills++;
      killer.kills.total++;
      killer.xp += 150;
      if (o.wanted) { killer.bounty += C.WANTED_BOUNTY; this.msg(killer, `Wanted target eliminated: +$${C.WANTED_BOUNTY} bounty on extract`); }
      if (!killer.wanted && killer.pkills >= C.WANTED_KILLS) {
        killer.wanted = true;
        this.broadcast({ t: 'msg', text: `${killer.name} is now WANTED — location revealed. Bounty: $${C.WANTED_BOUNTY}`, kind: 'warn' });
      }
    }
    const how = cause ?? (killer ? `Killed by ${killer.name}` : `Killed by ${src?.name ?? 'the Zone'}`);
    this.broadcast({ t: 'feed', text: killer ? `${killer.name} eliminated ${o.name}` : `${o.name} died` });
    this.finish(o, false, how);
    // squadmates who are downed with no one left to revive them bleed out instantly
    for (const m of this.players.values()) {
      if (m.squad === o.squad && m.state === 'downed') {
        const any = [...this.players.values()].some(x => x.squad === m.squad && x.state === 'alive');
        const tq = countItem(m.inv.pack, 'tourniquet') + countItem(m.inv.safe, 'tourniquet') > 0;
        if (!any && !tq) this.kill(m, m.downedBy, 'Bled out — no squadmates left');
      }
    }
  }

  finish(p, extracted, how) {
    if (extracted) p.state = 'extracted';
    if (extracted) p.xp += 250;
    p.openCont = null;
    const res = {
      extracted, cause: extracted ? 'extracted' : 'dead', how,
      inv: extracted ? p.inv : { primary: null, secondary: null, shield: null, rig: null, pack: [], safe: p.inv.safe },
      xp: p.xp, kills: p.kills, pkills: p.pkills, visited: [...p.visited], bounty: extracted ? p.bounty : 0,
      duration: Math.round(this.time - p.joinedAt),
    };
    this.hooks.onResult(p.id, res, p.deployInfo).then(report => {
      this.send(p, { t: 'raid_end', extracted, how, report });
    }).catch(e => console.error('[raid] onResult failed', e));
  }

  damageEnemy(e, dmg, src) {
    if (!this.enemies.has(e.id)) return false;
    e.hp -= dmg;
    if (src) {
      e.aware.set(src.id, 1);
      if (e.state !== 'combat') { e.state = 'combat'; e.target = src.id; e.lostT = 0; e.react = this.time + 0.4; }
      if (e.target !== src.id && this.rng() < 0.3) e.target = src.id;
    }
    if (e.hp > 0) return false;
    this.enemies.delete(e.id);
    // drops
    let items = [];
    if (e.type === 'merc') {
      items = this.rollLoot('merc', 2);
      if (e.weapon && this.rng() < 0.35) { const s = makeStack(e.weapon); s.mag = randInt(this.rng, 0, Math.floor(s.mag / 2)); items.push(s); }
    } else {
      for (const [id, [a, b]] of Object.entries(e.d.drops)) {
        const n = randInt(this.rng, a, b);
        if (n > 0) addToStacks(items, makeStack(id, n));
      }
    }
    if (e.d.boss) addToStacks(items, makeStack('gilded'));
    if (items.length) this.addDynContainer(e.type === 'merc' ? 'body' : 'wreck', `${e.d.name} ${e.type === 'merc' ? 'body' : 'wreck'}`, e.x, e.z, items);
    this.broadcastNear(e.x, e.z, C.AOI_RANGE, { t: 'fx', k: e.d.human ? 'die' : 'pop', x: r1(e.x), y: r1(this.enemyCenterY(e)), z: r1(e.z), big: !!e.d.boss });
    if (src) {
      src.kills[e.type] = (src.kills[e.type] ?? 0) + 1;
      src.kills.total++;
      src.xp += e.d.xp;
    }
    if (e.d.boss) this.broadcast({ t: 'msg', text: `${src?.name ?? 'Someone'} brought down THE WARDEN`, kind: 'warn' });
    return true;
  }

  explode(x, y, z, radius, dmg, src, opts = {}) {
    const w = this.world;
    for (const o of this.players.values()) {
      if (!this.inRaid(o)) continue;
      const d = Math.hypot(o.x - x, 1 - y, o.z - z);
      if (d > radius) continue;
      if (!lineOfSight(w, x, y + 0.3, z, o.x, 1, o.z)) continue;
      const amt = dmg * (1 - d / radius * 0.7);
      if (opts.ownerSquad != null && o.squad === opts.ownerSquad && o !== src) continue;
      this.damagePlayer(o, amt, src ? { kind: 'player', p: src, x, z } : { kind: 'enemy', name: opts.name ?? 'Explosion', x, z });
    }
    if (!opts.noEnemies) {
      for (const e of [...this.enemies.values()]) {
        const cy = this.enemyCenterY(e);
        const d = Math.hypot(e.x - x, cy - y, e.z - z);
        if (d > radius + e.d.radius) continue;
        if (!lineOfSight(w, x, y + 0.3, z, e.x, cy, e.z)) continue;
        this.damageEnemy(e, dmg * (1 - Math.max(0, d - e.d.radius) / radius * 0.7) * (e.d.boss ? 1.5 : 1), src);
      }
    }
    this.broadcastNear(x, z, C.AOI_RANGE, { t: 'fx', k: 'boom', x: r1(x), y: r1(y), z: r1(z), r: radius });
    this.emitNoise(x, z, 80, src);
  }

  // ------------------------------------------------------------------ noise & AI
  emitNoise(x, z, radius, src, force = false) {
    for (const e of this.enemies.values()) {
      const d = Math.hypot(e.x - x, e.z - z);
      if (d > radius) continue;
      if (e.state === 'combat' && !force) continue;
      if (e.state !== 'combat') { e.state = 'investigate'; e.inv = { x: x + randRange(this.rng, -4, 4), z: z + randRange(this.rng, -4, 4), t: 0 }; }
      if (src && d < radius * 0.5) e.aware.set(src.id, Math.min(0.95, (e.aware.get(src.id) ?? 0) + 0.5));
    }
  }

  extractSwarm(ex, caller) {
    const n = 2 + Math.floor(this.time / 300);
    for (let i = 0; i < n + 2; i++) {
      const a = this.rng() * Math.PI * 2, r = randRange(this.rng, 40, 60);
      const type = i < 2 ? 'gnat' : pick(this.rng, ['tick', 'tick', 'merc', 'gnat']);
      const e = this.spawnEnemy(type, ex.x + Math.cos(a) * r, ex.z + Math.sin(a) * r, null);
      if (!e) break;
      e.state = 'investigate'; e.inv = { x: ex.x, z: ex.z, t: 0 };
      e.aware.set(caller.id, 0.7);
    }
  }

  updateEnemies(dt) {
    const w = this.world;
    const live = [...this.players.values()].filter(p => this.inRaid(p));
    for (const p of live) p.awareNew = 0;
    for (const e of this.enemies.values()) {
      const d = e.d;
      e.alarmCd = Math.max(0, e.alarmCd - dt);
      // ---- perception (staggered: each enemy every 4th tick)
      if ((this.tickNo + e.percOff) % 4 === 0) {
        const ey = this.enemyCenterY(e) + (d.human ? 1.4 : 0.2);
        for (const p of live) {
          const dx = p.x - e.x, dz = p.z - e.z;
          const dist = Math.hypot(dx, dz);
          let aw = e.aware.get(p.id) ?? 0;
          const vis = (p.crouch ? 0.6 : 1) * (p.sprint ? 1.25 : 1) * (p.state === 'downed' ? 0.5 : 1);
          const sight = d.sight * vis;
          let seen = false;
          if (dist < sight) {
            const ang = Math.atan2(-dx, -dz);
            let diff = Math.abs(((ang - e.yaw + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
            const inCone = diff < 1.25 || dist < 7 || d.fly || e.state === 'combat';
            if (inCone && lineOfSight(w, e.x, ey, e.z, p.x, this.eyeY(p) - 0.3, p.z)) seen = true;
          }
          if (seen) {
            aw += (0.35 + (1 - dist / sight) * 2.2) * dt * 4;
            if (aw >= 1) {
              aw = 1;
              if (e.state !== 'combat' || !e.target) { e.state = 'combat'; e.target = p.id; e.react = this.time + 0.8; }
              if (e.target === p.id) { e.last = { x: p.x, z: p.z }; e.lostT = 0; }
            }
          } else {
            aw = Math.max(0, aw - 0.25 * dt * 4 * (e.state === 'combat' ? 0.3 : 1));
          }
          e.aware.set(p.id, aw);
          if (aw > (p.awareNew ?? 0)) p.awareNew = aw;
          if (e.target === p.id) e.seeTarget = seen;
        }
      } else {
        for (const p of live) { const aw = e.aware.get(p.id) ?? 0; if (aw > p.awareNew) p.awareNew = aw; }
      }

      // ---- behaviour
      let tgt = e.target ? this.players.get(e.target) : null;
      if (tgt && !this.inRaid(tgt)) { tgt = null; e.target = null; e.state = 'patrol'; }
      if (e.state === 'combat' && tgt) {
        const dx = tgt.x - e.x, dz = tgt.z - e.z, dist = Math.hypot(dx, dz);
        const face = Math.atan2(-dx, -dz);
        e.yaw = turnToward(e.yaw, face, (e.type === 'sentry' ? 1.4 : e.type === 'warden' ? 1.2 : 5) * dt);
        if (!e.seeTarget) {
          e.lostT += dt;
          if (e.lostT > 5) { e.state = 'investigate'; e.inv = { ...(e.last ?? { x: tgt.x, z: tgt.z }), t: 0 }; e.target = null; continue; }
          if (e.last && d.speed) this.steer(e, e.last.x, e.last.z, d.speed * 0.9, dt);
        } else {
          // movement style per type
          if (e.type === 'tick') {
            this.steer(e, tgt.x, tgt.z, d.speed, dt);
            if (dist < d.range + 0.6) { this.enemies.delete(e.id); this.explode(e.x, 0.5, e.z, d.explode, d.dmg, null, { name: 'Tick', noEnemies: false }); continue; }
          } else if (e.type === 'gnat') {
            const orbit = 12;
            const ox = tgt.x - Math.sin(this.time * 0.7 + e.id) * orbit, oz = tgt.z - Math.cos(this.time * 0.7 + e.id) * orbit;
            this.steer(e, ox, oz, d.speed * 0.8, dt);
          } else if (e.type === 'squealer') {
            const away = dist < 18 ? -1 : 0;
            if (away) this.steer(e, e.x - dx, e.z - dz, d.speed, dt);
            e.alarmT += dt;
            if (e.alarmT > 2.5 && e.alarmCd <= 0) {
              e.alarmT = 0; e.alarmCd = 25;
              this.broadcastNear(e.x, e.z, C.AOI_RANGE, { t: 'fx', k: 'alarm', x: r1(e.x), y: r1(e.y), z: r1(e.z) });
              this.emitNoise(e.x, e.z, 70, tgt, true);
              for (let i = 0; i < 3; i++) {
                const g = this.spawnEnemy('gnat', e.x + randRange(this.rng, -6, 6), e.z + randRange(this.rng, -6, 6), null);
                if (g) { g.state = 'combat'; g.target = tgt.id; g.aware.set(tgt.id, 1); g.last = { x: tgt.x, z: tgt.z }; }
              }
            }
          } else if (e.type === 'merc' || e.type === 'warden') {
            const want = d.range * 0.55;
            if (dist > want) this.steer(e, tgt.x, tgt.z, d.speed, dt);
            else if (e.type === 'merc') {
              // strafe
              const sx = -dz / dist * e.strafe, sz = dx / dist * e.strafe;
              if (!this.steer(e, e.x + sx * 3, e.z + sz * 3, d.speed * 0.6, dt)) e.strafe *= -1;
              if (this.rng() < dt * 0.3) e.strafe *= -1;
            }
          }
          // shooting
          if (d.rpm > 0 && dist < d.range) {
            const facingOk = Math.abs(((face - e.yaw + Math.PI * 3) % (Math.PI * 2)) - Math.PI) < 0.35;
            if (facingOk && this.time >= (e.react ?? 0) && this.time - e.lastShot >= 60 / d.rpm) {
              e.lastShot = this.time;
              this.enemyShoot(e, tgt, dist);
            }
          }
          if (e.type === 'warden') {
            e.barrageT -= dt;
            if (e.barrageT <= 0) {
              e.barrageT = 8;
              for (let i = 0; i < 5; i++) {
                const sx = tgt.x + randRange(this.rng, -6, 6), sz = tgt.z + randRange(this.rng, -6, 6);
                this.strikes.push({ x: sx, z: sz, t: 1.4 + i * 0.25 });
                this.broadcastNear(sx, sz, C.AOI_RANGE, { t: 'fx', k: 'mark', x: r1(sx), z: r1(sz), dur: 1.4 + i * 0.25 });
              }
            }
          }
        }
      } else if (e.state === 'investigate' && e.inv) {
        if (d.speed) {
          const reached = Math.hypot(e.inv.x - e.x, e.inv.z - e.z) < 2.5;
          if (!reached) {
            this.steer(e, e.inv.x, e.inv.z, d.speed * 0.7, dt);
            e.yaw = turnToward(e.yaw, Math.atan2(-(e.inv.x - e.x), -(e.inv.z - e.z)), 4 * dt);
          } else {
            e.inv.t += dt;
            e.yaw += dt * 1.2;
          }
          if (e.inv.t > 5) { e.state = 'patrol'; e.inv = null; }
        } else {
          e.yaw = turnToward(e.yaw, Math.atan2(-(e.inv.x - e.x), -(e.inv.z - e.z)), 1.4 * dt);
          e.inv.t += dt;
          if (e.inv.t > 6) { e.state = 'patrol'; e.inv = null; }
        }
      } else {
        // patrol / idle wander
        e.state = 'patrol';
        if (!d.speed) { e.yaw += dt * 0.5; }
        else {
          if (!e.wander || Math.hypot(e.wander.x - e.x, e.wander.z - e.z) < 2 || this.rng() < dt * 0.05) {
            if (e.roam) {
              const poi = pick(this.rng, POIS);
              e.wander = { x: poi.x + randRange(this.rng, -15, 15), z: poi.z + randRange(this.rng, -15, 15) };
            } else {
              e.wander = { x: e.home.x + randRange(this.rng, -14, 14), z: e.home.z + randRange(this.rng, -14, 14) };
            }
          }
          this.steer(e, e.wander.x, e.wander.z, d.speed * 0.35, dt);
          e.yaw = turnToward(e.yaw, Math.atan2(-(e.wander.x - e.x), -(e.wander.z - e.z)), 2 * dt);
        }
      }
      if (d.fly) e.y = d.fly + Math.sin(this.time * 2 + e.id) * 0.4;
    }
    for (const p of live) p.awareness = p.awareNew ?? 0;
  }

  steer(e, tx, tz, speed, dt) {
    const w = this.world;
    const dx = tx - e.x, dz = tz - e.z;
    const dist = Math.hypot(dx, dz);
    if (dist < 0.2) return true;
    const base = Math.atan2(dx, dz);
    const r = Math.min(e.d.radius, 1.2);
    const fy = e.d.fly ? e.y : 0.5;
    let moved = false;
    for (const off of [0, 0.6, -0.6, 1.2, -1.2, 1.8, -1.8, 2.5, -2.5]) {
      const a = base + off * (e.strafe || 1);
      const sx = Math.sin(a), sz = Math.cos(a);
      const look = Math.min(dist, 2.5 + r);
      const hit = raycast(w, e.x, fy, e.z, sx, 0, sz, look);
      if (hit.box >= 0 && hit.t < look - 0.01) continue;
      const step = Math.min(dist, speed * dt);
      let nx = e.x + sx * step, nz = e.z + sz * step;
      if (e.d.fly) [nx, nz] = resolveCircle(w, nx, nz, r, e.y - 0.5, e.y + 0.5);
      else [nx, nz] = resolveCircle(w, nx, nz, r, 0, e.type === 'warden' ? 5 : 1.8);
      e.x = nx; e.z = nz;
      if (!e.d.fly || e.state !== 'combat') e.yawMove = a;
      moved = true;
      break;
    }
    return moved;
  }

  enemyShoot(e, tgt, dist) {
    const w = this.world;
    const ey = this.enemyCenterY(e) + (e.d.human ? 1.4 : 0);
    const ty = this.eyeY(tgt) - 0.4;
    let dx = tgt.x - e.x, dy = ty - ey, dz = tgt.z - e.z;
    const len = Math.hypot(dx, dy, dz);
    dx /= len; dy /= len; dz /= len;
    const base = { gnat: 0.07, merc: 0.05, sentry: 0.045, warden: 0.055 }[e.type] ?? 0.05;
    const spread = base + (tgt.sprint ? 0.03 : tgt.moving ? 0.015 : 0) - (tgt.crouch ? 0.01 : 0) + dist * 0.0004;
    dx += (this.rng() - 0.5) * 2 * spread; dy += (this.rng() - 0.5) * 2 * spread; dz += (this.rng() - 0.5) * 2 * spread;
    const l2 = Math.hypot(dx, dy, dz); dx /= l2; dy /= l2; dz /= l2;
    const wt = raycast(w, e.x, ey, e.z, dx, dy, dz, e.d.range * 1.5);
    let end = wt.t;
    const top = tgt.state === 'downed' ? 0.7 : tgt.crouch ? 1.0 : 1.7;
    const t = rayCylinder(e.x, ey, e.z, dx, dy, dz, tgt.x, tgt.z, 0.45, 0, top, wt.t);
    if (t >= 0) {
      end = t;
      this.damagePlayer(tgt, e.d.dmg, { kind: 'enemy', name: e.d.name, x: e.x, z: e.z });
    }
    this.broadcastNear(e.x, e.z, C.AOI_RANGE, { t: 'fx', k: 'eshot', id: e.id, o: [r1(e.x), r1(ey), r1(e.z)], e: [r1(e.x + dx * end), r1(ey + dy * end), r1(e.z + dz * end)] });
  }

  // ------------------------------------------------------------------ tick
  safeTick() {
    try { this.tick(); } catch (err) { console.error('[raid] tick error', err); }
  }

  tick() {
    if (this.closed) return;
    const dt = DT;
    this.time += dt;
    this.tickNo++;
    this.w();

    for (const p of this.players.values()) {
      if (!this.inRaid(p)) continue;
      // stamina
      const smax = C.STAMINA_MAX * (1 + 0.2 * skillRank(p, 'marathon'));
      if (p.sprint) p.stamina = Math.max(0, p.stamina - C.STAMINA_DRAIN * dt);
      else p.stamina = Math.min(smax, p.stamina + C.STAMINA_REGEN * dt);
      if (p.stamina <= 0) p.sprint = false;
      // footstep noise
      p.noiseT -= dt;
      if (p.moving && p.noiseT <= 0 && !p.crouch && p.state === 'alive') {
        const r = p.sprint ? 16 * (1 - 0.25 * skillRank(p, 'quiet_feet')) : 6;
        this.emitNoise(p.x, p.z, r, p);
        p.noiseT = p.sprint ? 0.45 : 0.8;
      }
      if (p.reloading && this.time >= p.reloading.until) this.finishReload(p);
      if (p.state === 'downed') {
        const anyMate = [...this.players.values()].some(x => x !== p && x.squad === p.squad && x.state === 'alive');
        p.bleed -= dt * (anyMate ? 1 : 1.5);
        if (p.bleed <= 0) { this.kill(p, p.downedBy, 'Bled out'); continue; }
      }
      const a = p.action;
      if (a && this.time >= a.until) {
        p.action = null;
        if (a.k === 'use') this.finishUse(p, a.id);
        else if (a.k === 'search') this.openLoot(p, a.c);
        else if (a.k === 'revive') { if (a.target.state === 'downed') this.revive(a.target, p); }
        else if (a.k === 'hatch') {
          if (!a.h.used && (removeItem(p.inv.pack, 'hatch_key', 1) || removeItem(p.inv.safe, 'hatch_key', 1))) {
            a.h.used = true;
            this.broadcast({ t: 'hatch', id: a.h.id, used: true });
            this.finish(p, true, 'Extracted through a raider hatch');
          }
        }
      }
    }

    this.updateEnemies(dt);
    this.updateGrenades(dt);

    for (let i = this.strikes.length - 1; i >= 0; i--) {
      const s = this.strikes[i];
      s.t -= dt;
      if (s.t <= 0) { this.strikes.splice(i, 1); this.explode(s.x, 0.3, s.z, 4.5, 55, null, { name: 'The Warden', noEnemies: true }); }
    }

    // extraction
    for (const ex of this.extracts) {
      if (!ex.closed && this.time >= ex.closeAt) {
        ex.closed = true; ex.state = 'closed';
        this.broadcast({ t: 'extract', id: ex.id, state: 'closed' });
        if (ex.closeAt < C.RAID_DURATION) this.broadcast({ t: 'msg', text: `${ex.name} extraction is now CLOSED`, kind: 'warn' });
        continue;
      }
      if (ex.state === 'called') {
        ex.t -= dt;
        if (ex.t <= 0) {
          let n = 0;
          for (const p of this.players.values()) {
            if (p.state === 'alive' && Math.hypot(p.x - ex.x, p.z - ex.z) <= C.EXTRACT_RADIUS) { this.finish(p, true, `Extracted at ${ex.name}`); n++; }
          }
          ex.state = 'cooldown'; ex.t = C.EXTRACT_COOLDOWN;
          this.broadcast({ t: 'extract', id: ex.id, state: ex.state, tt: ex.t, n });
        }
      } else if (ex.state === 'cooldown') {
        ex.t -= dt;
        if (ex.t <= 0) { ex.state = 'idle'; this.broadcast({ t: 'extract', id: ex.id, state: 'idle' }); }
      }
    }

    // time warnings + sweep
    const left = C.RAID_DURATION - this.time;
    for (const mark of [300, 120, 60, 30]) {
      if (left <= mark && left + dt > mark) this.broadcast({ t: 'msg', text: `THE SWEEP begins in ${mark >= 60 ? mark / 60 + ' min' : mark + 's'} — extract now`, kind: 'warn' });
    }
    if (left <= 0) {
      for (const p of this.players.values()) if (this.inRaid(p)) this.kill(p, { kind: 'enemy', name: 'The Sweep' }, 'Caught in The Sweep (raid timer expired)');
    }

    // POI repopulation for late joiners
    if (this.tickNo % (C.TICK_RATE * 90) === 0) this.repopulate();

    // history for lag compensation
    for (const p of this.players.values()) {
      if (!this.inRaid(p)) continue;
      p.hist.push([this.time, p.x, 0, p.z, p.crouch]);
      if (p.hist.length > HISTORY) p.hist.shift();
    }
    for (const e of this.enemies.values()) {
      e.hist.push([this.time, e.x, e.y, e.z, false]);
      if (e.hist.length > HISTORY) e.hist.shift();
    }

    this.sendSnapshots();

    if (this.everJoined && this.activeCount === 0 && this.time > 5) this.close();
  }

  updateGrenades(dt) {
    const w = this.world;
    for (let i = this.grenades.length - 1; i >= 0; i--) {
      const g = this.grenades[i];
      const nx = g.x + g.vx * dt, ny = g.y + g.vy * dt, nz = g.z + g.vz * dt;
      const dx = nx - g.x, dy = ny - g.y, dz = nz - g.z, len = Math.hypot(dx, dy, dz);
      if (len > 1e-4) {
        const hit = raycast(w, g.x, g.y, g.z, dx / len, dy / len, dz / len, len);
        if (hit.box >= 0 && hit.t < len) {
          const b = w.boxes[hit.box];
          // reflect off the face we hit (approximate by nearest face)
          const hx = g.x + dx / len * hit.t, hy = g.y + dy / len * hit.t, hz = g.z + dz / len * hit.t;
          const faces = [Math.abs(hx - b.x0), Math.abs(hx - b.x1), Math.abs(hy - b.y0), Math.abs(hy - b.y1), Math.abs(hz - b.z0), Math.abs(hz - b.z1)];
          const f = faces.indexOf(Math.min(...faces));
          if (f < 2) g.vx = -g.vx * 0.4; else if (f < 4) g.vy = -g.vy * 0.4; else g.vz = -g.vz * 0.4;
          g.x = hx - dx / len * 0.05; g.y = hy - dy / len * 0.05; g.z = hz - dz / len * 0.05;
        } else { g.x = nx; g.y = ny; g.z = nz; }
      }
      g.vy -= 22 * dt;
      if (g.y <= 0.1) { g.y = 0.1; g.vy = Math.abs(g.vy) * 0.3; g.vx *= 0.6; g.vz *= 0.6; if (Math.abs(g.vy) < 1) g.vy = 0; }
      g.fuse -= dt;
      if (g.kind === 'frag' && g.fuse <= 0) {
        this.grenades.splice(i, 1);
        this.explode(g.x, g.y, g.z, ITEMS.frag.radius, ITEMS.frag.dmg, g.owner, { ownerSquad: g.owner.squad });
        continue;
      }
      if (g.kind === 'lure' && g.fuse <= 0) {
        g.lureT += dt;
        if ((g.lureT % 1) < dt) {
          // pull machines (not mercs) even out of combat
          for (const e of this.enemies.values()) {
            if (e.d.human || e.d.boss) continue;
            if (Math.hypot(e.x - g.x, e.z - g.z) < 60) { e.state = 'investigate'; e.target = null; e.inv = { x: g.x, z: g.z, t: 0 }; }
          }
        }
        if (g.lureT > ITEMS.lure.lure) { this.grenades.splice(i, 1); continue; }
      }
    }
  }

  repopulate() {
    for (const poi of POIS) {
      let count = 0;
      for (const e of this.enemies.values()) if (e.poi === poi.id) count++;
      if (count >= poi._initial * 0.5) continue;
      const near = [...this.players.values()].some(p => this.inRaid(p) && Math.hypot(p.x - poi.x, p.z - poi.z) < poi.r + 60);
      if (near) continue;
      const add = Math.ceil(poi._initial * 0.6) - count;
      for (let i = 0; i < add; i++) this.spawnEnemyAtPoi(pick(this.rng, ['gnat', 'tick', 'merc']), poi);
    }
  }

  sendSnapshots() {
    const players = [...this.players.values()].filter(p => this.inRaid(p));
    const wanted = players.filter(p => p.wanted).map(p => [p.nid, r1(p.x), r1(p.z)]);
    for (const p of players) {
      if (!p.ws || p.ws.readyState !== 1) continue;
      if (p.invDirty) this.sendInv(p);
      const ps = [];
      for (const o of players) {
        if (o === p) continue;
        const sq = o.squad === p.squad;
        if (!sq && Math.hypot(o.x - p.x, o.z - p.z) > C.AOI_RANGE) continue;
        const flags = (o.crouch ? 1 : 0) | (o.sprint ? 2 : 0) | (o.ads ? 4 : 0) | (o.state === 'downed' ? 8 : 0) |
          (o.wanted ? 16 : 0) | (o.reloading ? 32 : 0) | (o.action ? 64 : 0) | (sq ? 128 : 0) | (o.moving ? 256 : 0);
        const wi = o.inv[o.active] ? WEAPON_KEYS.indexOf(o.inv[o.active].id) : -1;
        ps.push([o.nid, r2(o.x), r2(o.z), r2(o.yaw), r2(o.pitch), flags, wi, Math.round(o.hp / o.maxHp * 100)]);
      }
      const es = [];
      for (const e of this.enemies.values()) {
        if (Math.hypot(e.x - p.x, e.z - p.z) > C.AOI_RANGE) continue;
        const st = e.state === 'combat' ? 2 : e.state === 'investigate' ? 1 : 0;
        es.push([e.id, ENEMY_KEYS.indexOf(e.type), r2(e.x), r2(e.y), r2(e.z), r2(e.yaw), st, Math.round(e.hp / e.d.hp * 100)]);
      }
      const wpn = this.weapon(p);
      const me = {
        hp: Math.round(p.hp), mhp: p.maxHp, sh: Math.round(p.inv.shield?.charge ?? 0), shc: this.shieldCap(p),
        st: Math.round(p.stamina), aw: r2(p.awareness), mag: wpn?.mag ?? 0,
        res: wpn ? countItem(p.inv.pack, WEAPONS[wpn.id].ammo) : 0, s: p.state,
        dh: p.state === 'downed' ? Math.round(p.bleed) : undefined, wanted: p.wanted || undefined,
      };
      this.send(p, { t: 's', tm: r2(this.time), p: ps, e: es, me, w: wanted.length ? wanted : undefined });
    }
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.interval);
    this.hooks.onClosed(this);
  }

  stats() {
    return { id: this.id, time: Math.round(this.time), players: this.activeCount, enemies: this.enemies.size };
  }
}

function turnToward(a, b, maxStep) {
  let d = ((b - a + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
  if (Math.abs(d) <= maxStep) return b;
  return a + Math.sign(d) * maxStep;
}
