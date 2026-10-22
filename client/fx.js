// Cheap, pooled combat effects: one draw call each for particles, decals and shell casings,
// and a fixed light pool (adding/removing lights at runtime forces shader recompiles in three.js).
import * as THREE from 'three';
import { KIND } from '/shared/world.js';

// ---------------------------------------------------------------- particles (sparks, dust, dirt, chips)
const P_VERT = `
attribute float size; attribute float alpha; attribute vec3 color;
varying float vA; varying vec3 vC;
void main() {
  vA = alpha; vC = color;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = size * (300.0 / -mv.z);
  gl_Position = projectionMatrix * mv;
}`;
const P_FRAG = `
varying float vA; varying vec3 vC;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float d = dot(c, c);
  if (d > 0.25) discard;
  gl_FragColor = vec4(vC, vA * (1.0 - d * 3.2));
}`;

export class Particles {
  constructor(scene, cap = 900, additive = false) {
    this.cap = cap; this.n = 0; this.head = 0;
    this.pos = new Float32Array(cap * 3); this.vel = new Float32Array(cap * 3);
    this.col = new Float32Array(cap * 3); this.size = new Float32Array(cap); this.alpha = new Float32Array(cap);
    this.life = new Float32Array(cap); this.max = new Float32Array(cap); this.grav = new Float32Array(cap); this.grow = new Float32Array(cap);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(this.col, 3));
    g.setAttribute('size', new THREE.BufferAttribute(this.size, 1));
    g.setAttribute('alpha', new THREE.BufferAttribute(this.alpha, 1));
    this.mat = new THREE.ShaderMaterial({ vertexShader: P_VERT, fragmentShader: P_FRAG, transparent: true, depthWrite: false, blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending });
    this.points = new THREE.Points(g, this.mat);
    this.points.frustumCulled = false;
    scene.add(this.points);
  }
  emit(x, y, z, vx, vy, vz, { color = 0xffffff, size = 0.1, life = 0.5, grav = 9.8, grow = 0 } = {}) {
    const i = this.head; this.head = (this.head + 1) % this.cap;
    this.pos[i * 3] = x; this.pos[i * 3 + 1] = y; this.pos[i * 3 + 2] = z;
    this.vel[i * 3] = vx; this.vel[i * 3 + 1] = vy; this.vel[i * 3 + 2] = vz;
    const c = new THREE.Color(color);
    this.col[i * 3] = c.r; this.col[i * 3 + 1] = c.g; this.col[i * 3 + 2] = c.b;
    this.size[i] = size; this.alpha[i] = 1; this.life[i] = life; this.max[i] = life; this.grav[i] = grav; this.grow[i] = grow;
  }
  update(dt) {
    for (let i = 0; i < this.cap; i++) {
      if (this.life[i] <= 0) { if (this.alpha[i] !== 0) this.alpha[i] = 0; continue; }
      this.life[i] -= dt;
      this.vel[i * 3 + 1] -= this.grav[i] * dt;
      this.pos[i * 3] += this.vel[i * 3] * dt; this.pos[i * 3 + 1] += this.vel[i * 3 + 1] * dt; this.pos[i * 3 + 2] += this.vel[i * 3 + 2] * dt;
      if (this.pos[i * 3 + 1] < 0.02) { this.pos[i * 3 + 1] = 0.02; this.vel[i * 3 + 1] *= -0.3; this.vel[i * 3] *= 0.6; this.vel[i * 3 + 2] *= 0.6; }
      this.size[i] += this.grow[i] * dt;
      this.alpha[i] = Math.max(0, this.life[i] / this.max[i]);
    }
    const a = this.points.geometry.attributes;
    a.position.needsUpdate = a.alpha.needsUpdate = a.size.needsUpdate = a.color.needsUpdate = true;
  }
}

// ---------------------------------------------------------------- bullet-hole decals (instanced ring buffer)
export class Decals {
  constructor(scene, cap = 220) {
    const cv = document.createElement('canvas'); cv.width = cv.height = 64;
    const g = cv.getContext('2d');
    const grd = g.createRadialGradient(32, 32, 2, 32, 32, 30);
    grd.addColorStop(0, 'rgba(10,8,6,1)'); grd.addColorStop(0.35, 'rgba(25,20,16,0.9)'); grd.addColorStop(1, 'rgba(40,34,28,0)');
    g.fillStyle = grd; g.fillRect(0, 0, 64, 64);
    const tex = new THREE.CanvasTexture(cv);
    this.mesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(0.12, 0.12), new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 }), cap);
    this.mesh.count = 0; this.cap = cap; this.head = 0;
    this.mesh.frustumCulled = false;
    scene.add(this.mesh);
    this.m = new THREE.Matrix4(); this.q = new THREE.Quaternion(); this.z = new THREE.Vector3(0, 0, 1);
  }
  add(p, n) {
    this.q.setFromUnitVectors(this.z, n);
    const s = 0.7 + Math.random() * 0.6;
    this.m.compose(new THREE.Vector3(p.x + n.x * 0.01, p.y + n.y * 0.01, p.z + n.z * 0.01), this.q, new THREE.Vector3(s, s, s));
    this.mesh.setMatrixAt(this.head, this.m);
    this.head = (this.head + 1) % this.cap;
    this.mesh.count = Math.min(this.cap, this.mesh.count + 1);
    this.mesh.instanceMatrix.needsUpdate = true;
  }
  clear() { this.mesh.count = 0; this.head = 0; }
}

// ---------------------------------------------------------------- shell casings (instanced, simple physics)
export class Shells {
  constructor(scene, cap = 60) {
    this.mesh = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.006, 0.006, 0.03, 6), new THREE.MeshStandardMaterial({ color: 0xc9a248, metalness: 0.9, roughness: 0.3 }), cap);
    this.mesh.count = cap; this.cap = cap; this.head = 0;
    this.mesh.frustumCulled = false;
    this.s = Array.from({ length: cap }, () => ({ p: new THREE.Vector3(0, -10, 0), v: new THREE.Vector3(), r: new THREE.Euler(), w: 0, life: 0 }));
    this.m = new THREE.Matrix4(); this.q = new THREE.Quaternion(); this.one = new THREE.Vector3(1, 1, 1);
    scene.add(this.mesh);
    for (let i = 0; i < cap; i++) this.write(i);
  }
  eject(pos, right, up, shotgun) {
    const s = this.s[this.head]; this.head = (this.head + 1) % this.cap;
    s.p.copy(pos);
    s.v.copy(right).multiplyScalar(1.8 + Math.random()).addScaledVector(up, 1.5 + Math.random());
    s.r.set(Math.random() * 3, Math.random() * 3, Math.random() * 3);
    s.w = 15 + Math.random() * 10; s.life = 2.5; s.big = shotgun;
  }
  write(i) {
    const s = this.s[i];
    this.q.setFromEuler(s.r);
    const sc = s.big ? 2.2 : 1;
    this.m.compose(s.life > 0 ? s.p : new THREE.Vector3(0, -50, 0), this.q, new THREE.Vector3(sc, sc, sc));
    this.mesh.setMatrixAt(i, this.m);
  }
  update(dt) {
    for (let i = 0; i < this.cap; i++) {
      const s = this.s[i];
      if (s.life <= 0) continue;
      s.life -= dt;
      s.v.y -= 9.8 * dt;
      s.p.addScaledVector(s.v, dt);
      if (s.p.y < 0.01) { s.p.y = 0.01; s.v.y *= -0.35; s.v.x *= 0.5; s.v.z *= 0.5; s.w *= 0.5; }
      s.r.x += s.w * dt; s.r.z += s.w * 0.7 * dt;
      this.write(i);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}

// ---------------------------------------------------------------- pooled flash lights
export class LightPool {
  constructor(scene, n = 4) {
    this.lights = Array.from({ length: n }, () => { const l = new THREE.PointLight(0xffc070, 0, 8, 2); scene.add(l); return { l, t: 0, max: 0, peak: 0 }; });
    this.i = 0;
  }
  flash(x, y, z, color, peak, dur, range) {
    const s = this.lights[this.i]; this.i = (this.i + 1) % this.lights.length;
    s.l.position.set(x, y, z); s.l.color.setHex(color); s.l.distance = range; s.t = dur; s.max = dur; s.peak = peak;
  }
  update(dt) { for (const s of this.lights) { s.t = Math.max(0, s.t - dt); s.l.intensity = s.max ? s.peak * (s.t / s.max) : 0; } }
}

// Muzzle flash sprite texture (star burst)
let flashTex = null;
export function flashTexture() {
  if (flashTex) return flashTex;
  const cv = document.createElement('canvas'); cv.width = cv.height = 64;
  const g = cv.getContext('2d');
  const grd = g.createRadialGradient(32, 32, 0, 32, 32, 30);
  grd.addColorStop(0, 'rgba(255,250,220,1)'); grd.addColorStop(0.3, 'rgba(255,200,90,0.9)'); grd.addColorStop(1, 'rgba(255,120,20,0)');
  g.fillStyle = grd;
  g.beginPath();
  for (let i = 0; i < 16; i++) { const a = i / 16 * Math.PI * 2, r = i % 2 ? 12 : 31; g.lineTo(32 + Math.cos(a) * r, 32 + Math.sin(a) * r); }
  g.closePath(); g.fill();
  flashTex = new THREE.CanvasTexture(cv);
  return flashTex;
}

// Surface type for impact effects from the box kind hit by a ray (-2 = ground)
export function surfaceOf(world, boxIndex) {
  if (boxIndex === -2) return 'dirt';
  const b = world.boxes[boxIndex];
  if (!b) return 'dirt';
  switch (b.k) {
    case KIND.metal: case KIND.car: case KIND.door: case KIND.tower: return 'metal';
    case KIND.crate: case KIND.trunk: return 'wood';
    case KIND.canopy: return 'leaf';
    case KIND.rock: return 'rock';
    default: return 'concrete';
  }
}

// Outward normal of the box face nearest to a hit point
export function boxNormal(world, boxIndex, p) {
  if (boxIndex === -2 || !world.boxes[boxIndex]) return new THREE.Vector3(0, 1, 0);
  const b = world.boxes[boxIndex];
  const d = [Math.abs(p.x - b.x0), Math.abs(p.x - b.x1), Math.abs(p.y - b.y0), Math.abs(p.y - b.y1), Math.abs(p.z - b.z0), Math.abs(p.z - b.z1)];
  const i = d.indexOf(Math.min(...d));
  return [new THREE.Vector3(-1, 0, 0), new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, -1, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, -1), new THREE.Vector3(0, 0, 1)][i];
}
