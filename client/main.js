import { Net } from './net.js';
import { Hideout } from './hideout.js';
import { Game } from './game.js';
import { Sfx } from './audio.js';
import { $, toast } from './ui.js';

const TOKEN_KEY = 'dmcheap_token';
const net = new Net();
const sfx = new Sfx();
const hideout = new Hideout(net);
let game = null;
let inRaid = false;

function show(id) {
  for (const s of ['login', 'hideout', 'raid']) $('#' + s).classList.toggle('hidden', s !== id);
}

function getGame() {
  if (!game) game = new Game(net, sfx, () => { inRaid = false; show('hideout'); hideout.render(); });
  return game;
}

// debug handle for automated tests / console tinkering
window.dmcheap = { get game() { return game; }, net, hideout };

const hello = () => ({ t: 'hello', token: localStorage.getItem(TOKEN_KEY) || undefined, name: $('#login-name').value || undefined });

net.on('welcome', (m) => { localStorage.setItem(TOKEN_KEY, m.token); });
net.on('profile', (m) => {
  hideout.party = m.party ?? hideout.party;
  hideout.setProfile(m.profile, m.notes);
  if (!inRaid) show('hideout');
});
net.on('party', (m) => hideout.setParty(m.party));
net.on('err', (m) => { if (inRaid) game?.feed(m.msg, 'warn'); else toast(m.msg, true); });
net.on('raid_start', (m) => {
  inRaid = true;
  show('raid');
  getGame().start(m);
});
net.on('_any', (m) => { if (game) game.handle(m); });
net.on('_close', () => { if (!inRaid) $('#login-status').textContent = 'Connection lost — reconnecting…'; });
net.on('_open', () => { $('#login-status').textContent = ''; });

// route raid messages that have explicit handlers above through the game too
for (const t of ['s', 'inv', 'pos', 'fx', 'hit', 'dmg', 'msg', 'feed', 'chat', 'loot', 'cont_add', 'cont_rm', 'cont_open', 'door', 'extract', 'hatch', 'action', 'downed', 'revived', 'ping', 'raid_end']) {
  net.on(t, (m) => { if (game) game.handle(m); });
}

if (localStorage.getItem(TOKEN_KEY)) {
  $('#login-status').textContent = 'Connecting…';
  net.connect(hello);
} else {
  show('login');
}
$('#login-go').addEventListener('click', () => {
  sfx.unlock();
  $('#login-status').textContent = 'Connecting…';
  net.connect(hello);
});
$('#login-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#login-go').click(); });
document.addEventListener('click', () => sfx.unlock(), { once: true });
