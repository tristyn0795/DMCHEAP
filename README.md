# DMCHEAP

A browser-based **third-person PvPvE extraction shooter** inspired by **ARC Raiders** and **Call of Duty DMZ** (MW2 2022 → MW4 2026). It's sized to run as **one Railway service** for about $5–20/month.

> Topside is cheap. Getting out isn't.

Gear up in **The Cheap Seats** (an underground hideout). Deploy topside into a 400 × 400 m zone run by the bargain-bin autonomous defence machines of **C.H.E.A.P.** (*Combat Hardware for Exclusion Area Patrol*). Then fight Rustline mercs and other raiders, loot, and reach a lift before **The Sweep**. If you die, you lose everything outside your safe pocket.

```
npm install
npm start            # http://localhost:3000
npm test             # in-process raid logic + real WebSocket bots
```

## Deploy on Railway

1. Push this folder to a GitHub repo.
2. In Railway: **New Project → Deploy from GitHub repo**. `railway.json` sets the start command, the `/health` health check and a 15 s drain window.
3. On the service, open **Settings → Networking → Generate Domain**. Clients connect to `wss://<domain>/ws` on the same port as the page.
4. Add persistence. Pick one:
   - **Recommended:** add the **Postgres** plugin and set `DATABASE_URL=${{Postgres.DATABASE_URL}}` on the service. The `profiles`, `friends`, `friend_requests` and `recent_raiders` tables are created on boot.
   - **Or** attach a **Volume** mounted at `/app/data` and set `DATA_DIR=/app/data`.
5. Keep **1 replica**. Raids live in process memory, so see "Scaling" before adding replicas.

| Env var | Default | Purpose |
|---|---|---|
| `PORT` | injected by Railway | HTTP + WebSocket port |
| `DATABASE_URL` | – | Postgres for profiles (falls back to JSON files) |
| `DATA_DIR` | `./data` | JSON profile store when there's no Postgres |
| `MAX_RAIDS` | `12` | Max concurrent raid instances (12 raiders each) |
| `FILL_WAIT_MS` | `15000` | Max wait before Fill Squad launches a partial squad |

### Why it's built this way (Railway constraints)

- **No inbound UDP on Railway.** Railway supports outbound UDP only. Native game netcode (UDP, WebRTC data channels) can't accept players there, so all realtime traffic is **WebSocket over Railway's HTTPS edge** with `permessage-deflate` compression.
- **Avoid the raw TCP proxy for browsers.** It has no TLS or custom domain, and community reports say `wss://` through it hangs. One port serves both the page and `/ws`.
- **Usage-based billing:** $20/vCPU-month, $10/GB-RAM-month, $0.05/GB egress, per the Railway docs. Measured on this code:
  - A full 12-player raid with ~100 AI ticks in **~1.2 ms of a 50 ms budget**.
  - Each player downloads **~2.3 KB/s** after deflate (~8 MB per hour).
  - The process idles at **~100 MB RAM**.
  - So one 1 vCPU / 512 MB service can host roughly 10–20 raids (120–240 concurrent players). Bandwidth works out to about **$0.0004 per player-hour**.

## What's in the game

| System | Inspired by | DMCHEAP version |
|---|---|---|
| Extraction loop, gear at risk | both | Deploy with your loadout. Death drops everything except the safe pocket. |
| Safe pocket | ARC Raiders safe pockets / DMZ secure slot | Rigs give 0–3 protected slots. Weapons can't go in. |
| Free loadout | ARC free loadout / DMZ "Equip Free Loadout" | **Free Kit:** a random basic weapon, light shield and free rig at no cost. |
| Insured weapon | MW2 DMZ insured slot | One insured gun comes back after 15 min if lost. You can pay to expedite. |
| Shields | ARC Raiders | Light/Medium/Heavy shields absorb 40–60% of damage while charged. Shield cells recharge them. |
| Machines | ARC (Wasp/Hornet/Snitch/Leaper/Bastion…) | **Gnat** drone, **Squealer** alarm drone (calls reinforcements), **Tick** suicide crawler, **Sentry** turret (armored front, weak back), **The Warden** boss walker (weak-point core, artillery barrage). |
| Human AI faction | DMZ factions | **Rustline Mercs**: strafe, take fire, drop weapons. |
| POI threat levels | MW4 DMZ (Threat 1–5) | Seven POIs from ▲ to ▲▲▲▲▲. Threat raises enemy density and loot rarity. |
| Stealth meter | MW4 DMZ | The HUD bar fills white → yellow → orange as machines notice you. Crouching, distance and cover matter. Sprinting and gunfire make noise. |
| Locked vaults | DMZ keys/strongholds, ARC locked rooms | Depot, Mall and Reactor vaults need single-use keys. |
| Extraction | DMZ exfil chopper + ARC elevators | 3 of 6 lifts open per raid. Calling one takes 40 s and draws a swarm. Two lifts close early. |
| Raider hatch | ARC Raiders hatches | A Hatch Key gives a quiet 5 s solo extraction. |
| Raid timer | ARC 30 min / DMZ radiation | 20 min, then The Sweep kills everyone left. |
| Downed & revive | both | Squadmates revive with E. A tourniquet allows one self-revive. |
| Wanted / bounty | MW4 DMZ (4 kills → Wanted) | 3 raider kills reveal you on everyone's map. Killing a Wanted raider pays $2,500. |
| Crafting & recycling | ARC workshop / DMZ 3D printer | Workbench levels 1–3 and 22 recipes. Recycle junk into materials. |
| Traders & contracts | ARC traders/quests, DMZ orders | Penny the Quartermaster sells basics. Contracts cover kill, deliver, survey, extract and boss jobs. |
| Skill trees | ARC (Survival/Mobility/Conditioning) | Same three trees, 9 nodes, 1 point per level. |
| Squads | both (trios) | Up to 3 per squad, 12 raiders per raid. **Squads persist** between raids and through disconnects (5 min grace). Members **ready up** (which locks gear) and the leader deploys. Invite with a **link** (`/?join=CODE`) or a code. Squad, hub and proximity text chat, plus pings. |
| Held slots / drop-in | Helldivers 2 SOS-style join | If the leader deploys without you, your raid slot is **held for 5 min**. **JOIN SQUAD** spawns you at your squad's infil. |
| Fill Squad | ARC Raiders / Marathon | Solos and duos with *Fill* on are grouped into trios (≤15 s wait) and stay a squad afterwards. |
| Friends & presence | Marathon "Runner Connections" | Add by **Name#TAG**. See who's in the hub, in the hideout or topside (with time left). One-click Invite/Join. **Recent Raiders** lists squadmates and the people you fought. |
| Spectate squad | — | Dead or extracted while squadmates are still topside? Follow-cam them (Space for the next squadmate). |
| Walkable hub | Dark and Darker tavern, Destiny Tower | **The Cheap Seats**: a shared 3D bunker (24 per instance, your squad and friends placed together). Stations open the menus, **The Lift** is the ready/deploy pad. Emotes (1–5), chat bubbles. **Menu mode** skips it. |

## Controls

**Hub:** `WASD` walk · `E` use station / lift · `1`–`5` emotes · `Enter` chat (`/p` squad chat) · `Tab` terminal (menus) · `O` friends.

**Raid:** `WASD` move · `Shift` sprint · `C` crouch · mouse aim · `LMB` fire · `RMB` aim down sights · `R` reload · `1`/`2` weapons · `E` interact/search/revive/extract · `Q` heal · `Z` shield cell · `G` frag · `T` lure beacon · `X` tourniquet (while downed) · `Tab` inventory · `M` map · `F` ping · `V` swap shoulder · `Enter` chat (start with `/` for proximity).

## Architecture

```
client/                 static ES modules, no build step
  index.html, style.css
  main.js               screen routing (login / hub / menus / raid), invite links
  net.js                WebSocket + reconnect
  hideout.js            stash/loadout/trader/workbench/contracts/skills UI (full screen or terminal overlay)
  hubworld.js           walkable hub: Three.js scene, kiosks, lift, emotes, chat bubbles
  social.js             squad + friends panels, Deploy/Ready/Join Squad button logic
  models.js             shared low-poly character + label builders
  game.js               Three.js renderer, 3rd-person camera, prediction/interp, HUD, inventory, map
  audio.js              procedural WebAudio SFX (no assets)
shared/                 imported by BOTH server and browser
  data.js               items, weapons, enemies, loot tables, recipes, skills, POIs
  world.js              seeded map generation, spatial grid, collision, raycasts
  hubmap.js             hub layout (kiosks, lift) shared by server collision + client render
server/
  index.js              HTTP static + /ws, auth, message routing, deploy plumbing
  raid.js               authoritative 20 Hz raid simulation (+ held slots, late squad joins, spectators)
  party.js              persistent squads, ready check, held slots, fill-squad queue
  social.js             friends, requests, presence, recent raiders, invites
  hub.js                walkable hub instances (10 Hz, 24 cap, squad/friends placed together)
  profiles.js           hideout economy + raid result application
  storage.js            Postgres or JSON-file profile store
test/smoke.js           logic tests + networked bot test
```

**Netcode model (sized for a browser game on WebSockets):**

- **Movement:** clients predict it locally with the shared collision code. The server checks it against a speed budget and the same collision, sends corrections, and rejects wall tunnelling.
- **Everything else is server-authoritative:** damage, ammo, loot, AI, inventory and the economy.
- **Hitscan with lag compensation:** the server rewinds players and enemies to the client's render time, capped at 350 ms.
- **Snapshots:** sent at 20 Hz, filtered to a 160 m area of interest, and interpolated on the client 100 ms behind.
- **Map:** the world is generated from a fixed seed on both sides, so it's never sent over the network. Loot, enemies and the set of open extracts are rolled per raid.

## Scaling past one box

1. **Scale vertically first.** One Node process at ~1.2 ms per raid tick goes a long way.
2. **Then shard.** Run N copies of this service (each a "region" or "shard") behind a tiny lobby that picks a shard and hands the client its `wss://` URL. Profiles already live in Postgres, so any shard can load any player.
3. **Bandwidth next steps if egress grows:** binary snapshots (e.g. `DataView`-packed), delta compression, and a lower snapshot rate for far-away entities.

## Known limits / roadmap

- Shot direction is client-reported, so aimbots are possible. Server-side checks for spread and angular speed would be the next anti-cheat layer.
- AI uses steering and raycast avoidance, not a navmesh. It can get stuck on complex interiors.
- Art is low-poly primitives with procedural audio. Swap in glTF models and samples later.
- No voice chat (WebRTC voice would need a TURN server that isn't on Railway).
