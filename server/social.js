// Friends (Name#TAG), requests, presence, Recent Raiders, party invites, join-a-friend.
import { tagOf } from './storage.js';

export class Social {
  constructor(ctx) {
    this.ctx = ctx;               // { storage, sessions, profiles, parties, send, statusOf, names }
    this.onlineFriends = new Map(); // pid -> Set(friend ids) for online players (hub placement, presence pushes)
  }

  async onConnect(pid) {
    const ids = await this.ctx.storage.friendsOf(pid);
    this.onlineFriends.set(pid, new Set(ids));
    this.notifyFriends(pid);
  }
  onDisconnect(pid) {
    this.notifyFriends(pid);
    this.onlineFriends.delete(pid);
  }
  friendsOnline(pid) {
    const set = this.onlineFriends.get(pid);
    if (!set) return new Set();
    return new Set([...set].filter(id => this.ctx.sessions.has(id)));
  }
  // presence changed (login/logout/raid) -> friends with the list open get a refresh hint
  notifyFriends(pid) {
    for (const f of this.friendsOnline(pid)) this.ctx.send(f, { t: 'friends_dirty' });
  }

  async list(pid) {
    const st = this.ctx.storage;
    const [friends, incoming, outgoing, recent] = await Promise.all([st.friendsOf(pid), st.requestsTo(pid), st.requestsFrom(pid), st.recentOf(pid)]);
    const ids = [...new Set([...friends, ...incoming, ...outgoing, ...recent.map(r => r.id)])];
    const cards = await st.cards(ids);
    const card = (id) => {
      const live = this.ctx.profiles.get(id);
      const c = cards[id] ?? {};
      return { id, name: live?.name ?? c.name ?? '?', tag: tagOf(id), level: live?.level ?? c.level ?? 1, seen: live?.lastSeen ?? c.seen ?? 0 };
    };
    const fset = new Set(friends);
    const myParty = this.ctx.parties.partyOf(pid);
    return {
      me: { tag: tagOf(pid) },
      friends: friends.map(id => {
        const fp = this.ctx.parties.partyOf(id);
        return {
          ...card(id), status: this.ctx.statusOf(id),
          party: fp ? { size: fp.members.size, open: fp.friendsJoin, mine: fp === myParty } : null,
        };
      }).sort((a, b) => (b.status.s !== 'offline') - (a.status.s !== 'offline') || a.name.localeCompare(b.name)),
      incoming: incoming.map(card),
      outgoing: outgoing.map(card),
      recent: recent.map(r => ({ ...card(r.id), how: r.how, at: r.at, friend: fset.has(r.id) })),
    };
  }

  async sendList(pid) { this.ctx.send(pid, { t: 'friends', ...(await this.list(pid)) }); }

  async add(pid, query) {
    const st = this.ctx.storage;
    let target = null;
    if (query.id) target = String(query.id);
    else {
      const m = String(query.tag ?? '').trim().match(/^(.+)#([0-9a-fA-F]{4})$/);
      if (!m) throw new Error('Use the format Name#1A2B');
      target = await st.findByNameTag(m[1].trim(), m[2]);
      if (!target) throw new Error('No raider with that name and tag');
    }
    if (target === pid) throw new Error("That's you");
    if (await st.areFriends(pid, target)) throw new Error('Already friends');
    if (!(await st.cards([target]))[target] && !this.ctx.profiles.get(target)) throw new Error('No such raider');
    if (await st.hasRequest(target, pid)) return this.accept(pid, target);
    await st.addRequest(pid, target);
    this.ctx.send(target, { t: 'notice', text: `${this.ctx.names(pid)} sent you a friend request`, kind: 'friend' });
    this.ctx.send(target, { t: 'friends_dirty' });
    this.ctx.send(pid, { t: 'notice', text: 'Friend request sent' });
    await this.sendList(pid);
  }

  async accept(pid, from) {
    const st = this.ctx.storage;
    if (!(await st.hasRequest(from, pid))) throw new Error('No such request');
    await st.addFriends(pid, from);
    this.onlineFriends.get(pid)?.add(from);
    this.onlineFriends.get(from)?.add(pid);
    this.ctx.send(from, { t: 'notice', text: `${this.ctx.names(pid)} accepted your friend request`, kind: 'friend' });
    this.ctx.send(from, { t: 'friends_dirty' });
    await this.sendList(pid);
  }

  async decline(pid, from) {
    await this.ctx.storage.removeRequest(from, pid);
    await this.ctx.storage.removeRequest(pid, from); // also cancels my outgoing request
    await this.sendList(pid);
  }

  async remove(pid, other) {
    await this.ctx.storage.removeFriends(pid, other);
    this.onlineFriends.get(pid)?.delete(other);
    this.onlineFriends.get(other)?.delete(pid);
    this.ctx.send(other, { t: 'friends_dirty' });
    await this.sendList(pid);
  }

  // Invite a friend / recent raider to my squad (creates a squad if I'm solo).
  invite(pid, target) {
    if (!this.ctx.sessions.has(target)) throw new Error("They're offline");
    let party = this.ctx.parties.partyOf(pid);
    if (!party) party = this.ctx.parties.create(pid);
    if (party.members.has(target)) throw new Error('Already in your squad');
    if (party.members.size >= 3) throw new Error('Your squad is full');
    this.ctx.send(target, { t: 'party_invite', from: this.ctx.names(pid), fromId: pid, code: party.code });
    this.ctx.send(pid, { t: 'notice', text: `Invite sent to ${this.ctx.names(target)}` });
  }

  // Join a friend's squad without a code (if their squad allows friends), or form one with them.
  async joinFriend(pid, friend) {
    if (!(await this.ctx.storage.areFriends(pid, friend))) throw new Error('Not your friend');
    if (!this.ctx.sessions.has(friend)) throw new Error("They're offline");
    const parties = this.ctx.parties;
    let party = parties.partyOf(friend);
    if (!party) {
      party = parties.create(friend);
      this.ctx.send(friend, { t: 'notice', text: `${this.ctx.names(pid)} joined you — squad formed` });
    }
    parties.join(pid, party.code, { viaFriend: true });
  }

  async recordRecent(pid, met) {
    if (!met?.length) return;
    try { await this.ctx.storage.addRecent(pid, met); } catch (e) { console.error('[social] recent failed', e); }
  }
}
