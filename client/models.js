// Low-poly character + label builders shared by the raid and the hub.
import * as THREE from 'three';

export function makeHuman(color, visor = 0xff8a2a) {
  const g = new THREE.Group();
  g.rotation.order = 'YXZ';
  const mat = new THREE.MeshLambertMaterial({ color });
  const dark = new THREE.MeshLambertMaterial({ color: 0x2a2622 });
  const legGeo = new THREE.BoxGeometry(0.2, 0.8, 0.22); legGeo.translate(0, -0.4, 0);
  const legL = new THREE.Mesh(legGeo, dark); legL.position.set(-0.13, 0.82, 0);
  const legR = new THREE.Mesh(legGeo, dark); legR.position.set(0.13, 0.82, 0);
  const torso = new THREE.Mesh(new THREE.BoxGeometry(0.52, 0.66, 0.32), mat); torso.position.y = 1.15;
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.17, 12, 10), mat); head.position.y = 1.62;
  const vis = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.08, 0.06), new THREE.MeshBasicMaterial({ color: visor })); vis.position.set(0, 1.64, -0.15);
  const pack = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.5, 0.2), dark); pack.position.set(0, 1.18, 0.26);
  // arms pivot at the shoulder; rotation.x = 0 points forward (holding a gun), +PI/2 points up
  const armGeo = new THREE.BoxGeometry(0.12, 0.12, 0.55); armGeo.translate(0, 0, -0.26);
  const armR = new THREE.Mesh(armGeo, mat); armR.position.set(0.3, 1.4, -0.02);
  const armL = new THREE.Mesh(armGeo, mat); armL.position.set(-0.3, 1.4, -0.02);
  armL.rotation.y = -0.45;
  armR.rotation.order = armL.rotation.order = 'YXZ';
  const gun = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.12, 0.75), new THREE.MeshLambertMaterial({ color: 0x1e1e1e })); gun.position.set(0.22, 1.36, -0.6);
  for (const m of [legL, legR, torso, head, pack, armR, armL, gun]) m.castShadow = true;
  // detailed gun models (client/guns.js) hang off this mount: grip in the right hand, stock at the shoulder
  const mount = new THREE.Group();
  mount.position.set(0.26, 1.32, -0.2);
  g.add(legL, legR, torso, head, vis, pack, armR, armL, gun, mount);
  return { group: g, legL, legR, armL, armR, gun, mount, model: null, visor: vis, phase: 0 };
}

// Swap the gun model a character is holding (null = keep the placeholder box)
export function setGunModel(h, built) {
  if (h.model) h.mount.remove(h.model.group);
  h.model = built;
  if (built) h.mount.add(built.group);
}

export function makeLabel(text, color = '#ffc24b', sub = null) {
  const cv = document.createElement('canvas');
  const meas = cv.getContext('2d');
  meas.font = 'bold 26px Segoe UI, sans-serif';
  let w = meas.measureText(text).width;
  if (sub) { meas.font = '600 18px Segoe UI, sans-serif'; w = Math.max(w, meas.measureText(sub).width); }
  cv.width = Math.max(256, Math.ceil(w + 24)); cv.height = sub ? 76 : 48;
  const g = cv.getContext('2d');
  const mid = cv.width / 2;
  g.textAlign = 'center';
  g.lineWidth = 5; g.strokeStyle = '#000';
  g.font = 'bold 26px Segoe UI, sans-serif';
  g.strokeText(text, mid, 34);
  g.fillStyle = color; g.fillText(text, mid, 34);
  if (sub) {
    g.font = '600 18px Segoe UI, sans-serif';
    g.strokeText(sub, mid, 62);
    g.fillStyle = '#d8cfc2'; g.fillText(sub, mid, 62);
  }
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(cv), depthTest: false, transparent: true }));
  sp.scale.set(2.4 * cv.width / 256, sub ? 0.71 : 0.45, 1);
  sp.renderOrder = 10;
  return sp;
}

// Shared walk/crouch/downed animation. `emote` drives hub-only poses.
export function animHuman(h, { moving = false, crouch = false, downed = false, speed = 4, dt = 0.016, armed = true, emote = null, t = 0 }) {
  const g = h.group;
  g.rotation.x = 0;
  g.position.y = 0;
  h.gun.visible = armed && !h.model;
  h.mount.visible = armed;
  h.armR.scale.z = 1; h.armL.scale.z = 1; h.armL.rotation.x = 0;
  if (downed) {
    g.rotation.x = -Math.PI / 2 * 0.9;
    g.position.y = 0.3;
    g.scale.y = 1;
    return;
  }
  g.scale.y = crouch || emote === 'sit' ? 0.72 : 1;
  if (moving) h.phase += dt * Math.min(12, 4 + speed * 1.3);
  else h.phase *= 0.9;
  const sw = Math.sin(h.phase) * (moving ? 0.6 : 0);
  h.legL.rotation.x = sw; h.legR.rotation.x = -sw;
  // arms
  const rest = armed ? 0 : -1.25;
  let ar = rest, al = rest, az = 0;
  if (!armed && moving) { ar = rest - sw * 0.4; al = rest + sw * 0.4; }
  if (emote === 'wave') { ar = 2.5; az = Math.sin(t * 10) * 0.35; }
  else if (emote === 'cheer') { ar = al = 2.8; g.position.y = Math.abs(Math.sin(t * 7)) * 0.25; }
  else if (emote === 'point') { ar = 0.15; }
  else if (emote === 'dance') { ar = 2 + Math.sin(t * 8) * 0.8; al = 2 - Math.sin(t * 8) * 0.8; g.position.y = Math.abs(Math.sin(t * 8)) * 0.12; h.legL.rotation.x = Math.sin(t * 8) * 0.5; h.legR.rotation.x = -Math.sin(t * 8) * 0.5; }
  else if (emote === 'sit') { ar = al = -0.6; }
  h.armR.rotation.x = ar; h.armL.rotation.x = al; h.armR.rotation.z = az;
  h.armL.rotation.y = armed ? -0.45 : 0;
  if (armed && h.model) {
    // right hand on the grip, left hand reaching for the foregrip
    const f = h.model.fore;
    h.armR.rotation.x = -0.55; h.armR.scale.z = 0.55;
    const dx = h.mount.position.x + f.x - h.armL.position.x, dy = h.mount.position.y + f.y - h.armL.position.y, dz = h.mount.position.z + f.z - h.armL.position.z;
    const len = Math.hypot(dx, dy, dz);
    h.armL.rotation.y = Math.atan2(-dx, -dz);
    h.armL.rotation.x = Math.asin(Math.max(-1, Math.min(1, dy / len)));
    h.armL.scale.z = len / 0.55;
  }
}
