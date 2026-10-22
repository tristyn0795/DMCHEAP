// Squad + friends UI and the single "primary action" button logic (Deploy / Ready / Join squad / Searching).
// Rendered into both the hideout menus and the walkable hub HUD.
import { C, sellPrice } from '/shared/data.js';
import { $, esc, money, toast } from './ui.js';

const STATUS_LABEL = { hub: 'In hub', menu: 'In hideout', spectating: 'Spectating', offline: 'Offline' };
const HOW_LABEL = { squad: 'Squadmate', fought: 'Fought', 'killed you': 'Killed you', 'you killed': 'You killed' };

export function fmtLeft(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export class SocialUI {
  constructor(net, getProfile, onChange) {
    this.net = net;
    this.getProfile = getProfile;
    this.onChange = onChange;
    this.party = null;
    this.friends = null;
    this.fill = { searching: false, since: 0 };
    this.fillPref = localStorage.getItem('dmcheap_fill') === '1';
    document.addEventListener('click', (ev) => this.onClick(ev));
    document.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' && ev.target?.id === 'friend-tag') this.addFriend();
      if (ev.key === 'Enter' && ev.target?.id === 'party-code') this.joinCode();
    });
    setInterval(() => this.tickLabels(), 1000);
  }

  get myId() { return this.getProfile()?.id; }
  isLeader() { return !this.party || this.party.leader === this.myId; }
  me() { return this.party?.members.find(m => m.id === this.myId); }

  setParty(p) { this.party = p; this.onChange(); }
  setFriends(f) { this.friends = f; this.onChange(); }
  setFill(m) { this.fill = { searching: !!m.searching, since: m.since ?? Date.now() }; this.onChange(); }
  requestFriends() { this.net.send({ t: 'friends_list' }); }

  // ---------------------------------------------------------------- primary action
  primary() {
    const p = this.party;
    if (this.fill.searching) return { label: `SEARCHING FOR SQUAD ${fmtLeft(Date.now() - this.fill.since)} · CANCEL`, action: 'fill_cancel', cls: 'searching' };
    if (p?.joinUntil && p.joinUntil > Date.now()) return { label: `JOIN SQUAD TOPSIDE ${fmtLeft(p.joinUntil - Date.now())}`, action: 'join_squad', cls: 'join' };
    if (!p) return { label: this.fillPref ? 'DEPLOY (FILL SQUAD)' : 'DEPLOY TOPSIDE', action: 'deploy', cls: '' };
    if (this.isLeader()) {
      const others = p.members.filter(m => m.id !== this.myId);
      const ready = others.filter(m => m.ready).length;
      return { label: others.length ? `DEPLOY SQUAD (${ready + 1}/${p.members.length} READY)` : (this.fillPref ? 'DEPLOY (FILL SQUAD)' : 'DEPLOY TOPSIDE'), action: 'deploy', cls: ready === others.length ? '' : 'partial' };
    }
    const mine = this.me();
    if (mine?.status.s === 'raid') return { label: 'TOPSIDE…', action: null, cls: 'disabled' };
    return mine?.ready ? { label: 'READY ✓ (CLICK TO UNREADY)', action: 'unready', cls: 'ready' } : { label: 'READY UP', action: 'ready', cls: 'notready' };
  }

  doPrimary() {
    const a = this.primary().action;
    if (!a) return;
    if (a === 'deploy') {
      const prof = this.getProfile();
      if (!prof) return;
      if (!prof.loadout.primary && !prof.loadout.secondary && !confirm('You have no weapon equipped. Deploy anyway?')) return;
      const L = prof.loadout;
      const risk = [L.primary, L.secondary, L.shield, L.rig, ...L.pack].filter(Boolean).reduce((s, x) => s + sellPrice(x.id) * x.qty, 0);
      if (risk > 8000 && !confirm(`You're taking ${money(risk)} of gear topside. Everything outside your safe pocket is lost if you die. Deploy?`)) return;
      const smallSquad = !this.party || this.party.members.length < C.MAX_SQUAD;
      this.net.send({ t: 'deploy', fill: this.fillPref && smallSquad });
    } else if (a === 'join_squad') this.net.send({ t: 'join_squad' });
    else if (a === 'fill_cancel') this.net.send({ t: 'fill_cancel' });
    else if (a === 'ready') this.net.send({ t: 'party_ready', ready: true });
    else if (a === 'unready') this.net.send({ t: 'party_ready', ready: false });
  }

  onDeployConfirm(m) {
    if (confirm(`${m.missing.join(', ')} ${m.missing.length > 1 ? "aren't" : "isn't"} ready.\nDeploy without them? Their slot is held for 5 minutes so they can JOIN SQUAD.`)) {
      this.net.send({ t: 'deploy', force: true });
    } else this.net.send({ t: 'party_nudge' });
  }

  onInvite(m) {
    const box = document.getElementById('toasts');
    const d = document.createElement('div');
    d.className = 'toast';
    d.innerHTML = `<b>${esc(m.from)}</b> invited you to their squad. <button class="btn small primary" data-soc="accept-invite" data-arg="${esc(m.code)}">Join</button> <button class="btn small" data-soc="dismiss">Ignore</button>`;
    box.appendChild(d);
    setTimeout(() => d.remove(), 30000);
  }

  // ---------------------------------------------------------------- squad panel
  memberStatus(m) {
    const st = m.status;
    if (m.last && Date.now() - m.last.at < 90000 && st.s !== 'raid') {
      return m.last.extracted ? '<span class="pill good">EXTRACTED</span>' : '<span class="pill bad">KIA</span>';
    }
    if (st.s === 'raid') return `<span class="pill raid" data-until="${st.until ?? 0}">TOPSIDE ${st.until ? fmtLeft(st.until - Date.now()) : ''}</span>${st.down ? ' <span class="pill bad">DOWNED</span>' : ''}`;
    if (st.s === 'offline') return `<span class="pill off" data-until="${st.until ?? 0}">RECONNECTING ${st.until ? fmtLeft(st.until - Date.now()) : ''}</span>`;
    return m.ready ? '<span class="pill good">READY</span>' : `<span class="pill">${STATUS_LABEL[st.s] ?? st.s}</span>`;
  }

  partyHTML({ compact = false } = {}) {
    const p = this.party;
    const fill = `<label class="chk"><input type="checkbox" data-soc="fill" ${this.fillPref ? 'checked' : ''}> Fill empty slots with other raiders</label>`;
    if (!p) {
      return `<div class="soc-party"><div class="soc-h">SQUAD <span class="cost">solo</span></div>
        <div class="row"><button class="btn small primary" data-soc="create">Create squad</button>
        <input id="party-code" maxlength="5" placeholder="CODE" class="codein"><button class="btn small" data-soc="join-code">Join</button></div>
        ${fill}</div>`;
    }
    const lead = this.isLeader();
    const rows = p.members.map(m => `<div class="soc-m ${m.id === this.myId ? 'me' : ''}">
        <div class="grow"><b>${esc(m.name)}</b>${m.id === p.leader ? ' <span title="Squad leader">★</span>' : ''} <span class="cost">${m.level ? 'Lv ' + m.level : ''}</span></div>
        ${this.memberStatus(m)}
        ${lead && m.id !== this.myId && !compact ? `<button class="btn tiny" data-soc="promote" data-arg="${m.id}" title="Make leader">★</button><button class="btn tiny" data-soc="kick" data-arg="${m.id}" title="Remove">✕</button>` : ''}
      </div>`).join('');
    return `<div class="soc-party"><div class="soc-h">SQUAD <b class="code">${esc(p.code)}</b>
        <button class="btn tiny" data-soc="copy-link" title="Copy invite link">🔗 Invite link</button></div>
      ${rows}
      ${p.members.length < C.MAX_SQUAD ? `<div class="cost">${C.MAX_SQUAD - p.members.length} open slot(s) — share the link or invite a friend</div>` : ''}
      ${lead ? `<label class="chk"><input type="checkbox" data-soc="friends-join" ${p.friendsJoin ? 'checked' : ''}> Friends can join without a code</label>${p.members.length < C.MAX_SQUAD ? fill : ''}` : ''}
      <div class="row">${lead && p.members.length > 1 ? '<button class="btn small" data-soc="nudge">Ready check</button>' : ''}<button class="btn small" data-soc="leave">Leave squad</button></div></div>`;
  }

  // ---------------------------------------------------------------- friends panel
  friendStatus(f) {
    const st = f.status;
    if (st.s === 'raid') return `<span class="pill raid" data-until="${st.until ?? 0}">TOPSIDE ${st.until ? fmtLeft(st.until - Date.now()) : ''}</span>`;
    if (st.s === 'offline') return `<span class="pill off">${f.seen ? 'seen ' + ago(f.seen) : 'offline'}</span>`;
    return `<span class="pill online">${STATUS_LABEL[st.s] ?? 'Online'}</span>`;
  }

  friendsHTML() {
    const F = this.friends;
    const prof = this.getProfile();
    const myTag = prof ? `${prof.name}#${prof.tag ?? F?.me?.tag ?? '????'}` : '';
    if (!F) return `<div class="soc-friends"><div class="soc-h">FRIENDS</div><p class="cost">Loading…</p></div>`;
    const inSquad = (id) => this.party?.members.some(m => m.id === id);
    const friendRows = F.friends.map(f => `<div class="soc-m"><div class="grow"><b>${esc(f.name)}</b><span class="cost">#${esc(f.tag)} · Lv ${f.level}</span></div>
        ${this.friendStatus(f)}
        ${f.status.s !== 'offline' && !inSquad(f.id) ? `<button class="btn tiny" data-soc="invite" data-arg="${f.id}">Invite</button>` : ''}
        ${f.status.s !== 'offline' && f.status.s !== 'raid' && !inSquad(f.id) && (!f.party || f.party.open) ? `<button class="btn tiny" data-soc="join-friend" data-arg="${f.id}">Join</button>` : ''}
        <button class="btn tiny ghost" data-soc="unfriend" data-arg="${f.id}" title="Remove friend">✕</button></div>`).join('');
    const reqRows = F.incoming.map(r => `<div class="soc-m"><div class="grow"><b>${esc(r.name)}</b><span class="cost">#${esc(r.tag)} wants to be friends</span></div>
        <button class="btn tiny primary" data-soc="accept" data-arg="${r.id}">Accept</button><button class="btn tiny" data-soc="decline" data-arg="${r.id}">Decline</button></div>`).join('');
    const outRows = F.outgoing.map(r => `<div class="soc-m"><div class="grow">${esc(r.name)}<span class="cost">#${esc(r.tag)} · request sent</span></div><button class="btn tiny ghost" data-soc="decline" data-arg="${r.id}">Cancel</button></div>`).join('');
    const recent = F.recent.map(r => `<div class="soc-m"><div class="grow">${esc(r.name)}<span class="cost">#${esc(r.tag)} · ${HOW_LABEL[r.how] ?? r.how} · ${ago(r.at)}</span></div>
        ${r.friend ? '<span class="pill online">friend</span>' : `<button class="btn tiny" data-soc="add-id" data-arg="${r.id}">Add</button>`}
        ${!inSquad(r.id) ? `<button class="btn tiny" data-soc="invite" data-arg="${r.id}">Invite</button>` : ''}</div>`).join('');
    return `<div class="soc-friends"><div class="soc-h">FRIENDS <span class="cost">you are <b class="code">${esc(myTag)}</b></span></div>
      <div class="row"><input id="friend-tag" placeholder="Name#1A2B" class="tagin"><button class="btn small" data-soc="add">Add friend</button></div>
      ${reqRows ? `<div class="soc-sub">Requests</div>${reqRows}` : ''}
      <div class="soc-sub">Friends (${F.friends.length})</div>${friendRows || '<p class="cost">No friends yet. Share your Name#TAG.</p>'}
      ${outRows ? `<div class="soc-sub">Pending</div>${outRows}` : ''}
      <div class="soc-sub">Recent raiders</div>${recent || '<p class="cost">Raid with or against someone and they show up here.</p>'}</div>`;
  }

  // keep countdown pills ticking without a re-render
  tickLabels() {
    for (const el of document.querySelectorAll('[data-until]')) {
      const u = +el.dataset.until;
      if (!u) continue;
      el.textContent = el.textContent.replace(/\d+:\d\d$/, fmtLeft(u - Date.now()));
    }
    if (this.fill.searching || this.party?.joinUntil) this.onChange(true);
  }

  // ---------------------------------------------------------------- clicks
  addFriend() {
    const v = $('#friend-tag')?.value.trim();
    if (v) this.net.send({ t: 'friend_add', tag: v });
  }
  joinCode() {
    const v = $('#party-code')?.value.trim();
    if (v) this.net.send({ t: 'party_join', code: v });
  }

  onClick(ev) {
    const el = ev.target.closest('[data-soc]');
    if (!el) return;
    const a = el.dataset.soc, arg = el.dataset.arg;
    const send = (m) => this.net.send(m);
    switch (a) {
      case 'create': return send({ t: 'party_create' });
      case 'join-code': return this.joinCode();
      case 'leave': return send({ t: 'party_leave' });
      case 'kick': return send({ t: 'party_kick', id: arg });
      case 'promote': return send({ t: 'party_promote', id: arg });
      case 'nudge': send({ t: 'party_nudge' }); return toast('Ready check sent');
      case 'friends-join': return send({ t: 'party_settings', friendsJoin: el.checked });
      case 'fill':
        this.fillPref = el.checked;
        localStorage.setItem('dmcheap_fill', this.fillPref ? '1' : '0');
        return this.onChange();
      case 'copy-link': {
        const link = `${location.origin}/?join=${this.party?.code}`;
        navigator.clipboard?.writeText(link).then(() => toast('Invite link copied — send it to a friend'), () => prompt('Copy this invite link:', link));
        return;
      }
      case 'add': return this.addFriend();
      case 'add-id': return send({ t: 'friend_add', id: arg });
      case 'accept': return send({ t: 'friend_accept', id: arg });
      case 'decline': return send({ t: 'friend_decline', id: arg });
      case 'unfriend': if (confirm('Remove this friend?')) send({ t: 'friend_remove', id: arg }); return;
      case 'invite': return send({ t: 'party_invite', id: arg });
      case 'join-friend': return send({ t: 'join_friend', id: arg });
      case 'accept-invite': el.closest('.toast')?.remove(); return send({ t: 'party_join', code: arg });
      case 'dismiss': el.closest('.toast')?.remove(); return;
      case 'primary': return this.doPrimary();
    }
  }
}

function ago(ts) {
  if (!ts) return '';
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 90) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}
