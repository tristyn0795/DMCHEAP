// "The Cheap Seats" — the walkable underground hub. Shared by server (collision) and client (render).
import { buildWorld, KIND } from './world.js';

export const HUB = {
  CAP: 24,            // players per hub instance (Destiny's Tower holds ~26)
  TICK: 10,           // hub snapshot rate (Hz) — no combat, so this is plenty
  HALF_X: 22, HALF_Z: 16, HEIGHT: 7,
  LIFT: { x: 0, z: -11.5, r: 3.2 },
  SPAWN: { x: 0, z: 3, r: 4 },
};

// Each station opens a hideout menu tab. `x,z` is where you stand to use it.
export const KIOSKS = [
  { id: 'stash',     name: 'Stash & Loadout',  tab: 'loadout',   x: -17, z: -7, face: 1,  color: 0xd9822b },
  { id: 'gunsmith',  name: 'Gunsmith Bench',    tab: 'gunsmith',  x: -17, z: -1, face: 1,  color: 0xc8ced6 },
  { id: 'trader',    name: "Penny's Counter",   tab: 'trader',    x: -17, z: 5,  face: 1,  color: 0xffc24b },
  { id: 'workbench', name: "Ox's Workbench",    tab: 'workbench', x: 17,  z: 5,  face: -1, color: 0x59b8ff },
  { id: 'contracts', name: 'Contract Board',    tab: 'contracts', x: 17,  z: -7, face: -1, color: 0x5fd17a },
  { id: 'skills',    name: "Doc Ruiz's Clinic", tab: 'skills',    x: 0,   z: 12, face: 0,  color: 0xff6a6a },
  { id: 'record',    name: 'Hall of Records',   tab: 'record',    x: -8,  z: 12, face: 0,  color: 0xa65bf0 },
  { id: 'squad',     name: 'Squad Terminal',    tab: 'squad',     x: 8,   z: 12, face: 0,  color: 0x9fe0ff },
];

export const EMOTES = ['wave', 'cheer', 'point', 'dance', 'sit'];

let cached = null;
export function generateHub() {
  if (cached) return cached;
  const boxes = [];
  const add = (x0, y0, z0, x1, y1, z1, k) => boxes.push({ x0: Math.min(x0, x1), y0, z0: Math.min(z0, z1), x1: Math.max(x0, x1), y1, z1: Math.max(z0, z1), k });
  const { HALF_X: X, HALF_Z: Z, HEIGHT: H } = HUB;
  // shell
  add(-X - 1, 0, -Z - 1, X + 1, H, -Z, KIND.perimeter);
  add(-X - 1, 0, Z, X + 1, H, Z + 1, KIND.perimeter);
  add(-X - 1, 0, -Z, -X, H, Z, KIND.perimeter);
  add(X, 0, -Z, X + 1, H, Z, KIND.perimeter);
  add(-X - 1, H, -Z - 1, X + 1, H + 0.5, Z + 1, KIND.roof);
  // pillars
  for (const x of [-9, 9]) for (const z of [-6, 4]) add(x - 0.6, 0, z - 0.6, x + 0.6, H, z + 0.6, KIND.concrete);
  // kiosk counters (behind where you stand)
  for (const k of KIOSKS) {
    if (k.face === 1) add(k.x - 2.2, 0, k.z - 1.6, k.x - 1.2, 1.1, k.z + 1.6, KIND.metal);
    else if (k.face === -1) add(k.x + 1.2, 0, k.z - 1.6, k.x + 2.2, 1.1, k.z + 1.6, KIND.metal);
    else add(k.x - 1.6, 0, k.z + 1.2, k.x + 1.6, 1.1, k.z + 2.2, KIND.metal);
  }
  // lift cage posts (open front so squads can walk in)
  const L = HUB.LIFT;
  for (const [dx, dz] of [[-3.6, -3.6], [3.6, -3.6], [-3.6, 2.2], [3.6, 2.2]]) add(L.x + dx - 0.25, 0, L.z + dz - 0.25, L.x + dx + 0.25, H, L.z + dz + 0.25, KIND.metal);
  // clutter: crates and benches
  for (const [x, z, w, d, h] of [[-12, 10, 2, 1, 1], [12, -12, 1.4, 1.4, 1.2], [-13, -12, 3, 0.8, 0.5], [13, 11, 1, 1, 0.9], [-4, 6, 3, 0.7, 0.5], [4, 6, 3, 0.7, 0.5]]) {
    add(x - w / 2, 0, z - d / 2, x + w / 2, h, z + d / 2, KIND.crate);
  }
  cached = buildWorld({ boxes, containers: [], doors: [] });
  return cached;
}

export function inLift(x, z) { return Math.hypot(x - HUB.LIFT.x, z - HUB.LIFT.z) <= HUB.LIFT.r; }
