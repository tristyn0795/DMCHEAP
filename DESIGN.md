# DMCHEAP — Design notes & research

## Pillars
1. **Risk is the content.** Everything you carry topside can be lost. Extraction is the win condition, not kills.
2. **PvPvE tension.** Machines are predictable and loud. Raiders are not. Noise draws both.
3. **Cheap to run.** One Node process on Railway, no build step, no assets, no UDP.

## Research summary (what we borrowed and why)

### ARC Raiders (Embark, 2025)
- **The loop:** raiders go topside from the underground city **Speranza**, scavenge, and must extract. Loot is lost on death. Sessions run ~30 min. Extracts are public elevators and metro stations, plus **raider hatches**. Elevators depart ~90 s after being called. DMCHEAP uses 40 s, scaled to a smaller map.
- **Base:** you craft, repair and upgrade gear in a **workshop**, learn blueprints, and sell or recycle loot to traders. Recycling in raid yields less. DMCHEAP has a Workbench with 3 levels plus recycling.
- **Skill tree:** three branches. **Survival** (loot faster, move quieter), **Mobility** and **Conditioning**. Copied as the three trees.
- **Safe pockets** come from augments (0 on the free-loadout augment, up to 3 on epic ones). Weapons can't go in them. The **free loadout** gives a random starter kit with a light shield. Both are mirrored by DMCHEAP's rigs and Free Kit.
- **ARC machines:** Wasp and Hornet drones (exposed thrusters), the **Snitch** (a flying alarm that calls in drones), Rocketeer, **Leaper** (melee jumper) and **Bastion** (heavy walker, weak points on knees and back). In DMCHEAP these map to the Gnat, **Squealer**, Tick, Sentry (weak back) and **Warden** (weak core).
- **Rarity tiers:** gray → green → blue → purple → orange.

### Call of Duty DMZ (MW2 2022 → MW4 2026, "Hajin")
- **MW2 DMZ:** insured weapon slots (lost guns return after a cooldown), contraband (field loot is yours only if you extract), faction missions, contracts, **keys for strongholds**, and **exfil choppers that pull AI to the zone**.
- **MW4 DMZ (launches 23 Oct 2026):**
  - Modes are Story Missions, Dynamic Operations and Free Roam.
  - **Threat levels 1–5 per POI.** Gunfire raises local threat.
  - A **stealth meter** shades white → yellow → orange.
  - Operators carry traits and go MIA on death, with a paid rescue.
  - **Secure slots**, a free loadout, a stash of 40 items plus 12 weapons, and a FOB with stations.
  - **Lieutenant and Commander bosses** with bounties.
  - **4 operator kills makes you Wanted** and reveals you on the map.
  - **Three random exfil zones per match, closing near radiation first.**
  - A 30-minute deployment timer before radiation spreads.
  - 60 players in squads of up to 3.

### Railway (hosting)
- **Networking:**
  - No **inbound UDP** (staff-confirmed; outbound UDP only).
  - The TCP proxy has no TLS or custom domain, and community reports say browser `wss://` through it hangs.
  - Public HTTP domains proxy WebSockets on 443 to `$PORT`. So all game traffic goes over WebSockets on the HTTP port.
- **Pricing (usage-based):** $20/vCPU-month, $10/GB-RAM-month, $0.05/GB egress, $0.15/GB-month volume. Hobby is $5/month including $5 of usage.
- **Colyseus-on-Railway guidance:** bind `0.0.0.0`, read `PORT`, run a single replica because rooms live in memory. We followed this without the framework, to keep dependencies at `ws` + `pg` + `three`.

## Scale decisions

| Real games | DMCHEAP | Why |
|---|---|---|
| 60 players/match (MW4) | 12 per raid, 4 squads of 3 | Browser and WebSocket bandwidth, one Node process |
| Multi-km maps | 400 × 400 m, 7 POIs | Fits a 20 min raid on foot |
| 30 min raids | 20 min, extracts close at 14:00 and 17:00 | Shorter sessions in the browser |
| Thousands of items | ~45 items, 7 weapons, 6 enemy types | All data-driven in `shared/data.js` |
| Streaming 3D assets | Procedural low-poly + seeded world | Zero asset hosting, instant load |

## Economy cheat-sheet
- **Start:** $3,000, a Peashooter, a light shield, a Scav rig, a spare Buzz SMG and some materials.
- **Income:** selling loot (valuables $70–$9,000), contracts ($900–$15,000), and bounties ($2,500).
- **Sinks:** trader buys (1.6× markup), insurance (25% of weapon value), expediting insurance (40%), workbench upgrades ($10k and $40k plus materials), and contract rerolls ($300).
- **Gear progression:** materials and Workbench upgrades unlock crafting of rare and epic gear. Vaults and The Warden are the best sources of epic and legendary loot.

## Tuning knobs (all in `shared/data.js`)
- **`C`:** raid timer, extract countdown, squad and raid size, stamina, bleed-out, the Wanted threshold.
- **`ENEMIES`:** hp, sight, rpm, damage and speed. AI spread is in `server/raid.js` `enemyShoot`.
- **`LOOT_TABLES` and `CONTAINER_ROLLS`:** loot weights. Threat shifts weight toward rarer items via `rollLoot`.

## Sources
- ARC Raiders: [Rock Paper Shotgun review](https://www.rockpapershotgun.com/arc-raiders-review), [Epic Games Store](https://store.epicgames.com/p/arc-raiders), [PlayStation](https://www.playstation.com/games/arc-raiders/), [8bittoast — extraction](https://8bittoast.com/how-to-extract-arc-raiders/), [Prima — enemies](https://primagames.com/tips/how-to-beat-every-enemy-in-arc-raiders), [KeenGamer — recycling](https://www.keengamer.com/articles/guides/arc-raiders-recycling-guide-what-to-loot-sell-and-recycle/), [Nerdschalk — safe pockets](https://nerdschalk.com/arc-raiders-how-to-get-more-safe-pockets/), [AllThings.How — free loadouts](https://allthings.how/arc-raiders-free-loadouts-start-runs-extract-and-trade-augments/)
- DMZ: [Infinity Ward — Welcome to DMZ (2022)](https://infinityward.com/news/2022/11/warzone-2-0-launch-update--welcome-to-dmz), [GGRecon — insured weapons](https://www.ggrecon.com/guides/mw2-dmz-mode-how-to-insure-weapons), [Call of Duty — MW4 DMZ deep dive](https://www.callofduty.com/blog/2026/06/call-of-duty-modern-warfare-4-dmz-deep-dive), [AllThings.How — How DMZ works in MW4](https://allthings.how/how-dmz-works-in-call-of-duty-modern-warfare-4-beginner-s-guide/), [GosuGamers — MW4 launch 23 Oct](https://www.gosugamers.net/entertainment/news/78507-call-of-duty-modern-warfare-4-to-launch-on-23-october-with-dmz-nintendo-switch-2-version)
- Railway: [TCP proxy docs](https://docs.railway.com/networking/tcp-proxy), [Inbound UDP thread](https://station.railway.com/feedback/udp-inboud-connections-9f036ffc), [Pricing plans](https://docs.railway.com/pricing/plans), [Config as code](https://docs.railway.com/reference/config-as-code), [Deploying a realtime game on Railway](https://dev.to/arjen_/deploying-a-real-time-multiplayer-game-on-railway-2d11)
