// "The Cheap Seats" — the underground hideout between raids.
import {
  C, ITEMS, WEAPONS, RECIPES, BENCH_UPGRADES, TRADER_STOCK, SKILLS, POIS,
  buyPrice, sellPrice, xpToNext, countItem,
} from '/shared/data.js';
import { $, esc, money, itemHTML, showMenu, toast } from './ui.js';
import { ATTACHMENTS, ATT_SLOTS, ATT_SLOT_NAMES, AMMO_TYPES, AMMO_ORDER } from '/shared/data.js';
import { weaponStats, canAttach, slotOpen, upgradeCost, repairCost, gunName, MAX_TIER, TIER_NAMES } from '/shared/gunsmith.js';
import { gunIcon } from './guns.js';

const MOD_LABELS = { dmg: 'Damage', range: 'Range', noise: 'Noise', ads: 'Aim time', reload: 'Reload time', recoilV: 'Vertical recoil', recoilH: 'Horizontal recoil', recover: 'Recoil recovery', hip: 'Hip spread', adsSpread: 'Aimed spread', moveSpread: 'Moving spread', move: 'Move speed', mag: 'Mag size' };
const GOOD_UP = new Set(['dmg', 'range', 'recover', 'move', 'mag']);
export function describeMods(id) {
  const A = ATTACHMENTS[id];
  const parts = Object.entries(A.mods).map(([k, v]) => {
    const pct = Math.round((v - 1) * 100);
    const good = GOOD_UP.has(k) ? pct > 0 : pct < 0;
    return `<span class="${good ? 'ok' : 'no'}">${MOD_LABELS[k] ?? k} ${pct > 0 ? '+' : ''}${pct}%</span>`;
  });
  if (A.zoom) parts.unshift(`<span class="ok">${A.zoom}x zoom</span>`);
  if (A.suppress) parts.unshift('<span class="ok">Suppressed: hides you from distant ears &amp; the map</span>');
  return parts.join(' · ');
}

export class Hideout {
  constructor(net) {
    this.net = net;
    this.profile = null;
    this.tab = 'loadout';
    this.gsUid = null;
    this.leaderboard = [];
    $('#tabs').addEventListener('click', (ev) => {
      const b = ev.target.closest('button[data-tab]');
      if (!b) return;
      this.selectTab(b.dataset.tab);
    });
    $('#tab-body').addEventListener('click', (ev) => this.onClick(ev));
    setInterval(() => { if (this.tab === 'loadout' && this.profile?.insuranceClaims?.length) this.render(); }, 15000);
  }

  act(a, extra = {}) { this.net.send({ t: 'act', a, ...extra }); }

  setProfile(p, notes) {
    this.profile = p;
    for (const n of notes ?? []) toast(n);
    this.render();
  }

  async loadLeaderboard() {
    try { this.leaderboard = await (await fetch('/api/leaderboard')).json(); } catch { this.leaderboard = []; }
    this.render();
  }

  render() {
    const p = this.profile;
    if (!p) return;
    $('#h-name').textContent = p.name;
    $('#h-level').textContent = `LVL ${p.level}` + (p.skillPoints ? ` · ${p.skillPoints} skill pt` : '');
    $('#h-xp').style.width = Math.min(100, p.xp / xpToNext(p.level) * 100) + '%';
    $('#h-cash').textContent = money(p.cash);
    this.renderTopbar();
    const body = $('#tab-body');
    // keep whatever the player was typing in squad/friend inputs across re-renders
    const keep = {};
    for (const el of body.querySelectorAll('input[id]')) keep[el.id] = el.value;
    const focus = document.activeElement?.id;
    body.innerHTML = this['tab_' + this.tab]?.(p) ?? '';
    for (const [id, v] of Object.entries(keep)) { const el = body.querySelector('#' + id); if (el) el.value = v; }
    if (focus) body.querySelector('#' + focus)?.focus();
  }

  renderTopbar() {
    const party = this.social?.party;
    $('#h-squad-mini').innerHTML = party
      ? `Squad <b class="code">${esc(party.code)}</b>: ${party.members.map(m => esc(m.name) + (m.id === party.leader ? ' ★' : '') + (m.ready ? ' ✓' : '')).join(', ')}`
      : 'Solo — squad up in the Squad &amp; Friends tab';
    const pr = this.social?.primary();
    if (pr) { const b = $('#deploy'); b.textContent = pr.label; b.className = 'btn deploy ' + pr.cls; }
  }

  selectTab(tab) {
    if (!tab || !this['tab_' + tab]) return;
    this.tab = tab;
    for (const x of $('#tabs').children) x.classList.toggle('active', x.dataset.tab === tab);
    if (tab === 'record') this.loadLeaderboard();
    if (tab === 'squad') this.social?.requestFriends();
    this.render();
  }

  // ---------------------------------------------------------------- tabs
  tab_loadout(p) {
    const L = p.loadout;
    const rig = L.rig ? ITEMS[L.rig.id] : null;
    const packCap = (rig?.slots ?? 4) + (p.skills.pack_mule ?? 0);
    const safeCap = rig?.safe ?? 0;
    const ins = (s) => s && s.uid && s.uid === p.insured.uid;
    const slot = (name, key) => `<div class="slot"><div class="lbl">${name}</div>${L[key] ? itemHTML(L[key], { src: 'lo:' + key, insured: ins(L[key]) }) : '<div class="item empty">empty</div>'}</div>`;
    const packCells = [];
    for (let i = 0; i < packCap; i++) packCells.push(L.pack[i] ? itemHTML(L.pack[i], { idx: i, src: 'pack' }) : '<div class="item empty"></div>');
    const safeCells = [];
    for (let i = 0; i < safeCap; i++) safeCells.push(L.safe[i] ? itemHTML(L.safe[i], { idx: i, src: 'safe' }) : '<div class="item empty">safe</div>');
    const stashCells = p.stash.map((s, i) => itemHTML(s, { idx: i, src: 'stash', insured: ins(s) })).join('');
    const value = [L.primary, L.secondary, L.shield, L.rig, ...L.pack].filter(Boolean).reduce((a, s) => a + sellPrice(s.id) * s.qty, 0);
    const claims = (p.insuranceClaims ?? []).map((c, i) => {
      const left = Math.max(0, c.readyAt - Date.now());
      return `<div class="row"><div class="grow">${esc(ITEMS[c.stack.id].name)} — ${left ? `ready in ${Math.ceil(left / 60000)} min` : '<b style="color:var(--good)">ready</b>'}</div>
        <button class="btn small" data-claim="${i}">${left ? `Expedite ${money(ITEMS[c.stack.id].value * 0.4)}` : 'Claim'}</button></div>`;
    }).join('');
    return `<div class="cols">
      <div>
        <div class="panel"><h3>Loadout <span><button class="btn small" data-act="free_kit" title="Random basic kit, no cost. Arc Raiders free loadout / DMZ free loadout.">Free Kit</button> <button class="btn small" data-act="unequip_all">Unequip all</button></span></h3>
          <div class="slots">${slot('Primary', 'primary')}${slot('Secondary', 'secondary')}${slot('Shield', 'shield')}${slot('Rig', 'rig')}</div>
          <p class="cost">At-risk value: <b>${money(value)}</b> · Click items to move them.</p>
        </div>
        <div class="panel"><h3>Backpack <span class="cost">${L.pack.length}/${packCap}</span></h3><div class="grid">${packCells.join('')}</div></div>
        <div class="panel"><h3>Safe pocket <span class="cost">${L.safe.length}/${safeCap} — kept even if you die</span></h3>
          ${safeCap ? `<div class="grid">${safeCells.join('')}</div>` : '<p class="cost">Your rig has no safe pocket. Scav, Runner, Hauler and Smuggler rigs do.</p>'}</div>
        <div class="panel"><h3>Insurance</h3>
          <p class="cost">One insured weapon. If you lose it, the insurer returns it after ${C.INSURE_COOLDOWN_MIN} min (DMZ-style). Right now: <b>${p.insured.uid ? esc(this.insuredName(p)) : 'nothing insured'}</b>. Click a weapon → Insure.</p>
          ${claims}
        </div>
      </div>
      <div class="panel"><h3>Stash <span class="cost">${p.stash.length}/${C.STASH_SLOTS}</span></h3><div class="grid">${stashCells || '<p class="cost">Empty. Go topside.</p>'}</div></div>
    </div>`;
  }

  insuredName(p) {
    const all = [p.loadout.primary, p.loadout.secondary, ...p.stash].filter(Boolean);
    const s = all.find(x => x.uid === p.insured.uid);
    return s ? ITEMS[s.id].name : 'a weapon';
  }

  tab_trader(p) {
    const stock = TRADER_STOCK.map(id => {
      const it = ITEMS[id];
      const bulk = it.stack >= 10 ? Math.min(it.stack, id.startsWith('ammo') ? 60 : 10) : 0;
      return `<div class="row"><div class="grow">${itemHTML({ id, qty: 1 })}</div>
        <div class="cost">${money(buyPrice(id))} ea</div>
        <button class="btn small" data-buy="${id}" data-qty="1" ${p.cash < buyPrice(id) ? 'disabled' : ''}>Buy 1</button>
        ${bulk ? `<button class="btn small" data-buy="${id}" data-qty="${bulk}" ${p.cash < buyPrice(id) * bulk ? 'disabled' : ''}>Buy ${bulk}</button>` : ''}</div>`;
    }).join('');
    const sell = p.stash.map((s, i) => `<div class="row"><div class="grow">${itemHTML(s, { idx: i, src: 'stash' })}</div>
      <div class="cost">${money(sellPrice(s.id) * s.qty)}</div><button class="btn small" data-sell="${i}">Sell</button></div>`).join('');
    return `<div class="cols"><div class="panel"><h3>Penny's stock</h3><p class="cost">Penny the Quartermaster sells basics at ${Math.round((1.6 - 1) * 100)}% markup. Better gear comes from topside or the Workbench.</p>${stock}</div>
      <div class="panel"><h3>Sell from stash</h3>${sell || '<p class="cost">Nothing to sell.</p>'}</div></div>`;
  }

  // ---------------------------------------------------------------- gunsmith (5 slots, tiers, repair, ammo)
  allGuns(p) {
    const out = [];
    for (const k of ['primary', 'secondary']) if (p.loadout[k]) out.push({ s: p.loadout[k], where: k === 'primary' ? 'Primary' : 'Secondary' });
    for (const s of p.loadout.pack) if (ITEMS[s.id]?.type === 'weapon') out.push({ s, where: 'Backpack' });
    for (const s of p.stash) if (ITEMS[s.id]?.type === 'weapon') out.push({ s, where: 'Stash' });
    return out;
  }

  tab_gunsmith(p) {
    const guns = this.allGuns(p);
    if (!guns.length) return '<div class="panel"><h3>Gunsmith</h3><p class="cost">No weapons. Buy one from Penny or craft one at the Workbench.</p></div>';
    let sel = guns.find(g => g.s.uid === this.gsUid) ?? guns[0];
    this.gsUid = sel.s.uid;
    const g = sel.s;
    const st = weaponStats(g);
    const have = (id) => countItem(p.stash, id);
    const list = guns.map(x => `<div class="gs-gun ${x.s.uid === g.uid ? 'sel' : ''}" data-gs="sel" data-arg="${x.s.uid}">
        <img src="${gunIcon(x.s) ?? ''}" alt=""><div><b>${esc(gunName(x.s))}</b><div class="cost">${x.where} · ${Math.round(x.s.dur ?? 100)}%</div></div></div>`).join('');
    const bar = (label, v, txt) => `<div class="gs-stat"><span>${label}</span><div class="prog"><div style="width:${Math.max(3, Math.min(100, v * 100))}%"></div></div><b>${txt}</b></div>`;
    const stats = [
      bar('Damage', (st.dmg * st.pellets * st.dmgAmmo) / 100, `${Math.round(st.dmg)}${st.pellets > 1 ? '×' + st.pellets : ''}`),
      bar('Fire rate', st.rpm / 900, `${Math.round(st.rpm)} rpm${st.mode === 'burst' ? ' (burst)' : st.mode === 'auto' ? '' : ' ' + st.mode}`),
      bar('Range', st.range / 230, `${Math.round(st.range)} m`),
      bar('Accuracy', 1 - st.spread / 0.09, `${(st.spread * 1000).toFixed(0)} mrad`),
      bar('Recoil control', 1 - st.recoilV / 0.08, `${(st.recoilV * 1000).toFixed(0)}`),
      bar('Handling', 1 - st.ads / 0.45, `${Math.round(st.ads * 1000)} ms ADS`),
      bar('Stealth', 1 - st.noise / 100, st.suppressed ? 'suppressed' : `${Math.round(st.noise)} m heard`),
      bar('Capacity', st.mag / 120, `${st.mag} rds`),
    ].join('');
    const slots = ATT_SLOTS.map(slot => {
      if (!slotOpen(g.id, slot)) return `<div class="gs-slot off"><div class="lbl">${ATT_SLOT_NAMES[slot]}</div><div class="cost">Not available on this weapon</div></div>`;
      const cur = g.att?.[slot];
      const options = p.stash.map((x, i) => [x, i]).filter(([x]) => ATTACHMENTS[x.id]?.slot === slot && canAttach(g.id, x.id));
      return `<div class="gs-slot"><div class="lbl">${ATT_SLOT_NAMES[slot]}</div>
        ${cur ? `<div class="row">${itemHTML({ id: cur, qty: 1 })}<button class="btn tiny" data-gs="detach" data-arg="${slot}">Remove</button></div><div class="cost">${describeMods(cur)}</div>` : '<div class="cost">empty</div>'}
        ${options.length ? options.map(([x, i]) => `<button class="btn tiny gs-fit" data-gs="fit" data-arg="${i}" title="${esc(ATTACHMENTS[x.id].name)}">Fit ${esc(ATTACHMENTS[x.id].name)}</button><div class="cost gs-mods">${describeMods(x.id)}</div>`).join('') : (cur ? '' : '<div class="cost">No compatible attachments in your stash</div>')}
      </div>`;
    }).join('');
    const up = upgradeCost(g), rep = repairCost(g);
    const costTxt = (c) => `${money(c.cash)} + ${Object.entries(c.mats).map(([m, n]) => `<span class="${have(m) >= n ? 'ok' : 'no'}">${n}x ${esc(ITEMS[m].name)}</span>`).join(', ')}`;
    const ammoBtns = AMMO_ORDER.map(t => {
      const item = st.ammo + AMMO_TYPES[t].suffix;
      const n = have(item) + countItem(p.loadout.pack, item);
      return `<button class="btn small ${st.ammoType === t ? 'primary' : ''}" data-gs="ammo" data-arg="${t}" title="${esc(ITEMS[item].name)}">${AMMO_TYPES[t].name} (${n})</button>`;
    }).join(' ');
    return `<div class="gs">
      <div class="panel gs-list"><h3>Weapons</h3>${list}</div>
      <div>
        <div class="panel gs-main"><h3>${esc(gunName(g))} <span class="cost">${esc(st.cls)} · Tier ${st.tier}/${MAX_TIER}</span></h3>
          <img class="gs-big" src="${gunIcon(g) ?? ''}" alt="">
          <div class="gs-stats">${stats}</div>
        </div>
        <div class="panel"><h3>Attachments</h3><div class="gs-slots">${slots}</div></div>
        <div class="panel"><h3>Bench</h3>
          <div class="row"><div class="grow"><b>Upgrade</b> ${up ? `to tier ${TIER_NAMES[st.tier + 1]}: +5% damage, −8% recoil, −5% reload. ${costTxt(up)}` : '— max tier'}</div>${up ? '<button class="btn small" data-gs="upgrade">Upgrade</button>' : ''}</div>
          <div class="row"><div class="grow"><b>Condition</b> ${Math.round(g.dur ?? 100)}%${(g.dur ?? 100) < 30 ? ' <span class="no">(may jam)</span>' : (g.dur ?? 100) < 50 ? ' <span class="no">(accuracy suffers)</span>' : ''} ${rep ? '· Repair: ' + costTxt(rep) : ''}</div>${rep ? '<button class="btn small" data-gs="repair">Repair</button>' : ''}</div>
          <div class="row"><div class="grow"><b>Loaded ammo</b> <span class="cost">AP punches through shields &amp; armor plating · HP hits flesh harder</span></div>${ammoBtns}</div>
        </div>
      </div></div>`;
  }

  tab_workbench(p) {
    const have = (id) => countItem(p.stash, id);
    const costHTML = (cost) => Object.entries(cost).map(([m, n]) => `<span class="${have(m) >= n ? 'ok' : 'no'}">${n}x ${esc(ITEMS[m].name)} (${have(m)})</span>`).join(' · ');
    const rec = RECIPES.map((r, i) => {
      const ok = p.workbench >= r.lvl && Object.entries(r.cost).every(([m, n]) => have(m) >= n);
      return `<div class="row"><div style="width:150px">${itemHTML({ id: r.out, qty: r.qty })}</div>
        <div class="grow cost">${p.workbench < r.lvl ? `<span class="no">Needs bench lvl ${r.lvl}</span>` : costHTML(r.cost)}</div>
        <button class="btn small" data-craft="${i}" ${ok ? '' : 'disabled'}>Craft</button></div>`;
    }).join('');
    const up = BENCH_UPGRADES[p.workbench + 1];
    const recyclable = p.stash.map((s, i) => [s, i]).filter(([s]) => ITEMS[s.id]?.recycle);
    return `<div class="cols"><div>
        <div class="panel"><h3>Workbench — level ${p.workbench}</h3>
          ${up ? `<p class="cost">Upgrade to ${p.workbench + 1}: ${money(up.cash)} + ${costHTML(up.cost)}</p><button class="btn" data-act="upgrade_bench">Upgrade bench</button>` : '<p class="cost">Fully upgraded.</p>'}
        </div>
        <div class="panel"><h3>Recycle</h3><p class="cost">Break junk and spare guns into materials (Arc Raiders style).</p>
          ${recyclable.map(([s, i]) => `<div class="row"><div class="grow">${itemHTML(s)}</div><div class="cost">→ ${Object.entries(ITEMS[s.id].recycle).map(([m, n]) => `${n * s.qty}x ${ITEMS[m].name}`).join(', ')}</div><button class="btn small" data-recycle="${i}">Recycle</button></div>`).join('') || '<p class="cost">Nothing recyclable in stash.</p>'}
        </div></div>
      <div class="panel"><h3>Recipes</h3>${rec}</div></div>`;
  }

  tab_contracts(p) {
    const cards = p.contracts.map((c, i) => {
      const done = c.type === 'fetch' ? countItem(p.stash, c.item) >= c.n : c.progress >= c.n;
      const prog = c.type === 'fetch' ? Math.min(countItem(p.stash, c.item), c.n) : c.progress;
      return `<div class="card"><div class="giver">${esc(c.giver)}</div><div class="title">${esc(c.title)}</div>
        <div class="prog"><div style="width:${prog / c.n * 100}%"></div></div>
        <div class="cost">${prog}/${c.n} · Reward ${money(c.cash)} + ${c.xp} XP</div>
        <div class="cost">${c.type === 'fetch' ? 'Turn in from your stash.' : 'Progress only counts if you extract.'}</div>
        <div style="display:flex;gap:6px"><button class="btn small primary" data-cclaim="${i}" ${done ? '' : 'disabled'}>Turn in</button>
        <button class="btn small" data-creroll="${i}">Reroll ($300)</button></div></div>`;
    }).join('');
    return `<p class="cost" style="margin-top:0">Contracts are DMZ "orders" / Arc Raiders quests. Kills, surveys and extracts are credited when you get out alive.</p><div class="cards">${cards}</div>`;
  }

  tab_skills(p) {
    const tree = (key, label) => `<div class="panel"><h3>${label}</h3>${SKILLS[key].map(n => {
      const r = p.skills[n.id] ?? 0;
      return `<div class="row"><div class="grow"><b>${esc(n.name)}</b><div class="cost">${esc(n.desc)}</div></div>
        <span class="pips">${Array.from({ length: n.max }, (_, i) => `<i class="${i < r ? 'on' : ''}"></i>`).join('')}</span>
        <button class="btn small" data-skill="${n.id}" ${p.skillPoints > 0 && r < n.max ? '' : 'disabled'}>+</button></div>`;
    }).join('')}</div>`;
    return `<p class="cost" style="margin-top:0">${p.skillPoints} skill point(s). Earn one per level.</p>
      <div class="tree">${tree('survival', 'Survival')}${tree('mobility', 'Mobility')}${tree('conditioning', 'Conditioning')}</div>`;
  }

  tab_squad() {
    if (!this.social) return '';
    return `<div class="soc-cols"><div class="panel">${this.social.partyHTML()}</div><div class="panel">${this.social.friendsHTML()}</div></div>
      <p class="cost">Squads stay together between raids and through disconnects (5 min). If the leader deploys without you, your slot is held for 5 minutes — hit JOIN SQUAD. Dead or extracted? You can spectate squadmates who are still topside.</p>`;
  }

  tab_record(p) {
    const r = p.lastReport;
    const s = p.stats;
    const lb = this.leaderboard.map((x, i) => `<div class="row"><div style="width:24px">${i + 1}</div><div class="grow">${esc(x.name)}</div><div class="cost">LVL ${x.level} · ${x.extracts} extracts · ${money(x.value)}</div></div>`).join('');
    return `<div class="cols"><div>
      <div class="panel"><h3>Last raid</h3>${r ? `<div class="kv"><b>Result</b><span style="color:${r.extracted ? 'var(--good)' : 'var(--bad)'}">${r.extracted ? 'EXTRACTED' : 'KIA'} — ${esc(r.how ?? '')}</span>
        <b>Time</b><span>${Math.floor(r.duration / 60)}m ${r.duration % 60}s</span><b>XP</b><span>${r.xp}</span><b>Loot value</b><span>${money(r.value)}</span>
        <b>Kills</b><span>${r.kills.total} (${r.pkills} raiders)</span></div>` : '<p class="cost">No raids yet.</p>'}</div>
      <div class="panel"><h3>Career</h3><div class="kv"><b>Raids</b><span>${s.raids}</span><b>Extracts</b><span>${s.extracts} (${s.raids ? Math.round(s.extracts / s.raids * 100) : 0}%)</span>
        <b>Deaths</b><span>${s.deaths}</span><b>Kills</b><span>${s.kills}</span><b>Raider kills</b><span>${s.pkills}</span><b>Value extracted</b><span>${money(s.value)}</span></div>
        <div class="row" style="margin-top:10px"><input id="rename" maxlength="16" value="${esc(p.name)}" style="padding:6px;background:#000;border:1px solid var(--line);color:#fff"><button class="btn small" data-rename="1">Rename</button></div></div>
      </div><div class="panel"><h3>Leaderboard — value extracted</h3>${lb || '<p class="cost">Loading…</p>'}</div></div>`;
  }

  tab_howto() {
    return `<div class="panel howto" style="max-width:860px"><h3>How DMCHEAP works</h3>
      <p><b>The loop:</b> gear up in The Cheap Seats → deploy topside → loot, fight CHEAP machines, Rustline mercs and other raiders → reach an extraction before The Sweep (${C.RAID_DURATION / 60} min). Die and you lose everything you carried except your <b>safe pocket</b>. Your <b>insured</b> weapon comes back after a cooldown.</p>
      <ul>
        <li><b>Extraction:</b> 3 of 6 lifts are open each raid (see top-right). Press <kbd>E</kbd> at the beacon to call the lift. It takes ${C.EXTRACT_COUNTDOWN}s and the noise draws machines, so hold the zone. Two lifts close early.</li>
        <li><b>Raider hatches:</b> with a Hatch Key you can slip out alone and quietly in ${C.HATCH_TIME}s.</li>
        <li><b>Threat:</b> POIs are rated ▲ to ▲▲▲▲▲. Better loot, angrier machines. The Foundry holds <b>The Warden</b>. Shoot the glowing core on its back.</li>
        <li><b>Stealth meter:</b> the bar under your crosshair fills as enemies notice you. Crouch to stay quiet. Sprinting and gunfire make noise.</li>
        <li><b>Vaults:</b> Depot, Old Mall and Reactor Yard have locked vaults. Find or buy the key.</li>
        <li><b>Wanted:</b> kill ${C.WANTED_KILLS} raiders and your position is revealed to everyone. Killing a Wanted raider pays a bounty.</li>
        <li><b>Free Kit:</b> broke? Grab a free random kit. Nothing to lose.</li>
        <li><b>Squads:</b> up to ${C.MAX_SQUAD}. Share your invite link or add friends by <b>Name#TAG</b>. Squads stay together between raids. Members ready up, then the leader deploys. If you're left behind, your slot is held for 5 minutes: hit <b>JOIN SQUAD</b> to drop in next to them. <b>Fill squad</b> matches solos together.</li>
        <li><b>The Cheap Seats:</b> walk the hub with other raiders. Use the stations (E) for your stash, trader, workbench and so on. Stand in <b>The Lift</b> to ready up or deploy. Prefer menus? Switch to <b>Menu mode</b>.</li>
        <li><b>Gunsmith:</b> fit up to 5 attachments (muzzle, barrel, optic, magazine, grip/stock). Suppressors keep machines from hearing you. Upgrade guns to tier IV and repair worn guns, because worn guns lose accuracy and can jam (press R to clear). Choose FMJ, AP (beats shields and armor) or HP (more damage to flesh), and press <kbd>B</kbd> in a raid to switch.</li>
        <li><b>Spectate:</b> dead or extracted while squadmates are still topside? Watch them until they're out.</li>
      </ul>
      <p><b>Controls:</b> <kbd>WASD</kbd> move · <kbd>Shift</kbd> sprint · <kbd>C</kbd> crouch · <kbd>Mouse</kbd> aim · <kbd>LMB</kbd> fire · <kbd>RMB</kbd> ADS · <kbd>R</kbd> reload · <kbd>1</kbd>/<kbd>2</kbd> weapons · <kbd>B</kbd> ammo type · <kbd>E</kbd> interact/search/revive ·
      <kbd>Q</kbd> bandage/medkit · <kbd>Z</kbd> shield cell · <kbd>G</kbd> frag · <kbd>T</kbd> lure · <kbd>X</kbd> tourniquet (downed) · <kbd>Tab</kbd> inventory · <kbd>M</kbd> map · <kbd>F</kbd> ping · <kbd>V</kbd> swap shoulder · <kbd>Enter</kbd> chat</p></div>`;
  }

  // ---------------------------------------------------------------- clicks
  onClick(ev) {
    const t = ev.target;
    const gs = t.closest('[data-gs]');
    if (gs) {
      const a = gs.dataset.gs, arg = gs.dataset.arg, uid = this.gsUid;
      if (a === 'sel') { this.gsUid = arg; return this.render(); }
      if (a === 'fit') return this.act('attach', { uid, idx: +arg });
      if (a === 'detach') return this.act('detach', { uid, slot: arg });
      if (a === 'upgrade') return this.act('upgrade_gun', { uid });
      if (a === 'repair') return this.act('repair_gun', { uid });
      if (a === 'ammo') return this.act('set_ammo', { uid, type: arg });
    }
    const d = t.closest('[data-act],[data-buy],[data-sell],[data-craft],[data-recycle],[data-skill],[data-cclaim],[data-creroll],[data-claim],[data-rename]');
    if (d) {
      const ds = d.dataset;
      if (ds.act) return this.act(ds.act);
      if (ds.buy) return this.act('buy', { id: ds.buy, qty: +ds.qty });
      if (ds.sell) return this.act('sell', { idx: +ds.sell });
      if (ds.craft) return this.act('craft', { r: +ds.craft });
      if (ds.recycle) return this.act('recycle', { idx: +ds.recycle });
      if (ds.skill) return this.act('skill', { id: ds.skill });
      if (ds.cclaim) return this.act('contract_claim', { i: +ds.cclaim });
      if (ds.creroll) return this.act('contract_reroll', { i: +ds.creroll });
      if (ds.claim) return this.act('claim_insurance', { i: +ds.claim, expedite: true });
      if (ds.rename) return this.net.send({ t: 'rename', name: $('#rename').value });
    }
    const el = t.closest('.item[data-src]');
    if (!el || !el.dataset.src || this.tab !== 'loadout') return;
    const p = this.profile;
    const src = el.dataset.src, idx = +el.dataset.idx;
    if (src === 'stash') {
      const s = p.stash[idx];
      const it = ITEMS[s.id];
      const e = [];
      if (it.type === 'weapon') {
        e.push({ label: 'Equip as primary', fn: () => this.act('equip', { idx, slot: 'primary' }) });
        e.push({ label: 'Equip as secondary', fn: () => this.act('equip', { idx, slot: 'secondary' }) });
        e.push({ label: `Insure (${money(it.value * 0.25)})`, fn: () => this.act('insure', { uid: s.uid }), disabled: s.uid === p.insured.uid });
        e.push({ label: 'Open in Gunsmith', fn: () => { this.gsUid = s.uid; this.selectTab('gunsmith'); } });
      }
      if (it.type === 'shield') e.push({ label: 'Equip shield', fn: () => this.act('equip', { idx, slot: 'shield' }) });
      if (it.type === 'rig') e.push({ label: 'Equip rig', fn: () => this.act('equip', { idx, slot: 'rig' }) });
      e.push({ label: 'Move to backpack', fn: () => this.act('equip', { idx, slot: 'pack' }) });
      if (!['weapon', 'shield', 'rig'].includes(it.type)) e.push({ label: 'Move to safe pocket', fn: () => this.act('equip', { idx, slot: 'safe' }) });
      e.push({ label: `Sell (${money(sellPrice(s.id) * s.qty)})`, fn: () => this.act('sell', { idx }) });
      if (it.recycle) e.push({ label: 'Recycle', fn: () => this.act('recycle', { idx }) });
      showMenu(ev.clientX, ev.clientY, `${it.name}${s.qty > 1 ? ' x' + s.qty : ''}`, e);
    } else if (src === 'pack' || src === 'safe') {
      showMenu(ev.clientX, ev.clientY, ITEMS[p.loadout[src][idx].id].name, [{ label: 'Back to stash', fn: () => this.act('unequip', { slot: src, idx }) }]);
    } else if (src.startsWith('lo:')) {
      const slot = src.slice(3);
      const s = p.loadout[slot];
      const e = [{ label: 'Unequip to stash', fn: () => this.act('unequip', { slot }) }];
      if (ITEMS[s.id].type === 'weapon') {
        e.push({ label: `Insure (${money(ITEMS[s.id].value * 0.25)})`, fn: () => this.act('insure', { uid: s.uid }), disabled: s.uid === p.insured.uid });
        e.push({ label: 'Open in Gunsmith', fn: () => { this.gsUid = s.uid; this.selectTab('gunsmith'); } });
      }
      showMenu(ev.clientX, ev.clientY, ITEMS[s.id].name, e);
    }
  }
}
