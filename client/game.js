// Raid client: Three.js rendering, third-person controls, prediction + interpolation, HUD.
import * as THREE from 'three';
import { C, ITEMS, WEAPONS, ENEMIES, POIS, AMMO_TYPES, AMMO_ORDER, countItem } from '/shared/data.js';
import { weaponStats, recoilPattern, decodeGear, gearKey, JAM_BELOW } from '/shared/gunsmith.js';
import { buildGun } from './guns.js';
import { Particles, Decals, Shells, LightPool, flashTexture, surfaceOf, boxNormal } from './fx.js';
import { generateWorld, KIND, raycast, stepMove, poiAt, raySphere } from '/shared/world.js';
import { $, esc, itemHTML, showMenu, hideMenu } from './ui.js';
import { makeHuman as buildHuman, makeLabel as buildLabel, animHuman, setGunModel } from './models.js';

const ENEMY_KEYS = Object.keys(ENEMIES);
const WEAPON_KEYS = Object.keys(WEAPONS);
const INTERP = 0.1; // seconds of interpolation delay for remote entities
const KIND_COLORS = {
  [KIND.wall]: 0x8d8173, [KIND.roof]: 0x5b5148, [KIND.rock]: 0x77716a, [KIND.crate]: 0x8b5a2b, [KIND.car]: 0x7d3f2b,
  [KIND.trunk]: 0x4b3625, [KIND.canopy]: 0x4d6a34, [KIND.concrete]: 0xa29d93, [KIND.metal]: 0x5d6873, [KIND.door]: 0xd9731f,
  [KIND.tower]: 0x6f7a82, [KIND.perimeter]: 0x3b3631,
};
const CONT_LOOK = {
  crate: [0.9, 0.6, 0.6, 0x9a6a3a], toolbox: [0.7, 0.4, 0.4, 0xb8322a], medbox: [0.6, 0.45, 0.35, 0xe8e4dc],
  weaponcase: [1.1, 0.35, 0.5, 0x5d6b3a], safe: [0.8, 0.9, 0.7, 0x3a3f45], cache: [0.9, 0.3, 0.9, 0x3d5a2a],
  body: [0.9, 0.3, 0.5, 0x2d2a26], wreck: [1.0, 0.4, 1.0, 0x4a4f55], bag: [0.6, 0.35, 0.4, 0xd8b23a],
};
const CONT_NAMES = { crate: 'Crate', toolbox: 'Toolbox', medbox: 'Med Cabinet', weaponcase: 'Weapon Case', safe: 'Safe', cache: 'Hidden Cache', body: 'Body', wreck: 'Wreck', bag: 'Bag' };
const EXTRACT_COLORS = { idle: 0x4cff7a, called: 0xffc24b, cooldown: 0x59b8ff, closed: 0xff4d4d };

export class Game {
  constructor(net, sfx, onExit) {
    this.net = net;
    this.sfx = sfx;
    this.onExit = onExit;
    this.world = generateWorld();
    this.canvas = $('#view');
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(72, 1, 0.1, 600);
    this.keys = new Set();
    this.mouse = { l: false, r: false };
    this.active = false;
    this.sens = +(localStorage.getItem('dmcheap_sens') || 0.0022);
    this.buildScene();
    this.bindInput();
    addEventListener('resize', () => this.resize());
    this.resize();
    this.drawStaticMap();
    this.loop = this.loop.bind(this);
    this.lastFrame = performance.now();
    requestAnimationFrame(this.loop);
  }

  // ================================================================ scene
  buildScene() {
    const s = this.scene;
    const sky = 0xc79b74;
    s.background = new THREE.Color(sky);
    s.fog = new THREE.Fog(sky, 70, 300);
    s.add(new THREE.HemisphereLight(0xffe2c4, 0x3e332a, 1.1));
    const sun = new THREE.DirectionalLight(0xffd0a0, 1.9);
    sun.position.set(60, 90, 40);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const sc = sun.shadow.camera;
    sc.left = -70; sc.right = 70; sc.top = 70; sc.bottom = -70; sc.near = 10; sc.far = 250;
    sun.shadow.bias = -0.0005;
    s.add(sun); s.add(sun.target);
    this.sun = sun;

    // ground
    const cv = document.createElement('canvas');
    cv.width = cv.height = 256;
    const g = cv.getContext('2d');
    g.fillStyle = '#8a7a62'; g.fillRect(0, 0, 256, 256);
    for (let i = 0; i < 3000; i++) {
      const v = 110 + Math.random() * 40 | 0;
      g.fillStyle = `rgba(${v},${v - 12},${v - 30},0.35)`;
      g.fillRect(Math.random() * 256, Math.random() * 256, 2 + Math.random() * 3, 2 + Math.random() * 3);
    }
    const tex = new THREE.CanvasTexture(cv);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(60, 60);
    tex.colorSpace = THREE.SRGBColorSpace;
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(440, 440), new THREE.MeshLambertMaterial({ map: tex }));
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    s.add(ground);
    for (const p of POIS) {
      const pad = new THREE.Mesh(new THREE.CircleGeometry(p.r + 4, 40), new THREE.MeshLambertMaterial({ color: 0x5f574d }));
      pad.rotation.x = -Math.PI / 2; pad.position.set(p.x, 0.02, p.z); pad.receiveShadow = true;
      s.add(pad);
    }

    // static boxes, instanced per kind
    const byKind = new Map();
    this.doorMeshes = new Map();
    const unit = new THREE.BoxGeometry(1, 1, 1);
    unit.translate(0, 0.5, 0);
    this.world.boxes.forEach((b) => {
      if (b.k === KIND.door) {
        const m = new THREE.Mesh(unit, new THREE.MeshLambertMaterial({ color: KIND_COLORS[KIND.door], emissive: 0x3a1a00 }));
        m.position.set((b.x0 + b.x1) / 2, b.y0, (b.z0 + b.z1) / 2);
        m.scale.set(b.x1 - b.x0, b.y1 - b.y0, b.z1 - b.z0);
        m.castShadow = m.receiveShadow = true;
        s.add(m);
        this.doorMeshes.set(b.door, m);
        return;
      }
      if (!byKind.has(b.k)) byKind.set(b.k, []);
      byKind.get(b.k).push(b);
    });
    const mtx = new THREE.Matrix4(), col = new THREE.Color();
    for (const [k, list] of byKind) {
      const mat = new THREE.MeshLambertMaterial({ color: 0xffffff });
      const im = new THREE.InstancedMesh(unit, mat, list.length);
      list.forEach((b, i) => {
        mtx.makeScale(b.x1 - b.x0, b.y1 - b.y0, b.z1 - b.z0);
        mtx.setPosition((b.x0 + b.x1) / 2, b.y0, (b.z0 + b.z1) / 2);
        im.setMatrixAt(i, mtx);
        col.setHex(KIND_COLORS[k] ?? 0x888888).multiplyScalar(0.9 + Math.random() * 0.2);
        im.setColorAt(i, col);
      });
      im.castShadow = k !== KIND.perimeter;
      im.receiveShadow = true;
      s.add(im);
    }

    // static containers
    this.contMeshes = new Map();
    for (const c of this.world.containers) this.addContainerMesh(c.id, c.type, c.x, c.z);

    this.dynamic = new THREE.Group();
    s.add(this.dynamic);
    this.fxGroup = new THREE.Group();
    s.add(this.fxGroup);
    this.fx = [];
    this.sparks = new Particles(s, 700, true);
    this.dust = new Particles(s, 700, false);
    this.decals = new Decals(s);
    this.shells = new Shells(s);
    this.lights = new LightPool(s, 4);
    this.flashMat = new THREE.SpriteMaterial({ map: flashTexture(), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true });
  }

  addContainerMesh(id, type, x, z) {
    const [w, h, d, color] = CONT_LOOK[type] ?? CONT_LOOK.crate;
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), new THREE.MeshLambertMaterial({ color, emissive: 0x2a1600 }));
    m.position.set(x, h / 2, z);
    m.rotation.y = (id * 1.37) % Math.PI;
    m.castShadow = true;
    this.scene.add(m);
    this.contMeshes.set(id, m);
    return m;
  }

  setContainerOpened(id) {
    const m = this.contMeshes.get(id);
    if (m) { m.material.color.multiplyScalar(0.55); m.material.emissive.setHex(0x000000); }
  }

  makeHuman(color, visor) { return buildHuman(color, visor); }

  makeEnemy(type) {
    const g = new THREE.Group();
    const metal = new THREE.MeshLambertMaterial({ color: 0x4e5258 });
    const eyeMat = new THREE.MeshBasicMaterial({ color: 0xffd27a });
    let rotors = null, core = null;
    const add = (geo, mat, x, y, z) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); m.castShadow = true; g.add(m); return m; };
    if (type === 'gnat') {
      add(new THREE.SphereGeometry(0.32, 10, 8), metal, 0, 0, 0);
      add(new THREE.SphereGeometry(0.1, 6, 6), eyeMat, 0, 0, -0.3);
      rotors = [];
      for (const [x, z] of [[-0.45, -0.45], [0.45, -0.45], [-0.45, 0.45], [0.45, 0.45]]) rotors.push(add(new THREE.CylinderGeometry(0.22, 0.22, 0.02, 10), new THREE.MeshBasicMaterial({ color: 0x222222, transparent: true, opacity: 0.6 }), x, 0.12, z));
    } else if (type === 'squealer') {
      add(new THREE.OctahedronGeometry(0.6), new THREE.MeshLambertMaterial({ color: 0xc9a227 }), 0, 0, 0);
      add(new THREE.SphereGeometry(0.16, 8, 6), eyeMat, 0, 0, -0.5);
    } else if (type === 'tick') {
      add(new THREE.BoxGeometry(0.9, 0.35, 0.9), new THREE.MeshLambertMaterial({ color: 0x6a3a2a }), 0, 0.45, 0);
      for (const [x, z] of [[-0.5, -0.4], [0.5, -0.4], [-0.5, 0.4], [0.5, 0.4]]) add(new THREE.BoxGeometry(0.12, 0.4, 0.12), metal, x, 0.2, z);
      add(new THREE.SphereGeometry(0.1, 6, 6), eyeMat, 0, 0.5, -0.46);
    } else if (type === 'sentry') {
      add(new THREE.CylinderGeometry(0.8, 0.9, 0.8, 12), metal, 0, 0.4, 0);
      add(new THREE.BoxGeometry(1.2, 0.7, 1.2), new THREE.MeshLambertMaterial({ color: 0x6b6f45 }), 0, 1.3, 0);
      add(new THREE.BoxGeometry(0.16, 0.16, 1.2), metal, 0.25, 1.3, -1.0);
      add(new THREE.BoxGeometry(0.16, 0.16, 1.2), metal, -0.25, 1.3, -1.0);
      add(new THREE.BoxGeometry(0.4, 0.15, 0.06), eyeMat, 0, 1.5, -0.62);
      add(new THREE.BoxGeometry(0.8, 0.4, 0.05), new THREE.MeshBasicMaterial({ color: 0xff6a00 }), 0, 1.3, 0.62);
    } else if (type === 'merc') {
      const h = this.makeHuman(0x55503f, 0xff3030);
      h.group.userData.human = h;
      setGunModel(h, buildGun({ id: 'ranger', att: {} }));
      return { group: h.group, eyeMat: h.visor.material, human: h };
    } else if (type === 'warden') {
      add(new THREE.BoxGeometry(3.4, 2.2, 4.0), new THREE.MeshLambertMaterial({ color: 0x5a4f45 }), 0, 3.2, 0);
      add(new THREE.BoxGeometry(1.4, 1.0, 1.4), metal, 0, 4.4, -1.6);
      add(new THREE.BoxGeometry(0.9, 0.25, 0.1), eyeMat, 0, 4.5, -2.32);
      add(new THREE.BoxGeometry(0.3, 0.3, 2.4), metal, 1.9, 3.4, -1.6);
      add(new THREE.BoxGeometry(0.3, 0.3, 2.4), metal, -1.9, 3.4, -1.6);
      for (const [x, z] of [[-1.5, -1.6], [1.5, -1.6], [-1.5, 1.6], [1.5, 1.6]]) add(new THREE.BoxGeometry(0.5, 2.4, 0.5), metal, x, 1.2, z);
      core = add(new THREE.SphereGeometry(0.75, 14, 10), new THREE.MeshBasicMaterial({ color: 0x40d0ff }), 0, 4.1, 2.2);
    }
    return { group: g, eyeMat, rotors, core };
  }

  makeLabel(text, color) { return buildLabel(text, color); }

  // ================================================================ raid lifecycle
  start(m) {
    this.clearRaid();
    this.active = true;
    this.raidId = m.raid;
    this.nid = m.nid;
    this.me = {
      x: m.x, z: m.z, yaw: m.yaw, pitch: 0, crouch: false, hp: m.hp, mhp: m.maxHp, sh: 0, shc: 0, st: 100, aw: 0, mag: 0, res: 0,
      state: 'alive', eye: C.EYE_STAND,
    };
    this.serverTime = m.time;
    this.timeOffset = m.time - performance.now() / 1000;
    this.duration = m.duration;
    this.names = new Map(m.names);
    this.squad = new Map(m.squad.map(x => [x.nid, x.name]));
    this.remotes = new Map();
    this.enemies = new Map();
    this.inv = null;
    this.loot = null;
    this.action = null;
    this.pings = [];
    this.wantedList = [];
    this.lastShot = 0;
    this.lastShotSent = 0;
    this.bloom = 0;
    this.shoulder = 1;
    this.adsT = 0;
    this.localMag = null;
    this.firedThisClick = false;
    this.sendAcc = 0;
    this.hudAcc = 0;
    this.extracts = m.extracts.map(e => ({ ...e }));
    this.hatches = m.hatches.map(h => ({ ...h }));
    this.dynConts = new Map();
    for (const [id, open] of Object.entries(m.doors ?? {})) if (open) this.openDoor(id);
    for (const id of m.opened) this.setContainerOpened(id);
    for (const c of m.dyn) this.addDyn(c);
    this.buildExtractMeshes();
    this.player = this.makeHuman(0xd9822b, 0x7ff0ff);
    this.myGunKey = null; this.myGun = null; this.burstLeft = 0; this.recoilAcc = 0; this.sprayN = 0; this.reloadAnim = null; this.cycleAnim = null;
    this.dynamic.add(this.player.group);
    $('#raid').classList.remove('hidden');
    $('#end').classList.add('hidden');
    $('#inv').classList.add('hidden');
    $('#mapov').classList.add('hidden');
    $('#downed').classList.add('hidden');
    $('#feed').innerHTML = '';
    $('#chatlog').innerHTML = '';
    this.feed(`Deployed. Open lifts: ${this.extracts.map(e => e.name).join(', ')}`, 'warn');
    this.requestLock();
    this.resize();
  }

  clearRaid() {
    this.decals?.clear();
    for (const c of this.dynamic.children.slice()) this.dynamic.remove(c);
    for (const c of this.fxGroup.children.slice()) this.fxGroup.remove(c);
    this.fx = [];
    // restore static state
    for (const [, m] of this.doorMeshes) m.visible = true;
    for (const c of this.world.containers) {
      const m = this.contMeshes.get(c.id);
      const look = CONT_LOOK[c.type];
      m.material.color.setHex(look[3]); m.material.emissive.setHex(0x2a1600);
    }
    for (const [id, m] of this.contMeshes) if (id >= 10000) { this.scene.remove(m); this.contMeshes.delete(id); }
    this.world.doorOpen = {};
  }

  exit() {
    if (this.spectating) this.net.send({ t: 'spectate', on: false });
    this.spectating = false;
    $('#spec-hud')?.remove();
    $('#hud').classList.remove('spectating');
    this.active = false;
    document.exitPointerLock?.();
    $('#raid').classList.add('hidden');
    this.clearRaid();
    this.onExit();
  }

  buildExtractMeshes() {
    for (const e of this.extracts) {
      const g = new THREE.Group();
      const color = EXTRACT_COLORS[e.closed ? 'closed' : e.state] ?? 0x4cff7a;
      const ring = new THREE.Mesh(new THREE.RingGeometry(C.EXTRACT_RADIUS - 0.4, C.EXTRACT_RADIUS, 48), new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide, transparent: true, opacity: 0.8 }));
      ring.rotation.x = -Math.PI / 2; ring.position.y = 0.05;
      const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.6, 0.6, 60, 12, 1, true), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.25, depthWrite: false }));
      beam.position.y = 30;
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.5, 1.4, 0.5), new THREE.MeshLambertMaterial({ color: 0x333333, emissive: color, emissiveIntensity: 0.4 }));
      post.position.y = 0.7;
      g.add(ring, beam, post);
      g.position.set(e.x, 0, e.z);
      this.dynamic.add(g);
      e.mesh = g; e.ring = ring; e.beam = beam; e.post = post;
    }
    for (const h of this.hatches) {
      const m = new THREE.Mesh(new THREE.CylinderGeometry(0.8, 0.8, 0.15, 16), new THREE.MeshLambertMaterial({ color: h.used ? 0x333333 : 0x8a8f55, emissive: h.used ? 0 : 0x222200 }));
      m.position.set(h.x, 0.08, h.z);
      this.dynamic.add(m);
      h.mesh = m;
    }
  }

  setExtractState(e) {
    const color = EXTRACT_COLORS[e.closed ? 'closed' : e.state] ?? 0x4cff7a;
    e.ring.material.color.setHex(color); e.beam.material.color.setHex(color); e.post.material.emissive.setHex(color);
  }

  openDoor(id) {
    this.world.doorOpen[id] = true;
    const m = this.doorMeshes.get(id);
    if (m) m.visible = false;
  }

  addDyn(c) {
    this.dynConts.set(c.id, c);
    const m = this.addContainerMesh(c.id, c.type, c.x, c.z);
    m.material.emissive.setHex(c.type === 'body' ? 0x330000 : 0x1a1a00);
  }

  // ================================================================ network handlers
  handle(m) {
    if (!this.active && m.t !== 'raid_start') return;
    switch (m.t) {
      case 's': return this.onSnap(m);
      case 'inv': this.inv = m; this.syncMyGun(); if (!$('#inv').classList.contains('hidden')) this.renderInv(); return;
      case 'jam': this.sfx.click(); this.feed('JAMMED — press R to clear', 'warn'); return;
      case 'pos': this.me.x = m.x; this.me.z = m.z; return;
      case 'fx': return this.onFx(m);
      case 'hit': return this.onHit(m);
      case 'dmg': return this.onDmg(m);
      case 'msg': return this.feed(m.text, m.kind);
      case 'feed': return this.feed(m.text);
      case 'chat': return this.chatLine(m);
      case 'loot': {
        const wasOpen = this.loot?.id === m.id;
        this.loot = m;
        if (!wasOpen) { this.openInv(); }
        else if (!$('#inv').classList.contains('hidden')) this.renderInv();
        return;
      }
      case 'cont_add': return this.addDyn(m.c);
      case 'cont_rm': {
        const mesh = this.contMeshes.get(m.id);
        if (mesh) { this.scene.remove(mesh); this.contMeshes.delete(m.id); }
        this.dynConts.delete(m.id);
        if (this.loot?.id === m.id) { this.loot = null; if (!$('#inv').classList.contains('hidden')) this.renderInv(); }
        return;
      }
      case 'cont_open': return this.setContainerOpened(m.id);
      case 'door': this.openDoor(m.id); this.sfx.boom(0.2); return;
      case 'extract': {
        const e = this.extracts.find(x => x.id === m.id);
        if (!e) return;
        e.state = m.state; if (m.state === 'closed') e.closed = true;
        e.t = m.tt ?? 0; e.tAt = performance.now() / 1000;
        this.setExtractState(e);
        if (m.state === 'called') { this.feed(`${m.by} called the lift at ${e.name} — ${Math.round(e.t)}s`, 'warn'); this.sfx.horn(); }
        if (m.state === 'cooldown' && m.n) this.feed(`Lift departed ${e.name} with ${m.n} raider(s)`);
        return;
      }
      case 'hatch': {
        const h = this.hatches.find(x => x.id === m.id);
        if (h) { h.used = true; h.mesh.material.color.setHex(0x333333); h.mesh.material.emissive.setHex(0); }
        return;
      }
      case 'action': {
        if (!m.a) { this.action = null; return; }
        this.action = { a: m.a, id: m.id, dur: m.dur, start: performance.now() / 1000 };
        if (m.a === 'reload') { this.sfx.reload(this.currentWeapon()?.w.cls); this.reloadAnim = { start: this.now, dur: m.dur }; }
        if (m.a === 'unjam') { this.sfx.rack(); this.reloadAnim = { start: this.now, dur: m.dur, rack: true }; }
        return;
      }
      case 'downed': this.me.state = 'downed'; this.feed(m.canSelf ? 'DOWNED — press X to use your tourniquet' : 'DOWNED — hold on for a squadmate', 'warn'); return;
      case 'revived': this.me.state = 'alive'; this.feed('Back on your feet'); return;
      case 'ping': this.addPing(m); return;
      case 'raid_end': return this.onEnd(m);
      case 'names': for (const [nid, name] of m.add) this.names.set(nid, name); return;
      case 'squad': this.squad = new Map(m.squad.map(x => [x.nid, x.name])); return;
      case 'spec': this.specNid = m.nid; this.specName = m.name; this.spectating = true; $('#end').classList.add('hidden'); return;
      case 'spec_end': {
        if (!this.spectating) return;
        this.spectating = false;
        $('#spec-hud')?.remove();
        $('#hud').classList.remove('spectating');
        this.feed('Nobody left to spectate', 'warn');
        this.showEnd(false);
        return;
      }
    }
  }

  get now() { return performance.now() / 1000; }
  get serverNow() { return this.now + this.timeOffset; }

  onSnap(m) {
    const sample = m.tm - this.now;
    this.timeOffset += (sample - this.timeOffset) * (sample > this.timeOffset ? 0.3 : 0.05);
    this.serverTime = m.tm;
    const seenP = new Set();
    for (const a of m.p) {
      const [nid, x, z, yaw, pitch, flags, wi, hp] = a;
      seenP.add(nid);
      let r = this.remotes.get(nid);
      if (!r) {
        const sq = !!(flags & 128);
        const h = this.makeHuman(sq ? 0x3d8ff0 : 0x7b6a58, sq ? 0x7ff0ff : 0xff8a2a);
        r = { nid, h, buf: [], name: this.names.get(nid) ?? '?', squad: sq };
        this.dynamic.add(h.group);
        this.remotes.set(nid, r);
      }
      if (r.squad) {
        const nm = this.squad.get(nid) ?? this.names.get(nid) ?? r.name;
        if (r.labelName !== nm) {
          if (r.label) r.h.group.remove(r.label);
          r.label = this.makeLabel(nm, '#9fe0ff'); r.label.position.y = 2.25; r.h.group.add(r.label); r.labelName = nm;
        }
      }
      r.buf.push([m.tm, x, z, yaw, pitch]);
      if (r.buf.length > 30) r.buf.shift();
      r.flags = flags; r.hp = hp;
      if (r.gk !== wi) {
        r.gk = wi;
        const gear = decodeGear(wi);
        r.gun = gear ? buildGun(gear) : null;
        r.suppressed = !!(gear && weaponStats(gear).suppressed);
        setGunModel(r.h, r.gun);
      }
      if ((flags & 16) && !r.wantedLabel) { r.wantedLabel = this.makeLabel('WANTED', '#ff4d4d'); r.wantedLabel.position.y = 2.6; r.h.group.add(r.wantedLabel); }
    }
    for (const [nid, r] of this.remotes) if (!seenP.has(nid)) { this.dynamic.remove(r.h.group); this.remotes.delete(nid); }
    const seenE = new Set();
    for (const a of m.e) {
      const [id, ti, x, y, z, yaw, st, hp] = a;
      seenE.add(id);
      let e = this.enemies.get(id);
      if (!e) {
        const type = ENEMY_KEYS[ti];
        const mk = this.makeEnemy(type);
        e = { id, type, mk, buf: [] };
        this.dynamic.add(mk.group);
        this.enemies.set(id, e);
      }
      e.buf.push([m.tm, x, z, yaw, 0, y]);
      if (e.buf.length > 30) e.buf.shift();
      e.st = st; e.hp = hp;
    }
    for (const [id, e] of this.enemies) if (!seenE.has(id)) { this.dynamic.remove(e.mk.group); this.enemies.delete(id); }
    const me = m.me;
    if (me.s === 'spec') { this.specNid = me.tgt; this.wantedList = m.w ?? []; return; }
    Object.assign(this.me, { hp: me.hp, mhp: me.mhp, sh: me.sh, shc: me.shc, st: me.st, aw: me.aw, res: me.res, state: me.s, dh: me.dh, wanted: me.wanted, jam: !!me.jam, at: me.at, du: me.du });
    if (this.localMag == null || this.now - this.lastShot > 0.4) this.localMag = me.mag;
    this.wantedList = m.w ?? [];
  }

  sample(buf, t) {
    if (!buf.length) return null;
    if (t <= buf[0][0]) return buf[0];
    for (let i = buf.length - 1; i > 0; i--) {
      const a = buf[i - 1], b = buf[i];
      if (a[0] <= t && t <= b[0]) {
        const k = (t - a[0]) / Math.max(1e-6, b[0] - a[0]);
        const out = a.map((v, j) => j === 3 ? lerpAngle(v, b[j], k) : v + (b[j] - v) * k);
        return out;
      }
    }
    return buf[buf.length - 1];
  }

  onFx(m) {
    const meX = this.me.x, meZ = this.me.z;
    if (m.k === 'shot') {
      if (m.nid === this.nid) return;
      const d = Math.hypot(m.o[0] - meX, m.o[2] - meZ);
      const r = [...this.remotes.values()].find(x => x.nid === m.nid);
      const mz = r?.gun ? r.gun.muzzle.getWorldPosition(new THREE.Vector3()).toArray() : m.o;
      this.sfx.shot(m.w, Math.max(0, 1 - d / (m.sup ? 60 : 160)), { suppressed: !!m.sup, dist: d });
      for (const e of m.e) { this.tracer(mz, e, 0xffd27a, m.sup ? 0.35 : 0.9); this.impactAlong(m.o, e); }
      if (!m.sup) this.muzzleFlash(mz, WEAPONS[m.w]?.cls);
      if (r?.gun) r.kick = 1;
    } else if (m.k === 'eshot') {
      const d = Math.hypot(m.o[0] - meX, m.o[2] - meZ);
      const en = this.enemies.get(m.id);
      this.sfx.shot(en?.type === 'merc' ? 'merc' : 'machine', Math.max(0, 1 - d / 120) * 0.8);
      this.tracer(m.o, m.e, en?.type === 'merc' ? 0xffd27a : 0xff5a3a);
      this.impactAlong(m.o, m.e);
      if (en?.type === 'merc' || d < 60) this.muzzleFlash(m.o, en?.type === 'merc' ? 'Rifle' : 'machine');
    } else if (m.k === 'boom') {
      const d = Math.hypot(m.x - meX, m.z - meZ);
      this.sfx.boom(Math.max(0.05, 1 - d / 150));
      this.explosion(m.x, m.y, m.z, m.r ?? 4);
    } else if (m.k === 'pop' || m.k === 'die') {
      if (m.k === 'pop') this.explosion(m.x, m.y, m.z, m.big ? 6 : 1.5);
    } else if (m.k === 'alarm') {
      const d = Math.hypot(m.x - meX, m.z - meZ);
      this.sfx.alarm(Math.max(0.1, 1 - d / 100));
      this.feed('A Squealer is calling reinforcements!', 'warn');
    } else if (m.k === 'mark') {
      const ring = new THREE.Mesh(new THREE.RingGeometry(0.2, 4.5, 32), new THREE.MeshBasicMaterial({ color: 0xff2a2a, transparent: true, opacity: 0.35, side: THREE.DoubleSide, depthWrite: false }));
      ring.rotation.x = -Math.PI / 2; ring.position.set(m.x, 0.08, m.z);
      this.fxGroup.add(ring);
      this.fx.push({ obj: ring, life: m.dur, max: m.dur, kind: 'mark' });
    }
  }

  onHit(m) {
    const el = $('#hitmarker');
    el.style.color = m.k === 'kill' ? '#ff3b3b' : m.k === 'head' || m.k === 'weak' ? '#ffc24b' : m.k === 'shield' ? '#59b8ff' : '#fff';
    el.style.opacity = 1;
    clearTimeout(this.hmT);
    this.hmT = setTimeout(() => { el.style.opacity = 0; }, m.k === 'kill' ? 350 : 140);
    this.sfx.hit(m.k);
  }

  onDmg(m) {
    this.sfx.hurt();
    const a = Math.atan2(-(m.x - this.me.x), -(m.z - this.me.z));
    const rel = a - this.me.yaw;
    const d = document.createElement('div');
    d.className = 'd';
    d.style.transform = `rotate(${-rel}rad)`;
    $('#dmg-ind').appendChild(d);
    requestAnimationFrame(() => { d.style.opacity = 0; });
    setTimeout(() => d.remove(), 900);
  }

  onEnd(m) {
    document.exitPointerLock?.();
    this.me.state = m.extracted ? 'extracted' : 'dead';
    this.endMsg = m;
    this.showEnd(!!m.canSpectate);
  }

  showEnd(canSpectate) {
    const m = this.endMsg;
    const r = m.report ?? {};
    const el = $('#end');
    el.innerHTML = `<div class="card"><h2 class="${m.extracted ? 'ok' : 'bad'}">${m.extracted ? 'EXTRACTED' : 'KILLED IN ACTION'}</h2>
      <div class="cost">${esc(m.how ?? '')}</div>
      <div class="kv"><b>XP earned</b><span>${r.xp ?? 0}</span><b>Loot value</b><span>$${(r.value ?? 0).toLocaleString()}</span>
      <b>Kills</b><span>${r.kills?.total ?? 0} (${r.pkills ?? 0} raiders)</span><b>Time topside</b><span>${Math.floor((r.duration ?? 0) / 60)}m ${(r.duration ?? 0) % 60}s</span></div>
      ${(r.notes ?? []).map(n => `<div class="cost">• ${esc(n)}</div>`).join('')}
      <div class="row">${canSpectate ? '<button class="btn big" id="end-spec" style="background:#59b8ff">Spectate squad</button>' : ''}
      <button class="btn big" id="end-back">Back to The Cheap Seats</button></div></div>`;
    el.classList.remove('hidden');
    $('#inv').classList.add('hidden');
    $('#end-back').onclick = () => this.exit();
    const sp = $('#end-spec');
    if (sp) sp.onclick = () => { this.net.send({ t: 'spectate', on: true }); el.classList.add('hidden'); };
  }

  // follow cam for spectating a squadmate: borrow their interpolated pose
  followSpectate() {
    $('#hud').classList.add('spectating');
    const r = this.remotes.get(this.specNid);
    let hud = $('#spec-hud');
    if (!hud) { hud = document.createElement('div'); hud.id = 'spec-hud'; $('#hud').appendChild(hud); }
    hud.innerHTML = `SPECTATING <b>${esc(this.squad.get(this.specNid) ?? this.specName ?? '')}</b>${r ? ` · ${r.hp}% HP${r.flags & 8 ? ' · DOWNED' : ''}` : ''}<br><small><kbd>Space</kbd> next squadmate · <kbd>Esc</kbd> back to hub</small>`;
    if (!r) return;
    const s = this.sample(r.buf, this.serverNow - INTERP);
    if (!s) return;
    const me = this.me;
    me.x = s[1]; me.z = s[2]; me.yaw = s[3]; me.pitch = s[4] * 0.6;
    me.eye = r.flags & 8 ? 0.6 : r.flags & 1 ? C.EYE_CROUCH : C.EYE_STAND;
    me.hp = r.hp; me.mhp = 100;
  }

  // ================================================================ effects
  tracer(a, b, color, opacity = 0.9) {
    const geo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(...a), new THREE.Vector3(...b)]);
    const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ color, transparent: true, opacity }));
    this.fxGroup.add(line);
    this.fx.push({ obj: line, life: 0.08, max: 0.08, kind: 'fade', o0: opacity });
  }
  muzzleFlash(p, cls) {
    const sp = new THREE.Sprite(this.flashMat);
    const sz = cls === 'Pistol' || cls === 'SMG' ? 0.35 : cls === 'machine' ? 0.3 : cls === 'Shotgun' || cls === 'Sniper' || cls === 'LMG' ? 0.75 : 0.55;
    sp.scale.set(sz, sz, sz);
    sp.material.rotation = Math.random() * Math.PI;
    sp.position.set(...p);
    this.fxGroup.add(sp);
    this.fx.push({ obj: sp, life: 0.045, max: 0.045, kind: 'sprite' });
    this.lights.flash(p[0], p[1], p[2], 0xffc070, 6, 0.06, 7);
  }
  // Raycast the last stretch of a shot locally to find the surface, then spawn the right impact
  impactAlong(o, e) {
    const dx = e[0] - o[0], dy = e[1] - o[1], dz = e[2] - o[2];
    const len = Math.hypot(dx, dy, dz);
    if (len < 0.5 || Math.hypot(e[0] - this.me.x, e[2] - this.me.z) > 120) return;
    const hit = raycast(this.world, o[0], o[1], o[2], dx / len, dy / len, dz / len, len + 0.3);
    if (hit.box === -1 || Math.abs(hit.t - len) > 0.6) return; // ended in a body or mid-air
    const p = new THREE.Vector3(o[0] + dx / len * hit.t, o[1] + dy / len * hit.t, o[2] + dz / len * hit.t);
    this.impact(p, boxNormal(this.world, hit.box, p), surfaceOf(this.world, hit.box));
  }
  impact(p, n, surface) {
    const rnd = (k) => (Math.random() - 0.5) * k;
    if (surface === 'metal') {
      for (let i = 0; i < 9; i++) this.sparks.emit(p.x, p.y, p.z, n.x * 3 + rnd(5), n.y * 3 + rnd(5) + 1, n.z * 3 + rnd(5), { color: 0xffc860, size: 0.05, life: 0.25 + Math.random() * 0.2, grav: 12 });
    } else {
      const col = { dirt: 0x6e5a40, wood: 0x7a5530, leaf: 0x4d6a34, rock: 0x8a847a, concrete: 0x9a9286 }[surface] ?? 0x8a847a;
      for (let i = 0; i < 6; i++) this.dust.emit(p.x, p.y, p.z, n.x * 1.5 + rnd(1.5), n.y * 1.5 + rnd(1.5) + 0.6, n.z * 1.5 + rnd(1.5), { color: col, size: 0.12, life: 0.5 + Math.random() * 0.4, grav: 3, grow: 0.25 });
      if (surface === 'concrete' || surface === 'rock') for (let i = 0; i < 3; i++) this.sparks.emit(p.x, p.y, p.z, n.x * 2 + rnd(3), n.y * 2 + rnd(3), n.z * 2 + rnd(3), { color: 0xffe0a0, size: 0.03, life: 0.12, grav: 10 });
    }
    if (surface !== 'leaf') this.decals.add(p, n);
  }
  flash(p) {
    const s = new THREE.Mesh(new THREE.SphereGeometry(0.18, 6, 4), new THREE.MeshBasicMaterial({ color: 0xffe08a, transparent: true }));
    s.position.set(...p);
    this.fxGroup.add(s);
    this.fx.push({ obj: s, life: 0.05, max: 0.05, kind: 'fade' });
  }
  explosion(x, y, z, r) {
    const s = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 12), new THREE.MeshBasicMaterial({ color: 0xffa040, transparent: true, opacity: 0.9, depthWrite: false }));
    s.position.set(x, y, z);
    this.fxGroup.add(s);
    this.fx.push({ obj: s, life: 0.5, max: 0.5, kind: 'boom', r });
    this.lights.flash(x, y + 1, z, 0xff9a40, 30, 0.3, r * 6);
    for (let i = 0; i < 18; i++) this.dust.emit(x, y, z, (Math.random() - 0.5) * 8, Math.random() * 6, (Math.random() - 0.5) * 8, { color: 0x4a443c, size: 0.5, life: 1.2, grav: 2, grow: 1.2 });
    for (let i = 0; i < 20; i++) this.sparks.emit(x, y, z, (Math.random() - 0.5) * 14, Math.random() * 10, (Math.random() - 0.5) * 14, { color: 0xffb040, size: 0.08, life: 0.5, grav: 12 });
  }
  addPing(m) {
    const g = new THREE.Mesh(new THREE.ConeGeometry(0.4, 1.2, 4), new THREE.MeshBasicMaterial({ color: 0x9fe0ff, depthTest: false, transparent: true }));
    g.rotation.x = Math.PI;
    g.position.set(m.x, (m.y ?? 0) + 2.2, m.z);
    g.renderOrder = 11;
    this.fxGroup.add(g);
    this.fx.push({ obj: g, life: 10, max: 10, kind: 'ping' });
    this.pings.push({ x: m.x, z: m.z, until: this.now + 10 });
    this.sfx.ui();
    this.feed(`${m.nid === this.nid ? 'You' : this.squad.get(m.nid) ?? 'Squad'} pinged a location`);
  }
  updateFx(dt) {
    for (let i = this.fx.length - 1; i >= 0; i--) {
      const f = this.fx[i];
      f.life -= dt;
      const k = Math.max(0, f.life / f.max);
      if (f.kind === 'fade') f.obj.material.opacity = k * (f.o0 ?? 1);
      else if (f.kind === 'sprite') { /* shared material: just expire */ }
      else if (f.kind === 'boom') { f.obj.scale.setScalar(f.r * (1 - k * 0.7)); f.obj.material.opacity = k; }
      else if (f.kind === 'light') f.obj.intensity = 30 * k;
      else if (f.kind === 'mark') { f.obj.material.opacity = 0.2 + (1 - k) * 0.5; }
      else if (f.kind === 'ping') { f.obj.position.y += Math.sin(this.now * 4) * 0.005; f.obj.rotation.y += dt * 2; }
      if (f.life <= 0) {
        this.fxGroup.remove(f.obj);
        if (f.kind !== 'sprite') { f.obj.geometry?.dispose(); f.obj.material?.dispose(); }
        this.fx.splice(i, 1);
      }
    }
  }

  // ================================================================ input
  bindInput() {
    this.canvas.addEventListener('click', () => { if (this.active && !this.overlayOpen()) this.requestLock(); });
    $('#clickto').addEventListener('click', () => this.requestLock());
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === this.canvas;
      if (!this.locked) { this.mouse.l = this.mouse.r = false; this.keys.clear(); }
    });
    document.addEventListener('mousemove', (e) => {
      if (!this.locked || !this.active) return;
      const s = this.sens * (this.adsT > 0.5 ? 0.6 : 1) * (this.zoomSens ?? 1);
      this.me.yaw -= e.movementX * s;
      this.me.pitch = Math.max(-1.35, Math.min(1.2, this.me.pitch - e.movementY * s));
    });
    document.addEventListener('mousedown', (e) => {
      if (!this.locked || !this.active) return;
      this.sfx.unlock();
      if (e.button === 0) { this.mouse.l = true; this.firedThisClick = false; }
      if (e.button === 2) this.mouse.r = true;
    });
    document.addEventListener('mouseup', (e) => {
      if (e.button === 0) this.mouse.l = false;
      if (e.button === 2) this.mouse.r = false;
    });
    document.addEventListener('contextmenu', (e) => { if (this.active) e.preventDefault(); });
    document.addEventListener('keydown', (e) => this.onKey(e, true));
    document.addEventListener('keyup', (e) => this.onKey(e, false));
    $('#chatin').addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        let text = $('#chatin').value.trim();
        if (text) {
          const prox = text.startsWith('/');
          if (prox) text = text.slice(1).trim();
          this.net.send({ t: 'chat', ch: prox ? 'prox' : 'squad', text });
        }
        this.closeChat();
      } else if (e.key === 'Escape') this.closeChat();
    });
  }

  requestLock() {
    if (!this.active || this.overlayOpen()) return;
    this.sfx.unlock();
    try { const r = this.canvas.requestPointerLock(); r?.catch?.(() => {}); } catch {}
  }
  overlayOpen() {
    return !$('#inv').classList.contains('hidden') || !$('#mapov').classList.contains('hidden') || !$('#end').classList.contains('hidden') || !$('#chatin').classList.contains('hidden');
  }
  closeChat() { $('#chatin').value = ''; $('#chatin').classList.add('hidden'); this.requestLock(); }

  onKey(e, down) {
    if (!this.active) return;
    const k = e.code;
    if (k === 'Tab') { e.preventDefault(); if (down) this.toggleInv(); return; }
    if (this.spectating) {
      if (down && k === 'Space') this.net.send({ t: 'spectate', on: true, next: true });
      if (down && k === 'Escape') this.exit();
      return;
    }
    if (k === 'Escape' && down) { this.closeOverlays(); return; }
    if (k === 'KeyM' && down && $('#chatin').classList.contains('hidden')) { this.toggleMap(); return; }
    if (!down) { this.keys.delete(k); return; }
    if (e.repeat) return;
    if (k === 'Enter' && this.me.state !== 'dead') {
      if (!$('#chatin').classList.contains('hidden')) return;
      document.exitPointerLock?.();
      $('#chatin').classList.remove('hidden');
      setTimeout(() => $('#chatin').focus(), 0);
      return;
    }
    if (this.overlayOpen()) {
      if (k === 'KeyE' && !$('#inv').classList.contains('hidden')) this.closeOverlays();
      return;
    }
    this.keys.add(k);
    const send = (m) => this.net.send(m);
    switch (k) {
      case 'KeyR': send({ t: 'reload' }); break;
      case 'KeyB': this.cycleAmmo(); break;
      case 'Digit1': send({ t: 'swap', slot: 'primary' }); this.localMag = null; break;
      case 'Digit2': send({ t: 'swap', slot: 'secondary' }); this.localMag = null; break;
      case 'KeyC': case 'ControlLeft': this.me.crouch = !this.me.crouch; break;
      case 'KeyV': this.shoulder *= -1; break;
      case 'KeyE': this.interact(); break;
      case 'KeyQ': {
        const pack = this.inv?.inv.pack ?? [];
        const missing = this.me.mhp - this.me.hp;
        const id = missing > 55 && countItem(pack, 'medkit') ? 'medkit' : countItem(pack, 'bandage') ? 'bandage' : 'medkit';
        send({ t: 'use', id });
        break;
      }
      case 'KeyZ': send({ t: 'use', id: 'shield_cell' }); break;
      case 'KeyX': send({ t: 'use', id: 'tourniquet' }); break;
      case 'KeyG': send({ t: 'throw', id: 'frag', d: this.throwDir() }); break;
      case 'KeyT': send({ t: 'throw', id: 'lure', d: this.throwDir() }); break;
      case 'KeyF': {
        const a = this.aimPoint();
        send({ t: 'ping', x: a.x, y: a.y, z: a.z });
        break;
      }
    }
  }

  closeOverlays() {
    hideMenu();
    if (!$('#inv').classList.contains('hidden')) { $('#inv').classList.add('hidden'); this.net.send({ t: 'close_loot' }); this.loot = null; }
    $('#mapov').classList.add('hidden');
    if (!$('#chatin').classList.contains('hidden')) this.closeChat();
  }

  throwDir() {
    const f = this.forward();
    return [f.x, f.y + 0.15, f.z];
  }

  forward() {
    const { yaw, pitch } = this.me;
    return new THREE.Vector3(-Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch));
  }

  // first thing under the crosshair: world geometry or an entity
  aimPoint() {
    const cam = this.camera.position;
    const f = this.forward();
    let t = raycast(this.world, cam.x, cam.y, cam.z, f.x, f.y, f.z, 400).t;
    const test = (x, y, z, r) => { const h = raySphere(cam.x, cam.y, cam.z, f.x, f.y, f.z, x, y, z, r, t); if (h > 0 && h < t) t = h; };
    for (const e of this.enemies.values()) {
      const p = e.mk.group.position, d = ENEMIES[e.type];
      const cy = d.fly ? p.y : e.type === 'merc' ? 1.1 : e.type === 'warden' ? 3.2 : e.type === 'sentry' ? 1.3 : d.radius;
      test(p.x, cy, p.z, Math.max(0.5, d.radius));
    }
    for (const r of this.remotes.values()) if (!r.squad) { const p = r.h.group.position; test(p.x, 1.0, p.z, 0.6); }
    t = Math.max(t, 2);
    return new THREE.Vector3(cam.x + f.x * t, cam.y + f.y * t, cam.z + f.z * t);
  }

  interact() {
    const it = this.interactTarget;
    if (!it) return;
    this.net.send({ t: 'interact', ...it.msg });
  }

  // ================================================================ inventory UI
  toggleInv() {
    if (!$('#inv').classList.contains('hidden')) { this.closeOverlays(); this.requestLock(); return; }
    this.openInv();
  }
  openInv() {
    if (this.me.state === 'dead' || this.me.state === 'extracted') return;
    document.exitPointerLock?.();
    $('#mapov').classList.add('hidden');
    $('#inv').classList.remove('hidden');
    this.renderInv();
  }
  renderInv() {
    const el = $('#inv');
    const I = this.inv;
    if (!I) { el.innerHTML = '<div class="col">Loading…</div>'; return; }
    const inv = I.inv;
    const eq = (k, label) => `<div class="slot"><div class="lbl">${label}${I.active === k ? ' (active)' : ''}</div>${inv[k] ? itemHTML(inv[k], { src: 'eq', idx: k }) : '<div class="item empty">empty</div>'}</div>`;
    const cells = (arr, cap, src) => { const out = []; for (let i = 0; i < cap; i++) out.push(arr[i] ? itemHTML(arr[i], { src, idx: i }) : `<div class="item empty">${src === 'safe' ? 'safe' : ''}</div>`); return out.join(''); };
    const L = this.loot;
    const lootName = L ? (L.name ?? CONT_NAMES[L.type] ?? 'Container') : null;
    el.innerHTML = `<div class="col"><h3>Equipped</h3><div class="slots">${eq('primary', 'Primary')}${eq('secondary', 'Secondary')}${eq('shield', 'Shield')}${eq('rig', 'Rig')}</div>
      <h3 style="margin-top:12px">Backpack ${inv.pack.length}/${I.packCap}</h3><div class="grid">${cells(inv.pack, I.packCap, 'pack')}</div>
      <h3 style="margin-top:12px">Safe pocket ${inv.safe.length}/${I.safeCap}</h3>${I.safeCap ? `<div class="grid">${cells(inv.safe, I.safeCap, 'safe')}</div>` : '<div class="hint">No safe pocket on this rig.</div>'}
      <div class="hint">Click an item for options · Shift+click to quick-move · Tab / Esc to close</div></div>
      <div class="col"><h3>${L ? esc(lootName) : 'Nearby'}</h3>${L ? (L.items.length ? `<div class="grid">${L.items.map((s, i) => itemHTML(s, { src: 'loot', idx: i })).join('')}</div>` : '<div class="hint">Empty.</div>') : '<div class="hint">Press E on a container, body or wreck to search it.</div>'}
      ${L && L.items.length ? '<button class="btn small" id="takeall" style="margin-top:10px">Take all</button>' : ''}</div>`;
    el.onclick = (ev) => this.onInvClick(ev);
    const ta = $('#takeall');
    if (ta) ta.onclick = (ev) => { ev.stopPropagation(); for (let i = L.items.length - 1; i >= 0; i--) this.net.send({ t: 'take', id: L.id, i, to: 'pack' }); };
  }
  onInvClick(ev) {
    const el = ev.target.closest('.item[data-src]');
    if (!el || !el.dataset.src) return;
    const src = el.dataset.src, idx = el.dataset.idx;
    const inv = this.inv.inv;
    const send = (m) => this.net.send(m);
    const L = this.loot;
    if (src === 'loot') {
      const s = L.items[+idx]; const it = ITEMS[s.id];
      if (ev.shiftKey) return send({ t: 'take', id: L.id, i: +idx, to: ['weapon', 'shield', 'rig'].includes(it.type) && (it.type !== 'weapon' || !inv.primary || !inv.secondary) && !inv[it.type] ? 'equip' : 'pack' });
      const e = [{ label: 'Take to backpack', fn: () => send({ t: 'take', id: L.id, i: +idx, to: 'pack' }) }];
      if (['weapon', 'shield', 'rig'].includes(it.type)) e.unshift({ label: 'Equip', fn: () => send({ t: 'take', id: L.id, i: +idx, to: 'equip' }) });
      else e.push({ label: 'Take to safe pocket', fn: () => send({ t: 'take', id: L.id, i: +idx, to: 'safe' }) });
      return showMenu(ev.clientX, ev.clientY, it.name + (s.qty > 1 ? ' x' + s.qty : ''), e);
    }
    if (src === 'pack' || src === 'safe') {
      const s = inv[src][+idx]; const it = ITEMS[s.id];
      if (ev.shiftKey) return L ? send({ t: 'put', from: src, i: +idx, id: L.id }) : send({ t: 'invmove', from: src, i: +idx });
      const e = [];
      if (it.type === 'med') e.push({ label: 'Use', fn: () => send({ t: 'use', id: s.id }) });
      if (['weapon', 'shield', 'rig'].includes(it.type)) e.push({ label: 'Equip', fn: () => send({ t: 'invmove', from: src, i: +idx, to: 'equip' }) });
      else e.push({ label: src === 'pack' ? 'Move to safe pocket' : 'Move to backpack', fn: () => send({ t: 'invmove', from: src, i: +idx }) });
      if (L) e.push({ label: `Put in ${L.name ?? CONT_NAMES[L.type]}`, fn: () => send({ t: 'put', from: src, i: +idx, id: L.id }) });
      e.push({ label: 'Drop', fn: () => send({ t: 'put', from: src, i: +idx }) });
      return showMenu(ev.clientX, ev.clientY, it.name + (s.qty > 1 ? ' x' + s.qty : ''), e);
    }
    if (src === 'eq') {
      const s = inv[idx]; const it = ITEMS[s.id];
      const e = [];
      if (it.type === 'weapon' && this.inv.active !== idx) e.push({ label: 'Make active', fn: () => send({ t: 'swap', slot: idx }) });
      if (L) e.push({ label: `Put in ${L.name ?? CONT_NAMES[L.type]}`, fn: () => send({ t: 'put', from: idx, id: L.id }) });
      e.push({ label: 'Drop', fn: () => send({ t: 'put', from: idx }) });
      return showMenu(ev.clientX, ev.clientY, it.name, e);
    }
  }

  // ================================================================ map
  toggleMap() {
    const el = $('#mapov');
    if (!el.classList.contains('hidden')) { el.classList.add('hidden'); this.requestLock(); return; }
    $('#inv').classList.add('hidden');
    document.exitPointerLock?.();
    el.classList.remove('hidden');
    this.drawMap();
  }
  drawStaticMap() {
    const cv = document.createElement('canvas');
    cv.width = cv.height = 800;
    const g = cv.getContext('2d');
    const S = 800 / (C.MAP_HALF * 2);
    g.fillStyle = '#2b2620'; g.fillRect(0, 0, 800, 800);
    for (const p of POIS) {
      g.fillStyle = '#3a342c'; g.beginPath(); g.arc((p.x + C.MAP_HALF) * S, (p.z + C.MAP_HALF) * S, (p.r + 4) * S, 0, Math.PI * 2); g.fill();
    }
    const col = (k) => '#' + (KIND_COLORS[k] ?? 0x888888).toString(16).padStart(6, '0');
    for (const b of this.world.boxes) {
      if (b.k === KIND.roof || b.k === KIND.perimeter) continue;
      g.fillStyle = b.k === KIND.canopy ? '#3b4f2c' : col(b.k);
      g.fillRect((b.x0 + C.MAP_HALF) * S, (b.z0 + C.MAP_HALF) * S, Math.max(1, (b.x1 - b.x0) * S), Math.max(1, (b.z1 - b.z0) * S));
    }
    g.font = 'bold 15px Segoe UI, sans-serif'; g.textAlign = 'center';
    for (const p of POIS) {
      const x = (p.x + C.MAP_HALF) * S, y = (p.z + C.MAP_HALF) * S;
      g.lineWidth = 4; g.strokeStyle = '#000';
      const label = `${p.name} ${'▲'.repeat(p.threat)}`;
      g.strokeText(label, x, y - (p.r + 6) * S); g.fillStyle = p.threat >= 4 ? '#ff7a2f' : '#ffc24b'; g.fillText(label, x, y - (p.r + 6) * S);
    }
    this.staticMap = cv;
  }
  drawMap() {
    if ($('#mapov').classList.contains('hidden')) return;
    const cv = $('#mapcv'), g = cv.getContext('2d');
    const S = 800 / (C.MAP_HALF * 2);
    const P = (x, z) => [(x + C.MAP_HALF) * S, (z + C.MAP_HALF) * S];
    g.drawImage(this.staticMap, 0, 0);
    g.font = 'bold 13px Segoe UI, sans-serif'; g.textAlign = 'center';
    for (const e of this.extracts) {
      const [x, y] = P(e.x, e.z);
      g.strokeStyle = '#' + (EXTRACT_COLORS[e.closed ? 'closed' : e.state]).toString(16).padStart(6, '0');
      g.lineWidth = 3; g.beginPath(); g.arc(x, y, C.EXTRACT_RADIUS * S + 4, 0, Math.PI * 2); g.stroke();
      g.fillStyle = g.strokeStyle; g.fillText(e.name + (e.closed ? ' (closed)' : ''), x, y + 26);
    }
    for (const h of this.hatches) { const [x, y] = P(h.x, h.z); g.fillStyle = h.used ? '#555' : '#c8c86a'; g.beginPath(); g.arc(x, y, 4, 0, Math.PI * 2); g.fill(); }
    for (const p of this.pings) if (p.until > this.now) { const [x, y] = P(p.x, p.z); g.fillStyle = '#9fe0ff'; g.beginPath(); g.moveTo(x, y); g.lineTo(x - 6, y - 12); g.lineTo(x + 6, y - 12); g.fill(); }
    for (const r of this.remotes.values()) if (r.squad) { const p = r.h.group.position; const [x, y] = P(p.x, p.z); g.fillStyle = '#3d8ff0'; g.beginPath(); g.arc(x, y, 5, 0, Math.PI * 2); g.fill(); }
    for (const [nid, wx, wz] of this.wantedList) { if (nid === this.nid) continue; const [x, y] = P(wx, wz); g.fillStyle = '#ff3b3b'; g.fillRect(x - 5, y - 5, 10, 10); g.fillText('WANTED', x, y - 9); }
    const [mx, my] = P(this.me.x, this.me.z);
    g.save(); g.translate(mx, my); g.rotate(-this.me.yaw);
    g.fillStyle = '#ff7a2f'; g.beginPath(); g.moveTo(0, -10); g.lineTo(7, 8); g.lineTo(-7, 8); g.closePath(); g.fill();
    g.restore();
  }

  // ================================================================ per-frame
  resize() {
    const w = innerWidth, h = innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  loop(t) {
    requestAnimationFrame(this.loop);
    const dt = Math.min(0.1, (t - this.lastFrame) / 1000);
    this.lastFrame = t;
    if (!this.active) return;
    this.update(dt);
    this.renderer.render(this.scene, this.camera);
  }

  update(dt) {
    const me = this.me;
    if (this.spectating) this.followSpectate();
    const W = this.currentWeapon();
    const alive = me.state === 'alive', downed = me.state === 'downed';
    const inControl = this.locked && (alive || downed);
    // ---- movement (client-predicted; server validates)
    const k = this.keys;
    const f = inControl ? (k.has('KeyW') ? 1 : 0) - (k.has('KeyS') ? 1 : 0) : 0;
    const r = inControl ? (k.has('KeyD') ? 1 : 0) - (k.has('KeyA') ? 1 : 0) : 0;
    this.ads = inControl && alive && this.mouse.r;
    const firing = this.mouse.l && inControl && alive;
    this.sprint = inControl && alive && k.has('ShiftLeft') && f > 0 && !this.ads && !firing && me.st > 2 && !this.action;
    if (this.sprint && me.crouch) me.crouch = false;
    let speed = downed ? C.DOWNED_SPEED : this.sprint ? C.SPRINT_SPEED : me.crouch ? C.CROUCH_SPEED : this.ads ? C.ADS_SPEED : C.WALK_SPEED;
    if (this.action && this.action.a !== 'reload') speed = Math.min(speed, C.CROUCH_SPEED);
    speed *= this.speedMult();
    const moved = (alive || downed) ? stepMove(this.world, me, { f, r, yaw: me.yaw }, dt, speed) : false;
    this.moving = moved;
    me.eye += ((downed ? 0.5 : me.crouch ? C.EYE_CROUCH : C.EYE_STAND) - me.eye) * Math.min(1, dt * 10);

    this.sendAcc += dt;
    if (this.sendAcc >= 1 / C.TICK_RATE && (alive || downed)) {
      this.sendAcc = 0;
      this.net.send({ t: 'in', x: +me.x.toFixed(3), z: +me.z.toFixed(3), yaw: +me.yaw.toFixed(3), pitch: +me.pitch.toFixed(3), c: me.crouch ? 1 : 0, s: this.sprint ? 1 : 0, a: this.ads ? 1 : 0 });
    }

    // ---- camera
    const adsTime = Math.max(0.08, W?.w.ads ?? 0.2);
    this.adsT = Math.max(0, Math.min(1, this.adsT + (this.ads ? 1 : -1.5) * dt / adsTime));
    const a = this.adsT;
    const side = (0.85 + 0.12 * a) * this.shoulder, up = 0.5 - 0.22 * a, back = 4.2 - 2.75 * a;
    const pivot = new THREE.Vector3(me.x, me.eye + 0.1, me.z);
    const fwd = this.forward();
    const right = new THREE.Vector3(Math.cos(me.yaw), 0, -Math.sin(me.yaw));
    const desired = pivot.clone().addScaledVector(right, side).add(new THREE.Vector3(0, up, 0)).addScaledVector(fwd, -back);
    const dir = desired.clone().sub(pivot); const len = dir.length(); dir.divideScalar(len);
    const hit = raycast(this.world, pivot.x, pivot.y, pivot.z, dir.x, dir.y, dir.z, len);
    const camDist = hit.box !== -1 && hit.t < len ? Math.max(0.2, hit.t - 0.25) : len;
    this.camera.position.copy(pivot).addScaledVector(dir, camDist);
    this.camera.rotation.set(me.pitch, me.yaw, 0, 'YXZ');
    // optic magnification: fov shrinks with zoom; high-power optics get a scope overlay
    const zoom = W?.w.zoom ?? 1.2;
    const adsFov = 2 * Math.atan(Math.tan(36 * Math.PI / 180) / (zoom * 1.2)) * 180 / Math.PI;
    const fovTarget = 72 + (adsFov - 72) * this.adsT;
    if (Math.abs(this.camera.fov - fovTarget) > 0.05) { this.camera.fov = fovTarget; this.camera.updateProjectionMatrix(); }
    this.scoped = zoom >= 3 && this.adsT > 0.85;
    $('#scope').classList.toggle('hidden', !this.scoped);
    this.zoomSens = this.adsT > 0.5 ? 1 / Math.max(1, zoom * 0.8) : 1;
    this.sun.position.set(me.x + 60, 90, me.z + 40);
    this.sun.target.position.set(me.x, 0, me.z);

    // ---- local avatar
    const pg = this.player.group;
    pg.position.set(me.x, 0, me.z);
    pg.rotation.set(0, me.yaw, 0);
    this.animHuman(this.player, moved, me.crouch, downed, speed, dt);
    pg.visible = camDist > 0.8 && (alive || downed) && !this.scoped;
    this.animGun(this.player, dt);

    // ---- shooting
    this.bloom = Math.max(0, this.bloom - dt * 3);
    if (!this.mouse.l) this.firedThisClick = false;
    if (this.sprint) this.lastSprintAt = this.now;
    if (W && ((firing && alive) || this.burstLeft > 0)) this.tryFire(W.w, W.s);
    if (W && this.recoilAcc > 0 && this.now - this.lastShot > 60 / W.w.rpm * 1.4) {
      const r = Math.min(this.recoilAcc, W.w.recover * 0.35 * dt);
      me.pitch -= r; this.recoilAcc -= r;
    }

    // ---- remotes & enemies interpolation
    const rt = this.serverNow - INTERP;
    for (const rm of this.remotes.values()) {
      const s = this.sample(rm.buf, rt);
      if (!s) continue;
      const g = rm.h.group;
      const px = g.position.x, pz = g.position.z;
      g.position.set(s[1], 0, s[2]);
      g.rotation.set(0, s[3], 0);
      const mv = !!(rm.flags & 256);
      this.animGun(rm.h, dt, rm);
      this.animHuman(rm.h, mv, !!(rm.flags & 1), !!(rm.flags & 8), Math.hypot(s[1] - px, s[2] - pz) / Math.max(dt, 1e-3), dt);
    }
    for (const e of this.enemies.values()) {
      const s = this.sample(e.buf, rt);
      if (!s) continue;
      const g = e.mk.group;
      const px = g.position.x, pz = g.position.z;
      g.position.set(s[1], s[5] ?? 0, s[2]);
      g.rotation.set(0, s[3], 0);
      if (e.mk.rotors) for (const ro of e.mk.rotors) ro.rotation.y += dt * 40;
      if (e.mk.eyeMat) e.mk.eyeMat.color.setHex(e.st === 2 ? 0xff2020 : e.st === 1 ? 0xffaa00 : 0xffe6b0);
      if (e.mk.core) e.mk.core.material.color.setHSL(0.55, 1, 0.5 + Math.sin(this.now * 6) * 0.15);
      if (e.mk.human) this.animHuman(e.mk.human, Math.hypot(s[1] - px, s[2] - pz) > 0.001, false, false, 4, dt);
    }

    this.updateInteract();
    this.updateFx(dt);
    this.sparks.update(dt); this.dust.update(dt); this.shells.update(dt); this.lights.update(dt);
    if (this.loot && !$('#inv').classList.contains('hidden')) {
      const c = this.findCont(this.loot.id);
      if (!c || Math.hypot(c.x - me.x, c.z - me.z) > C.INTERACT_RANGE + 1.2) { this.loot = null; this.net.send({ t: 'close_loot' }); this.renderInv(); }
    }
    this.hudAcc += dt;
    if (this.hudAcc > 1 / 15) { this.hudAcc = 0; this.updateHud(); this.drawMap(); }
  }

  speedMult() {
    const inv = this.inv?.inv;
    let m = 1;
    if (inv?.rig) m *= ITEMS[inv.rig.id].speed;
    if (inv?.shield) m *= ITEMS[inv.shield.id].speed;
    return m * 0.99; // stay slightly under the server's limit
  }

  animHuman(h, moving, crouch, downed, speed, dt) {
    animHuman(h, { moving, crouch, downed, speed, dt, armed: true });
  }

  currentWeapon() {
    const I = this.inv;
    if (!I) return null;
    const s = I.inv[I.active];
    return s ? { s, w: weaponStats(s) } : null;
  }

  // keep the held gun model in sync with the active weapon + attachments
  syncMyGun() {
    const W = this.currentWeapon();
    const key = W ? gearKey(W.s) : '';
    if (key === this.myGunKey) return;
    this.myGunKey = key;
    this.myGun = W ? buildGun(W.s) : null;
    setGunModel(this.player, this.myGun);
    this.burstLeft = 0;
  }

  cycleAmmo() {
    const W = this.currentWeapon();
    if (!W) return;
    const pack = this.inv.inv.pack;
    const cur = AMMO_ORDER.indexOf(W.s.ammoType ?? 'fmj');
    for (let i = 1; i <= AMMO_ORDER.length; i++) {
      const t = AMMO_ORDER[(cur + i) % AMMO_ORDER.length];
      if (countItem(pack, W.w.ammo + AMMO_TYPES[t].suffix) > 0) {
        if (t !== W.s.ammoType) { this.net.send({ t: 'ammo', type: t }); this.feed(`Loading ${AMMO_TYPES[t].name} rounds`); }
        return;
      }
    }
    this.feed('No other ammo types for this weapon in your backpack');
  }

  tryFire(W, s) {
    const now = this.now;
    if (this.sprint || this.action) { this.burstLeft = 0; return; }
    if (this.me.jam) { if (!this.firedThisClick) { this.sfx.click(); this.firedThisClick = true; this.feed('JAMMED — press R', 'warn'); } return; }
    if ((s.dur ?? 100) <= 0) return;
    if (now - (this.lastSprintAt ?? -10) < W.sprintFire) return;
    if (now - this.lastShot < 60 / W.rpm) return;
    if (W.mode === 'burst') {
      if (this.burstLeft <= 0) {
        if (this.firedThisClick || now < (this.burstLockUntil ?? 0)) return;
        this.burstLeft = W.burst;
      }
    } else if (!W.auto && this.firedThisClick) return;
    if ((this.localMag ?? 0) <= 0) {
      this.burstLeft = 0;
      if (!this.firedThisClick) { this.sfx.click(); this.firedThisClick = true; if (this.me.res > 0) this.net.send({ t: 'reload' }); }
      return;
    }
    this.firedThisClick = true;
    if (W.mode === 'burst') { this.burstLeft--; if (this.burstLeft <= 0) this.burstLockUntil = now + W.burstDelay; }
    if (now - this.lastShot > 0.35) this.sprayN = 0;
    this.lastShot = now;
    this.localMag--;
    const me = this.me;
    const origin = new THREE.Vector3(me.x, me.crouch ? C.EYE_CROUCH : C.EYE_STAND, me.z);
    const aim = this.aimPoint();
    const base = aim.clone().sub(origin).normalize();
    const spread = W.spread * (this.ads ? W.adsSpread : 1) * (this.moving ? W.moveSpread : 1) * (me.crouch ? 0.8 : 1) * (1 + this.bloom);
    this.player.group.updateMatrixWorld(true);
    const muzzle = this.myGun ? this.myGun.muzzle.getWorldPosition(new THREE.Vector3()) : origin.clone().addScaledVector(base, 0.8);
    const dirs = [];
    for (let i = 0; i < W.pellets; i++) {
      const d = base.clone();
      const u = new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize().multiplyScalar(Math.random() * spread);
      d.add(u).normalize();
      dirs.push([+d.x.toFixed(4), +d.y.toFixed(4), +d.z.toFixed(4)]);
      const hit = raycast(this.world, origin.x, origin.y, origin.z, d.x, d.y, d.z, W.range * 2);
      const end = origin.clone().addScaledVector(d, hit.t);
      this.tracer(muzzle.toArray(), end.toArray(), 0xffe9a8, W.suppressed ? 0.35 : 0.9);
      if (hit.box !== -1) this.impact(end, boxNormal(this.world, hit.box, end), surfaceOf(this.world, hit.box));
    }
    this.net.send({ t: 'fire', d: dirs, rt: +(this.serverNow - INTERP).toFixed(3) });
    this.sfx.shot(s.id, 0.9, { suppressed: W.suppressed, dist: 0 });
    if (!W.suppressed) this.muzzleFlash(muzzle.toArray(), W.cls);
    // brass: auto/semi eject now; pump & bolt eject when the action cycles
    const right = new THREE.Vector3(Math.cos(me.yaw), 0, -Math.sin(me.yaw));
    if (W.cls !== 'Revolver' && W.mode !== 'pump' && W.mode !== 'bolt') this.shells.eject(muzzle.clone().lerp(origin, 0.6), right, new THREE.Vector3(0, 1, 0), false);
    if (W.mode === 'pump' || W.mode === 'bolt') {
      this.cycleAnim = { start: now + 0.12, dur: 60 / W.rpm * 0.7, mode: W.mode };
      setTimeout(() => { this.sfx.rack(W.mode); if (this.myGun) this.shells.eject(muzzle.clone().lerp(origin, 0.6), right, new THREE.Vector3(0, 1, 0), W.mode === 'pump'); }, 160);
    }
    // recoil: learnable per-gun pattern + a little noise, partially recovered after you stop firing
    const n = this.sprayN++;
    const adsK = this.ads ? 0.75 : 1;
    const kickV = W.recoilV * adsK * (1 + Math.min(n, 8) * 0.04);
    const kickH = W.recoilH * adsK * (recoilPattern(s.id, n) + (Math.random() - 0.5) * 0.4);
    me.pitch = Math.min(1.2, me.pitch + kickV);
    me.yaw -= kickH;
    this.recoilAcc = (this.recoilAcc ?? 0) + kickV * 0.7;
    this.bloom = Math.min(2.5, this.bloom + (W.auto || W.mode === 'burst' ? 0.18 : 0.5));
    this.gunKick = 1;
  }

  // gun-local animation: recoil kick, mag drop during reload, pump/bolt cycling
  animGun(h, dt, remote) {
    const g = h.model;
    if (!g) return;
    const k = remote ? (remote.kick = Math.max(0, (remote.kick ?? 0) - dt * 10)) : (this.gunKick = Math.max(0, (this.gunKick ?? 0) - dt * 10));
    g.group.position.z = k * 0.06;
    g.group.rotation.x = k * 0.08;
    if (remote) return;
    if (g.mag && g.magHome) {
      const ra = this.reloadAnim;
      let off = 0, vis = true;
      if (ra && !ra.rack) {
        const t = (this.now - ra.start) / ra.dur;
        if (t >= 1) this.reloadAnim = null;
        else if (t < 0.3) off = t / 0.3 * 0.25;
        else if (t < 0.55) { off = 0.25; vis = false; }
        else off = Math.max(0, (1 - (t - 0.55) / 0.35)) * 0.25;
      }
      g.mag.position.y = g.magHome.y - off;
      g.mag.visible = vis;
    }
    const ca = this.cycleAnim;
    if (ca && this.now >= ca.start) {
      const t = (this.now - ca.start) / ca.dur;
      const back = t < 0.5 ? t * 2 : Math.max(0, 2 - t * 2);
      if (g.pump && g.pumpHome) g.pump.position.z = g.pumpHome.z + back * 0.09;
      if (g.bolt) g.bolt.rotation.y = back * 1.2;
      if (t >= 1) this.cycleAnim = null;
    }
  }

  findCont(id) {
    if (id >= 10000) return this.dynConts.get(id);
    return this.world.containers[id];
  }

  updateInteract() {
    const me = this.me;
    let best = null, bd = Infinity;
    const consider = (d, label, msg) => { if (d < bd) { bd = d; best = { label, msg }; } };
    if (me.state === 'alive') {
      for (const c of this.world.containers) {
        const d = Math.hypot(c.x - me.x, c.z - me.z);
        if (d < C.INTERACT_RANGE) consider(d, `Search ${CONT_NAMES[c.type]}`, { k: 'cont', id: c.id });
      }
      for (const c of this.dynConts.values()) {
        const d = Math.hypot(c.x - me.x, c.z - me.z);
        if (d < C.INTERACT_RANGE) consider(d - 0.3, `Search ${c.name ?? CONT_NAMES[c.type]}`, { k: 'cont', id: c.id });
      }
      for (const dr of this.world.doors) {
        if (this.world.doorOpen[dr.id]) continue;
        const d = Math.hypot(dr.x - me.x, dr.z - me.z);
        if (d < 3) consider(d, `Unlock vault (${ITEMS[dr.key].name})`, { k: 'door', id: dr.id });
      }
      for (const e of this.extracts) {
        const d = Math.hypot(e.x - me.x, e.z - me.z);
        if (d < C.EXTRACT_RADIUS) consider(d + 2, e.closed ? `${e.name} — CLOSED` : e.state === 'called' ? `Lift inbound — hold the zone` : `Call lift at ${e.name}`, { k: 'extract', id: e.id });
      }
      for (const h of this.hatches) {
        if (h.used) continue;
        const d = Math.hypot(h.x - me.x, h.z - me.z);
        if (d < C.INTERACT_RANGE) consider(d, 'Open raider hatch (Hatch Key)', { k: 'hatch', id: h.id });
      }
      for (const r of this.remotes.values()) {
        if (!r.squad || !(r.flags & 8)) continue;
        const p = r.h.group.position;
        const d = Math.hypot(p.x - me.x, p.z - me.z);
        if (d < C.INTERACT_RANGE) consider(d - 1, `Revive ${this.squad.get(r.nid) ?? 'squadmate'}`, { k: 'revive', nid: r.nid });
      }
    }
    this.interactTarget = best;
  }

  feed(text, kind) {
    const d = document.createElement('div');
    d.className = 'f' + (kind === 'warn' ? ' warn' : '');
    d.textContent = text;
    const box = $('#feed');
    box.appendChild(d);
    while (box.children.length > 7) box.firstChild.remove();
    setTimeout(() => d.remove(), kind === 'warn' ? 9000 : 6000);
  }

  chatLine(m) {
    const d = document.createElement('div');
    d.className = 'c' + (m.ch === 'prox' ? ' prox' : '');
    d.innerHTML = `<b>${m.ch === 'prox' ? '[near] ' : ''}${esc(m.from)}:</b> ${esc(m.text)}`;
    const box = $('#chatlog');
    box.appendChild(d);
    while (box.children.length > 8) box.firstChild.remove();
    setTimeout(() => d.remove(), 20000);
  }

  updateHud() {
    const me = this.me;
    const left = Math.max(0, this.duration - this.serverNow);
    const tEl = $('#timer');
    tEl.textContent = `${Math.floor(left / 60)}:${String(Math.floor(left % 60)).padStart(2, '0')}`;
    tEl.classList.toggle('low', left < 180);
    $('#extracts').innerHTML = this.extracts.map(e => {
      const d = Math.round(Math.hypot(e.x - me.x, e.z - me.z));
      let st = e.closed ? 'closed' : e.state === 'called' ? `inbound ${Math.max(0, Math.ceil(e.t - (this.now - (e.tAt ?? this.now))))}s` : e.state === 'cooldown' ? 'cycling' : `closes ${fmt(e.closeAt - this.serverNow)}`;
      if (!e.closed && e.closeAt >= this.duration && e.state === 'idle') st = 'open';
      return `<div class="x ${e.closed ? 'closed' : e.state}">⬆ ${esc(e.name)} · ${d}m · ${st}</div>`;
    }).join('');
    const deg = Math.round(((-me.yaw * 180 / Math.PI) % 360 + 360) % 360);
    const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
    $('#heading').textContent = `${dirs[Math.round(deg / 45) % 8]} ${deg}°`;
    const poi = poiAt(me.x, me.z);
    $('#zone').textContent = poi ? `${poi.name} ${'▲'.repeat(poi.threat)}` : 'Wilds';
    $('#b-hp').style.width = (me.hp / me.mhp * 100) + '%';
    $('#t-hp').textContent = `${me.hp}/${me.mhp}`;
    $('#b-sh').style.width = (me.shc ? me.sh / me.shc * 100 : 0) + '%';
    $('#t-sh').textContent = me.shc ? `${me.sh}/${me.shc}` : '—';
    $('#b-st').style.width = Math.min(100, me.st) + '%';
    const W = this.currentWeapon();
    $('#wname').innerHTML = W ? `${esc(W.w.name.toUpperCase())} · ${W.w.cls}${W.w.mode === 'burst' ? ' · BURST' : ''}` + (this.inv.active === 'secondary' ? ' [2]' : ' [1]')
      + `<div class="wsub"><span class="ammo-type">${AMMO_TYPES[me.at ?? 'fmj']?.name ?? 'FMJ'}</span> <kbd>B</kbd>${me.du != null && me.du < JAM_BELOW ? ` <span class="worn">WORN ${me.du}%</span>` : ''}${me.jam ? ' <span class="worn">JAMMED · R</span>' : ''}</div>` : 'UNARMED';
    $('#ammo').innerHTML = W ? `${this.localMag ?? 0}<small> / ${me.res}</small>` : '';
    const pack = this.inv?.inv.pack ?? [];
    const q = (key, id, label) => `<span><kbd>${key}</kbd>${label} ${countItem(pack, id)}</span>`;
    $('#quick').innerHTML = q('Q', 'bandage', 'Bandage') + q('Z', 'shield_cell', 'Cell') + q('G', 'frag', 'Frag') + q('T', 'lure', 'Lure');
    // stealth meter (DMZ-style white -> yellow -> orange)
    const aw = me.aw ?? 0;
    const sf = $('#stealth-fill');
    sf.style.width = (aw * 100) + '%';
    sf.style.background = aw >= 1 ? '#ff4d1a' : aw > 0.5 ? '#ffb020' : '#ffffff';
    $('#stealth').style.opacity = aw > 0.02 ? 1 : 0.35;
    // crosshair spread
    const W2 = W?.w;
    const gap = W2 ? 6 + W2.spread * 400 * (this.ads ? W2.adsSpread : 1) * (this.moving ? W2.moveSpread : 1) * (1 + this.bloom) : 8;
    const ch = $('#crosshair');
    ch.querySelector('.t').style.top = `${-gap - 8}px`; ch.querySelector('.b').style.top = `${gap}px`;
    ch.querySelector('.l').style.left = `${-gap - 8}px`; ch.querySelector('.r').style.left = `${gap}px`;
    ch.style.opacity = this.sprint || this.scoped ? 0 : 1;
    // prompt & progress
    const pr = $('#prompt');
    if (this.interactTarget && !this.action) { pr.style.display = 'block'; pr.innerHTML = `<kbd>E</kbd>${esc(this.interactTarget.label)}`; }
    else pr.style.display = 'none';
    const pg = $('#progress');
    if (this.action) {
      const k = (this.now - this.action.start) / this.action.dur;
      if (k >= 1) this.action = null;
      else {
        pg.classList.remove('hidden');
        $('#progress-fill').style.width = (k * 100) + '%';
        $('#progress-label').textContent = { reload: 'Reloading', use: `Using ${ITEMS[this.action.id]?.name ?? ''}`, search: 'Searching', revive: 'Reviving', hatch: 'Opening hatch' }[this.action.a] ?? this.action.a;
      }
    }
    if (!this.action) pg.classList.add('hidden');
    // squad
    const mates = [...this.squad.entries()].filter(([nid]) => nid !== this.nid);
    $('#squadhud').innerHTML = mates.map(([nid, name]) => {
      const r = this.remotes.get(nid);
      const down = r && (r.flags & 8);
      return `<div class="m ${down ? 'down' : ''}"><span>${esc(name)}${down ? ' — DOWNED' : r ? '' : ' — out'}</span><div class="mb"><div style="width:${r ? r.hp : 0}%"></div></div></div>`;
    }).join('');
    // downed
    const dn = $('#downed');
    if (me.state === 'downed') { dn.classList.remove('hidden'); dn.innerHTML = `<div>DOWNED<br><small>Bleeding out in ${me.dh ?? '?'}s · crawl to cover · squadmates press E to revive<br><kbd>X</kbd> use Tourniquet</small></div>`; }
    else dn.classList.add('hidden');
    $('#clickto').classList.toggle('hidden', this.locked || this.overlayOpen() || this.spectating || me.state === 'dead' || me.state === 'extracted');
    $('#wanted').classList.toggle('hidden', !me.wanted);
    // boss bar
    let boss = null;
    for (const e of this.enemies.values()) if (e.type === 'warden') boss = e;
    let bb = $('#bossbar');
    if (boss && Math.hypot(boss.mk.group.position.x - me.x, boss.mk.group.position.z - me.z) < 100) {
      if (!bb) { bb = document.createElement('div'); bb.id = 'bossbar'; bb.style.cssText = 'position:absolute;top:70px;left:50%;transform:translateX(-50%);width:420px;text-align:center;font-weight:800;letter-spacing:.2em;color:#ff7a2f'; $('#hud').appendChild(bb); }
      bb.innerHTML = `THE WARDEN<div class="bar" style="height:8px;margin-top:4px"><div style="width:${boss.hp}%;background:#ff4d1a;height:100%"></div></div>`;
    } else if (bb) bb.remove();
  }
}

function lerpAngle(a, b, t) {
  const d = ((b - a + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
  return a + d * t;
}
function fmt(s) {
  s = Math.max(0, s);
  return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
}
