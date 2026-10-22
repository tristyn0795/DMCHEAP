// The walkable hub ("The Cheap Seats"): shared 3D space, kiosks that open the hideout menus,
// the Lift (ready up / deploy), emotes, chat bubbles.
import * as THREE from 'three';
import { C } from '/shared/data.js';
import { KIND, raycast, stepMove } from '/shared/world.js';
import { HUB, KIOSKS, EMOTES, generateHub, inLift } from '/shared/hubmap.js';
import { makeHuman, makeLabel, animHuman } from './models.js';
import { $, esc } from './ui.js';

const KIND_COLORS = { [KIND.perimeter]: 0x4a423a, [KIND.roof]: 0x2a2520, [KIND.concrete]: 0x6e675e, [KIND.metal]: 0x56606a, [KIND.crate]: 0x8b5a2b };
const INTERP_MS = 120;

export class HubView {
  // ui: { openTerminal(tab), liftAction() -> {label, run()}, myId(), isSquad(pid) }
  constructor(net, sfx, ui) {
    this.net = net;
    this.sfx = sfx;
    this.ui = ui;
    this.world = generateHub();
    this.canvas = $('#hubview');
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(70, 1, 0.1, 200);
    this.active = false;
    this.keys = new Set();
    this.others = new Map();
    this.me = null;
    this.sens = +(localStorage.getItem('dmcheap_sens') || 0.0022);
    this.buildScene();
    this.bind();
    addEventListener('resize', () => this.resize());
    this.resize();
    this.last = performance.now();
    this.loop = this.loop.bind(this);
    requestAnimationFrame(this.loop);
  }

  buildScene() {
    const s = this.scene;
    s.background = new THREE.Color(0x15110d);
    s.fog = new THREE.Fog(0x15110d, 25, 60);
    s.add(new THREE.HemisphereLight(0xffe2c4, 0x2b241d, 0.9));
    for (const [x, z, c] of [[-10, -6, 0xffb070], [10, -6, 0xffb070], [-10, 8, 0xffd2a0], [10, 8, 0xffd2a0], [0, -11, 0x7fffb0]]) {
      const l = new THREE.PointLight(c, 28, 26, 1.6);
      l.position.set(x, 5.6, z);
      s.add(l);
      const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.18, 8, 6), new THREE.MeshBasicMaterial({ color: c }));
      bulb.position.copy(l.position);
      s.add(bulb);
    }
    // floor with painted lines
    const cv = document.createElement('canvas'); cv.width = cv.height = 256;
    const g = cv.getContext('2d');
    g.fillStyle = '#4b453e'; g.fillRect(0, 0, 256, 256);
    for (let i = 0; i < 1600; i++) { const v = 60 + Math.random() * 30 | 0; g.fillStyle = `rgba(${v},${v - 4},${v - 10},0.4)`; g.fillRect(Math.random() * 256, Math.random() * 256, 2, 2); }
    g.strokeStyle = '#3a352f'; g.lineWidth = 3; g.strokeRect(0, 0, 256, 256);
    const tex = new THREE.CanvasTexture(cv); tex.wrapS = tex.wrapT = THREE.RepeatWrapping; tex.repeat.set(11, 8); tex.colorSpace = THREE.SRGBColorSpace;
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(HUB.HALF_X * 2, HUB.HALF_Z * 2), new THREE.MeshLambertMaterial({ map: tex }));
    floor.rotation.x = -Math.PI / 2;
    s.add(floor);
    // static boxes
    const unit = new THREE.BoxGeometry(1, 1, 1); unit.translate(0, 0.5, 0);
    for (const b of this.world.boxes) {
      const m = new THREE.Mesh(unit, new THREE.MeshLambertMaterial({ color: KIND_COLORS[b.k] ?? 0x777777 }));
      m.position.set((b.x0 + b.x1) / 2, b.y0, (b.z0 + b.z1) / 2);
      m.scale.set(b.x1 - b.x0, b.y1 - b.y0, b.z1 - b.z0);
      s.add(m);
    }
    // kiosks: glowing screen + sign
    for (const k of KIOSKS) {
      const screen = new THREE.Mesh(new THREE.PlaneGeometry(2.6, 1.4), new THREE.MeshBasicMaterial({ color: k.color, transparent: true, opacity: 0.85 }));
      const label = makeLabel(k.name, '#' + k.color.toString(16).padStart(6, '0'));
      if (k.face === 1) { screen.position.set(k.x - 2.25, 2.1, k.z); screen.rotation.y = Math.PI / 2; label.position.set(k.x - 1.6, 3.3, k.z); }
      else if (k.face === -1) { screen.position.set(k.x + 2.25, 2.1, k.z); screen.rotation.y = -Math.PI / 2; label.position.set(k.x + 1.6, 3.3, k.z); }
      else { screen.position.set(k.x, 2.1, k.z + 2.25); screen.rotation.y = Math.PI; label.position.set(k.x, 3.3, k.z + 1.6); }
      s.add(screen, label);
      const pad = new THREE.Mesh(new THREE.CircleGeometry(1.1, 24), new THREE.MeshBasicMaterial({ color: k.color, transparent: true, opacity: 0.18 }));
      pad.rotation.x = -Math.PI / 2; pad.position.set(k.x, 0.02, k.z);
      s.add(pad);
    }
    // the lift
    const L = HUB.LIFT;
    this.liftRing = new THREE.Mesh(new THREE.RingGeometry(L.r - 0.25, L.r, 48), new THREE.MeshBasicMaterial({ color: 0x4cff7a, side: THREE.DoubleSide }));
    this.liftRing.rotation.x = -Math.PI / 2; this.liftRing.position.set(L.x, 0.03, L.z);
    const plat = new THREE.Mesh(new THREE.CylinderGeometry(L.r - 0.3, L.r - 0.3, 0.12, 40), new THREE.MeshLambertMaterial({ color: 0x5d6873 }));
    plat.position.set(L.x, 0.06, L.z);
    const sign = makeLabel('THE LIFT — TOPSIDE', '#4cff7a', 'squad up here · E to ready / deploy');
    sign.position.set(L.x, 5, L.z - 2.8); sign.scale.multiplyScalar(1.6);
    s.add(this.liftRing, plat, sign);
    this.dyn = new THREE.Group();
    s.add(this.dyn);
  }

  resize() {
    const w = innerWidth, h = innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h; this.camera.updateProjectionMatrix();
  }

  // ---------------------------------------------------------------- lifecycle
  enter() { this.net.send({ t: 'hub_enter' }); }

  start(m) {
    for (const o of this.others.values()) this.dyn.remove(o.h.group);
    this.others.clear();
    if (this.me?.h) this.dyn.remove(this.me.h.group);
    this.inst = m.inst;
    const h = makeHuman(0xd9822b, 0x7ff0ff);
    this.dyn.add(h.group);
    this.me = { nid: m.nid, x: m.x, z: m.z, yaw: m.yaw, pitch: -0.15, h, emote: null, emoteAt: 0 };
    for (const c of m.players) if (c.nid !== m.nid) this.addOther(c);
    this.active = true;
    $('#hub-inst').textContent = `${m.inst} · ${m.players.length}/${HUB.CAP}`;
  }

  stop() {
    this.active = false;
    document.exitPointerLock?.();
  }

  addOther(c) {
    if (this.others.has(c.nid)) return;
    const squad = this.ui.isSquad(c.pid);
    const h = makeHuman(squad ? 0x3d8ff0 : 0x8a7860, squad ? 0x7ff0ff : 0xff8a2a);
    const o = { ...c, h, buf: [], squad, flags: 0, emote: null, bubble: null };
    this.setLabel(o);
    this.dyn.add(h.group);
    this.others.set(c.nid, o);
  }

  setLabel(o) {
    if (o.label) o.h.group.remove(o.label);
    const ready = o.flags & 4;
    o.label = makeLabel(o.name, o.squad ? '#9fe0ff' : '#ffc24b', `Lv ${o.level}${ready ? ' · ✓ READY' : ''}`);
    o.label.position.y = 2.35;
    o.labelKey = `${o.squad}|${ready}`;
    o.h.group.add(o.label);
  }

  refreshSquadColors() {
    for (const o of this.others.values()) {
      const sq = this.ui.isSquad(o.pid);
      if (sq !== o.squad) {
        this.dyn.remove(o.h.group);
        const h = makeHuman(sq ? 0x3d8ff0 : 0x8a7860, sq ? 0x7ff0ff : 0xff8a2a);
        o.h = h; o.squad = sq; o.label = null;
        this.setLabel(o);
        this.dyn.add(h.group);
      }
    }
  }

  handle(m) {
    switch (m.t) {
      case 'hub_start': return this.start(m);
      case 'hub_add': this.addOther(m.p); this.updateCount(); return;
      case 'hub_rm': { const o = this.others.get(m.nid); if (o) { this.dyn.remove(o.h.group); this.others.delete(m.nid); } this.updateCount(); return; }
      case 'hub_pos': if (this.me) { this.me.x = m.x; this.me.z = m.z; } return;
      case 'hub_s': {
        const now = performance.now();
        for (const [nid, x, z, yaw, flags, em] of m.p) {
          if (this.me && nid === this.me.nid) continue;
          const o = this.others.get(nid);
          if (!o) continue;
          o.buf.push([now, x, z, yaw]);
          if (o.buf.length > 20) o.buf.shift();
          o.flags = flags;
          const e = em >= 0 ? EMOTES[em] : null;
          if (e !== o.emote) { o.emote = e; o.emoteAt = now / 1000; }
          if (o.labelKey !== `${o.squad}|${flags & 4}`) this.setLabel(o);
        }
        return;
      }
      case 'hub_chat': {
        this.chatLine(m);
        const o = m.nid != null ? (this.me?.nid === m.nid ? this.me : this.others.get(m.nid)) : null;
        if (o && m.ch === 'hub') this.bubble(o, m.text);
        return;
      }
    }
  }

  updateCount() { if (this.inst) $('#hub-inst').textContent = `${this.inst} · ${this.others.size + 1}/${HUB.CAP}`; }

  bubble(o, text) {
    if (o.bubble) o.h.group.remove(o.bubble);
    const t = text.length > 34 ? text.slice(0, 33) + '…' : text;
    o.bubble = makeLabel(t, '#ffffff');
    o.bubble.position.y = 2.95;
    o.h.group.add(o.bubble);
    const b = o.bubble;
    setTimeout(() => { if (o.bubble === b) { o.h.group.remove(b); o.bubble = null; } }, 6000);
  }

  chatLine(m) {
    const d = document.createElement('div');
    d.className = 'c' + (m.ch === 'party' ? ' party' : '');
    d.innerHTML = `<b>${m.ch === 'party' ? '[squad] ' : ''}${esc(m.from)}:</b> ${esc(m.text)}`;
    const box = $('#hub-chatlog');
    box.appendChild(d);
    while (box.children.length > 10) box.firstChild.remove();
    setTimeout(() => d.remove(), 30000);
  }

  // ---------------------------------------------------------------- input
  bind() {
    this.canvas.addEventListener('click', () => this.lock());
    $('#hub-click').addEventListener('click', () => this.lock());
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === this.canvas;
      if (!this.locked) this.keys.clear();
    });
    document.addEventListener('mousemove', (e) => {
      if (!this.locked || !this.active || !this.me) return;
      this.me.yaw -= e.movementX * this.sens;
      this.me.pitch = Math.max(-1.0, Math.min(0.8, this.me.pitch - e.movementY * this.sens));
    });
    document.addEventListener('keydown', (e) => {
      if (!this.active || this.ui.overlayOpen()) return;
      if (e.target?.tagName === 'INPUT') return;
      const k = e.code;
      if (k === 'Tab' || k === 'KeyI') { e.preventDefault(); this.ui.openTerminal(); return; }
      if (k === 'Enter') { this.openChat(); e.preventDefault(); return; }
      if (k === 'KeyO') { this.ui.toggleFriends(); return; }
      if (!this.locked) return;
      this.keys.add(k);
      if (e.repeat) return;
      if (k === 'KeyE') this.interact();
      const ei = ['Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5'].indexOf(k);
      if (ei >= 0) { this.net.send({ t: 'emote', e: EMOTES[ei] }); this.me.emote = EMOTES[ei]; this.me.emoteAt = performance.now() / 1000; }
      if (k === 'KeyC') this.me.crouch = !this.me.crouch;
    });
    document.addEventListener('keyup', (e) => this.keys.delete(e.code));
    const input = $('#hub-chatin');
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        let text = input.value.trim();
        if (text) {
          const party = /^\/p\s/i.test(text);
          if (party) text = text.slice(3).trim();
          if (text) this.net.send({ t: 'hub_chat', ch: party ? 'party' : 'hub', text });
        }
        input.value = ''; input.classList.add('hidden'); this.lock();
      } else if (e.key === 'Escape') { input.value = ''; input.classList.add('hidden'); }
    });
  }

  lock() {
    if (!this.active || this.ui.overlayOpen()) return;
    this.sfx.unlock();
    try { const r = this.canvas.requestPointerLock(); r?.catch?.(() => {}); } catch {}
  }

  openChat() {
    document.exitPointerLock?.();
    const i = $('#hub-chatin');
    i.classList.remove('hidden');
    setTimeout(() => i.focus(), 0);
  }

  interact() {
    const t = this.target;
    if (!t) return;
    if (t.kiosk) { this.sfx.ui(); this.ui.openTerminal(t.kiosk.tab); }
    else if (t.lift) this.ui.liftAction().run();
  }

  // ---------------------------------------------------------------- frame
  loop(t) {
    requestAnimationFrame(this.loop);
    const dt = Math.min(0.1, (t - this.last) / 1000);
    this.last = t;
    if (!this.active || !this.me) return;
    this.update(dt);
    this.renderer.render(this.scene, this.camera);
  }

  update(dt) {
    const me = this.me;
    const k = this.keys;
    const ctl = this.locked && !this.ui.overlayOpen();
    const f = ctl ? (k.has('KeyW') ? 1 : 0) - (k.has('KeyS') ? 1 : 0) : 0;
    const r = ctl ? (k.has('KeyD') ? 1 : 0) - (k.has('KeyA') ? 1 : 0) : 0;
    const speed = me.crouch ? C.CROUCH_SPEED : k.has('ShiftLeft') ? C.SPRINT_SPEED * 0.98 : C.WALK_SPEED;
    const moved = stepMove(this.world, me, { f, r, yaw: me.yaw }, dt, speed);
    if (moved) me.emote = null;
    this.sendAcc = (this.sendAcc ?? 0) + dt;
    if (this.sendAcc >= 1 / HUB.TICK) {
      this.sendAcc = 0;
      this.net.send({ t: 'hin', x: +me.x.toFixed(3), z: +me.z.toFixed(3), yaw: +me.yaw.toFixed(3), c: me.crouch ? 1 : 0 });
    }
    const now = performance.now() / 1000;
    me.h.group.position.set(me.x, 0, me.z);
    me.h.group.rotation.set(0, me.yaw, 0);
    animHuman(me.h, { moving: moved, crouch: me.crouch, dt, speed, armed: false, emote: me.emote, t: now - (me.emoteAt ?? 0) });
    if (me.emote && now - me.emoteAt > 8) me.emote = null;

    // camera
    const fwd = new THREE.Vector3(-Math.sin(me.yaw) * Math.cos(me.pitch), Math.sin(me.pitch), -Math.cos(me.yaw) * Math.cos(me.pitch));
    const right = new THREE.Vector3(Math.cos(me.yaw), 0, -Math.sin(me.yaw));
    const pivot = new THREE.Vector3(me.x, 1.7, me.z);
    const desired = pivot.clone().addScaledVector(right, 0.6).add(new THREE.Vector3(0, 0.45, 0)).addScaledVector(fwd, -4.2);
    const dir = desired.clone().sub(pivot); const len = dir.length(); dir.divideScalar(len);
    const hit = raycast(this.world, pivot.x, pivot.y, pivot.z, dir.x, dir.y, dir.z, len);
    const dist = hit.box !== -1 && hit.t < len ? Math.max(0.3, hit.t - 0.25) : len;
    this.camera.position.copy(pivot).addScaledVector(dir, dist);
    this.camera.rotation.set(me.pitch, me.yaw, 0, 'YXZ');

    // others (interpolated by arrival time)
    const rt = performance.now() - INTERP_MS;
    for (const o of this.others.values()) {
      const b = o.buf;
      if (!b.length) continue;
      let s = b[b.length - 1];
      for (let i = b.length - 1; i > 0; i--) {
        if (b[i - 1][0] <= rt && rt <= b[i][0]) {
          const a = b[i - 1], c = b[i], kk = (rt - a[0]) / Math.max(1, c[0] - a[0]);
          const dy = ((c[3] - a[3] + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
          s = [rt, a[1] + (c[1] - a[1]) * kk, a[2] + (c[2] - a[2]) * kk, a[3] + dy * kk];
          break;
        }
      }
      o.h.group.position.set(s[1], 0, s[2]);
      o.h.group.rotation.set(0, s[3], 0);
      animHuman(o.h, { moving: !!(o.flags & 1), crouch: !!(o.flags & 2), dt, speed: 4, armed: false, emote: o.emote, t: now - (o.emoteAt ?? 0) });
    }

    // interaction target
    let target = null;
    if (inLift(me.x, me.z)) target = { lift: true };
    else for (const kk of KIOSKS) if (Math.hypot(kk.x - me.x, kk.z - me.z) < 2.6) { target = { kiosk: kk }; break; }
    this.target = target;
    const pr = $('#hub-prompt');
    if (target) {
      pr.style.display = 'block';
      pr.innerHTML = `<kbd>E</kbd>${esc(target.kiosk ? target.kiosk.name : this.ui.liftAction().label)}`;
    } else pr.style.display = 'none';
    this.liftRing.material.color.setHex(inLift(me.x, me.z) ? 0xffc24b : 0x4cff7a);
    $('#hub-click').classList.toggle('hidden', this.locked || this.ui.overlayOpen() || !$('#hub-chatin').classList.contains('hidden'));
  }
}
