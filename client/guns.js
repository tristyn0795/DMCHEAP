// Procedural, grounded low-poly firearms (no asset files). Each gun is built from boxes/cylinders
// in real-world metres, pointing down -Z with its origin at the pistol grip (where the right hand goes).
// Sockets: muzzle (tip, for flash/tracers), optic (top rail), mag (mesh animated on reload), foregrip (left hand).
import * as THREE from 'three';
import { ATTACHMENTS, WEAPONS } from '/shared/data.js';

const MAT = {};
function mat(key, color, opts = {}) {
  return (MAT[key] ??= new THREE.MeshStandardMaterial({ color, roughness: opts.rough ?? 0.6, metalness: opts.metal ?? 0.4, emissive: opts.emissive ?? 0x000000 }));
}
const M = {
  steel: () => mat('steel', 0x34373b, { metal: 0.7, rough: 0.45 }),
  dark: () => mat('dark', 0x1f2023, { metal: 0.3, rough: 0.7 }),
  poly: () => mat('poly', 0x26272a, { metal: 0.05, rough: 0.85 }),
  tan: () => mat('tan', 0x8a7a5c, { metal: 0.05, rough: 0.85 }),
  od: () => mat('od', 0x4a5136, { metal: 0.05, rough: 0.85 }),
  wood: () => mat('wood', 0x6b4423, { metal: 0.0, rough: 0.7 }),
  brass: () => mat('brass', 0xb08d4a, { metal: 0.9, rough: 0.35 }),
  gold: () => mat('gold', 0xd4ae52, { metal: 0.95, rough: 0.25 }),
  glassR: () => mat('glassR', 0x220000, { emissive: 0xff2a2a, metal: 0.2, rough: 0.2 }),
  glassG: () => mat('glassG', 0x0b2a1a, { emissive: 0x2cff8a, metal: 0.2, rough: 0.1 }),
  lens: () => mat('lens', 0x0a1a2a, { metal: 0.9, rough: 0.05, emissive: 0x05101a }),
};

function box(g, w, h, d, x, y, z, m, rx = 0) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
  mesh.position.set(x, y, z); mesh.rotation.x = rx;
  mesh.castShadow = true;
  g.add(mesh);
  return mesh;
}
function cyl(g, r, len, x, y, z, m, axis = 'z', seg = 10) {
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(r, r, len, seg), m);
  if (axis === 'z') mesh.rotation.x = Math.PI / 2;
  if (axis === 'x') mesh.rotation.z = Math.PI / 2;
  mesh.position.set(x, y, z);
  mesh.castShadow = true;
  g.add(mesh);
  return mesh;
}

// Base gun geometry. Returns sockets in gun-local space.
const BUILD = {
  pistol(g, m) {
    box(g, 0.03, 0.035, 0.19, 0, 0.075, -0.07, m.recv);                      // slide
    box(g, 0.028, 0.025, 0.15, 0, 0.045, -0.05, m.frame);                    // frame
    box(g, 0.028, 0.11, 0.045, 0, -0.005, 0.0, m.frame, 0.25);               // grip
    const mag = box(g, 0.022, 0.03, 0.035, 0, -0.065, 0.012, m.steel, 0.25); // mag base
    box(g, 0.004, 0.008, 0.006, 0, 0.097, -0.155, m.steel);                 // front sight
    box(g, 0.016, 0.008, 0.006, 0, 0.097, 0.01, m.steel);                   // rear sight
    box(g, 0.012, 0.025, 0.035, 0, 0.022, -0.035, m.frame);                 // trigger guard
    return { muzzle: [0, 0.075, -0.17], optic: [0, 0.1, -0.05], mag, fore: [0, 0.03, -0.06], length: 0.2 };
  },
  revolver(g, m) {
    box(g, 0.03, 0.05, 0.1, 0, 0.06, -0.04, m.recv);                         // frame
    cyl(g, 0.026, 0.05, 0, 0.065, -0.06, m.steel, 'z', 6);                   // cylinder
    cyl(g, 0.01, 0.17, 0, 0.078, -0.17, m.steel);                            // barrel
    box(g, 0.014, 0.012, 0.17, 0, 0.09, -0.17, m.recv);                      // rib
    box(g, 0.03, 0.11, 0.045, 0, -0.005, 0.02, m.wood, 0.35);                // grip
    box(g, 0.004, 0.01, 0.008, 0, 0.1, -0.245, m.steel);
    const mag = cyl(g, 0.006, 0.03, 0.015, 0.05, -0.045, m.brass, 'z');      // visible rounds
    return { muzzle: [0, 0.078, -0.255], optic: [0, 0.1, -0.12], mag, fore: [0, 0.04, -0.06], length: 0.28 };
  },
  smg(g, m) {
    box(g, 0.048, 0.065, 0.28, 0, 0.06, -0.08, m.recv);                      // receiver
    box(g, 0.044, 0.04, 0.12, 0, 0.045, -0.26, m.frame);                     // handguard
    cyl(g, 0.011, 0.07, 0, 0.06, -0.35, m.steel);                            // barrel
    box(g, 0.03, 0.1, 0.04, 0, -0.025, 0.0, m.frame, 0.2);                   // grip
    const mag = box(g, 0.026, 0.16, 0.035, 0, -0.04, -0.12, m.steel, -0.08); // straight mag
    box(g, 0.01, 0.01, 0.2, -0.02, 0.06, 0.15, m.steel);                     // wire stock rails
    box(g, 0.01, 0.01, 0.2, 0.02, 0.06, 0.15, m.steel);
    box(g, 0.05, 0.07, 0.015, 0, 0.05, 0.25, m.frame);                       // butt plate
    box(g, 0.02, 0.008, 0.2, 0, 0.097, -0.09, m.steel);                      // top rail
    box(g, 0.004, 0.015, 0.006, 0, 0.105, -0.3, m.steel);                    // front sight
    return { muzzle: [0, 0.06, -0.385], optic: [0, 0.105, -0.08], mag, fore: [0, 0.03, -0.25], length: 0.66 };
  },
  shotgun(g, m) {
    box(g, 0.05, 0.07, 0.2, 0, 0.06, -0.05, m.recv);                          // receiver
    cyl(g, 0.012, 0.5, 0, 0.08, -0.4, m.steel);                              // barrel
    cyl(g, 0.012, 0.38, 0, 0.05, -0.33, m.steel);                            // mag tube
    const pump = box(g, 0.048, 0.045, 0.16, 0, 0.05, -0.3, m.frame);         // forend (pump)
    box(g, 0.032, 0.1, 0.04, 0, -0.03, 0.04, m.frame, 0.35);                 // grip
    box(g, 0.042, 0.07, 0.26, 0, 0.045, 0.2, m.stock, -0.1);                 // stock
    box(g, 0.045, 0.1, 0.02, 0, 0.03, 0.33, m.dark);                         // pad
    box(g, 0.004, 0.008, 0.006, 0, 0.095, -0.64, m.brass);                   // bead
    const mag = cyl(g, 0.009, 0.06, 0.03, 0.05, -0.04, m.brass, 'z');         // shell on side
    return { muzzle: [0, 0.08, -0.65], optic: [0, 0.1, -0.05], mag, fore: [0, 0.03, -0.3], pump, length: 0.98 };
  },
  carbine(g, m) {
    box(g, 0.05, 0.06, 0.25, 0, 0.07, -0.06, m.recv);                        // upper
    box(g, 0.046, 0.05, 0.18, 0, 0.025, -0.04, m.frame);                     // lower
    box(g, 0.054, 0.056, 0.27, 0, 0.068, -0.31, m.frame);                    // handguard
    for (let i = 0; i < 5; i++) box(g, 0.056, 0.012, 0.012, 0, 0.068, -0.2 - i * 0.05, m.steel); // rail slots
    cyl(g, 0.011, 0.14, 0, 0.07, -0.5, m.steel);                             // barrel
    box(g, 0.012, 0.035, 0.012, 0, 0.11, -0.43, m.steel);                    // front sight post
    box(g, 0.02, 0.009, 0.26, 0, 0.104, -0.09, m.steel);                     // top rail
    box(g, 0.03, 0.1, 0.04, 0, -0.02, 0.02, m.frame, 0.3);                   // grip
    const mag = box(g, 0.026, 0.15, 0.06, 0, -0.04, -0.09, m.steel, -0.18);  // curved-ish mag
    cyl(g, 0.016, 0.16, 0, 0.065, 0.13, m.steel);                            // buffer tube
    const stock = box(g, 0.044, 0.075, 0.16, 0, 0.05, 0.2, m.stock);         // stock
    box(g, 0.02, 0.025, 0.02, 0, 0.115, 0.03, m.steel);                      // rear sight
    return { muzzle: [0, 0.07, -0.57], optic: [0, 0.112, -0.1], mag, fore: [0, 0.035, -0.32], stock, length: 0.86 };
  },
  burst(g, m) {
    // bullpup: magazine behind the grip
    box(g, 0.056, 0.085, 0.42, 0, 0.06, 0.02, m.recv);                       // body
    box(g, 0.05, 0.05, 0.2, 0, 0.055, -0.27, m.frame);                       // handguard
    cyl(g, 0.011, 0.12, 0, 0.065, -0.42, m.steel);                           // barrel
    box(g, 0.03, 0.1, 0.04, 0, -0.03, -0.08, m.frame, 0.25);                 // grip (forward of mag)
    const mag = box(g, 0.026, 0.13, 0.06, 0, -0.03, 0.08, m.steel, -0.12);   // mag behind grip
    box(g, 0.05, 0.1, 0.02, 0, 0.05, 0.24, m.dark);                          // butt pad
    box(g, 0.02, 0.009, 0.3, 0, 0.108, -0.06, m.steel);                      // rail
    box(g, 0.012, 0.03, 0.012, 0, 0.1, -0.35, m.steel);
    return { muzzle: [0, 0.065, -0.48], optic: [0, 0.116, -0.08], mag, fore: [0, 0.03, -0.27], length: 0.72 };
  },
  k47(g, m) {
    box(g, 0.05, 0.06, 0.28, 0, 0.06, -0.05, m.recv);                        // receiver
    box(g, 0.046, 0.02, 0.27, 0, 0.098, -0.05, m.steel);                     // dust cover
    box(g, 0.05, 0.05, 0.2, 0, 0.055, -0.3, m.wood);                         // lower handguard
    cyl(g, 0.012, 0.18, 0, 0.098, -0.3, m.wood);                             // gas tube cover
    cyl(g, 0.011, 0.2, 0, 0.06, -0.5, m.steel);                              // barrel
    box(g, 0.012, 0.04, 0.012, 0, 0.1, -0.56, m.steel);                      // front sight
    box(g, 0.03, 0.1, 0.04, 0, -0.025, 0.04, m.frame, 0.35);                 // grip
    const mag = new THREE.Group();                                           // banana mag
    box(mag, 0.028, 0.09, 0.055, 0, -0.03, -0.1, m.steel, -0.25);
    box(mag, 0.028, 0.09, 0.055, 0, -0.105, -0.075, m.steel, -0.55);
    g.add(mag);
    box(g, 0.042, 0.075, 0.25, 0, 0.035, 0.21, m.wood, -0.12);               // wooden stock
    return { muzzle: [0, 0.06, -0.6], optic: [0, 0.112, -0.06], mag, fore: [0, 0.03, -0.3], length: 0.9 };
  },
  dmr(g, m) {
    box(g, 0.054, 0.065, 0.3, 0, 0.07, -0.06, m.recv);
    box(g, 0.058, 0.058, 0.34, 0, 0.068, -0.37, m.frame);
    cyl(g, 0.013, 0.2, 0, 0.07, -0.63, m.steel);
    box(g, 0.02, 0.009, 0.36, 0, 0.106, -0.15, m.steel);
    box(g, 0.03, 0.1, 0.04, 0, -0.02, 0.02, m.frame, 0.3);
    const mag = box(g, 0.03, 0.09, 0.07, 0, -0.02, -0.1, m.steel);           // 10-rd box mag
    box(g, 0.05, 0.09, 0.26, 0, 0.05, 0.22, m.stock);                        // precision stock
    box(g, 0.03, 0.025, 0.12, 0, 0.105, 0.2, m.stock);                       // cheek riser
    box(g, 0.006, 0.12, 0.006, -0.02, 0.0, -0.5, m.steel, 1.35);             // folded bipod legs
    box(g, 0.006, 0.12, 0.006, 0.02, 0.0, -0.5, m.steel, 1.35);
    return { muzzle: [0, 0.07, -0.73], optic: [0, 0.114, -0.12], mag, fore: [0, 0.035, -0.36], length: 1.08 };
  },
  sniper(g, m) {
    box(g, 0.06, 0.07, 0.36, 0, 0.06, -0.05, m.frame);                       // chassis
    cyl(g, 0.02, 0.24, 0, 0.09, -0.06, m.recv);                              // round action
    cyl(g, 0.016, 0.5, 0, 0.085, -0.45, m.steel);                            // heavy barrel
    const bolt = cyl(g, 0.007, 0.06, 0.04, 0.09, 0.02, m.steel, 'x');        // bolt handle
    box(g, 0.012, 0.012, 0.012, 0.072, 0.09, 0.02, m.steel);
    box(g, 0.03, 0.1, 0.04, 0, -0.03, 0.06, m.frame, 0.3);
    const mag = box(g, 0.03, 0.06, 0.08, 0, 0.0, -0.06, m.steel);
    box(g, 0.05, 0.1, 0.3, 0, 0.04, 0.28, m.stock);                          // skeleton stock
    box(g, 0.02, 0.009, 0.24, 0, 0.115, -0.08, m.steel);
    return { muzzle: [0, 0.085, -0.7], optic: [0, 0.12, -0.08], mag, fore: [0, 0.03, -0.32], bolt, length: 1.15 };
  },
  lmg(g, m) {
    box(g, 0.07, 0.09, 0.34, 0, 0.07, -0.05, m.recv);                        // receiver
    box(g, 0.06, 0.06, 0.2, 0, 0.06, -0.33, m.frame);                        // handguard
    cyl(g, 0.015, 0.32, 0, 0.07, -0.55, m.steel);                            // heavy barrel
    box(g, 0.015, 0.05, 0.12, 0, 0.14, -0.12, m.steel);                      // carry handle
    box(g, 0.03, 0.1, 0.04, 0, -0.03, 0.06, m.frame, 0.3);
    const mag = box(g, 0.09, 0.11, 0.1, -0.015, -0.03, -0.12, m.od);         // box mag
    cyl(g, 0.006, 0.05, 0.03, 0.04, -0.12, m.brass, 'x');                    // belt peeking out
    box(g, 0.05, 0.085, 0.24, 0, 0.05, 0.22, m.stock);
    box(g, 0.006, 0.18, 0.006, -0.03, -0.02, -0.55, m.steel, 0.3);           // bipod
    box(g, 0.006, 0.18, 0.006, 0.03, -0.02, -0.55, m.steel, 0.3);
    return { muzzle: [0, 0.07, -0.71], optic: [0, 0.125, -0.06], mag, fore: [0, 0.035, -0.33], length: 1.05 };
  },
};

function materialsFor(id, gold) {
  if (gold) return { recv: M.gold(), frame: M.gold(), stock: M.dark(), steel: M.steel(), wood: M.wood(), dark: M.dark() };
  const furniture = { k47: M.wood(), revolver: M.wood(), lmg: M.od(), dmr: M.tan(), shotgun: M.poly(), sniper: M.tan() }[id] ?? M.poly();
  return { recv: M.steel(), frame: M.poly(), stock: furniture, steel: M.steel(), wood: M.wood(), dark: M.dark() };
}

// Attachment meshes (also used alone for inventory icons)
export function buildAttachment(id) {
  const g = new THREE.Group();
  const A = ATTACHMENTS[id];
  let len = 0;
  switch (id) {
    case 'att_comp': cyl(g, 0.017, 0.05, 0, 0, -0.025, M.steel(), 'z', 8); for (let i = 0; i < 3; i++) box(g, 0.036, 0.004, 0.006, 0, 0.012, -0.012 - i * 0.012, M.dark()); len = 0.05; break;
    case 'att_brake': box(g, 0.036, 0.03, 0.055, 0, 0, -0.027, M.steel()); box(g, 0.038, 0.012, 0.01, 0, 0, -0.02, M.dark()); box(g, 0.038, 0.012, 0.01, 0, 0, -0.04, M.dark()); len = 0.055; break;
    case 'att_supp': cyl(g, 0.02, 0.17, 0, 0, -0.085, M.dark(), 'z', 14); len = 0.17; break;
    case 'att_supp_heavy': cyl(g, 0.026, 0.22, 0, 0, -0.11, M.dark(), 'z', 14); cyl(g, 0.027, 0.02, 0, 0, -0.03, M.steel(), 'z', 14); len = 0.22; break;
    case 'att_reddot': box(g, 0.03, 0.012, 0.05, 0, 0.006, 0, M.dark()); cyl(g, 0.014, 0.04, 0, 0.026, 0, M.dark(), 'z', 12); cyl(g, 0.011, 0.002, 0, 0.026, -0.021, M.glassR(), 'z', 12); break;
    case 'att_holo': box(g, 0.036, 0.012, 0.07, 0, 0.006, 0, M.dark()); box(g, 0.04, 0.04, 0.006, 0, 0.032, -0.03, M.dark()); box(g, 0.03, 0.028, 0.002, 0, 0.034, -0.026, M.glassG()); box(g, 0.006, 0.04, 0.05, -0.017, 0.032, 0, M.dark()); box(g, 0.006, 0.04, 0.05, 0.017, 0.032, 0, M.dark()); break;
    case 'att_3x': box(g, 0.026, 0.02, 0.08, 0, 0.01, 0, M.dark()); cyl(g, 0.016, 0.16, 0, 0.038, 0, M.dark(), 'z', 14); cyl(g, 0.02, 0.03, 0, 0.038, -0.08, M.dark(), 'z', 14); cyl(g, 0.018, 0.002, 0, 0.038, -0.096, M.lens(), 'z', 14); break;
    case 'att_6x': box(g, 0.026, 0.024, 0.1, 0, 0.012, 0, M.dark()); cyl(g, 0.018, 0.26, 0, 0.045, 0, M.dark(), 'z', 14); cyl(g, 0.027, 0.06, 0, 0.045, -0.13, M.dark(), 'z', 14); cyl(g, 0.025, 0.002, 0, 0.045, -0.161, M.lens(), 'z', 14); cyl(g, 0.009, 0.03, 0, 0.068, 0, M.steel(), 'y', 8); break;
    case 'att_vgrip': box(g, 0.026, 0.09, 0.03, 0, -0.045, 0, M.poly()); break;
    case 'att_agrip': box(g, 0.026, 0.035, 0.08, 0, -0.02, 0, M.poly(), -0.5); break;
    case 'att_stock': box(g, 0.05, 0.085, 0.2, 0, 0, 0, M.poly()); box(g, 0.05, 0.11, 0.025, 0, -0.005, 0.1, M.dark()); box(g, 0.03, 0.02, 0.1, 0, 0.05, 0.02, M.poly()); break;
    case 'att_mag_ext': box(g, 0.026, 0.23, 0.05, 0, -0.08, 0, M.steel()); break;
    case 'att_mag_drum': cyl(g, 0.065, 0.07, 0, -0.08, 0, M.steel(), 'x', 18); box(g, 0.026, 0.06, 0.045, 0, -0.01, 0, M.steel()); break;
    case 'att_mag_fast': box(g, 0.026, 0.15, 0.05, 0, -0.06, 0, M.steel()); box(g, 0.03, 0.02, 0.055, 0, -0.14, 0, mat('fastpull', 0xd9822b, { metal: 0.1 })); break;
    case 'att_barrel_long': cyl(g, 0.012, 0.1, 0, 0, -0.05, M.steel()); len = 0.1; break;
    case 'att_barrel_short': cyl(g, 0.013, 0.03, 0, 0, -0.015, M.steel()); len = 0.03; break;
  }
  g.userData.len = len;
  g.userData.slot = A?.slot;
  return g;
}

// Build a complete gun. stack: { id, att, tier }. Returns { group, muzzle (Object3D), mag, pump, bolt, length }
export function buildGun(stack, gold = false) {
  const id = stack.id;
  const g = new THREE.Group();
  const builder = BUILD[modelOf(id)] ?? BUILD.carbine;
  const m = materialsFor(modelOf(id), gold || id === 'gilded');
  const sock = builder(g, m);
  const att = stack.att ?? {};
  const muzzle = new THREE.Object3D();
  muzzle.position.set(...sock.muzzle);
  g.add(muzzle);
  // barrel mods shift the muzzle
  if (att.barrel) {
    const b = buildAttachment(att.barrel);
    if (att.barrel === 'att_barrel_short') muzzle.position.z += 0.05;
    else { b.position.set(...sock.muzzle); g.add(b); muzzle.position.z -= b.userData.len; }
  }
  if (att.muzzle) {
    const a = buildAttachment(att.muzzle);
    a.position.copy(muzzle.position);
    g.add(a);
    muzzle.position.z -= a.userData.len;
  }
  if (att.optic) {
    const o = buildAttachment(att.optic);
    o.position.set(...sock.optic);
    g.add(o);
  }
  let mag = sock.mag;
  if (att.mag && mag) {
    const mm = buildAttachment(att.mag);
    mm.position.copy(mag.position);
    mm.rotation.copy(mag.rotation);
    mm.position.y += 0.04;
    mag.visible = false;
    g.add(mm);
    mag = mm;
  }
  if (att.grip === 'att_stock' && sock.stock) {
    sock.stock.visible = false;
    const st = buildAttachment('att_stock');
    st.position.copy(sock.stock.position);
    g.add(st);
  } else if (att.grip && att.grip !== 'att_stock') {
    const gr = buildAttachment(att.grip);
    gr.position.set(sock.fore[0], sock.fore[1] - 0.005, sock.fore[2]);
    g.add(gr);
  }
  // tier marking: a coloured band on the receiver
  if ((stack.tier ?? 1) > 1) {
    const col = [0, 0, 0x3d8ff0, 0xa65bf0, 0xf0a43d][stack.tier];
    box(g, 0.056, 0.01, 0.03, 0, 0.03, -0.02, mat('tier' + stack.tier, col, { metal: 0.3, emissive: col }));
  }
  return { group: g, muzzle, mag, magHome: mag ? mag.position.clone() : null, pump: sock.pump, pumpHome: sock.pump?.position.clone(), bolt: sock.bolt, fore: new THREE.Vector3(...sock.fore), length: sock.length };
}

function modelOf(id) { return WEAPONS[id]?.model ?? 'carbine'; }

// ---------------------------------------------------------------- inventory icons (rendered once, cached)
let iconRenderer = null, iconScene = null, iconCam = null;
const iconCache = new Map();
function iconSetup() {
  if (iconRenderer) return true;
  try {
    const cv = document.createElement('canvas');
    iconRenderer = new THREE.WebGLRenderer({ canvas: cv, antialias: true, alpha: true, preserveDrawingBuffer: true });
    iconRenderer.setSize(256, 112, false);
    iconRenderer.outputColorSpace = THREE.SRGBColorSpace;
    iconScene = new THREE.Scene();
    iconScene.add(new THREE.HemisphereLight(0xffffff, 0x404040, 1.6));
    const d = new THREE.DirectionalLight(0xffffff, 2.2); d.position.set(1, 2, 1); iconScene.add(d);
    iconCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, 10);
    return true;
  } catch { return false; }
}

function renderObject(obj) {
  const box3 = new THREE.Box3().setFromObject(obj);
  const size = box3.getSize(new THREE.Vector3()), c = box3.getCenter(new THREE.Vector3());
  const aspect = 256 / 112;
  let halfW = Math.max(size.z, size.y * aspect) / 2 * 1.12;
  let halfH = halfW / aspect;
  iconCam.left = -halfW; iconCam.right = halfW; iconCam.top = halfH; iconCam.bottom = -halfH;
  iconCam.position.set(c.x + 2, c.y + 0.25, c.z);
  iconCam.lookAt(c.x, c.y, c.z);
  iconCam.updateProjectionMatrix();
  iconScene.add(obj);
  iconRenderer.setClearColor(0x000000, 0);
  iconRenderer.render(iconScene, iconCam);
  iconScene.remove(obj);
  return iconRenderer.domElement.toDataURL('image/png');
}

export function gunIcon(stack) {
  const key = `${stack.id}|${JSON.stringify(stack.att ?? {})}|${stack.tier ?? 1}`;
  if (iconCache.has(key)) return iconCache.get(key);
  if (!iconSetup()) return null;
  const url = renderObject(buildGun(stack).group);
  iconCache.set(key, url);
  return url;
}
export function attIcon(id) {
  if (iconCache.has(id)) return iconCache.get(id);
  if (!iconSetup()) return null;
  const g = buildAttachment(id);
  if (ATTACHMENTS[id]?.slot === 'mag' || id === 'att_vgrip') g.rotation.y = 0;
  const url = renderObject(g);
  iconCache.set(id, url);
  return url;
}
