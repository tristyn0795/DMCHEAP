// Deterministic world generation + collision/raycast shared by server and client.
// The static layout is identical every raid (seeded), so players can learn the map;
// loot, enemies and which extracts are open are rolled per raid by the server.
import { C, POIS } from './data.js';

export const MAP_SEED = 1337;
const CELL = 8;

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export const randRange = (rng, a, b) => a + rng() * (b - a);
export const randInt = (rng, a, b) => Math.floor(a + rng() * (b - a + 1));
export const pick = (rng, arr) => arr[Math.floor(rng() * arr.length)];

// Box kinds -> render palette index (client maps these to materials)
export const KIND = { wall: 0, roof: 1, rock: 2, crate: 3, car: 4, trunk: 5, canopy: 6, concrete: 7, metal: 8, door: 9, tower: 10, perimeter: 11 };

export const EXTRACT_SITES = [
  { id: 'west_lift',  name: 'West Lift',     x: -178, z: 10 },
  { id: 'east_lift',  name: 'East Rail',     x: 178,  z: 60 },
  { id: 'north_pad',  name: 'North Pad',     x: 10,   z: 178 },
  { id: 'south_pad',  name: 'South Pad',     x: -60,  z: -180 },
  { id: 'se_dock',    name: 'Dockside',      x: 172,  z: -172 },
  { id: 'nw_ridge',   name: 'Ridge Station', x: -172, z: 172 },
];
export const HATCH_SITES = [
  { id: 'hatch_a', x: -60, z: 80 }, { id: 'hatch_b', x: 70, z: 70 }, { id: 'hatch_c', x: 60, z: -50 },
  { id: 'hatch_d', x: -80, z: -40 }, { id: 'hatch_e', x: 150, z: 40 },
];
export const SPAWN_SITES = [
  { x: -185, z: -60 }, { x: -185, z: 90 }, { x: -100, z: 185 }, { x: 70, z: 185 }, { x: 185, z: 130 },
  { x: 185, z: -80 }, { x: 110, z: -186 }, { x: -130, z: -186 }, { x: 186, z: 10 }, { x: -186, z: 30 },
];

export function generateWorld(seed = MAP_SEED) {
  const rng = mulberry32(seed);
  const boxes = [];
  const containers = [];
  const doors = []; // { id, box index, key }
  const reserved = []; // circles kept clear of scatter

  const addBox = (x0, y0, z0, x1, y1, z1, k, extra) => {
    const b = { x0: Math.min(x0, x1), y0: Math.min(y0, y1), z0: Math.min(z0, z1), x1: Math.max(x0, x1), y1: Math.max(y0, y1), z1: Math.max(z0, z1), k };
    if (extra) Object.assign(b, extra);
    boxes.push(b);
    return boxes.length - 1;
  };
  const addContainer = (type, x, z, poi, threat, y = 0) => {
    containers.push({ id: containers.length, type, x: +x.toFixed(2), y, z: +z.toFixed(2), poi: poi ?? null, threat: threat ?? 1 });
  };
  const blocked = (x, z, r) => {
    if (Math.abs(x) > C.MAP_HALF - 6 || Math.abs(z) > C.MAP_HALF - 6) return true;
    for (const c of reserved) if (Math.hypot(c.x - x, c.z - z) < c.r + r) return true;
    return false;
  };

  // perimeter
  const H = C.MAP_HALF;
  addBox(-H - 2, 0, -H - 2, H + 2, 10, -H, KIND.perimeter);
  addBox(-H - 2, 0, H, H + 2, 10, H + 2, KIND.perimeter);
  addBox(-H - 2, 0, -H, -H, 10, H, KIND.perimeter);
  addBox(H, 0, -H, H + 2, 10, H, KIND.perimeter);

  for (const e of EXTRACT_SITES) reserved.push({ x: e.x, z: e.z, r: 12 });
  for (const h of HATCH_SITES) reserved.push({ x: h.x, z: h.z, r: 4 });
  for (const s of SPAWN_SITES) reserved.push({ x: s.x, z: s.z, r: 6 });

  // building: walls with door gaps, roof, containers inside
  const T = 0.4, WH = 4;
  function building(cx, cz, w, d, opts = {}) {
    const x0 = cx - w / 2, x1 = cx + w / 2, z0 = cz - d / 2, z1 = cz + d / 2;
    const doorW = opts.doorW ?? 2.2;
    const sides = opts.doors ?? [Math.floor(rng() * 4)];
    // each side: build wall segments around a centered (or offset) gap
    const wall = (side) => {
      const hasDoor = sides.includes(side);
      const horiz = side === 0 || side === 2; // 0 = north (z0), 1 = east (x1), 2 = south (z1), 3 = west (x0)
      const len = horiz ? w : d;
      const off = hasDoor ? randRange(rng, -len / 2 + doorW, len / 2 - doorW) * 0.6 : 0;
      const segs = hasDoor ? [[-len / 2, off - doorW / 2], [off + doorW / 2, len / 2]] : [[-len / 2, len / 2]];
      for (const [a, b] of segs) {
        if (b - a < 0.05) continue;
        if (horiz) {
          const z = side === 0 ? z0 : z1;
          addBox(cx + a, 0, z - T / 2, cx + b, WH, z + T / 2, KIND.wall);
        } else {
          const x = side === 1 ? x1 : x0;
          addBox(x - T / 2, 0, cz + a, x + T / 2, WH, cz + b, KIND.wall);
        }
      }
      if (hasDoor && opts.lockedDoor) {
        const idx = horiz
          ? addBox(cx + off - doorW / 2, 0, (side === 0 ? z0 : z1) - T / 2, cx + off + doorW / 2, WH, (side === 0 ? z0 : z1) + T / 2, KIND.door, { door: opts.lockedDoor })
          : addBox((side === 1 ? x1 : x0) - T / 2, 0, cz + off - doorW / 2, (side === 1 ? x1 : x0) + T / 2, WH, cz + off + doorW / 2, KIND.door, { door: opts.lockedDoor });
        doors.push({ id: opts.lockedDoor, box: idx, key: opts.key, x: (boxes[idx].x0 + boxes[idx].x1) / 2, z: (boxes[idx].z0 + boxes[idx].z1) / 2 });
      }
    };
    for (let s = 0; s < 4; s++) wall(s);
    if (!opts.noRoof) addBox(x0 - 0.3, WH, z0 - 0.3, x1 + 0.3, WH + 0.35, z1 + 0.3, KIND.roof);
    reserved.push({ x: cx, z: cz, r: Math.hypot(w, d) / 2 + 2 });
    return { x0, x1, z0, z1 };
  }
  function fits(cx, cz, w, d) {
    const r = Math.hypot(w, d) / 2 + 2.5;
    return !blocked(cx, cz, r);
  }
  const insideSpots = (b, n) => {
    const out = [];
    for (let i = 0; i < n; i++) {
      out.push([randRange(rng, b.x0 + 1.2, b.x1 - 1.2), randRange(rng, b.z0 + 1.2, b.z1 - 1.2)]);
    }
    return out;
  };

  for (const poi of POIS) {
    const t = poi.threat;
    // POI landmark
    if (poi.id === 'relay') {
      addBox(poi.x - 1.5, 0, poi.z - 1.5, poi.x + 1.5, 26, poi.z + 1.5, KIND.tower);
      reserved.push({ x: poi.x, z: poi.z, r: 4 });
    }
    if (poi.id === 'reactor') {
      for (const [ox, oz] of [[-12, 10], [12, 10]]) {
        addBox(poi.x + ox - 5, 0, poi.z + oz - 5, poi.x + ox + 5, 16, poi.z + oz + 5, KIND.concrete);
        reserved.push({ x: poi.x + ox, z: poi.z + oz, r: 8 });
      }
    }
    if (poi.id === 'mall') {
      const b = building(poi.x, poi.z, 36, 22, { doors: [0, 2, 1] });
      // interior partitions (shops)
      for (let i = -1; i <= 1; i++) addBox(poi.x + i * 9 - 0.2, 0, poi.z - 11, poi.x + i * 9 + 0.2, 4, poi.z - 3, KIND.wall);
      for (let i = -1; i <= 1; i++) addBox(poi.x + i * 9 - 0.2, 0, poi.z + 3, poi.x + i * 9 + 0.2, 4, poi.z + 11, KIND.wall);
      for (const [x, z] of insideSpots(b, 6)) addContainer(pick(rng, ['crate', 'crate', 'toolbox', 'medbox', 'weaponcase']), x, z, poi.id, t);
    }
    if (poi.id === 'foundry') {
      const b = building(poi.x, poi.z, 34, 26, { doors: [0, 1, 2, 3], doorW: 4 });
      for (let i = 0; i < 4; i++) {
        const px = poi.x + randRange(rng, -12, 12), pz = poi.z + randRange(rng, -9, 9);
        addBox(px - 1, 0, pz - 1, px + 1, 4, pz + 1, KIND.metal);
      }
      for (const [x, z] of insideSpots(b, 4)) addContainer(pick(rng, ['weaponcase', 'toolbox', 'cache']), x, z, poi.id, t);
    }
    if (poi.id === 'checkpoint') {
      for (let i = 0; i < 10; i++) {
        const a = randRange(rng, 0, Math.PI * 2), r = randRange(rng, 6, poi.r - 4);
        const x = poi.x + Math.cos(a) * r, z = poi.z + Math.sin(a) * r;
        if (blocked(x, z, 2)) continue;
        if (rng() < 0.5) addBox(x - 2, 0, z - 0.4, x + 2, 0.95, z + 0.4, KIND.concrete);
        else addBox(x - 0.4, 0, z - 2, x + 0.4, 0.95, z + 2, KIND.concrete);
      }
    }
    // vault (locked room, needs a key) — DMZ strongholds / Arc locked rooms
    if (poi.vault) {
      for (let tries = 0; tries < 60; tries++) {
        const a = randRange(rng, 0, Math.PI * 2), r = randRange(rng, 8, poi.r - 6);
        const cx = poi.x + Math.cos(a) * r, cz = poi.z + Math.sin(a) * r;
        if (!fits(cx, cz, 7, 7)) continue;
        const key = { depot_vault: 'key_depot', mall_vault: 'key_mall', reactor_vault: 'key_reactor' }[poi.vault];
        const b = building(cx, cz, 7, 7, { doors: [randInt(rng, 0, 3)], lockedDoor: poi.vault, key });
        addContainer('safe', b.x0 + 1.4, b.z0 + 1.4, poi.id, t + 1);
        addContainer('safe', b.x1 - 1.4, b.z1 - 1.4, poi.id, t + 1);
        addContainer('weaponcase', b.x0 + 1.4, b.z1 - 1.4, poi.id, t + 1);
        break;
      }
    }
    // regular buildings
    const nb = poi.id === 'suburbs' ? 9 : poi.id === 'mall' ? 3 : 5 + Math.floor(t / 2);
    for (let i = 0, placed = 0; i < 80 && placed < nb; i++) {
      const w = randRange(rng, 7, 14), d = randRange(rng, 7, 13);
      const a = randRange(rng, 0, Math.PI * 2), r = randRange(rng, 4, poi.r);
      const cx = poi.x + Math.cos(a) * r, cz = poi.z + Math.sin(a) * r;
      if (!fits(cx, cz, w, d)) continue;
      const b = building(cx, cz, w, d, { doors: rng() < 0.4 ? [randInt(rng, 0, 3), randInt(rng, 0, 3)] : [randInt(rng, 0, 3)] });
      placed++;
      const n = randInt(rng, 1, 3);
      for (const [x, z] of insideSpots(b, n)) {
        const roll = rng();
        addContainer(roll < 0.45 ? 'crate' : roll < 0.65 ? 'toolbox' : roll < 0.85 ? 'medbox' : 'weaponcase', x, z, poi.id, t);
      }
    }
    // outdoor clutter: crates and cars
    for (let i = 0; i < 6 + t * 2; i++) {
      const a = randRange(rng, 0, Math.PI * 2), r = randRange(rng, 3, poi.r + 6);
      const x = poi.x + Math.cos(a) * r, z = poi.z + Math.sin(a) * r;
      if (blocked(x, z, 2.5)) continue;
      if (rng() < 0.4) {
        const rot = rng() < 0.5;
        addBox(x - (rot ? 2.1 : 1), 0, z - (rot ? 1 : 2.1), x + (rot ? 2.1 : 1), 1.4, z + (rot ? 1 : 2.1), KIND.car);
        if (rng() < 0.4) addContainer('crate', x + (rot ? 0 : 1.6), z + (rot ? 1.6 : 0), poi.id, t);
      } else {
        addBox(x - 0.8, 0, z - 0.8, x + 0.8, 1.2, z + 0.8, KIND.crate);
      }
      reserved.push({ x, z, r: 2.5 });
    }
  }

  // wilderness scatter: rocks, trees, wrecks, and hidden caches
  for (let i = 0; i < 260; i++) {
    const x = randRange(rng, -H + 8, H - 8), z = randRange(rng, -H + 8, H - 8);
    const nearPoi = POIS.some(p => Math.hypot(p.x - x, p.z - z) < p.r + 4);
    if (nearPoi || blocked(x, z, 3)) continue;
    const roll = rng();
    if (roll < 0.45) {
      // tree: trunk blocks movement, canopy only blocks bullets/LOS
      addBox(x - 0.35, 0, z - 0.35, x + 0.35, 3.2, z + 0.35, KIND.trunk);
      const s = randRange(rng, 1.6, 2.6);
      addBox(x - s, 2.6, z - s, x + s, 2.6 + s * 1.6, z + s, KIND.canopy);
      reserved.push({ x, z, r: 1.5 });
    } else if (roll < 0.8) {
      const w = randRange(rng, 1.5, 5), d = randRange(rng, 1.5, 5), h = randRange(rng, 1.0, 3.2);
      addBox(x - w / 2, 0, z - d / 2, x + w / 2, h, z + d / 2, KIND.rock);
      reserved.push({ x, z, r: Math.max(w, d) / 2 + 1 });
    } else {
      const rot = rng() < 0.5;
      addBox(x - (rot ? 2.1 : 1), 0, z - (rot ? 1 : 2.1), x + (rot ? 2.1 : 1), 1.4, z + (rot ? 1 : 2.1), KIND.car);
      reserved.push({ x, z, r: 3 });
    }
  }
  for (let i = 0, n = 0; i < 200 && n < 14; i++) {
    const x = randRange(rng, -H + 15, H - 15), z = randRange(rng, -H + 15, H - 15);
    if (blocked(x, z, 2)) continue;
    addContainer('cache', x, z, null, 3);
    reserved.push({ x, z, r: 2 });
    n++;
  }

  return buildWorld({ boxes, containers, doors });
}

// Attach spatial grid and helpers
export function buildWorld(w) {
  const H = C.MAP_HALF + 4;
  const n = Math.ceil((H * 2) / CELL);
  const grid = new Array(n * n);
  for (let i = 0; i < grid.length; i++) grid[i] = [];
  w.boxes.forEach((b, i) => {
    const cx0 = Math.max(0, Math.floor((b.x0 + H) / CELL)), cx1 = Math.min(n - 1, Math.floor((b.x1 + H) / CELL));
    const cz0 = Math.max(0, Math.floor((b.z0 + H) / CELL)), cz1 = Math.min(n - 1, Math.floor((b.z1 + H) / CELL));
    for (let cx = cx0; cx <= cx1; cx++) for (let cz = cz0; cz <= cz1; cz++) grid[cz * n + cx].push(i);
  });
  w.grid = grid; w.gridN = n; w.gridH = H;
  w.stamp = new Uint32Array(w.boxes.length); w.stampId = 1;
  w.doorOpen = {};
  return w;
}

function boxActive(w, b) { return !(b.door && w.doorOpen[b.door]); }

// Query boxes overlapping an XZ rect
export function queryRect(w, x0, z0, x1, z1, out = []) {
  const { gridN: n, gridH: H } = w;
  const cx0 = Math.max(0, Math.floor((x0 + H) / CELL)), cx1 = Math.min(n - 1, Math.floor((x1 + H) / CELL));
  const cz0 = Math.max(0, Math.floor((z0 + H) / CELL)), cz1 = Math.min(n - 1, Math.floor((z1 + H) / CELL));
  const id = ++w.stampId;
  for (let cx = cx0; cx <= cx1; cx++) for (let cz = cz0; cz <= cz1; cz++) {
    for (const bi of w.grid[cz * n + cx]) {
      if (w.stamp[bi] === id) continue;
      w.stamp[bi] = id;
      out.push(bi);
    }
  }
  return out;
}

const tmpList = [];
// Push a circle (radius r, vertical span [y0,y1]) out of boxes. Returns [x, z].
export function resolveCircle(w, x, z, r, y0 = 0, y1 = 1.8) {
  for (let iter = 0; iter < 3; iter++) {
    tmpList.length = 0;
    queryRect(w, x - r, z - r, x + r, z + r, tmpList);
    let moved = false;
    for (const bi of tmpList) {
      const b = w.boxes[bi];
      if (b.y0 >= y1 || b.y1 <= y0 + 0.05 || !boxActive(w, b)) continue;
      const px = Math.max(b.x0, Math.min(x, b.x1)), pz = Math.max(b.z0, Math.min(z, b.z1));
      const dx = x - px, dz = z - pz;
      const d2 = dx * dx + dz * dz;
      if (d2 >= r * r) continue;
      if (d2 > 1e-8) {
        const d = Math.sqrt(d2), push = r - d;
        x += (dx / d) * push; z += (dz / d) * push;
      } else {
        // center inside box: push out along the shallowest axis
        const l = x - b.x0, rr = b.x1 - x, t = z - b.z0, bb = b.z1 - z;
        const m = Math.min(l, rr, t, bb);
        if (m === l) x = b.x0 - r; else if (m === rr) x = b.x1 + r; else if (m === t) z = b.z0 - r; else z = b.z1 + r;
      }
      moved = true;
    }
    if (!moved) break;
  }
  const lim = C.MAP_HALF - r;
  return [Math.max(-lim, Math.min(lim, x)), Math.max(-lim, Math.min(lim, z))];
}

// Ray vs AABB (slab). Returns entry t or -1
export function rayBox(ox, oy, oz, dx, dy, dz, b, maxT) {
  let tmin = 0, tmax = maxT;
  const axes = [[ox, dx, b.x0, b.x1], [oy, dy, b.y0, b.y1], [oz, dz, b.z0, b.z1]];
  for (const [o, d, lo, hi] of axes) {
    if (Math.abs(d) < 1e-9) { if (o < lo || o > hi) return -1; continue; }
    let t1 = (lo - o) / d, t2 = (hi - o) / d;
    if (t1 > t2) { const s = t1; t1 = t2; t2 = s; }
    if (t1 > tmin) tmin = t1;
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return -1;
  }
  return tmin;
}

// World raycast via 2D DDA over the grid. Returns distance to first hit (or maxT if none) and box index.
export function raycast(w, ox, oy, oz, dx, dy, dz, maxT) {
  const { gridN: n, gridH: H } = w;
  let cx = Math.floor((ox + H) / CELL), cz = Math.floor((oz + H) / CELL);
  const stepX = dx > 0 ? 1 : -1, stepZ = dz > 0 ? 1 : -1;
  const tDX = Math.abs(dx) < 1e-9 ? Infinity : CELL / Math.abs(dx);
  const tDZ = Math.abs(dz) < 1e-9 ? Infinity : CELL / Math.abs(dz);
  let tMX = Math.abs(dx) < 1e-9 ? Infinity : (((dx > 0 ? cx + 1 : cx) * CELL - H) - ox) / dx;
  let tMZ = Math.abs(dz) < 1e-9 ? Infinity : (((dz > 0 ? cz + 1 : cz) * CELL - H) - oz) / dz;
  const id = ++w.stampId;
  let best = maxT, bestBox = -1, tCell = 0;
  while (tCell <= best) {
    if (cx >= 0 && cz >= 0 && cx < n && cz < n) {
      for (const bi of w.grid[cz * n + cx]) {
        if (w.stamp[bi] === id) continue;
        w.stamp[bi] = id;
        const b = w.boxes[bi];
        if (!boxActive(w, b)) continue;
        const t = rayBox(ox, oy, oz, dx, dy, dz, b, best);
        if (t >= 0 && t < best) { best = t; bestBox = bi; }
      }
    } else if (tCell > 0) break;
    if (tMX < tMZ) { tCell = tMX; tMX += tDX; cx += stepX; } else { tCell = tMZ; tMZ += tDZ; cz += stepZ; }
    if (tCell > maxT) break;
  }
  if (oy + dy * best < 0 && dy < 0) { // ground
    const tg = -oy / dy;
    if (tg < best) return { t: tg, box: -2 };
  }
  return { t: best, box: bestBox };
}

export function lineOfSight(w, ax, ay, az, bx, by, bz) {
  const dx = bx - ax, dy = by - ay, dz = bz - az;
  const d = Math.hypot(dx, dy, dz);
  if (d < 1e-6) return true;
  const r = raycast(w, ax, ay, az, dx / d, dy / d, dz / d, d);
  return r.box === -1 || r.t >= d - 0.05;
}

// Ray vs vertical cylinder (x,z center, radius, y range). Returns t or -1
export function rayCylinder(ox, oy, oz, dx, dy, dz, cx, cz, r, y0, y1, maxT) {
  const fx = ox - cx, fz = oz - cz;
  const a = dx * dx + dz * dz;
  if (a < 1e-9) return -1;
  const b = 2 * (fx * dx + fz * dz), c = fx * fx + fz * fz - r * r;
  const disc = b * b - 4 * a * c;
  if (disc < 0) return -1;
  const s = Math.sqrt(disc);
  for (const t of [(-b - s) / (2 * a), (-b + s) / (2 * a)]) {
    if (t < 0 || t > maxT) continue;
    const y = oy + dy * t;
    if (y >= y0 && y <= y1) return t;
  }
  return -1;
}

export function raySphere(ox, oy, oz, dx, dy, dz, cx, cy, cz, r, maxT) {
  const fx = ox - cx, fy = oy - cy, fz = oz - cz;
  const b = fx * dx + fy * dy + fz * dz;
  const c = fx * fx + fy * fy + fz * fz - r * r;
  const disc = b * b - c;
  if (disc < 0) return -1;
  const t = -b - Math.sqrt(disc);
  if (t < 0 || t > maxT) return -1;
  return t;
}

export function poiAt(x, z) {
  let best = null, bd = Infinity;
  for (const p of POIS) {
    const d = Math.hypot(p.x - x, p.z - z);
    if (d < p.r + 6 && d < bd) { best = p; bd = d; }
  }
  return best;
}

// Character movement shared by client prediction and server validation.
export function stepMove(w, s, input, dt, speed) {
  // input: { f, r } in [-1,1], yaw radians
  let mx = 0, mz = 0;
  const sin = Math.sin(input.yaw), cos = Math.cos(input.yaw);
  // forward = (-sin, -cos) matching three.js camera convention (yaw 0 looks toward -Z)
  mx += -sin * input.f + cos * input.r;
  mz += -cos * input.f - sin * input.r;
  const len = Math.hypot(mx, mz);
  if (len > 1) { mx /= len; mz /= len; }
  const nx = s.x + mx * speed * dt, nz = s.z + mz * speed * dt;
  const [rx, rz] = resolveCircle(w, nx, nz, C.PLAYER_RADIUS, 0, 1.8);
  s.x = rx; s.z = rz;
  return len > 0.01;
}
