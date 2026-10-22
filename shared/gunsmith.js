// Gunsmith rules shared by server and client: final weapon stats from base + attachments + tier + ammo + wear,
// attachment compatibility, upgrade/repair costs, recoil patterns and compact "gear keys" for the network.
import { WEAPONS, ITEMS, ATTACHMENTS, ATT_SLOTS, AMMO_TYPES, ADS_SPREAD_MULT, MOVE_SPREAD_MULT } from './data.js';

export const WEAPON_KEYS = Object.keys(WEAPONS);
export const ATT_KEYS = Object.keys(ATTACHMENTS);
export const TIER_NAMES = ['', '', 'II', 'III', 'IV'];
export const MAX_TIER = 4;
export const JAM_BELOW = 30;

export function gunName(stack) {
  const W = WEAPONS[stack?.id];
  if (!W) return ITEMS[stack?.id]?.name ?? '?';
  const t = stack.tier ?? 1;
  return W.name + (t > 1 ? ' ' + TIER_NAMES[t] : '');
}

export function canAttach(weaponId, attId) {
  const W = WEAPONS[weaponId], A = ATTACHMENTS[attId];
  if (!W || !A) return false;
  const rule = W.slots?.[A.slot];
  if (rule === true) return true;
  if (Array.isArray(rule)) return rule.includes(attId);
  return false;
}
export function slotOpen(weaponId, slot) {
  const rule = WEAPONS[weaponId]?.slots?.[slot];
  return rule === true || (Array.isArray(rule) && rule.length > 0);
}

export function ammoItemFor(stack) {
  const W = WEAPONS[stack.id];
  return W.ammo + (AMMO_TYPES[stack.ammoType ?? 'fmj']?.suffix ?? '');
}

// Final stats for a weapon stack. Pure function — the server uses it for authority, the client for feel/UI.
export function weaponStats(stack) {
  const W = WEAPONS[stack?.id];
  if (!W) return null;
  const s = {
    id: stack.id, name: gunName(stack), cls: W.cls, mode: W.mode, auto: W.mode === 'auto', burst: W.burst ?? 1, burstDelay: W.burstDelay ?? 0,
    pellets: W.pellets ?? 1, dmg: W.dmg, rpm: W.rpm, mag: W.mag, ammo: W.ammo, spread: W.spread,
    adsSpread: ADS_SPREAD_MULT, moveSpread: MOVE_SPREAD_MULT, range: W.range, reload: W.reload, noise: W.noise,
    recoilV: W.recoil.v, recoilH: W.recoil.h, recover: W.recoil.rec, ads: W.ads, sprintFire: W.sprintFire, head: W.head ?? 1.8,
    move: W.move ?? 1, zoom: 1.2, optic: null, suppressed: false, model: W.model, gold: !!W.gold,
    tier: stack.tier ?? 1, dur: stack.dur ?? 100, ammoType: stack.ammoType ?? 'fmj',
  };
  let magMult = 1;
  for (const slot of ATT_SLOTS) {
    const id = stack.att?.[slot];
    const A = id && ATTACHMENTS[id];
    if (!A) continue;
    const m = A.mods;
    if (m.dmg) s.dmg *= m.dmg;
    if (m.range) s.range *= m.range;
    if (m.noise) s.noise *= m.noise;
    if (m.ads) s.ads *= m.ads;
    if (m.reload) s.reload *= m.reload;
    if (m.recoilV) s.recoilV *= m.recoilV;
    if (m.recoilH) s.recoilH *= m.recoilH;
    if (m.recover) s.recover *= m.recover;
    if (m.hip) s.spread *= m.hip;
    if (m.adsSpread) s.adsSpread *= m.adsSpread;
    if (m.moveSpread) s.moveSpread *= m.moveSpread;
    if (m.move) s.move *= m.move;
    if (m.mag) magMult *= m.mag;
    if (A.zoom) { s.zoom = A.zoom; s.optic = id; }
    if (A.suppress) s.suppressed = true;
  }
  s.mag = Math.max(1, Math.round(W.mag * magMult));
  // tier upgrades (Arc Raiders-style weapon levels)
  const t = s.tier - 1;
  s.dmg *= 1 + 0.05 * t;
  s.recoilV *= 1 - 0.08 * t; s.recoilH *= 1 - 0.08 * t;
  s.reload *= 1 - 0.05 * t;
  s.spread *= 1 - 0.05 * t;
  // ammo type
  const AT = AMMO_TYPES[s.ammoType] ?? AMMO_TYPES.fmj;
  s.ammoItem = W.ammo + AT.suffix;
  s.dmgAmmo = AT.dmg; s.absorb = AT.absorb; s.machine = AT.machine; s.pen = !!AT.pen;
  // worn guns get sloppy; below JAM_BELOW they can jam
  if (s.dur < 50) s.spread *= 1 + (50 - s.dur) / 100;
  s.wear = 0.06 + (W.dmg * (W.pellets ?? 1)) / 700;
  s.jamChance = s.dur < JAM_BELOW ? ((JAM_BELOW - s.dur) / JAM_BELOW) * 0.04 : 0;
  return s;
}

// Deterministic per-weapon horizontal recoil pattern (learnable spray), plus small randomness on the client.
export function recoilPattern(id, n) {
  const seed = WEAPON_KEYS.indexOf(id) + 1;
  return Math.sin(n * 0.55 + seed * 1.7) * 0.8 + Math.sin(n * 0.21 + seed) * 0.4;
}

export function upgradeCost(stack) {
  const t = stack.tier ?? 1;
  if (t >= MAX_TIER) return null;
  const v = ITEMS[stack.id]?.value ?? 1000;
  const mats = { scrap: 10 * t, circuits: 2 * t };
  if (t >= 2) mats.alloy = 2 * (t - 1);
  if (t >= 3) mats.cheap_core = 1;
  return { cash: Math.round(v * 0.4 * t / 50) * 50, mats };
}

export function repairCost(stack) {
  const missing = 100 - (stack.dur ?? 100);
  if (missing < 1) return null;
  const v = ITEMS[stack.id]?.value ?? 1000;
  return { cash: Math.round((missing / 100) * v * 0.3 / 10) * 10, mats: { scrap: Math.ceil(missing / 12) } };
}

// Compact gear key for remote rendering: "weaponIdx|att,att,att,att,att|tier"
export function gearKey(stack) {
  if (!stack || !WEAPONS[stack.id]) return '';
  const att = ATT_SLOTS.map(sl => { const a = stack.att?.[sl]; return a ? ATT_KEYS.indexOf(a) : ''; }).join(',');
  return `${WEAPON_KEYS.indexOf(stack.id)}|${att}|${stack.tier ?? 1}`;
}
export function decodeGear(key) {
  if (!key) return null;
  const [wi, att, tier] = String(key).split('|');
  const id = WEAPON_KEYS[+wi];
  if (!id) return null;
  const a = {};
  (att ?? '').split(',').forEach((v, i) => { if (v !== '' && ATT_KEYS[+v]) a[ATT_SLOTS[i]] = ATT_KEYS[+v]; });
  return { id, att: a, tier: +tier || 1 };
}
