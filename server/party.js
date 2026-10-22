// Persistent squads ("parties"): keyed by profile id, survive disconnects (grace period) and raids.
// Ready check locks loadouts; the leader deploys ready members and holds slots for the rest;
// Fill Squad queues small groups together (ARC Raiders / Marathon style).
import { C } from '../shared/data.js';

export const GRACE_MS = 5 * 60 * 1000;     // keep a disconnected member's slot this long
export const RESERVE_MS = 5 * 60 * 1000;   // hold a raid slot for squadmates left behind
const FILL_MAX_WAIT = +process.env.FILL_WAIT_MS || 15 * 1000;
const RECENT_RESULT_MS = 90 * 1000;

export class PartyManager {
  constructor(ctx) {
    this.ctx = ctx;              // { sessions, profiles, raids, hub, send, statusOf, deployGroup, joinRaid, names }
    this.parties = new Map();    // code -> party
    this.of = new Map();         // pid -> party
    this.fillQueue = [];         // { pids, party, since }
    this.sweepTimer = setInterval(() => this.sweep(), 5000);
    this.fillTimer = setInterval(() => this.matchFill(), 1000);
  }

  partyOf(pid) { return this.of.get(pid) ?? null; }
  isReady(pid) { return !!this.partyOf(pid)?.members.get(pid)?.ready; }

  newCode() {
    let code;
    do { code = Math.random().toString(36).slice(2, 7).toUpperCase(); } while (code.length < 5 || this.parties.has(code));
    return code;
  }

  create(pid) {
    this.leave(pid, true);
    const party = { code: this.newCode(), leader: pid, members: new Map(), friendsJoin: true, raid: null };
    this.parties.set(party.code, party);
    this.addMember(party, pid);
    this.push(party);
    return party;
  }

  addMember(party, pid) {
    party.members.set(pid, { ready: false, offlineAt: null, last: null });
    this.of.set(pid, party);
  }

  join(pid, code, { viaFriend = false, silent = false } = {}) {
    const party = this.parties.get(String(code ?? '').toUpperCase().trim());
    if (!party) throw new Error('No squad with that code');
    if (party.members.has(pid)) return party;
    if (party.members.size >= C.MAX_SQUAD) throw new Error('Squad is full');
    if (viaFriend && !party.friendsJoin) throw new Error('That squad is invite-only');
    this.cancelFill(pid);
    this.cancelFillParty(party);
    this.leave(pid, true);
    this.addMember(party, pid);
    if (!silent) this.notice(party, `${this.ctx.names(pid)} joined the squad`, pid);
    this.push(party);
    return party;
  }

  leave(pid, quiet = false) {
    const party = this.partyOf(pid);
    if (!party) return;
    this.cancelFill(pid);
    party.members.delete(pid);
    this.of.delete(pid);
    if (party.members.size === 0) {
      this.parties.delete(party.code);
    } else {
      if (party.leader === pid) party.leader = this.pickLeader(party);
      if (!quiet) this.notice(party, `${this.ctx.names(pid)} left the squad`);
      this.push(party);
    }
    this.ctx.send(pid, { t: 'party', party: null });
  }

  pickLeader(party) {
    // prefer an online member
    for (const id of party.members.keys()) if (this.ctx.sessions.has(id)) return id;
    return [...party.members.keys()][0];
  }

  kick(pid, target) {
    const party = this.partyOf(pid);
    if (!party || party.leader !== pid) throw new Error('Only the squad leader can do that');
    if (target === pid || !party.members.has(target)) return;
    this.leave(target, true);
    this.ctx.send(target, { t: 'notice', text: 'You were removed from the squad' });
    this.notice(party, `${this.ctx.names(target)} was removed`);
  }

  promote(pid, target) {
    const party = this.partyOf(pid);
    if (!party || party.leader !== pid || !party.members.has(target)) return;
    party.leader = target;
    this.push(party);
  }

  setReady(pid, ready) {
    const party = this.partyOf(pid);
    if (!party) throw new Error('Not in a squad');
    if (this.ctx.profiles.get(pid)?.inRaid) throw new Error('You are still topside');
    party.members.get(pid).ready = !!ready;
    this.push(party);
    // everyone ready -> tell the leader
    if (ready && [...party.members.entries()].every(([id, m]) => id === party.leader || m.ready)) {
      this.ctx.send(party.leader, { t: 'notice', text: 'Squad is ready — deploy when you are', kind: 'good' });
    }
  }

  settings(pid, s) {
    const party = this.partyOf(pid);
    if (!party || party.leader !== pid) throw new Error('Only the squad leader can change squad settings');
    if (typeof s.friendsJoin === 'boolean') party.friendsJoin = s.friendsJoin;
    this.push(party);
  }

  nudge(pid) {
    const party = this.partyOf(pid);
    if (!party || party.leader !== pid) return;
    for (const [id, m] of party.members) if (id !== pid && !m.ready) this.ctx.send(id, { t: 'notice', text: `${this.ctx.names(pid)} wants to deploy — ready up!`, kind: 'nudge' });
  }

  onConnect(pid) {
    const party = this.partyOf(pid);
    if (!party) return null;
    party.members.get(pid).offlineAt = null;
    this.push(party);
    return party;
  }

  onDisconnect(pid) {
    this.cancelFill(pid);
    const party = this.partyOf(pid);
    if (!party) return;
    const m = party.members.get(pid);
    m.offlineAt = Date.now();
    m.ready = false;
    if (party.leader === pid) {
      const next = this.pickLeader(party);
      if (next !== pid) party.leader = next;
    }
    this.push(party);
  }

  // A member's raid finished (extracted or KIA) — keep the squad together.
  onRaidResult(pid, extracted) {
    const party = this.partyOf(pid);
    if (!party) return;
    const m = party.members.get(pid);
    if (m) m.last = { extracted, at: Date.now() };
    const anyTopside = [...party.members.keys()].some(id => this.ctx.profiles.get(id)?.inRaid);
    if (!anyTopside && party.raid) {
      const raid = this.ctx.raids.get(party.raid.raidId);
      if (!raid || ![...raid.reserved.values()].some(r => r.squad === party.raid.squadId && r.until > Date.now())) party.raid = null;
    }
    this.push(party);
  }

  sweep() {
    const now = Date.now();
    for (const party of [...this.parties.values()]) {
      let changed = false;
      for (const [id, m] of [...party.members]) {
        if (m.offlineAt && now - m.offlineAt > GRACE_MS && !this.ctx.profiles.get(id)?.inRaid) {
          this.leave(id, true);
          this.notice(party, `${this.ctx.names(id)} dropped from the squad (offline)`);
          changed = true;
        }
        if (m.last && now - m.last.at > RECENT_RESULT_MS) { m.last = null; changed = true; }
      }
      if (party.raid) {
        const raid = this.ctx.raids.get(party.raid.raidId);
        const reserved = raid && [...raid.reserved.values()].some(r => r.squad === party.raid.squadId && r.until > now);
        const topside = [...party.members.keys()].some(id => this.ctx.profiles.get(id)?.inRaid);
        if (!reserved && !topside) { party.raid = null; changed = true; }
      }
      if (changed && this.parties.has(party.code)) this.push(party);
    }
  }

  // ------------------------------------------------------------ deploy
  deploy(pid, { force = false, fill = false } = {}) {
    const { sessions, profiles } = this.ctx;
    const party = this.partyOf(pid);
    if (this.inFill(pid)) throw new Error('Already searching for squadmates');
    if (!party) {
      if (fill) return this.enqueueFill([pid], null);
      return this.ctx.deployGroup([pid], null, []);
    }
    if (party.leader !== pid) throw new Error('Only the squad leader can deploy — ready up instead');
    const going = [], missing = [];
    for (const [id, m] of party.members) {
      const s = sessions.get(id);
      const ok = id === pid || (m.ready && s && !profiles.get(id)?.inRaid && !s.spectating);
      (ok ? going : missing).push(id);
    }
    if (missing.length && !force) {
      this.ctx.send(pid, { t: 'deploy_confirm', missing: missing.map(id => this.ctx.names(id)) });
      return null;
    }
    if (fill && going.length < C.MAX_SQUAD && !missing.length) return this.enqueueFill(going, party);
    return this.ctx.deployGroup(going, party, missing);
  }

  afterDeploy(party, raid, squadId) {
    if (!party) return;
    party.raid = { raidId: raid.id, squadId };
    for (const m of party.members.values()) m.ready = false;
    this.push(party);
  }

  joinSquad(pid) {
    const party = this.partyOf(pid);
    if (!party?.raid) throw new Error('Your squad is not topside');
    if (this.ctx.profiles.get(pid)?.inRaid) throw new Error('You are already topside');
    const raid = this.ctx.raids.get(party.raid.raidId);
    const res = raid?.reserved.get(pid);
    if (!raid || raid.closed || !res || res.until < Date.now()) throw new Error('Your reserved slot has expired');
    this.ctx.joinRaid(pid, raid, res.squad);
    this.push(party);
  }

  // ------------------------------------------------------------ fill squad
  inFill(pid) { return this.fillQueue.some(e => e.pids.includes(pid)); }

  enqueueFill(pids, party) {
    const entry = { pids: [...pids], party, since: Date.now() };
    this.fillQueue.push(entry);
    for (const id of pids) this.ctx.send(id, { t: 'fill', searching: true, since: entry.since });
    this.matchFill();
    return null;
  }

  cancelFill(pid) {
    const i = this.fillQueue.findIndex(e => e.pids.includes(pid));
    if (i < 0) return false;
    const [e] = this.fillQueue.splice(i, 1);
    for (const id of e.pids) this.ctx.send(id, { t: 'fill', searching: false });
    return true;
  }
  cancelFillParty(party) {
    const e = this.fillQueue.find(x => x.party === party);
    if (e) this.cancelFill(e.pids[0]);
  }

  matchFill() {
    const q = this.fillQueue;
    if (!q.length) return;
    q.sort((a, b) => a.since - b.since);
    const now = Date.now();
    const used = new Set();
    const launches = [];
    for (let i = 0; i < q.length; i++) {
      if (used.has(i)) continue;
      const group = [i];
      let size = q[i].pids.length;
      for (let j = i + 1; j < q.length && size < C.MAX_SQUAD; j++) {
        if (used.has(j) || size + q[j].pids.length > C.MAX_SQUAD) continue;
        group.push(j); size += q[j].pids.length;
      }
      if (size >= C.MAX_SQUAD || now - q[i].since >= FILL_MAX_WAIT) {
        for (const k of group) used.add(k);
        launches.push(group.map(k => q[k]));
      }
    }
    // remove from the queue before launching (launching mutates parties, which may cancel fills)
    this.fillQueue = q.filter((_, k) => !used.has(k));
    for (const entries of launches) this.launchFill(entries);
  }

  launchFill(entries) {
    const all = entries.flatMap(e => e.pids).filter(id => this.ctx.sessions.has(id) && !this.ctx.profiles.get(id)?.inRaid);
    for (const id of entries.flatMap(e => e.pids)) this.ctx.send(id, { t: 'fill', searching: false });
    if (!all.length) return;
    // merge everyone into the first party (or a fresh one) so the squad sticks together afterwards
    let party = entries.find(e => e.party && this.parties.has(e.party.code))?.party;
    if (!party) party = this.create(all[0]);
    for (const id of all) if (!party.members.has(id)) {
      this.leave(id, true);
      if (party.members.size < C.MAX_SQUAD) this.addMember(party, id);
    }
    if (entries.length > 1) this.notice(party, `Fill squad formed: ${[...party.members.keys()].map(id => this.ctx.names(id)).join(', ')}`);
    try { this.ctx.deployGroup([...party.members.keys()].filter(id => all.includes(id)), party, []); }
    catch (e) { for (const id of all) this.ctx.send(id, { t: 'err', msg: e.message }); }
  }

  // ------------------------------------------------------------ views
  view(party, forPid) {
    if (!party) return null;
    const raid = party.raid ? this.ctx.raids.get(party.raid.raidId) : null;
    const res = raid?.reserved.get(forPid);
    return {
      code: party.code,
      leader: party.leader,
      friendsJoin: party.friendsJoin,
      joinUntil: res && res.until > Date.now() && !raid.closed ? res.until : null,
      members: [...party.members.entries()].map(([id, m]) => ({
        id, name: this.ctx.names(id), level: this.ctx.profiles.get(id)?.level ?? null,
        ready: m.ready, last: m.last, status: this.ctx.statusOf(id, m),
      })),
    };
  }

  push(party) {
    if (!party) return;
    for (const id of party.members.keys()) this.ctx.send(id, { t: 'party', party: this.view(party, id) });
  }
  pushFor(pid) { const p = this.partyOf(pid); if (p) this.push(p); }

  notice(party, text, except) {
    for (const id of party.members.keys()) if (id !== except) this.ctx.send(id, { t: 'notice', text });
  }
}
