// Hideout ("The Cheap Seats") logic: stash, loadout, trader, workbench, skills,
// insurance and contracts. All validation is server-side; the client only sends intents.
import crypto from 'node:crypto';
import {
  C, ITEMS, WEAPONS, RECIPES, BENCH_UPGRADES, TRADER_STOCK, SKILLS, POIS, CONTRACT_GIVERS,
  makeStack, addToStacks, countItem, removeItem, buyPrice, sellPrice, xpToNext, skillRank,
} from '../shared/data.js';

const SLOT_TYPES = { primary: 'weapon', secondary: 'weapon', shield: 'shield', rig: 'rig' };

export function newProfile(name) {
  const p = {
    id: crypto.randomUUID().replace(/-/g, '').slice(0, 12),
    token: crypto.randomBytes(24).toString('hex'),
    name: sanitizeName(name),
    created: Date.now(),
    level: 1, xp: 0, skillPoints: 1, skills: {},
    cash: C.START_CASH,
    workbench: 1,
    stash: [],
    loadout: emptyLoadout(),
    insured: { uid: null },
    insuranceClaims: [],
    contracts: [],
    stats: { raids: 0, extracts: 0, deaths: 0, kills: 0, pkills: 0, value: 0 },
    lastReport: null,
    inRaid: null,
    raidBackup: null,
  };
  p.loadout.primary = makeStack('peashooter');
  p.loadout.shield = makeStack('shield_light');
  p.loadout.rig = makeStack('rig_scav');
  addToStacks(p.loadout.pack, makeStack('ammo_light', 72));
  addToStacks(p.loadout.pack, makeStack('bandage', 3));
  addToStacks(p.loadout.pack, makeStack('shield_cell', 2));
  for (const [id, q] of [['buzz', 1], ['ammo_light', 90], ['frag', 2], ['scrap', 12], ['wires', 6], ['chem', 3]]) addToStacks(p.stash, makeStack(id, q));
  while (p.contracts.length < 3) p.contracts.push(genContract(p));
  return p;
}

export function sanitizeName(n) {
  const s = String(n ?? '').replace(/[^\w\- ]/g, '').trim().slice(0, 16);
  return s || 'Raider' + Math.floor(Math.random() * 9000 + 1000);
}

export function emptyLoadout() {
  return { primary: null, secondary: null, shield: null, rig: null, pack: [], safe: [] };
}

export function packCapacity(p, rigStack = p.loadout.rig) {
  const rig = rigStack ? ITEMS[rigStack.id] : null;
  return (rig?.slots ?? 4) + skillRank(p, 'pack_mule');
}
export function safeCapacity(rigStack) {
  return rigStack ? (ITEMS[rigStack.id]?.safe ?? 0) : 0;
}

function toStash(p, stack, notes) {
  const left = addToStacks(p.stash, stack, C.STASH_SLOTS);
  if (left > 0) {
    const cash = Math.floor(sellPrice(stack.id) * left * 0.5);
    p.cash += cash;
    notes?.push(`Stash full: auto-sold ${left}x ${ITEMS[stack.id]?.name ?? stack.id} for $${cash}`);
  }
}

function stashItem(p, idx) {
  const s = p.stash[idx | 0];
  if (!s) throw new Error('No such stash item');
  return s;
}

// ------------------------------------------------------------ actions
export function applyAction(p, msg) {
  const a = msg.a;
  const notes = [];
  if (p.inRaid) throw new Error('You are in a raid');
  switch (a) {
    case 'equip': {
      const s = stashItem(p, msg.idx);
      const it = ITEMS[s.id];
      const slot = msg.slot;
      if (SLOT_TYPES[slot]) {
        if (it.type !== SLOT_TYPES[slot]) throw new Error(`That can't go in ${slot}`);
        p.stash.splice(msg.idx | 0, 1);
        const prev = p.loadout[slot];
        p.loadout[slot] = s;
        if (prev) toStash(p, prev, notes);
        if (slot === 'rig') {
          const cap = packCapacity(p), sc = safeCapacity(s);
          while (p.loadout.pack.length > cap) toStash(p, p.loadout.pack.pop(), notes);
          while (p.loadout.safe.length > sc) toStash(p, p.loadout.safe.pop(), notes);
        }
      } else if (slot === 'pack' || slot === 'safe') {
        if (slot === 'safe' && (it.type === 'weapon' || it.type === 'rig' || it.type === 'shield')) throw new Error('Weapons and gear cannot go in the safe pocket');
        const arr = p.loadout[slot];
        const cap = slot === 'pack' ? packCapacity(p) : safeCapacity(p.loadout.rig);
        const qty = Math.max(1, Math.min(s.qty, msg.qty | 0 || s.qty));
        const moving = { ...s, qty };
        const left = addToStacks(arr, moving, cap);
        const moved = qty - left;
        if (moved <= 0) throw new Error(slot === 'safe' ? 'Safe pocket full (better rigs have more)' : 'Backpack full');
        s.qty -= moved;
        if (s.qty <= 0) p.stash.splice(msg.idx | 0, 1);
      } else throw new Error('Bad slot');
      break;
    }
    case 'unequip': {
      const slot = msg.slot;
      if (SLOT_TYPES[slot]) {
        const s = p.loadout[slot];
        if (!s) throw new Error('Empty slot');
        p.loadout[slot] = null;
        toStash(p, s, notes);
        if (slot === 'rig') {
          while (p.loadout.pack.length > packCapacity(p)) toStash(p, p.loadout.pack.pop(), notes);
          while (p.loadout.safe.length) toStash(p, p.loadout.safe.pop(), notes);
        }
      } else if (slot === 'pack' || slot === 'safe') {
        const arr = p.loadout[slot];
        const s = arr[msg.idx | 0];
        if (!s) throw new Error('Empty slot');
        arr.splice(msg.idx | 0, 1);
        toStash(p, s, notes);
      } else throw new Error('Bad slot');
      break;
    }
    case 'unequip_all': {
      stripLoadout(p, notes);
      break;
    }
    case 'free_kit': {
      // Arc Raiders free loadout / DMZ "Equip Free Loadout": random basic kit at no cost
      stripLoadout(p, notes);
      const w = ['peashooter', 'buzz', 'doorknock'][Math.floor(Math.random() * 3)];
      p.loadout.primary = makeStack(w);
      p.loadout.shield = makeStack('shield_light');
      p.loadout.rig = makeStack('rig_free');
      const ammo = WEAPONS[w].ammo;
      addToStacks(p.loadout.pack, makeStack(ammo, ammo === 'ammo_shell' ? 24 : 75));
      addToStacks(p.loadout.pack, makeStack('bandage', 2));
      addToStacks(p.loadout.pack, makeStack('shield_cell', 1));
      if (Math.random() < 0.5) addToStacks(p.loadout.pack, makeStack(Math.random() < 0.5 ? 'frag' : 'lure', 1));
      notes.push(`Free kit issued: ${ITEMS[w].name}`);
      break;
    }
    case 'buy': {
      const id = String(msg.id);
      if (!TRADER_STOCK.includes(id)) throw new Error('Not for sale');
      const qty = Math.max(1, Math.min(msg.qty | 0 || 1, ITEMS[id].stack));
      const cost = buyPrice(id) * qty;
      if (p.cash < cost) throw new Error('Not enough cash');
      if (p.stash.length >= C.STASH_SLOTS && !p.stash.some(s => s.id === id && s.qty + qty <= ITEMS[id].stack)) throw new Error('Stash full');
      p.cash -= cost;
      toStash(p, makeStack(id, qty), notes);
      break;
    }
    case 'sell': {
      const s = stashItem(p, msg.idx);
      const qty = Math.max(1, Math.min(s.qty, msg.qty | 0 || s.qty));
      if (s.uid && s.uid === p.insured.uid) p.insured.uid = null;
      p.cash += sellPrice(s.id) * qty;
      s.qty -= qty;
      if (s.qty <= 0) p.stash.splice(msg.idx | 0, 1);
      break;
    }
    case 'recycle': {
      const s = stashItem(p, msg.idx);
      const rec = ITEMS[s.id].recycle;
      if (!rec) throw new Error("Can't recycle that");
      p.stash.splice(msg.idx | 0, 1);
      if (s.uid && s.uid === p.insured.uid) p.insured.uid = null;
      for (const [m, n] of Object.entries(rec)) toStash(p, makeStack(m, n * s.qty), notes);
      notes.push(`Recycled ${s.qty}x ${ITEMS[s.id].name}`);
      break;
    }
    case 'craft': {
      const r = RECIPES[msg.r | 0];
      if (!r) throw new Error('Unknown recipe');
      if (p.workbench < r.lvl) throw new Error(`Needs Workbench level ${r.lvl}`);
      for (const [m, n] of Object.entries(r.cost)) if (countItem(p.stash, m) < n) throw new Error(`Need ${n}x ${ITEMS[m].name}`);
      for (const [m, n] of Object.entries(r.cost)) removeItem(p.stash, m, n);
      toStash(p, makeStack(r.out, r.qty), notes);
      notes.push(`Crafted ${r.qty}x ${ITEMS[r.out].name}`);
      break;
    }
    case 'upgrade_bench': {
      const next = p.workbench + 1;
      const up = BENCH_UPGRADES[next];
      if (!up) throw new Error('Workbench is maxed');
      if (p.cash < up.cash) throw new Error('Not enough cash');
      for (const [m, n] of Object.entries(up.cost)) if (countItem(p.stash, m) < n) throw new Error(`Need ${n}x ${ITEMS[m].name}`);
      for (const [m, n] of Object.entries(up.cost)) removeItem(p.stash, m, n);
      p.cash -= up.cash;
      p.workbench = next;
      notes.push(`Workbench upgraded to level ${next}`);
      break;
    }
    case 'skill': {
      const node = Object.values(SKILLS).flat().find(n => n.id === msg.id);
      if (!node) throw new Error('Unknown skill');
      if (p.skillPoints <= 0) throw new Error('No skill points');
      if (skillRank(p, node.id) >= node.max) throw new Error('Maxed');
      p.skills[node.id] = skillRank(p, node.id) + 1;
      p.skillPoints--;
      break;
    }
    case 'insure': {
      // DMZ insured weapon slot: one weapon that comes back after a cooldown if lost
      const uid = String(msg.uid);
      const w = [p.loadout.primary, p.loadout.secondary, ...p.stash].find(s => s && s.uid === uid);
      if (!w) throw new Error('Weapon not found');
      const cost = Math.ceil(ITEMS[w.id].value * 0.25);
      if (p.cash < cost) throw new Error('Not enough cash');
      p.cash -= cost;
      p.insured.uid = uid;
      notes.push(`${ITEMS[w.id].name} insured for $${cost}`);
      break;
    }
    case 'claim_insurance': {
      const i = msg.i | 0;
      const c = p.insuranceClaims[i];
      if (!c) throw new Error('No claim');
      if (Date.now() < c.readyAt) {
        if (!msg.expedite) throw new Error('Not ready yet');
        const cost = Math.ceil(ITEMS[c.stack.id].value * 0.4);
        if (p.cash < cost) throw new Error('Not enough cash');
        p.cash -= cost;
      }
      p.insuranceClaims.splice(i, 1);
      const s = { ...c.stack, mag: WEAPONS[c.stack.id]?.mag ?? 0 };
      toStash(p, s, notes);
      p.insured.uid = s.uid;
      notes.push(`${ITEMS[s.id].name} returned by the insurer`);
      break;
    }
    case 'contract_claim': {
      const c = p.contracts[msg.i | 0];
      if (!c) throw new Error('No contract');
      if (c.type === 'fetch') {
        if (countItem(p.stash, c.item) < c.n) throw new Error(`Need ${c.n}x ${ITEMS[c.item].name} in your stash`);
        removeItem(p.stash, c.item, c.n);
      } else if (c.progress < c.n) throw new Error('Not complete');
      p.cash += c.cash;
      notes.push(`Contract complete: +$${c.cash}, +${c.xp} XP`);
      grantXp(p, c.xp, notes);
      p.contracts[msg.i | 0] = genContract(p);
      break;
    }
    case 'contract_reroll': {
      const i = msg.i | 0;
      if (!p.contracts[i]) throw new Error('No contract');
      if (p.cash < 300) throw new Error('Not enough cash');
      p.cash -= 300;
      p.contracts[i] = genContract(p);
      break;
    }
    default:
      throw new Error('Unknown action');
  }
  return notes;
}

function stripLoadout(p, notes) {
  for (const slot of ['primary', 'secondary', 'shield', 'rig']) {
    if (p.loadout[slot]) {
      if (p.loadout[slot].id !== 'rig_free') toStash(p, p.loadout[slot], notes);
      p.loadout[slot] = null;
    }
  }
  for (const s of p.loadout.pack) toStash(p, s, notes);
  for (const s of p.loadout.safe) toStash(p, s, notes);
  p.loadout.pack = []; p.loadout.safe = [];
}

export function grantXp(p, xp, notes) {
  p.xp += Math.max(0, Math.round(xp));
  while (p.xp >= xpToNext(p.level)) {
    p.xp -= xpToNext(p.level);
    p.level++;
    p.skillPoints++;
    notes?.push(`Level up! You are level ${p.level} (+1 skill point)`);
  }
}

// ------------------------------------------------------------ contracts (DMZ orders / Arc quests)
const KILL_TARGETS = { gnat: [4, 8, 120], tick: [3, 6, 150], merc: [3, 6, 260], squealer: [1, 3, 300], sentry: [1, 2, 700] };
const FETCH_TARGETS = { scrap: [15, 30], wires: [8, 15], chem: [4, 8], circuits: [3, 6], toaster: [1, 2], old_phone: [2, 3], gold_watch: [1, 1], data_drive: [1, 1] };

export function genContract(p) {
  const giver = CONTRACT_GIVERS[Math.floor(Math.random() * CONTRACT_GIVERS.length)];
  const r = Math.random();
  const ri = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
  let c;
  if (r < 0.38) {
    const keys = Object.keys(KILL_TARGETS).filter(k => k !== 'sentry' || p.level >= 3);
    const e = keys[Math.floor(Math.random() * keys.length)];
    const [a, b, per] = KILL_TARGETS[e];
    const n = ri(a, b);
    c = { type: 'kill', enemy: e, n, cash: n * per + 300, title: `Scrap ${n} ${e === 'merc' ? 'Rustline Mercs' : e[0].toUpperCase() + e.slice(1) + 's'}` };
  } else if (r < 0.63) {
    const keys = Object.keys(FETCH_TARGETS);
    const it = keys[Math.floor(Math.random() * keys.length)];
    const [a, b] = FETCH_TARGETS[it];
    const n = ri(a, b);
    c = { type: 'fetch', item: it, n, cash: Math.round(ITEMS[it].value * n * 1.8 + 300), title: `Deliver ${n}x ${ITEMS[it].name}` };
  } else if (r < 0.85) {
    const pois = POIS.filter(x => x.threat <= Math.min(5, 2 + Math.floor(p.level / 2)));
    const poi = pois[Math.floor(Math.random() * pois.length)];
    c = { type: 'visit', poi: poi.id, n: 1, cash: 600 + poi.threat * 450, title: `Survey ${poi.name} and extract` };
  } else if (r < 0.95 || p.level < 5) {
    const n = ri(1, 2);
    c = { type: 'extract', n, cash: 900 * n, title: `Extract successfully ${n} time${n > 1 ? 's' : ''}` };
  } else {
    c = { type: 'boss', enemy: 'warden', n: 1, cash: 15000, title: 'Bring down The Warden' };
  }
  c.progress = 0;
  c.xp = Math.round(c.cash * 0.45);
  c.giver = giver;
  c.id = Math.random().toString(36).slice(2, 8);
  return c;
}

// ------------------------------------------------------------ raid lifecycle
export function prepareDeploy(p, raidId) {
  const lo = p.loadout;
  p.raidBackup = structuredClone(lo);
  p.inRaid = raidId;
  p.loadout = emptyLoadout();
  const insuredAtRisk = [lo.primary, lo.secondary].some(s => s && s.uid && s.uid === p.insured.uid);
  return { loadout: lo, insuredAtRisk, insuredStack: insuredAtRisk ? structuredClone([lo.primary, lo.secondary].find(s => s && s.uid === p.insured.uid)) : null };
}

// Server restarted mid-raid (e.g. a Railway redeploy): give the gear back.
export function voidRaid(p) {
  if (p.raidBackup) p.loadout = p.raidBackup;
  p.raidBackup = null;
  p.inRaid = null;
}

function stackValue(s) { return s ? sellPrice(s.id) * s.qty : 0; }

export function applyRaidResult(p, res, deployInfo) {
  const notes = [];
  p.inRaid = null;
  p.raidBackup = null;
  p.stats.raids++;
  p.stats.kills += res.kills.total;
  p.stats.pkills += res.pkills;
  const inv = res.inv;
  let carried = 0;
  if (res.extracted) {
    p.stats.extracts++;
    p.loadout = { primary: inv.primary, secondary: inv.secondary, shield: inv.shield, rig: inv.rig, pack: [], safe: [] };
    for (const s of [...inv.pack, ...inv.safe]) { carried += stackValue(s); toStash(p, s, notes); }
    p.stats.value += carried;
    if (res.bounty > 0) { p.cash += res.bounty; notes.push(`Bounty payout: $${res.bounty}`); }
    for (const c of p.contracts) {
      if (c.type === 'kill' || c.type === 'boss') c.progress = Math.min(c.n, c.progress + (res.kills[c.enemy] ?? 0));
      if (c.type === 'visit' && res.visited.includes(c.poi)) c.progress = 1;
      if (c.type === 'extract') c.progress = Math.min(c.n, c.progress + 1);
    }
  } else {
    p.stats.deaths++;
    p.loadout = emptyLoadout();
    for (const s of inv.safe) toStash(p, s, notes);
    if (inv.safe.length) notes.push(`Safe pocket kept ${inv.safe.length} item stack(s)`);
  }
  // insured weapon lost? (died with it, or extracted without it)
  if (deployInfo?.insuredAtRisk) {
    const uid = deployInfo.insuredStack.uid;
    const still = res.extracted && [inv.primary, inv.secondary, ...inv.pack].some(s => s && s.uid === uid);
    if (!still) {
      p.insuranceClaims.push({ stack: deployInfo.insuredStack, readyAt: Date.now() + C.INSURE_COOLDOWN_MIN * 60000 });
      p.insured.uid = null;
      notes.push(`Insured ${ITEMS[deployInfo.insuredStack.id].name} lost — claim ready in ${C.INSURE_COOLDOWN_MIN} min`);
    }
  }
  grantXp(p, res.xp, notes);
  p.lastReport = {
    at: Date.now(), extracted: res.extracted, cause: res.cause, xp: res.xp, kills: res.kills, pkills: res.pkills,
    value: carried, duration: res.duration, notes, how: res.how,
  };
  return notes;
}

// Public view sent to the client (no token)
export function publicProfile(p) {
  const { token, raidBackup, ...rest } = p;
  return rest;
}
