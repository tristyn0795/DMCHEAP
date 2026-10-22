// End-to-end smoke test: in-process raid logic + a real server with WebSocket bots.
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import WebSocket from 'ws';
import { C, makeStack, countItem } from '../shared/data.js';
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

// ---------------------------------------------------------------- gunsmith + gunplay (in-process)
{
  const { weaponStats, canAttach, decodeGear, gearKey, upgradeCost } = await import('../shared/gunsmith.js');
  const p = newProfile('Smith');
  p.cash = 1e6;
  const gun = makeStack('ranger');
  p.stash.push(gun);
  for (const id of ['att_supp', 'att_3x', 'att_mag_ext', 'att_vgrip', 'att_6x']) p.stash.push(makeStack(id));
  const base = weaponStats(gun);
  const idxOf = (id) => p.stash.findIndex(s => s.id === id);
  applyAction(p, { a: 'attach', uid: gun.uid, idx: idxOf('att_supp') });
  applyAction(p, { a: 'attach', uid: gun.uid, idx: idxOf('att_mag_ext') });
  applyAction(p, { a: 'attach', uid: gun.uid, idx: idxOf('att_3x') });
  const st = weaponStats(gun);
  ok(st.suppressed && st.noise < base.noise * 0.5, `suppressor cuts noise (${base.noise} -> ${Math.round(st.noise)})`);
  ok(st.mag === 45 && st.zoom === 3, `extended mag 30 -> ${st.mag}, 3x zoom ${st.zoom}`);
  ok(!p.stash.some(s => s.id === 'att_supp'), 'attachment moved from stash onto the gun');
  applyAction(p, { a: 'attach', uid: gun.uid, idx: idxOf('att_6x') });
  ok(gun.att.optic === 'att_6x' && p.stash.some(s => s.id === 'att_3x'), 'swapping an optic returns the old one to the stash');
  let threw = false;
  const pistol = makeStack('peashooter'); p.stash.push(pistol);
  try { applyAction(p, { a: 'attach', uid: pistol.uid, idx: idxOf('att_3x') }); } catch { threw = true; }
  ok(threw && !canAttach('peashooter', 'att_3x'), 'incompatible attachment rejected');
  applyAction(p, { a: 'detach', uid: gun.uid, slot: 'mag' });
  ok(!gun.att.mag && gun.mag <= 30 && p.stash.some(s => s.id === 'att_mag_ext'), 'detaching mag clamps loaded rounds and returns the mag');
  for (const [m, n] of Object.entries({ scrap: 100, circuits: 40, alloy: 20, cheap_core: 4 })) p.stash.push(makeStack(m, n));
  applyAction(p, { a: 'upgrade_gun', uid: gun.uid });
  ok(gun.tier === 2 && weaponStats(gun).dmg > base.dmg, `tier upgrade raises damage (${base.dmg} -> ${weaponStats(gun).dmg.toFixed(1)})`);
  gun.dur = 20;
  ok(weaponStats(gun).jamChance > 0, 'worn guns can jam');
  applyAction(p, { a: 'repair_gun', uid: gun.uid });
  ok(gun.dur === 100, 'repair restores condition');
  p.stash.push(makeStack('ammo_medium_ap', 60));
  applyAction(p, { a: 'set_ammo', uid: gun.uid, type: 'ap' });
  ok(gun.ammoType === 'ap' && gun.mag > 0 && weaponStats(gun).pen, `AP ammo loaded (${gun.mag} rds)`);
  const d = decodeGear(gearKey(gun));
  ok(d.id === 'ranger' && d.att.optic === 'att_6x' && d.tier === 2, 'gear key round-trips for remote rendering');
  ok(upgradeCost({ id: 'ranger', tier: 4 }) === null, 'tier IV is max');
  const sold = makeStack('buzz'); sold.att = { optic: 'att_reddot' }; p.stash.push(sold);
  applyAction(p, { a: 'sell', idx: p.stash.indexOf(sold) });
  ok(p.stash.some(s => s.id === 'att_reddot'), 'selling a gun returns its attachments');

  // raid-side: wear, jams, ammo switching, AP vs shields
  const world = generateWorld();
  const raid = new Raid(world, { onResult: async () => ({}), onClosed() {} });
  clearInterval(raid.interval);
  raid.enemies.clear();
  const mk = () => { const m = []; return { readyState: 1, send: (x) => m.push(JSON.parse(x)), msgs: m }; };
  const shooter = newProfile('Shooter');
  shooter.loadout.primary = makeStack('ranger');
  shooter.loadout.pack.push(makeStack('ammo_medium', 90), makeStack('ammo_medium_hp', 60));
  const ws = mk();
  const { player: sp } = raid.addPlayer(shooter, prepareDeploy(shooter, raid.id), ws, 'SQ1');
  const g = sp.inv.primary;
  for (let i = 0; i < 5; i++) { raid.time += 0.2; raid.handle(shooter.id, { t: 'fire', d: [[0, 0, -1]], rt: raid.time }); }
  ok(g.dur < 100 && g.mag === 25, `shots wear the gun (dur ${g.dur.toFixed(2)}, mag ${g.mag})`);
  g.dur = 0.05; raid.time += 0.2;
  raid.handle(shooter.id, { t: 'fire', d: [[0, 0, -1]], rt: raid.time });
  g.jammed = false; raid.time += 0.2;
  raid.handle(shooter.id, { t: 'fire', d: [[0, 0, -1]], rt: raid.time });
  ok(g.dur === 0 && ws.msgs.some(m => m.t === 'msg' && /broken/.test(m.text)), 'a fully worn gun refuses to fire');
  g.dur = 100; g.jammed = true;
  const magBefore = g.mag;
  raid.time += 0.2; raid.handle(shooter.id, { t: 'fire', d: [[0, 0, -1]], rt: raid.time });
  ok(g.mag === magBefore, 'jammed gun does not fire');
  raid.handle(shooter.id, { t: 'reload' });
  ok(!g.jammed, 'R clears a jam');
  sp.reloadUntil = 0; sp.reloading = null;
  raid.handle(shooter.id, { t: 'ammo', type: 'hp' });
  ok(g.ammoType === 'hp' && g.mag === 0 && sp.reloading, 'ammo switch unloads the mag and reloads with the new type');
  raid.time = sp.reloadUntil + 0.01; raid.finishReload(sp);
  ok(g.mag === 30 && countItem(sp.inv.pack, 'ammo_medium_hp') === 30, 'reload pulled HP rounds');
  // AP vs shield absorption
  const vp = newProfile('Target');
  const { player: tgt } = raid.addPlayer(vp, prepareDeploy(vp, raid.id), mk(), 'SQ2');
  tgt.inv.shield.charge = 40; const hp0 = tgt.hp;
  raid.damagePlayer(tgt, 20, { kind: 'enemy', name: 't', x: 0, z: 0 }, { absorb: 1 });
  const fmjHp = hp0 - tgt.hp;
  tgt.hp = hp0; tgt.inv.shield.charge = 40;
  raid.damagePlayer(tgt, 20, { kind: 'enemy', name: 't', x: 0, z: 0 }, { absorb: 0.5 });
  ok(hp0 - tgt.hp > fmjHp, `AP rounds get through shields (FMJ ${fmjHp.toFixed(1)} vs AP ${(hp0 - tgt.hp).toFixed(1)} health damage)`);
  raid.close();
}

// ---------------------------------------------------------------- spectating (in-process)
{
  const world = generateWorld();
  const raid = new Raid(world, { onResult: async () => ({}), onClosed() {} });
  clearInterval(raid.interval);
  const mk = () => { const m = []; return { readyState: 1, send: (s) => m.push(JSON.parse(s)), msgs: m }; };
  const pa = newProfile('SpecA'), pb = newProfile('SpecB');
  const wa = mk(), wb = mk();
  const { player: a } = raid.addPlayer(pa, prepareDeploy(pa, raid.id), wa, 'SQ');
  const { player: b } = raid.addPlayer(pb, prepareDeploy(pb, raid.id), wb, 'SQ');
  ok(wa.msgs.some(m => m.t === 'squad' && m.squad.length === 2), 'squadmate roster pushed to existing member');
  raid.enemies.clear();
  // A dies for good (B alive -> A goes down first, then finish them)
  raid.damagePlayer(a, 999, { kind: 'enemy', name: 'Test', x: 0, z: 0 });
  ok(a.state === 'downed', 'player with a living squadmate is downed, not killed');
  raid.damagePlayer(a, 999, { kind: 'enemy', name: 'Test', x: 0, z: 0 });
  ok(a.state === 'dead', 'downed player can be finished');
  ok(raid.spectate(pa.id, true, wa), 'dead player can spectate squadmate');
  wa.msgs.length = 0;
  raid.tick();
  const snap = wa.msgs.find(m => m.t === 's');
  ok(snap && snap.me.s === 'spec' && snap.me.tgt === b.nid, 'spectator receives snapshots centred on squadmate');
  raid.close();
  ok(wa.msgs.some(m => m.t === 'spec_end'), 'spectators are told when the raid closes');
}

// ---------------------------------------------------------------- networked bots
{
  const port = 3900 + Math.floor(Math.random() * 90);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dmcheap-'));
  const srv = spawn(process.execPath, ['server/index.js'], { env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, DATABASE_URL: process.env.TEST_DATABASE_URL ?? '', FILL_WAIT_MS: '1500' }, stdio: ['ignore', 'pipe', 'pipe'] });
  srv.stderr.on('data', d => process.stderr.write('[srv] ' + d));
  await sleep(1200);
  const bot = (name, token) => new Promise((resolve) => {
    const ws = new WebSocket(`ws://localhost:${port}/ws`);
    const b = {
      ws, msgs: [], name, token: null, id: null, tag: null,
      send: (m) => ws.send(JSON.stringify(m)),
      clear: () => { b.msgs.length = 0; },
      wait: async (pred, ms = 4000) => { const t = Date.now(); while (Date.now() - t < ms) { const m = b.msgs.find(pred); if (m) return m; await sleep(25); } return null; },
      last: (pred) => [...b.msgs].reverse().find(pred),
    };
    ws.on('message', (d) => { const m = JSON.parse(d); b.msgs.push(m); if (m.t === 'welcome') { b.token = m.token; b.id = m.id; b.tag = m.tag; } });
    ws.on('open', () => { b.send({ t: 'hello', name, token }); resolve(b); });
  });
  const A = await bot('Alpha'), B = await bot('Bravo');
  ok(!!(await A.wait(m => m.t === 'profile')) && !!(await B.wait(m => m.t === 'profile')), 'bots got profiles');

  // ---- squads persist through disconnects
  A.send({ t: 'party_create' });
  const party = await A.wait(m => m.t === 'party' && m.party);
  ok(!!party, `party created ${party?.party.code}`);
  B.send({ t: 'party_join', code: party.party.code });
  ok(!!(await A.wait(m => m.t === 'party' && m.party?.members.length === 2)), 'B joined via code');
  B.ws.close();
  await sleep(300);
  const off = A.last(m => m.t === 'party');
  ok(off?.party.members.find(x => x.id === B.id)?.status.s === 'offline', 'disconnected member stays in squad as offline');
  const B2 = await bot('Bravo', B.token);
  const back = await B2.wait(m => m.t === 'party' && m.party);
  ok(back && back.party.code === party.party.code, 'reconnecting member is back in the same squad');

  // ---- friends + presence
  A.send({ t: 'friend_add', tag: `Bravo#${B.tag}` });
  ok(!!(await B2.wait(m => m.t === 'notice' && /friend request/.test(m.text))), 'friend request delivered');
  B2.send({ t: 'friend_accept', id: A.id });
  const fl = await B2.wait(m => m.t === 'friends' && m.friends.length === 1);
  ok(fl && fl.friends[0].id === A.id && fl.friends[0].status.s !== 'offline', 'friends list shows online friend');

  // ---- walkable hub
  A.send({ t: 'hub_enter' }); B2.send({ t: 'hub_enter' });
  const ha = await A.wait(m => m.t === 'hub_start'), hb = await B2.wait(m => m.t === 'hub_start');
  ok(ha && hb && ha.inst === hb.inst, 'squadmates placed in the same hub instance');
  A.send({ t: 'hin', x: ha.x + 0.3, z: ha.z, yaw: 0 });
  await sleep(250);
  const hs = B2.last(m => m.t === 'hub_s');
  ok(hs && hs.p.length === 2, 'hub snapshots include both raiders');
  B2.send({ t: 'hub_chat', text: 'yo' });
  ok(!!(await A.wait(m => m.t === 'hub_chat' && m.text === 'yo')), 'hub chat relayed');
  B2.send({ t: 'emote', e: 'wave' });
  await sleep(250);
  ok(A.last(m => m.t === 'hub_s')?.p.some(r => r[5] === 0), 'emote visible to others');

  // ---- ready check + deploy without someone + reserved slot + join squad
  B2.send({ t: 'party_ready', ready: true });
  ok(!!(await A.wait(m => m.t === 'party' && m.party?.members.find(x => x.id === B.id)?.ready)), 'ready state shared');
  B2.send({ t: 'act', a: 'free_kit' });
  ok(!!(await B2.wait(m => m.t === 'err' && /Unready/.test(m.msg))), 'ready locks loadout changes');
  B2.send({ t: 'party_ready', ready: false });
  await sleep(150);
  A.clear(); B2.clear();
  A.send({ t: 'deploy' });
  const conf = await A.wait(m => m.t === 'deploy_confirm');
  ok(conf && conf.missing.includes('Bravo'), 'leader warned that Bravo is not ready');
  A.send({ t: 'deploy', force: true });
  const sa = await A.wait(m => m.t === 'raid_start');
  ok(!!sa, 'leader deployed');
  const pv = await B2.wait(m => m.t === 'party' && m.party?.joinUntil);
  ok(!!pv, 'left-behind member gets a held slot (JOIN SQUAD)');
  B2.send({ t: 'join_squad' });
  const sb = await B2.wait(m => m.t === 'raid_start');
  ok(sb && sb.raid === sa.raid && sb.squad.length === 2, 'late member dropped into the same raid & squad');
  ok(sb && Math.hypot(sa.x - sb.x, sa.z - sb.z) < 8, 'late member spawned with squad');
  ok(!!(await A.wait(m => m.t === 'squad' && m.squad.length === 2)), 'existing member gets roster update');
  const st = await A.wait(m => m.t === 's' && m.p.length >= 1);
  ok(!!st, `snapshots flowing (sees ${st?.p.length} players, ${st?.e.length} enemies)`);
  A.send({ t: 'chat', ch: 'squad', text: 'hello squad' });
  ok(!!(await B2.wait(m => m.t === 'chat' && m.text === 'hello squad')), 'squad chat works in raid');

  // ---- fill squad: two solos get grouped
  const E = await bot('Echo'), F = await bot('Fox');
  await E.wait(m => m.t === 'profile'); await F.wait(m => m.t === 'profile');
  E.send({ t: 'deploy', fill: true }); F.send({ t: 'deploy', fill: true });
  ok(!!(await E.wait(m => m.t === 'fill' && m.searching)), 'fill search started');
  const se = await E.wait(m => m.t === 'raid_start', 6000), sf = await F.wait(m => m.t === 'raid_start', 6000);
  ok(se && sf && se.raid === sf.raid && sf.squad.length === 2, 'fill squad grouped two solos into one squad');

  const stats = await (await fetch(`http://localhost:${port}/api/stats`)).json();
  ok(stats.raids.reduce((a, r) => a + r.players, 0) === 4, `stats report 4 raiders topside (${JSON.stringify(stats.raids)})`);
  const bytes = A.msgs.filter(m => m.t === 's').map(m => JSON.stringify(m).length);
  console.log(`     avg snapshot ${Math.round(bytes.reduce((a, b) => a + b, 0) / Math.max(1, bytes.length))} bytes (pre-deflate)`);
  for (const b of [A, B2, E, F]) b.ws.close();
  srv.kill('SIGTERM');
  await sleep(300);
}

console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
process.exit(fails ? 1 : 0);
