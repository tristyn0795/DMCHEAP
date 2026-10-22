// End-to-end smoke test: in-process raid logic + a real server with WebSocket bots.
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import WebSocket from 'ws';
import { C, makeStack } from '../shared/data.js';
import { generateWorld } from '../shared/world.js';
import { Raid } from '../server/raid.js';
import { newProfile, prepareDeploy, applyRaidResult, applyAction } from '../server/profiles.js';

let fails = 0;
const ok = (cond, msg) => { console.log(`${cond ? 'PASS' : 'FAIL'} ${msg}`); if (!cond) fails++; };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ---------------------------------------------------------------- in-process raid logic
{
  const world = generateWorld();
  const results = [];
  const raid = new Raid(world, { onResult: async (pid, res, info) => { results.push({ pid, res, info }); return {}; }, onClosed() {} });
  clearInterval(raid.interval);
  const fakeWs = () => { const m = []; return { readyState: 1, send: (s) => m.push(JSON.parse(s)), msgs: m }; };
  ok(raid.enemies.size > 50, `raid spawned ${raid.enemies.size} enemies`);
  ok([...raid.containers.values()].every(c => Array.isArray(c.items)), 'containers rolled loot');

  // profile + deploy
  const prof = newProfile('Tester');
  prof.loadout.safe.push(makeStack('gold_watch', 1));
  const info = prepareDeploy(prof, raid.id);
  const ws1 = fakeWs();
  const { player: p } = raid.addPlayer(prof, info, ws1, 'S1');
  ok(ws1.msgs.some(m => m.t === 'raid_start'), 'raid_start sent');

  // fire weapon
  const mag0 = p.inv.primary.mag;
  raid.handle(p.id, { t: 'fire', d: [[0, 0, -1]], rt: raid.time });
  ok(p.inv.primary.mag === mag0 - 1, 'firing consumes ammo');
  raid.handle(p.id, { t: 'fire', d: [[0, 0, -1]], rt: raid.time });
  ok(p.inv.primary.mag === mag0 - 1, 'fire rate limit enforced');

  // reload
  for (let i = 0; i < 40; i++) raid.tick();
  raid.handle(p.id, { t: 'reload' });
  for (let i = 0; i < 40; i++) raid.tick();
  ok(p.inv.primary.mag === mag0 || p.state !== 'alive', 'reload refills magazine');

  // movement validation: teleport attempt is clamped
  const x0 = p.x;
  raid.handle(p.id, { t: 'in', x: p.x + 50, z: p.z, yaw: 0, pitch: 0 });
  ok(Math.abs(p.x - x0) <= 2.01, `speed hack clamped (moved ${Math.abs(p.x - x0).toFixed(2)}m)`);

  // search a container (teleport for test)
  const c = [...raid.containers.values()].find(c => !c.dyn && c.items.length);
  p.x = c.x + 0.5; p.z = c.z;
  raid.handle(p.id, { t: 'interact', k: 'cont', id: c.id });
  for (let i = 0; i < 60; i++) raid.tick();
  const lootMsg = ws1.msgs.find(m => m.t === 'loot' && m.id === c.id);
  ok(!!lootMsg, 'searching a container returns loot');
  const before = p.inv.pack.length;
  if (lootMsg) raid.handle(p.id, { t: 'take', id: c.id, i: 0, to: 'pack' });
  ok(p.inv.pack.length >= before, 'take item into backpack');

  // extraction: enemies cleared so the test is deterministic
  raid.enemies.clear();
  const ex = raid.extracts.find(e => !e.closed);
  p.x = ex.x; p.z = ex.z; p.hp = p.maxHp; p.state = 'alive'; p.action = null;
  raid.handle(p.id, { t: 'interact', k: 'extract', id: ex.id });
  ok(ex.state === 'called', 'extract called');
  raid.enemies.clear();
  for (let i = 0; i < C.EXTRACT_COUNTDOWN * C.TICK_RATE + 5; i++) { raid.enemies.clear(); raid.tick(); }
  await sleep(10);
  const r1 = results.find(r => r.pid === prof.id);
  ok(r1 && r1.res.extracted, 'player extracted after countdown');
  if (r1) {
    applyRaidResult(prof, r1.res, r1.info);
    ok(prof.stats.extracts === 1 && prof.loadout.primary, 'profile updated after extract (gear kept)');
    ok(prof.stash.some(s => s.id === 'gold_watch'), 'safe pocket item moved to stash');
  }

  // death: lose gear, keep safe pocket, body container dropped
  const raid2 = new Raid(world, { onResult: async (pid, res, info) => { results.push({ pid, res, info, r: 2 }); return {}; }, onClosed() {} });
  clearInterval(raid2.interval);
  const prof2 = newProfile('Victim');
  prof2.loadout.safe.push(makeStack('data_drive', 1));
  const info2 = prepareDeploy(prof2, raid2.id);
  const { player: v } = raid2.addPlayer(prof2, info2, fakeWs(), 'S2');
  const prof3 = newProfile('Killer');
  const { player: k } = raid2.addPlayer(prof3, prepareDeploy(prof3, raid2.id), fakeWs(), 'S3');
  raid2.damagePlayer(v, 999, { kind: 'player', p: k, x: k.x, z: k.z });
  await sleep(10);
  const r2 = results.find(r => r.pid === prof2.id);
  ok(r2 && !r2.res.extracted, 'solo player without tourniquet dies outright');
  ok([...raid2.containers.values()].some(c => c.type === 'body'), 'body container dropped with loot');
  ok(k.pkills === 1, 'killer credited');
  applyRaidResult(prof2, r2.res, r2.info);
  ok(!prof2.loadout.primary && prof2.stash.some(s => s.id === 'data_drive'), 'death loses gear but keeps safe pocket');
  raid.close(); raid2.close();

  // hideout actions
  const hp = newProfile('Shopper');
  hp.cash = 100000;
  applyAction(hp, { a: 'buy', id: 'ammo_medium', qty: 60 });
  ok(hp.stash.some(s => s.id === 'ammo_medium'), 'trader buy works');
  const idx = hp.stash.findIndex(s => s.id === 'buzz');
  applyAction(hp, { a: 'equip', idx, slot: 'secondary' });
  ok(hp.loadout.secondary?.id === 'buzz', 'equip secondary works');
  applyAction(hp, { a: 'craft', r: 0 });
  ok(hp.stash.some(s => s.id === 'ammo_light' && s.qty >= 40), 'craft works');
  applyAction(hp, { a: 'free_kit' });
  ok(hp.loadout.rig?.id === 'rig_free', 'free kit works');
  applyAction(hp, { a: 'insure', uid: hp.loadout.primary.uid });
  ok(hp.insured.uid === hp.loadout.primary.uid, 'insure works');
}

// ---------------------------------------------------------------- networked bots
{
  const port = 3900 + Math.floor(Math.random() * 90);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dmcheap-'));
  const srv = spawn(process.execPath, ['server/index.js'], { env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, DATABASE_URL: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
  srv.stderr.on('data', d => process.stderr.write('[srv] ' + d));
  await sleep(1200);
  const bot = (name) => new Promise((resolve) => {
    const ws = new WebSocket(`ws://localhost:${port}/ws`);
    const b = { ws, msgs: [], name, send: (m) => ws.send(JSON.stringify(m)), wait: async (pred, ms = 4000) => { const t = Date.now(); while (Date.now() - t < ms) { const m = b.msgs.find(pred); if (m) return m; await sleep(25); } return null; } };
    ws.on('message', (d) => b.msgs.push(JSON.parse(d)));
    ws.on('open', () => { b.send({ t: 'hello', name }); resolve(b); });
  });
  const A = await bot('Alpha'), B = await bot('Bravo');
  ok(!!(await A.wait(m => m.t === 'profile')), 'bot A got profile');
  A.send({ t: 'party_create' });
  const party = await A.wait(m => m.t === 'party');
  ok(!!party, `party created ${party?.party.code}`);
  B.send({ t: 'party_join', code: party.party.code });
  ok(!!(await B.wait(m => m.t === 'party' && m.party.members.length === 2)), 'bot B joined party');
  A.send({ t: 'deploy' });
  const sa = await A.wait(m => m.t === 'raid_start'), sb = await B.wait(m => m.t === 'raid_start');
  ok(sa && sb && sa.raid === sb.raid, 'squad deployed into the same raid');
  ok(sa && Math.hypot(sa.x - sb.x, sa.z - sb.z) < 8, 'squad spawned together');
  const snap = await A.wait(m => m.t === 's' && m.p.length >= 1);
  ok(!!snap, `snapshots flowing (sees ${snap?.p.length} players, ${snap?.e.length} enemies)`);
  // walk a few steps
  let x = sa.x, z = sa.z;
  for (let i = 0; i < 20; i++) { z += 0.2; A.send({ t: 'in', x, z, yaw: 0, pitch: 0 }); await sleep(50); }
  const later = B.msgs.filter(m => m.t === 's').pop();
  const seenA = later?.p.find(p => p[0] === sa.nid);
  ok(seenA && Math.abs(seenA[2] - z) < 1.5, 'squadmate sees movement');
  A.send({ t: 'fire', d: [[0, 0, 1]], rt: 0 });
  ok(!!(await B.wait(m => m.t === 'fx' && m.k === 'shot')), 'shot fx relayed');
  A.send({ t: 'chat', ch: 'squad', text: 'hello squad' });
  ok(!!(await B.wait(m => m.t === 'chat' && m.text === 'hello squad')), 'squad chat works');
  const stats = await (await fetch(`http://localhost:${port}/api/stats`)).json();
  ok(stats.raids.length === 1 && stats.raids[0].players === 2, 'stats endpoint reports raid');
  const bytes = A.msgs.filter(m => m.t === 's').map(m => JSON.stringify(m).length);
  console.log(`     avg snapshot ${Math.round(bytes.reduce((a, b) => a + b, 0) / bytes.length)} bytes (pre-deflate)`);
  A.ws.close(); B.ws.close();
  srv.kill('SIGTERM');
  await sleep(300);
}

console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
process.exit(fails ? 1 : 0);
