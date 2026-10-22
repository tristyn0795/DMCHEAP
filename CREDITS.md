# Credits

All third-party assets in DMCHEAP are public-domain (CC0). Attribution isn't required, but we credit them anyway.

## Audio (`client/audio/`)

Gunshots: **The Free Firearm Sound Library** (Prepared SFX Library), by Ben Jaszczak, Brian Nelson, Kevin Heras and Matthew Nanney. License [CC0 1.0](http://creativecommons.org/publicdomain/zero/1.0/). Mirror: <https://opengameart.org/content/the-free-firearm-sound-library>

| File(s) | Source recording |
|---|---|
| `pistol_near/far` | Walther PPQ 9mm (X_39P / X_31P) |
| `revolver_near/far` | Smith & Wesson 642 .38 (V_27P / V_22P) |
| `smg_near/far` | Carl Gustav M45 9mm (G_31P / G_20P) |
| `shotgun_near/far` | Benelli Nova 12ga (O_21P / O_17P) |
| `ar_near/far` | AR-15 5.56 (D_32P / D_24P) |
| `ak_near/far` | AK-47 7.62x39 (C_28P / C_31P) |
| `dmr_near/far` | Norinco SKS 7.62x39 (U_14P / U_19P) |
| `bolt_near/far` | Tikka T3 .30-06 (W_29P / W_24P) |

Reloads: **Gun Reload Sounds** by SpringySpringo. License CC0. <https://opengameart.org/content/gun-reload-sounds>
- `reload_pistol.mp3` ← gunreload1.wav
- `reload_rifle.mp3` ← assaultriflereload1.wav
- `rack.mp3` ← shotguncock.wav

Processing: we took the first clean shot from each recording, downmixed to mono, peak-normalised to −1 dB, added short fades and encoded 96 kbps MP3. All in-game weapon names and models are fictional.

## Code

- [three.js](https://threejs.org) (MIT)
- [ws](https://github.com/websockets/ws) (MIT)
- [node-postgres](https://node-postgres.com) (MIT)
