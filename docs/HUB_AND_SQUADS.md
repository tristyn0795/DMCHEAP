# Hub & seamless squad play — research and plan

Goal: friends meet in a shared space, group up without friction, and stay together through raid → hub → raid. Plus ways to rejoin and drop in mid-raid that fit an extraction game.

## 1. What the reference games do

| Game | Hub | Grouping | Mid-raid joining |
|---|---|---|---|
| **ARC Raiders** | **Speranza is menu-based.** In Jan 2026 Embark said a walkable version has been discussed but isn't committed. They'd keep the menus too, as a faster way to get things done. | Invite through the Social button. Max 3. **Fill Squad** toggle. Every member must **ready up**, then the leader starts. | None |
| **MW2 DMZ** | Menu | Party up to 3 before the match. Turn Squad Fill off for friends-only. | **Squad assimilation:** invite or "request to join" another squad in-match. Everyone must accept. Super-squads go up to **6**. |
| **MW4 DMZ (Oct 2026)** | FOB with stations (stash, 3D printer, gunsmith, range, boss board). Menu-driven. | Solo, duo or trio. Solos get a stealth meter. | Not documented yet |
| **Marathon** | Menu | Crew of 3. The leader invites by Bungie Name. Empty slots are filled by matchmaking on deploy. A **Runner Connections** screen lists recent players for quick friend requests or invites. | None |
| **Dark and Darker** | **Tavern lobby**: a small walkable waiting room, plus a **Gathering Hall** player list with region chat. | Invite by character name, then everyone readies before the host starts. | None |
| **Helldivers 2** | **A walkable ship per squad.** Quickplay can drop you into someone's ship. | Friend codes. Lobby privacy: Public, Friends-only or Invite-only. | **SOS beacon:** opens a running mission to drop-in joiners. |
| **Destiny 2** | Tower, a shared social space | Fireteams | Join-on-friend |

Destiny's Tower is capped at about 26 players per instance (Destinypedia). That's a good reference size for a browser hub instance.

Three takeaways:
1. Even AAA extraction games keep the hub mostly as menus. A walkable hub is mainly a social and identity feature, so **keep the menu shortcuts** (Embark's stated reasoning).
2. The flow that matters is: **invite → ready check → leader deploys**, with **Fill Squad** for solos.
3. Joining mid-raid exists only in forms that protect the extraction tension: DMZ's merging needs consent from everyone, and Helldivers' beacons are opt-in. A free "join my friend anywhere" would let players skip the risk.

## 2. Where DMCHEAP is today
- Parties live in memory in `server/index.js`. A **party is lost the moment someone disconnects** (`leaveParty` runs on socket close).
- The leader deploys every member who isn't in a raid. There's **no ready check**. A member still in a previous raid is **silently left behind**.
- Late joiners can only enter a raid in its first 4 min (`C.JOIN_WINDOW`), with **no reserved slot** and no guarantee of the squad's raid.
- Reconnecting to a live raid already works (`raid.reattach`).
- The hub is menus only. There are no friends, presence or invite links.

## 3. Proposed design

### 3.1 "The Cheap Seats" as a walkable hub (optional layer over the menus)
- A **HubRoom** is a small shared 3D space using the same Three.js client, movement and collision code.
  - It has no combat, an emote wheel, and text chat.
  - Players get a cosmetic **"last extract" banner** over their head, which is good for showing off.
- **Instances hold up to 24 players.** The router puts you in the instance with your **party first, then friends**, then the fullest open one.
- **Stations are kiosks** you walk up to and press E: Stash/Loadout, Penny (trader), Ox (workbench), contracts board, skills, records and leaderboard.
  - Each kiosk opens the existing panel. The **hotkeys and top tabs stay**, so nobody is forced to walk.
- **The Lift** is the deploy pad. The party stands in the lift ring, the ready check runs, and the leader pulls the lever.
- **Netcode:** 10 Hz snapshots of `[nid, x, z, yaw, anim]`, about 15 bytes per player. 24 players is about 4 KB/s per client before deflate. No lag compensation is needed.

### 3.2 Persistent party (the core of "seamless")
- **Parties are keyed by profile ID, not socket.** Disconnecting starts a 5-minute grace period. You stay listed as "reconnecting" and keep your slot.
- **Leader handoff** happens automatically if the leader leaves or the grace period runs out.
- The **party survives raids.** When members come back (extracted or KIA), they spawn **next to each other in the same hub instance**, and the party panel shows each member's status:

  ```
  Alpha  ✓ ready
  Bravo  ⏳ still topside (6:12 left)
  Charlie  💀 KIA (reviewing gear)
  ```
- **Ready check:**
  1. The leader presses Deploy, which opens a 20 s check.
  2. Each member clicks Ready, which **locks their loadout**.
  3. When everyone is ready, the squad deploys together. Members who are still topside or not ready block the check, and the leader sees who. A "Deploy without them" button reserves their slot (see 3.4).
- **Privacy:** `Invite only` / `Friends can join` / `Open (Fill Squad)`.

### 3.3 Friends, presence and invites
- **Friend IDs** are `Name#1234`, where the tag is the last 4 characters of the profile ID. You send a request, they accept, and the pair is stored in Postgres.
- **Recent Raiders** lists squadmates and the last 20 raiders you fought (Marathon's "Runner Connections"), with one-click friend or invite.
- **Presence** shows: In Hub (instance), In Raid (POI threat and minutes left, nothing more specific), or Offline (last seen).
- **Invite links:** `https://<domain>/?join=K7Q2M`. Opening one logs you in or creates a raider, then auto-joins the party. This is the lowest-friction path for a browser game, since it works over Discord or text.

### 3.4 Seamless raiding together
1. **Same raid, same spawn.** This already works for a party that deploys together. Keep it.
2. **Reserved slots.** If the leader deploys without someone, that member's slot in the raid is **held for 5 minutes**.
   - The held member gets a "Join your squad" button and spawns at the squad's infil point.
   - This overrides the normal 4-min join window for that player only.
3. **Squad Flare (Helldivers-SOS style, opt-in).** Mid-raid, the squad can fire a **Squad Flare** at a cleared spot. It's a craftable consumable.
   - Party members or friends in the hub can drop in **until 12:00 remaining**.
   - They arrive by the flare after a 10 s descent with a **Free Kit only**, no stash gear. This keeps it from becoming a safe loot shortcut.
   - The flare is loud: a noise event plus a map ping visible to everyone within 150 m. Bringing a friend in costs you exposure.
4. **Mid-raid alliances (DMZ assimilation).** Ping another squad and choose **Request alliance**. Every member of both squads must accept.
   - Accepting merges them into one squad for friendly-fire and revive rules, **capped at 6**, and dissolves on betrayal (damage) or on request.
   - The alliance shows in the after-action report, so friends made topside can be added to Recent Raiders.
5. **Stay together after death.** A KIA squadmate can choose **Spectate squad** (follow cam fed from the existing snapshot stream) or **Return to hub**.
   - Spectating keeps the group's voice and text together and is cheap: no extra simulation.
6. **Regroup on extract.** If squadmates extract at different lifts, they still land together in the hub and the party is intact.
7. **Fill Squad.** Solos who opt in are grouped into trios at deploy time from a short queue (≤20 s, then deploy anyway).

### 3.5 Balance guards
- No drop-ins after 12:00 remaining. Drop-ins come with a Free Kit only. Flares are loud.
- Alliances need unanimous consent and are capped at 6. A Wanted squad (bounty) can't form alliances.
- A reserved slot expires after 5 min and doesn't count toward the 12-player cap after it expires.

## 4. Architecture on Railway

### Phase 1: same single service (≈ up to 200 concurrent players)
- Add `server/hub.js` (HubRoom instances) and `server/party.js`, which is the existing party code made persistent and moved out of `index.js`.
- Keep everything in one Node process. One WebSocket per client carries both hub and raid messages, as now.
- Postgres gets new tables: `friends(a, b, since)`, `friend_requests(from, to, at)`, `recent_raiders(pid, other, at)`.
- Cost: almost nothing. A hub instance at 10 Hz is far cheaper than a raid.

### Phase 2: hub/gateway + raid shards (when one box isn't enough)
```
           browser ──wss──► hub service (public domain)
             │                 auth · hub instances · parties · friends · matchmaking
             │                 │  Postgres (profiles, friends)
             │                 │  Redis (presence, party state, shard registry, pub/sub)
             │                 ▼  private network: http://raid-1.railway.internal:8080
             └──wss──► raid-1 / raid-2 … (each its own public domain)
```
- **Join tickets:**
  1. On deploy, the hub picks a shard, reserves the slots and returns `{url: wss://raid-2…/ws, ticket}`.
  2. The ticket is an HMAC-signed `{pid, raidId, squadId, exp}` using a shared `TICKET_SECRET`.
  3. The client opens a second WebSocket to the shard, and the shard verifies the ticket.
  4. When the raid ends, the shard writes the result to Postgres and publishes `raid_result` over Redis so the hub can update the party panel.
- **Why separate services instead of replicas:**
  - Rooms are stateful.
  - Railway's public domain spreads requests across a service's replicas, so a client can't target a specific replica. Verify current routing behaviour before relying on this.
  - Browsers can't reach `*.railway.internal`.

  So each raid shard should be **its own service with its own public domain**. Shard-to-hub traffic stays on the private network.
- Redis is a one-click Railway template. Colyseus's docs describe the same pattern (`RedisPresence` + `RedisDriver`) if you ever move to that framework.

## 5. Build order (smallest useful steps first)
1. **Persistent parties + regroup after raid + ready check + member status.** This fixes the "seamless" problems with no new tech. *~1 day*
2. **Invite links (`?join=CODE`) + Fill Squad.** *~0.5 day*
3. **Reserved slots + "Join your squad" button.** *~0.5 day*
4. **Friends, presence and Recent Raiders (Postgres tables).** *~1 day*
5. **Spectate squad on death.** *~0.5 day*
6. **Walkable hub (HubRoom, kiosks, lift ready-ring, emotes).** *~2–3 days*
7. **Squad Flare drop-ins + alliances.** *~1–2 days*
8. **Phase 2 sharding,** only when concurrency demands it. *~2–3 days*

## Sources
- ARC Raiders: [Embark FAQ — Rust Belt](https://id.embark.games/arc-raiders/support/faq/134-welcome-to-the-rust-belt/), [GamingBolt — walkable Speranza](https://gamingbolt.com/?p=635183), [Gameranx — walkable Speranza](https://gameranx.com/updates/id/560573/article/arc-raiders-embark-studios-seems-interested-in-making-a-walkable-speranza/), [Icy Veins — playing with friends](https://wp-prod.icy-veins.com/how-to-play-with-friends-in-arc-raiders/)
- DMZ: [Dot Esports — joining/merging squads](https://dotesports.com/call-of-duty/news/how-to-join-and-merge-with-other-squads-in-dmz-and-warzone-2), [GGRecon — DMZ overview](https://ggrecon.com/guides/modern-warfare-2-dmz), [Pocket Tactics — MW4 DMZ](https://www.pockettactics.com/call-of-duty-modern-warfare-4/dmz), [codmunity — MW4 vs MW2 DMZ](https://codmunity.gg/dmz/whats-new)
- Marathon: [Cross Play Guide (help center)](https://help.marathonthegame.com/hc/en-us/articles/39004046491156/), [AllThings.How — crew invites](https://allthings.how/marathon-crew-invites-using-bungie-names-to-party-up-across-platforms/)
- Dark and Darker: [Shacknews — play with friends](https://www.shacknews.com/article/134149/play-with-friends-dark-and-darker)
- Helldivers 2: [Prima — SOS beacon](https://primagames.com/tips/how-to-fix-sos-beacon-not-working-in-helldivers-2), [Game8 — multiplayer](https://game8.co/games/Helldivers-2/archives/446148)
- Destiny 2: [Destinypedia — Tower](https://www.destinypedia.com/Tower_(Destiny_2)), [DualShockers — social space capacity](https://www.dualshockers.com/destiny-2-social-space-farm-gameplay-video/)
- Tech: [Railway private networking](https://docs.railway.com/networking/private-networking), [Colyseus server/presence docs](https://docs.colyseus.io/server/), [Gabriel Gambetta — fast-paced multiplayer](https://gabrielgambetta.com/), [UCL — interest management](https://www.ee.ucl.ac.uk/lcs/previous/LCS2011/LCS1121.pdf)
