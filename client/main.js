import { Net } from './net.js';
import { Hideout } from './hideout.js';
import { Game } from './game.js';
import { HubView } from './hubworld.js';
import { SocialUI } from './social.js';
import { Sfx } from './audio.js';
import { $, toast, hideMenu } from './ui.js';

const TOKEN_KEY = 'dmcheap_token';
const MODE_KEY = 'dmcheap_menu_mode';
const net = new Net();
const sfx = new Sfx();
const hideout = new Hideout(net);
let game = null;
let hub = null;
let inRaid = false;
let menuMode = localStorage.getItem(MODE_KEY) === '1';
let pendingJoin = new URLSearchParams(location.search).get('join');
let gotProfile = false;

const social = new SocialUI(net, () => hideout.profile, (light) => renderSocial(light));
hideout.social = social;

function show(id) {
  for (const s of ['login', 'hub', 'hideout', 'raid']) $('#' + s).classList.toggle('hidden', s !== id);
  $('#hideout').classList.remove('overlay-mode');
  $('#h-close').classList.add('hidden');
}

// ---------------------------------------------------------------- hub <-> menus
function getHub() {
  if (!hub) {
    hub = new HubView(net, sfx, {
      openTerminal: (tab) => openTerminal(tab),
      overlayOpen: () => !$('#hideout').classList.contains('hidden'),
      liftAction: () => { const p = social.primary(); return { label: p.label, run: () => social.doPrimary() }; },
      isSquad: (pid) => !!social.party?.members.some(m => m.id === pid && m.id !== hideout.profile?.id),
      toggleFriends: () => toggleFriends(),
    });
  }
  return hub;
}

function goHome() {
  if (inRaid) return;
  if (menuMode) {
    hub?.stop();
    net.send({ t: 'hub_leave' });
    show('hideout');
    hideout.render();
  } else {
    show('hub');
    getHub().enter();
    renderSocial();
  }
}

function openTerminal(tab) {
  document.exitPointerLock?.();
  const h = $('#hideout');
  h.classList.remove('hidden');
  h.classList.add('overlay-mode');
  $('#h-close').classList.remove('hidden');
  if (tab) hideout.selectTab(tab); else hideout.render();
}
function closeTerminal() {
  if (menuMode || inRaid) return;
  hideMenu();
  $('#hideout').classList.add('hidden');
  $('#hideout').classList.remove('overlay-mode');
  $('#h-close').classList.add('hidden');
  hub?.lock();
}
$('#h-close').addEventListener('click', closeTerminal);
document.addEventListener('keydown', (e) => {
  if (!$('#hideout').classList.contains('overlay-mode') || $('#hideout').classList.contains('hidden')) return;
  if (e.key === 'Escape' || (e.key === 'Tab' && e.target?.tagName !== 'INPUT')) {
    e.preventDefault();
    e.stopImmediatePropagation(); // don't let the hub's Tab handler reopen it
    closeTerminal();
  }
});

function setMenuMode(on) {
  menuMode = on;
  localStorage.setItem(MODE_KEY, on ? '1' : '0');
  $('#h-mode').textContent = on ? 'Walk the hub' : 'Menu mode';
  goHome();
}
$('#h-mode').addEventListener('click', () => setMenuMode(!menuMode));
$('#h-mode').textContent = menuMode ? 'Walk the hub' : 'Menu mode';

function toggleFriends() {
  const el = $('#hub-friends');
  el.classList.toggle('hidden');
  if (!el.classList.contains('hidden')) social.requestFriends();
}
$('#hubhud').addEventListener('click', (e) => {
  const b = e.target.closest('[data-hub]');
  if (!b) return;
  if (b.dataset.hub === 'terminal') openTerminal();
  if (b.dataset.hub === 'friends') toggleFriends();
  if (b.dataset.hub === 'menu-mode') setMenuMode(true);
});

// Squad/friends panels live in the hub HUD and the hideout's Squad tab.
function renderSocial(light = false) {
  const pr = social.primary();
  const hb = $('#hub-primary');
  hb.textContent = pr.label;
  hb.className = 'btn deploy ' + pr.cls;
  hideout.renderTopbar();
  if (light) return;
  const keep = (sel) => { const el = $(sel); return el ? [el.value, document.activeElement === el] : null; };
  const restore = (sel, v) => { const el = $(sel); if (el && v) { el.value = v[0]; if (v[1]) el.focus(); } };
  const tagV = keep('#hub-friends #friend-tag'), codeV = keep('#hub-party #party-code');
  $('#hub-party').innerHTML = social.partyHTML({ compact: true });
  if (!$('#hub-friends').classList.contains('hidden')) $('#hub-friends').innerHTML = social.friendsHTML();
  restore('#hub-friends #friend-tag', tagV); restore('#hub-party #party-code', codeV);
  if (hideout.tab === 'squad' && !$('#hideout').classList.contains('hidden')) hideout.render();
  hub?.refreshSquadColors();
}

function renderProfileBits(p) {
  $('#hub-name').textContent = `${p.name}#${p.tag ?? ''}`;
  $('#hub-level').textContent = `LVL ${p.level}${p.skillPoints ? ` · ${p.skillPoints} skill pt` : ''}`;
  $('#hub-cash').textContent = '$' + Math.round(p.cash).toLocaleString();
}

// ---------------------------------------------------------------- raid
function getGame() {
  if (!game) game = new Game(net, sfx, () => { inRaid = false; goHome(); });
  return game;
}

// debug handle for automated tests / console tinkering
window.dmcheap = { get game() { return game; }, get hub() { return hub; }, net, hideout, social };

// ---------------------------------------------------------------- network
const hello = () => ({ t: 'hello', token: localStorage.getItem(TOKEN_KEY) || undefined, name: $('#login-name').value || undefined });

net.on('welcome', (m) => { localStorage.setItem(TOKEN_KEY, m.token); });
net.on('profile', (m) => {
  hideout.setProfile(m.profile, m.notes);
  renderProfileBits(m.profile);
  if (!gotProfile) {
    gotProfile = true;
    if (!inRaid) goHome();
    if (pendingJoin) {
      net.send({ t: 'party_join', code: pendingJoin });
      pendingJoin = null;
      history.replaceState(null, '', location.pathname);
    }
  }
  renderSocial(true);
});
net.on('party', (m) => social.setParty(m.party));
net.on('friends', (m) => social.setFriends(m));
net.on('friends_dirty', () => {
  const visible = !$('#hub-friends').classList.contains('hidden') || (hideout.tab === 'squad' && !$('#hideout').classList.contains('hidden'));
  if (visible) social.requestFriends();
});
net.on('fill', (m) => social.setFill(m));
net.on('deploy_confirm', (m) => social.onDeployConfirm(m));
net.on('party_invite', (m) => { social.onInvite(m); sfx.ui(); });
net.on('notice', (m) => { if (inRaid && game) game.feed(m.text, 'warn'); else toast(m.text); if (m.kind === 'nudge') sfx.horn(); });
net.on('err', (m) => { if (inRaid) game?.feed(m.msg, 'warn'); else toast(m.msg, true); });
net.on('raid_start', (m) => {
  inRaid = true;
  hub?.stop();
  hideMenu();
  show('raid');
  getGame().start(m);
});
for (const t of ['hub_start', 'hub_s', 'hub_add', 'hub_rm', 'hub_pos', 'hub_chat']) {
  net.on(t, (m) => { if (!inRaid && !menuMode) getHub().handle(m); });
}
for (const t of ['s', 'inv', 'pos', 'fx', 'hit', 'dmg', 'msg', 'feed', 'chat', 'loot', 'cont_add', 'cont_rm', 'cont_open', 'door', 'extract', 'hatch', 'action', 'downed', 'revived', 'ping', 'raid_end', 'names', 'squad', 'spec', 'spec_end']) {
  net.on(t, (m) => { if (game) game.handle(m); });
}
net.on('_close', () => {
  gotProfile = false;
  if (!inRaid) $('#login-status').textContent = 'Connection lost — reconnecting…';
});
net.on('_open', () => { $('#login-status').textContent = ''; });

if (localStorage.getItem(TOKEN_KEY)) {
  $('#login-status').textContent = 'Connecting…';
  net.connect(hello);
} else {
  show('login');
  if (pendingJoin) $('#login-status').textContent = `You've been invited to squad ${pendingJoin}. Pick a name to join.`;
}
$('#login-go').addEventListener('click', () => {
  sfx.unlock();
  $('#login-status').textContent = 'Connecting…';
  net.connect(hello);
});
$('#login-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#login-go').click(); });
document.addEventListener('click', () => sfx.unlock(), { once: true });
