// DMCHEAP shared game data. Imported by both the Node server and the browser client,
// so everything here must be plain data + pure functions (no Node/DOM APIs).
//
// Lore: C.H.E.A.P. = "Combat Hardware for Exclusion Area Patrol" — the bargain-bin
// autonomous defence machines a bankrupt contractor left running in the DMZ.
// Raiders go topside from "The Cheap Seats" (underground hideout), loot, and get out.

export const VERSION = 1;

export const C = {
  TICK_RATE: 20,
  RAID_DURATION: 20 * 60,          // seconds
  JOIN_WINDOW: 4 * 60,             // late joins allowed during first N seconds
  MAX_PLAYERS_PER_RAID: 12,        // 4 squads of 3
  MAX_SQUAD: 3,
  MAP_HALF: 200,                   // world spans [-200, 200] on X and Z
  PLAYER_RADIUS: 0.4,
  EYE_STAND: 1.6,
  EYE_CROUCH: 1.1,
  WALK_SPEED: 4.2,
  SPRINT_SPEED: 6.6,
  CROUCH_SPEED: 2.2,
  ADS_SPEED: 2.8,
  DOWNED_SPEED: 0.9,
  STAMINA_MAX: 100,
  STAMINA_DRAIN: 18,               // per second sprinting
  STAMINA_REGEN: 14,
  BASE_HP: 100,
  DOWNED_HP: 60,                   // damage a downed raider can absorb before dying
  BLEEDOUT: 40,                    // seconds
  REVIVE_TIME: 4,
  SEARCH_TIME: 1.2,
  EXTRACT_COUNTDOWN: 40,           // seconds after calling the lift (DMZ chopper / Arc elevator)
  EXTRACT_RADIUS: 7,
  EXTRACT_COOLDOWN: 45,
  HATCH_TIME: 5,
  INTERACT_RANGE: 2.6,
  PROX_CHAT_RANGE: 40,
  AOI_RANGE: 160,                  // network area-of-interest radius
  WANTED_KILLS: 3,                 // raider kills that make you Wanted (DMZ bounty)
  WANTED_BOUNTY: 2500,
  STASH_SLOTS: 150,
  INSURE_COOLDOWN_MIN: 15,         // minutes until a lost insured weapon returns
  START_CASH: 3000,
};

export const RARITY = {
  common:    { name: 'Common',    color: '#9aa3ad', order: 0 },
  uncommon:  { name: 'Uncommon',  color: '#4fbf62', order: 1 },
  rare:      { name: 'Rare',      color: '#3d8ff0', order: 2 },
  epic:      { name: 'Epic',      color: '#a65bf0', order: 3 },
  legendary: { name: 'Legendary', color: '#f0a43d', order: 4 },
};

// ---------------------------------------------------------------- weapons
// Grounded, DMZ-style fictional firearms. Base stats; attachments/tier/ammo/wear are applied by
// weaponStats() in shared/gunsmith.js (used by BOTH server and client so they always agree).
// dmg per pellet · rpm · mode (auto|semi|burst|pump|bolt) · mag · ammo = caliber item · spread (rad, hip)
// range (full damage) · reload (s) · noise (AI hearing radius, m) · recoil: v/h kick (rad per shot), rec (recovery rad/s)
// ads (s to aim) · sprintFire (s after sprinting before you can shoot) · head (headshot mult) · model (procedural mesh)
// slots: allowed attachments per slot — true = any, false = none, [ids] = only those
const ALL = { muzzle: true, barrel: true, optic: true, mag: true, grip: true };
export const WEAPONS = {
  peashooter: { name: 'P-17 Pistol',      cls: 'Pistol',   dmg: 19, pellets: 1, rpm: 320, mode: 'semi',  mag: 12, ammo: 'ammo_light',  spread: 0.018, range: 60,  reload: 1.4, noise: 50, recoil: { v: 0.014, h: 0.006, rec: 1.0 }, ads: 0.12, sprintFire: 0.1,  head: 1.8, model: 'pistol',
    slots: { muzzle: ['att_supp', 'att_comp'], barrel: false, optic: ['att_reddot'], mag: ['att_mag_ext', 'att_mag_fast'], grip: false } },
  revolver:   { name: 'R-44 Revolver',    cls: 'Revolver', dmg: 46, pellets: 1, rpm: 150, mode: 'semi',  mag: 6,  ammo: 'ammo_heavy',  spread: 0.012, range: 70,  reload: 2.6, noise: 75, recoil: { v: 0.05, h: 0.01, rec: 0.8 },   ads: 0.14, sprintFire: 0.12, head: 2.0, model: 'revolver',
    slots: { muzzle: false, barrel: ['att_barrel_long'], optic: ['att_reddot', 'att_holo'], mag: ['att_mag_fast'], grip: false } },
  buzz:       { name: 'MX-9 SMG',         cls: 'SMG',      dmg: 13, pellets: 1, rpm: 820, mode: 'auto',  mag: 30, ammo: 'ammo_light',  spread: 0.032, range: 45,  reload: 2.0, noise: 55, recoil: { v: 0.007, h: 0.007, rec: 1.3 }, ads: 0.16, sprintFire: 0.12, head: 1.6, model: 'smg',
    slots: { ...ALL, optic: ['att_reddot', 'att_holo', 'att_3x'] } },
  doorknock:  { name: 'M8 Pump Shotgun',  cls: 'Shotgun',  dmg: 11, pellets: 8, rpm: 75,  mode: 'pump',  mag: 6,  ammo: 'ammo_shell',  spread: 0.085, range: 22,  reload: 3.0, noise: 70, recoil: { v: 0.065, h: 0.015, rec: 0.9 }, ads: 0.2,  sprintFire: 0.15, head: 1.3, model: 'shotgun',
    slots: { muzzle: ['att_comp', 'att_brake', 'att_supp'], barrel: true, optic: ['att_reddot', 'att_holo'], mag: ['att_mag_ext'], grip: true } },
  ranger:     { name: 'RG-4 Carbine',     cls: 'Rifle',    dmg: 21, pellets: 1, rpm: 600, mode: 'auto',  mag: 30, ammo: 'ammo_medium', spread: 0.02,  range: 90,  reload: 2.2, noise: 70, recoil: { v: 0.010, h: 0.007, rec: 1.0 }, ads: 0.2,  sprintFire: 0.18, head: 1.8, model: 'carbine', slots: ALL },
  br7:        { name: 'BR-7 Burst Rifle', cls: 'Rifle',    dmg: 24, pellets: 1, rpm: 900, mode: 'burst', burst: 3, burstDelay: 0.32, mag: 30, ammo: 'ammo_medium', spread: 0.017, range: 100, reload: 2.3, noise: 70, recoil: { v: 0.011, h: 0.005, rec: 1.2 }, ads: 0.22, sprintFire: 0.2, head: 1.8, model: 'burst', slots: ALL },
  k47:        { name: 'K-47 Rifle',       cls: 'Rifle',    dmg: 29, pellets: 1, rpm: 560, mode: 'auto',  mag: 30, ammo: 'ammo_heavy',  spread: 0.024, range: 85,  reload: 2.5, noise: 80, recoil: { v: 0.015, h: 0.011, rec: 0.9 }, ads: 0.24, sprintFire: 0.22, head: 1.8, model: 'k47', slots: ALL },
  longshot:   { name: 'LS-14 DMR',        cls: 'Marksman', dmg: 56, pellets: 1, rpm: 110, mode: 'semi',  mag: 10, ammo: 'ammo_heavy',  spread: 0.004, range: 170, reload: 2.6, noise: 90, recoil: { v: 0.035, h: 0.008, rec: 0.9 }, ads: 0.28, sprintFire: 0.25, head: 2.0, model: 'dmr', slots: ALL },
  mk2:        { name: 'MK-2 Bolt Sniper', cls: 'Sniper',   dmg: 95, pellets: 1, rpm: 45,  mode: 'bolt',  mag: 5,  ammo: 'ammo_heavy',  spread: 0.002, range: 220, reload: 3.0, noise: 95, recoil: { v: 0.075, h: 0.01, rec: 0.7 },  ads: 0.35, sprintFire: 0.3,  head: 2.4, model: 'sniper',
    slots: { muzzle: ['att_supp', 'att_supp_heavy', 'att_brake'], barrel: ['att_barrel_long'], optic: ['att_3x', 'att_6x'], mag: ['att_mag_ext'], grip: ['att_stock'] } },
  hauler:     { name: 'HL-60 LMG',        cls: 'LMG',      dmg: 22, pellets: 1, rpm: 640, mode: 'auto',  mag: 80, ammo: 'ammo_medium', spread: 0.034, range: 90,  reload: 4.5, noise: 80, recoil: { v: 0.012, h: 0.010, rec: 0.8 }, ads: 0.35, sprintFire: 0.35, head: 1.6, move: 0.93, model: 'lmg',
    slots: { ...ALL, mag: ['att_mag_fast'] } },
  gilded:     { name: "RG-4 'Gilded'",    cls: 'Rifle',    dmg: 27, pellets: 1, rpm: 660, mode: 'auto',  mag: 40, ammo: 'ammo_medium', spread: 0.015, range: 110, reload: 2.0, noise: 65, recoil: { v: 0.008, h: 0.006, rec: 1.2 }, ads: 0.18, sprintFire: 0.15, head: 1.8, model: 'carbine', gold: true, slots: ALL },
};
for (const w of Object.values(WEAPONS)) w.auto = w.mode === 'auto';

// ---------------------------------------------------------------- attachments (5-slot gunsmith)
// mods multiply base stats: dmg, range, noise, ads, reload, recoilV, recoilH, recover, hip (hip spread),
// adsSpread, moveSpread, move (walk speed), mag (capacity). zoom = optic magnification.
export const ATT_SLOTS = ['muzzle', 'barrel', 'optic', 'mag', 'grip'];
export const ATT_SLOT_NAMES = { muzzle: 'Muzzle', barrel: 'Barrel', optic: 'Optic', mag: 'Magazine', grip: 'Grip / Stock' };
export const ATTACHMENTS = {
  att_comp:         { slot: 'muzzle', name: 'Compensator',      rarity: 'uncommon', value: 500,  mods: { recoilH: 0.75, recoilV: 0.92, noise: 1.1 } },
  att_brake:        { slot: 'muzzle', name: 'Muzzle Brake',     rarity: 'uncommon', value: 550,  mods: { recoilV: 0.8, ads: 1.05 } },
  att_supp:         { slot: 'muzzle', name: 'Suppressor',       rarity: 'rare',     value: 1400, mods: { noise: 0.35, range: 0.9, ads: 1.05 }, suppress: true },
  att_supp_heavy:   { slot: 'muzzle', name: 'Heavy Suppressor', rarity: 'epic',     value: 3200, mods: { noise: 0.25, range: 1.05, ads: 1.12, recoilV: 0.92 }, suppress: true },
  att_barrel_long:  { slot: 'barrel', name: 'Long Barrel',      rarity: 'rare',     value: 1200, mods: { range: 1.25, dmg: 1.05, ads: 1.1, hip: 1.1 } },
  att_barrel_short: { slot: 'barrel', name: 'Short Barrel',     rarity: 'uncommon', value: 700,  mods: { range: 0.85, ads: 0.85, hip: 0.88 } },
  att_reddot:       { slot: 'optic',  name: 'Red Dot',          rarity: 'common',   value: 350,  mods: { adsSpread: 0.85 }, zoom: 1.3 },
  att_holo:         { slot: 'optic',  name: 'Holo Sight',       rarity: 'uncommon', value: 650,  mods: { adsSpread: 0.8, ads: 1.03 }, zoom: 1.5 },
  att_3x:           { slot: 'optic',  name: '3x Scope',         rarity: 'rare',     value: 1300, mods: { adsSpread: 0.75, ads: 1.15 }, zoom: 3 },
  att_6x:           { slot: 'optic',  name: '6x Scope',         rarity: 'epic',     value: 2600, mods: { adsSpread: 0.7, ads: 1.25 }, zoom: 6 },
  att_mag_ext:      { slot: 'mag',    name: 'Extended Mag',     rarity: 'uncommon', value: 600,  mods: { mag: 1.5, reload: 1.1 } },
  att_mag_drum:     { slot: 'mag',    name: 'Drum Mag',         rarity: 'epic',     value: 2200, mods: { mag: 2.2, reload: 1.35, ads: 1.1, move: 0.96 } },
  att_mag_fast:     { slot: 'mag',    name: 'Fast Mag',         rarity: 'rare',     value: 900,  mods: { reload: 0.75 } },
  att_vgrip:        { slot: 'grip',   name: 'Vertical Grip',    rarity: 'uncommon', value: 500,  mods: { recoilV: 0.85, recoilH: 0.9 } },
  att_agrip:        { slot: 'grip',   name: 'Angled Grip',      rarity: 'uncommon', value: 550,  mods: { ads: 0.85 } },
  att_stock:        { slot: 'grip',   name: 'Tactical Stock',   rarity: 'rare',     value: 1100, mods: { recover: 1.3, moveSpread: 0.8 } },
};

// ---------------------------------------------------------------- ammo types
// absorb: multiplier on how much a shield soaks (AP punches through, HP splashes on it); machine: vs CHEAP machines.
export const AMMO_TYPES = {
  fmj: { name: 'FMJ', suffix: '',    dmg: 1,    absorb: 1,   machine: 1 },
  ap:  { name: 'AP',  suffix: '_ap', dmg: 0.95, absorb: 0.5, machine: 1.25, pen: true },
  hp:  { name: 'HP',  suffix: '_hp', dmg: 1.2,  absorb: 1.4, machine: 0.85 },
};
export const AMMO_ORDER = ['fmj', 'ap', 'hp'];
export const HEADSHOT_MULT = 1.8;
export const ADS_SPREAD_MULT = 0.35;
export const MOVE_SPREAD_MULT = 1.6;

// ---------------------------------------------------------------- items
// type: weapon | ammo | med | shield | rig | grenade | material | valuable | key | quest
// recycle: what the Workbench breaks it into (Arc Raiders style recycling)
export const ITEMS = {
  // weapons
  peashooter: { name: 'P-17 Pistol',      type: 'weapon', rarity: 'common',    value: 400,   stack: 1, recycle: { scrap: 3 } },
  revolver:   { name: 'R-44 Revolver',    type: 'weapon', rarity: 'uncommon',  value: 1300,  stack: 1, recycle: { scrap: 6, alloy: 1 } },
  buzz:       { name: 'MX-9 SMG',         type: 'weapon', rarity: 'uncommon',  value: 1400,  stack: 1, recycle: { scrap: 8, wires: 2 } },
  doorknock:  { name: 'M8 Pump Shotgun',  type: 'weapon', rarity: 'uncommon',  value: 1600,  stack: 1, recycle: { scrap: 8, alloy: 1 } },
  ranger:     { name: 'RG-4 Carbine',     type: 'weapon', rarity: 'rare',      value: 3200,  stack: 1, recycle: { scrap: 10, alloy: 2, circuits: 2 } },
  br7:        { name: 'BR-7 Burst Rifle', type: 'weapon', rarity: 'rare',      value: 3600,  stack: 1, recycle: { scrap: 10, alloy: 3, circuits: 2 } },
  k47:        { name: 'K-47 Rifle',       type: 'weapon', rarity: 'rare',      value: 3900,  stack: 1, recycle: { scrap: 12, alloy: 3, circuits: 1 } },
  longshot:   { name: 'LS-14 DMR',        type: 'weapon', rarity: 'epic',      value: 5600,  stack: 1, recycle: { alloy: 4, circuits: 3 } },
  mk2:        { name: 'MK-2 Bolt Sniper', type: 'weapon', rarity: 'epic',      value: 6800,  stack: 1, recycle: { alloy: 5, circuits: 3, cheap_core: 1 } },
  hauler:     { name: 'HL-60 LMG',        type: 'weapon', rarity: 'epic',      value: 6200,  stack: 1, recycle: { alloy: 5, circuits: 3 } },
  gilded:     { name: "RG-4 'Gilded'",    type: 'weapon', rarity: 'legendary', value: 16000, stack: 1, recycle: { alloy: 8, cheap_core: 2 } },

  // ammo
  ammo_light:  { name: 'Light Ammo',  type: 'ammo', rarity: 'common',   value: 4,  stack: 150 },
  ammo_medium: { name: 'Medium Ammo', type: 'ammo', rarity: 'common',   value: 7,  stack: 150 },
  ammo_heavy:  { name: 'Heavy Ammo',  type: 'ammo', rarity: 'uncommon', value: 18, stack: 40 },
  ammo_shell:  { name: 'Shells',      type: 'ammo', rarity: 'common',   value: 12, stack: 40 },

  // consumables
  bandage:      { name: 'Bandage',      type: 'med', rarity: 'common',   value: 90,  stack: 5, use: 2.5, heal: 30 },
  medkit:       { name: 'Med Kit',      type: 'med', rarity: 'rare',     value: 420, stack: 3, use: 5,   heal: 80 },
  shield_cell:  { name: 'Shield Cell',  type: 'med', rarity: 'uncommon', value: 150, stack: 5, use: 3,   recharge: 40 },
  tourniquet:   { name: 'Tourniquet',   type: 'med', rarity: 'rare',     value: 900, stack: 1, selfRevive: true, desc: 'Get yourself up once when downed.' },
  frag:         { name: 'Frag Grenade', type: 'grenade', rarity: 'uncommon', value: 260, stack: 3, dmg: 95, radius: 6 },
  lure:         { name: 'Lure Beacon',  type: 'grenade', rarity: 'uncommon', value: 220, stack: 3, lure: 9, desc: 'Screams for 9s. CHEAP machines investigate.' },

  // shields (Arc Raiders shield model: absorb a % of damage while charged)
  shield_light:  { name: 'Light Shield',  type: 'shield', rarity: 'common',   value: 500,  stack: 1, cap: 40,  absorb: 0.4, speed: 1.0 },
  shield_medium: { name: 'Medium Shield', type: 'shield', rarity: 'rare',     value: 1900, stack: 1, cap: 70,  absorb: 0.5, speed: 0.97 },
  shield_heavy:  { name: 'Heavy Shield',  type: 'shield', rarity: 'epic',     value: 4600, stack: 1, cap: 100, absorb: 0.6, speed: 0.92 },

  // rigs (Arc augment / DMZ backpack): pack slots + safe pockets
  rig_free:     { name: 'Cheap Rig',     type: 'rig', rarity: 'common',   value: 0,    stack: 1, slots: 10, safe: 0, speed: 1.0,  desc: 'Free kit rig. No safe pocket.' },
  rig_scav:     { name: 'Scav Rig',      type: 'rig', rarity: 'uncommon', value: 900,  stack: 1, slots: 14, safe: 1, speed: 1.0 },
  rig_runner:   { name: 'Runner Rig',    type: 'rig', rarity: 'rare',     value: 2200, stack: 1, slots: 12, safe: 1, speed: 1.06 },
  rig_hauler:   { name: 'Hauler Rig',    type: 'rig', rarity: 'rare',     value: 2600, stack: 1, slots: 22, safe: 1, speed: 0.95 },
  rig_smuggler: { name: 'Smuggler Rig',  type: 'rig', rarity: 'epic',     value: 5200, stack: 1, slots: 16, safe: 3, speed: 1.0 },

  // crafting materials
  scrap:      { name: 'Scrap Metal',  type: 'material', rarity: 'common',    value: 12,   stack: 100 },
  wires:      { name: 'Wires',        type: 'material', rarity: 'common',    value: 25,   stack: 60 },
  chem:       { name: 'Chemicals',    type: 'material', rarity: 'uncommon',  value: 45,   stack: 40 },
  circuits:   { name: 'Circuit Board',type: 'material', rarity: 'uncommon',  value: 70,   stack: 40 },
  alloy:      { name: 'CHEAP Alloy',  type: 'material', rarity: 'rare',      value: 140,  stack: 30 },
  cheap_core: { name: 'CHEAP Core',   type: 'material', rarity: 'epic',      value: 650,  stack: 10, desc: 'Power core pulled from a machine.' },

  // valuables (sell or recycle)
  cassette:     { name: 'Mixtape',        type: 'valuable', rarity: 'common',    value: 70,   stack: 10, recycle: { scrap: 1 } },
  old_phone:    { name: 'Cracked Phone',  type: 'valuable', rarity: 'uncommon',  value: 260,  stack: 5,  recycle: { circuits: 2, wires: 1 } },
  toaster:      { name: 'Smart Toaster',  type: 'valuable', rarity: 'uncommon',  value: 300,  stack: 3,  recycle: { wires: 4, scrap: 4 } },
  gold_watch:   { name: 'Gold Watch',     type: 'valuable', rarity: 'rare',      value: 950,  stack: 5 },
  data_drive:   { name: 'Data Drive',     type: 'valuable', rarity: 'rare',      value: 1200, stack: 5,  recycle: { circuits: 6 } },
  gold_bar:     { name: 'Gold Bar',       type: 'valuable', rarity: 'epic',      value: 3200, stack: 5 },
  warden_heart: { name: "Warden's Heart", type: 'valuable', rarity: 'legendary', value: 9000, stack: 1,  recycle: { cheap_core: 4, alloy: 10 } },

  // keys (single use)
  key_depot:   { name: 'Depot Vault Key',   type: 'key', rarity: 'rare',     value: 700, stack: 1, opens: 'depot_vault' },
  key_mall:    { name: 'Mall Vault Key',    type: 'key', rarity: 'rare',     value: 900, stack: 1, opens: 'mall_vault' },
  key_reactor: { name: 'Reactor Vault Key', type: 'key', rarity: 'epic',     value: 1500, stack: 1, opens: 'reactor_vault' },
  hatch_key:   { name: 'Hatch Key',         type: 'key', rarity: 'uncommon', value: 800, stack: 1, desc: 'Opens a raider hatch for a quiet solo extraction.' },
};

// attachments and AP/HP ammo variants are generated from their tables
for (const [id, a] of Object.entries(ATTACHMENTS)) {
  ITEMS[id] = { name: a.name, type: 'attachment', slot: a.slot, rarity: a.rarity, value: a.value, stack: 1, recycle: { scrap: 2, ...(a.value >= 1000 ? { alloy: 1 } : { wires: 1 }) } };
}
for (const base of ['ammo_light', 'ammo_medium', 'ammo_heavy', 'ammo_shell']) {
  const b = ITEMS[base];
  for (const t of ['ap', 'hp']) {
    ITEMS[base + AMMO_TYPES[t].suffix] = { name: `${b.name} (${AMMO_TYPES[t].name})`, type: 'ammo', rarity: t === 'ap' ? 'rare' : 'uncommon', value: Math.round(b.value * (t === 'ap' ? 2.2 : 1.6)), stack: b.stack, caliber: base, ammoType: t };
  }
  b.caliber = base; b.ammoType = 'fmj';
}

export function itemName(id) { return ITEMS[id]?.name ?? id; }
export function stackSize(id) { return ITEMS[id]?.stack ?? 1; }

// ---------------------------------------------------------------- enemies
// CHEAP machines (Arc Raiders ARC) + Rustline mercs (DMZ AI faction)
export const ENEMIES = {
  gnat:     { name: 'Gnat',     hp: 40,   fly: 6.0, speed: 7.5, dmg: 4,  rpm: 150, range: 28, sight: 38, radius: 0.5,  xp: 20,  drops: { scrap: [1, 3], wires: [0, 2] } },
  squealer: { name: 'Squealer', hp: 55,   fly: 7.0, speed: 4.5, dmg: 0,  rpm: 0,   range: 0,  sight: 45, radius: 0.6,  xp: 35,  drops: { circuits: [1, 2], wires: [1, 2] }, alarm: true },
  tick:     { name: 'Tick',     hp: 35,   fly: 0,   speed: 8.5, dmg: 45, rpm: 0,   range: 2,  sight: 30, radius: 0.55, xp: 25,  drops: { scrap: [1, 2], chem: [0, 1] }, explode: 4 },
  sentry:   { name: 'Sentry',   hp: 240,  fly: 0,   speed: 0,   dmg: 8,  rpm: 200, range: 55, sight: 60, radius: 0.9,  xp: 90,  drops: { circuits: [1, 3], alloy: [1, 2], cheap_core: [0, 1] }, frontArmor: 0.5 },
  merc:     { name: 'Rustline Merc', hp: 110, fly: 0, speed: 4.2, dmg: 10, rpm: 260, range: 50, sight: 46, radius: 0.45, xp: 55, drops: {}, human: true },
  warden:   { name: 'The Warden', hp: 2600, fly: 0,  speed: 2.6, dmg: 14, rpm: 320, range: 75, sight: 75, radius: 2.4,  xp: 1200, drops: { warden_heart: [1, 1], cheap_core: [2, 4], alloy: [4, 8] }, boss: true, weakpoint: 2.2 },
};

// ---------------------------------------------------------------- loot tables
// Weighted rolls. Threat level (1-5) of the POI shifts rarity up.
export const LOOT_TABLES = {
  crate:      [['scrap', 30, [2, 6]], ['wires', 18, [1, 4]], ['cassette', 14, [1, 2]], ['ammo_light', 12, [15, 40]], ['ammo_medium', 10, [15, 40]], ['bandage', 10, [1, 2]], ['old_phone', 8, [1, 1]], ['toaster', 5, [1, 1]], ['chem', 8, [1, 2]], ['hatch_key', 1.2, [1, 1]]],
  toolbox:    [['scrap', 30, [4, 10]], ['wires', 22, [2, 6]], ['circuits', 14, [1, 3]], ['chem', 12, [1, 3]], ['alloy', 5, [1, 2]], ['toaster', 4, [1, 1]]],
  medbox:     [['bandage', 40, [1, 3]], ['shield_cell', 30, [1, 2]], ['chem', 14, [1, 3]], ['medkit', 8, [1, 1]], ['tourniquet', 2.5, [1, 1]]],
  weaponcase: [['peashooter', 14, [1, 1]], ['buzz', 12, [1, 1]], ['doorknock', 10, [1, 1]], ['ranger', 6, [1, 1]], ['longshot', 1.5, [1, 1]], ['hauler', 1.5, [1, 1]], ['ammo_light', 18, [20, 60]], ['ammo_medium', 18, [20, 60]], ['ammo_shell', 10, [6, 16]], ['ammo_heavy', 6, [5, 15]], ['frag', 10, [1, 2]], ['lure', 5, [1, 1]], ['shield_light', 6, [1, 1]], ['shield_medium', 2, [1, 1]], ['rig_scav', 4, [1, 1]], ['revolver', 6, [1, 1]], ['br7', 3, [1, 1]], ['k47', 3, [1, 1]], ['mk2', 1, [1, 1]],
    ['att_reddot', 8, [1, 1]], ['att_comp', 5, [1, 1]], ['att_vgrip', 5, [1, 1]], ['att_mag_ext', 5, [1, 1]], ['att_holo', 4, [1, 1]], ['att_brake', 4, [1, 1]], ['att_agrip', 4, [1, 1]], ['att_barrel_short', 3, [1, 1]],
    ['att_supp', 2, [1, 1]], ['att_3x', 2, [1, 1]], ['att_stock', 2, [1, 1]], ['att_mag_fast', 2, [1, 1]], ['att_barrel_long', 2, [1, 1]],
    ['ammo_medium_ap', 4, [10, 30]], ['ammo_light_hp', 4, [15, 40]], ['ammo_heavy_ap', 2, [5, 12]], ['ammo_shell_hp', 3, [6, 12]]],
  safe:       [['gold_watch', 22, [1, 2]], ['gold_bar', 8, [1, 1]], ['data_drive', 16, [1, 2]], ['old_phone', 20, [1, 2]], ['cheap_core', 6, [1, 1]], ['key_depot', 3, [1, 1]], ['key_mall', 3, [1, 1]], ['key_reactor', 1.5, [1, 1]], ['hatch_key', 4, [1, 1]], ['rig_runner', 2, [1, 1]], ['shield_heavy', 1, [1, 1]], ['rig_smuggler', 0.7, [1, 1]], ['att_supp', 3, [1, 1]], ['att_6x', 1, [1, 1]], ['att_mag_drum', 1, [1, 1]], ['att_supp_heavy', 0.7, [1, 1]]],
  cache:      [['alloy', 18, [1, 3]], ['circuits', 20, [2, 4]], ['gold_watch', 10, [1, 1]], ['medkit', 10, [1, 1]], ['ammo_heavy', 10, [5, 12]], ['frag', 12, [1, 2]], ['key_depot', 4, [1, 1]], ['key_mall', 4, [1, 1]], ['hatch_key', 6, [1, 1]], ['shield_medium', 4, [1, 1]], ['rig_hauler', 2, [1, 1]], ['att_3x', 4, [1, 1]], ['att_supp', 3, [1, 1]], ['att_mag_fast', 3, [1, 1]], ['ammo_heavy_ap', 6, [5, 12]], ['ammo_medium_ap', 6, [10, 30]], ['k47', 2, [1, 1]], ['mk2', 1, [1, 1]]],
  merc:       [['ammo_medium', 30, [10, 30]], ['ammo_light', 20, [10, 30]], ['bandage', 20, [1, 2]], ['ranger', 4, [1, 1]], ['buzz', 7, [1, 1]], ['doorknock', 5, [1, 1]], ['frag', 8, [1, 1]], ['shield_cell', 10, [1, 1]], ['gold_watch', 3, [1, 1]], ['key_depot', 1.5, [1, 1]], ['hatch_key', 1.5, [1, 1]], ['k47', 4, [1, 1]], ['br7', 2, [1, 1]], ['att_reddot', 4, [1, 1]], ['att_vgrip', 3, [1, 1]], ['att_comp', 3, [1, 1]], ['ammo_medium_hp', 5, [10, 25]]],
};

// Number of rolls per container, by type
export const CONTAINER_ROLLS = { crate: [1, 3], toolbox: [2, 3], medbox: [1, 3], weaponcase: [2, 3], safe: [2, 4], cache: [2, 4], merc: [1, 3] };

// ---------------------------------------------------------------- workbench recipes
export const RECIPES = [
  { out: 'ammo_light',  qty: 40, lvl: 1, cost: { scrap: 4 } },
  { out: 'ammo_medium', qty: 40, lvl: 1, cost: { scrap: 6, chem: 1 } },
  { out: 'ammo_shell',  qty: 12, lvl: 1, cost: { scrap: 4, chem: 1 } },
  { out: 'ammo_heavy',  qty: 10, lvl: 2, cost: { scrap: 4, chem: 2 } },
  { out: 'bandage',     qty: 2,  lvl: 1, cost: { chem: 1, scrap: 1 } },
  { out: 'shield_cell', qty: 1,  lvl: 1, cost: { circuits: 1, chem: 1 } },
  { out: 'frag',        qty: 1,  lvl: 1, cost: { scrap: 3, chem: 2 } },
  { out: 'lure',        qty: 1,  lvl: 1, cost: { wires: 2, circuits: 1 } },
  { out: 'buzz',        qty: 1,  lvl: 1, cost: { scrap: 20, wires: 6, circuits: 2 } },
  { out: 'doorknock',   qty: 1,  lvl: 1, cost: { scrap: 18, alloy: 2 } },
  { out: 'rig_scav',    qty: 1,  lvl: 1, cost: { scrap: 10, wires: 4 } },
  { out: 'medkit',      qty: 1,  lvl: 2, cost: { chem: 3, circuits: 1 } },
  { out: 'tourniquet',  qty: 1,  lvl: 2, cost: { chem: 4, circuits: 1 } },
  { out: 'hatch_key',   qty: 1,  lvl: 2, cost: { wires: 4, circuits: 2, alloy: 1 } },
  { out: 'ranger',      qty: 1,  lvl: 2, cost: { scrap: 25, alloy: 4, circuits: 4 } },
  { out: 'shield_medium', qty: 1, lvl: 2, cost: { alloy: 3, circuits: 3 } },
  { out: 'rig_runner',  qty: 1,  lvl: 2, cost: { wires: 8, circuits: 2, alloy: 1 } },
  { out: 'rig_hauler',  qty: 1,  lvl: 2, cost: { scrap: 20, alloy: 4 } },
  { out: 'longshot',    qty: 1,  lvl: 3, cost: { alloy: 8, circuits: 6, cheap_core: 1 } },
  { out: 'hauler',      qty: 1,  lvl: 3, cost: { alloy: 10, circuits: 6, cheap_core: 2 } },
  { out: 'shield_heavy', qty: 1, lvl: 3, cost: { alloy: 6, circuits: 5, cheap_core: 1 } },
  { out: 'rig_smuggler', qty: 1, lvl: 3, cost: { alloy: 5, circuits: 4, cheap_core: 1 } },
  // guns
  { out: 'revolver',    qty: 1, lvl: 1, cost: { scrap: 16, alloy: 1 } },
  { out: 'br7',         qty: 1, lvl: 2, cost: { scrap: 25, alloy: 5, circuits: 4 } },
  { out: 'k47',         qty: 1, lvl: 2, cost: { scrap: 30, alloy: 5, circuits: 2 } },
  { out: 'mk2',         qty: 1, lvl: 3, cost: { alloy: 10, circuits: 5, cheap_core: 1 } },
  // ammo variants
  { out: 'ammo_light_ap',  qty: 30, lvl: 2, cost: { scrap: 4, alloy: 1 } },
  { out: 'ammo_light_hp',  qty: 30, lvl: 1, cost: { scrap: 4, chem: 1 } },
  { out: 'ammo_medium_ap', qty: 30, lvl: 2, cost: { scrap: 6, alloy: 1 } },
  { out: 'ammo_medium_hp', qty: 30, lvl: 1, cost: { scrap: 6, chem: 2 } },
  { out: 'ammo_heavy_ap',  qty: 10, lvl: 2, cost: { scrap: 4, alloy: 1, chem: 1 } },
  { out: 'ammo_heavy_hp',  qty: 10, lvl: 2, cost: { scrap: 4, chem: 3 } },
  { out: 'ammo_shell_ap',  qty: 10, lvl: 2, cost: { scrap: 5, alloy: 1 } },
  { out: 'ammo_shell_hp',  qty: 10, lvl: 1, cost: { scrap: 4, chem: 2 } },
  // attachments
  { out: 'att_reddot',       qty: 1, lvl: 1, cost: { scrap: 4, wires: 2, circuits: 1 } },
  { out: 'att_comp',         qty: 1, lvl: 1, cost: { scrap: 8 } },
  { out: 'att_vgrip',        qty: 1, lvl: 1, cost: { scrap: 6 } },
  { out: 'att_mag_ext',      qty: 1, lvl: 1, cost: { scrap: 8, wires: 1 } },
  { out: 'att_brake',        qty: 1, lvl: 2, cost: { scrap: 10, alloy: 1 } },
  { out: 'att_agrip',        qty: 1, lvl: 2, cost: { scrap: 8, alloy: 1 } },
  { out: 'att_holo',         qty: 1, lvl: 2, cost: { wires: 4, circuits: 2 } },
  { out: 'att_barrel_short', qty: 1, lvl: 2, cost: { scrap: 10, alloy: 1 } },
  { out: 'att_barrel_long',  qty: 1, lvl: 2, cost: { scrap: 12, alloy: 2 } },
  { out: 'att_supp',         qty: 1, lvl: 2, cost: { scrap: 10, alloy: 3, chem: 1 } },
  { out: 'att_3x',           qty: 1, lvl: 2, cost: { wires: 4, circuits: 3, alloy: 1 } },
  { out: 'att_stock',        qty: 1, lvl: 2, cost: { scrap: 12, alloy: 2 } },
  { out: 'att_mag_fast',     qty: 1, lvl: 2, cost: { scrap: 10, wires: 3, alloy: 1 } },
  { out: 'att_6x',           qty: 1, lvl: 3, cost: { circuits: 5, alloy: 3, cheap_core: 1 } },
  { out: 'att_mag_drum',     qty: 1, lvl: 3, cost: { scrap: 20, alloy: 4, circuits: 2 } },
  { out: 'att_supp_heavy',   qty: 1, lvl: 3, cost: { alloy: 6, chem: 2, cheap_core: 1 } },
];

export const BENCH_UPGRADES = {
  2: { cash: 10000, cost: { scrap: 60, wires: 20, circuits: 10 } },
  3: { cash: 40000, cost: { alloy: 20, circuits: 30, cheap_core: 3 } },
};

// ---------------------------------------------------------------- trader (Penny, the Quartermaster)
export const TRADER_STOCK = [
  'peashooter', 'revolver', 'buzz', 'doorknock', 'ammo_light', 'ammo_medium', 'ammo_shell', 'ammo_heavy',
  'ammo_light_hp', 'ammo_medium_hp', 'att_reddot', 'att_comp', 'att_vgrip', 'att_mag_ext',
  'bandage', 'shield_cell', 'frag', 'shield_light', 'rig_scav', 'scrap', 'chem',
];
export const BUY_MARKUP = 1.6;
export function buyPrice(id) { return Math.ceil((ITEMS[id]?.value ?? 0) * BUY_MARKUP); }
export function sellPrice(id) { return Math.floor(ITEMS[id]?.value ?? 0); }

// ---------------------------------------------------------------- skills (Arc's three trees)
export const SKILLS = {
  survival: [
    { id: 'quiet_feet', name: 'Quiet Feet', max: 3, desc: 'Sprint noise -25% per rank' },
    { id: 'scavenger',  name: 'Scavenger',  max: 3, desc: 'Search time -20% per rank' },
    { id: 'pack_mule',  name: 'Pack Mule',  max: 3, desc: '+1 backpack slot per rank' },
  ],
  mobility: [
    { id: 'marathon',    name: 'Marathon',    max: 3, desc: '+20% stamina per rank' },
    { id: 'fleet',       name: 'Fleet Foot',  max: 3, desc: '+3% move speed per rank' },
    { id: 'quick_hands', name: 'Quick Hands', max: 3, desc: 'Reload & item use -8% per rank' },
  ],
  conditioning: [
    { id: 'tough',      name: 'Tough',      max: 3, desc: '+10 max health per rank' },
    { id: 'medic',      name: 'Field Medic',max: 3, desc: 'Healing +15% per rank' },
    { id: 'shield_tech',name: 'Shield Tech',max: 3, desc: 'Shield capacity +10% per rank' },
  ],
};
export function skillRank(profile, id) { return profile?.skills?.[id] ?? 0; }
export function xpToNext(level) { return 800 + level * 400; }

// ---------------------------------------------------------------- POIs & contracts
export const POIS = [
  { id: 'suburbs',   name: 'Suburbs',       x: -125, z: 120,  r: 38, threat: 1 },
  { id: 'relay',     name: 'Relay Station', x: 120,  z: 125,  r: 32, threat: 2 },
  { id: 'depot',     name: 'Depot',         x: -130, z: -105, r: 36, threat: 2, vault: 'depot_vault' },
  { id: 'mall',      name: 'Old Mall',      x: 0,    z: 35,   r: 40, threat: 3, vault: 'mall_vault' },
  { id: 'checkpoint',name: 'Checkpoint',    x: 135,  z: -15,  r: 30, threat: 3 },
  { id: 'reactor',   name: 'Reactor Yard',  x: 105,  z: -125, r: 36, threat: 4, vault: 'reactor_vault' },
  { id: 'foundry',   name: 'The Foundry',   x: -20,  z: -120, r: 34, threat: 5, boss: 'warden' },
];

export const CONTRACT_GIVERS = ['Penny (Quartermaster)', 'Doc Ruiz (Clinic)', 'Ox (Workbench)'];

// ---------------------------------------------------------------- helpers
export function newUid() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

export function makeStack(id, qty = 1) {
  const s = { id, qty };
  const it = ITEMS[id];
  if (!it) return s;
  if (it.type === 'weapon') { s.uid = newUid(); s.mag = WEAPONS[id].mag; s.qty = 1; s.att = {}; s.tier = 1; s.dur = 100; s.ammoType = 'fmj'; }
  if (it.type === 'shield') { s.charge = it.cap; s.qty = 1; }
  if (it.type === 'rig') s.qty = 1;
  return s;
}

// Add a stack into an array of stacks respecting stack sizes. Returns leftover qty (0 if all fit).
// maxSlots limits how many stack entries the array may hold.
export function addToStacks(arr, stack, maxSlots = Infinity) {
  const max = stackSize(stack.id);
  let qty = stack.qty;
  if (max > 1) {
    for (const s of arr) {
      if (s.id === stack.id && s.qty < max) {
        const take = Math.min(max - s.qty, qty);
        s.qty += take; qty -= take;
        if (qty <= 0) return 0;
      }
    }
  }
  while (qty > 0 && arr.length < maxSlots) {
    const take = Math.min(max, qty);
    arr.push({ ...stack, qty: take });
    qty -= take;
  }
  return qty;
}

export function countItem(arr, id) {
  let n = 0;
  for (const s of arr) if (s.id === id) n += s.qty;
  return n;
}

// Remove qty of an item id across stacks. Returns true if enough existed (and removes it).
export function removeItem(arr, id, qty) {
  if (countItem(arr, id) < qty) return false;
  for (let i = arr.length - 1; i >= 0 && qty > 0; i--) {
    if (arr[i].id !== id) continue;
    const take = Math.min(arr[i].qty, qty);
    arr[i].qty -= take; qty -= take;
    if (arr[i].qty <= 0) arr.splice(i, 1);
  }
  return true;
}
