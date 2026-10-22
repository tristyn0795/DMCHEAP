// WebAudio SFX: recorded CC0 gunshots (see CREDITS.md) with near/far variants, distance filtering and
// suppressor processing; everything else (machines, UI, explosions) is synthesized procedurally.
const SAMPLE_FILES = ['pistol', 'revolver', 'smg', 'shotgun', 'ar', 'ak', 'dmr', 'bolt'].flatMap(n => [n + '_near', n + '_far']).concat(['reload_pistol', 'reload_rifle', 'rack']);
// weapon id -> [sample family, playback rate]
const GUN_SOUND = {
  peashooter: ['pistol', 1], revolver: ['revolver', 1], buzz: ['smg', 1], doorknock: ['shotgun', 1], ranger: ['ar', 1],
  br7: ['ar', 1.06], gilded: ['ar', 0.97], k47: ['ak', 1], longshot: ['dmr', 1], mk2: ['bolt', 1], hauler: ['ak', 0.88], merc: ['ak', 1.02],
};

export class Sfx {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.noise = null;
    this.volume = 0.5;
    this.buffers = {};
  }
  async loadSamples() {
    if (this.loading) return;
    this.loading = true;
    await Promise.all(SAMPLE_FILES.map(async (n) => {
      try {
        const res = await fetch(`/audio/${n}.mp3`);
        this.buffers[n] = await this.ctx.decodeAudioData(await res.arrayBuffer());
      } catch { /* fall back to synthesis */ }
    }));
  }
  play(name, { vol = 1, rate = 1, lowpass = 20000, highpass = 0, delay = 0 } = {}) {
    const buf = this.buffers[name];
    if (!this.ctx || !buf || vol <= 0.005) return false;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = rate;
    let node = src;
    if (lowpass < 20000) { const f = this.ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = lowpass; node.connect(f); node = f; }
    if (highpass > 0) { const f = this.ctx.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = highpass; node.connect(f); node = f; }
    const g = this.ctx.createGain(); g.gain.value = vol;
    node.connect(g); g.connect(this.master);
    src.start(this.ctx.currentTime + delay);
    return true;
  }
  unlock() {
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    this.ctx = new AC();
    this.master = this.ctx.createGain();
    this.master.gain.value = this.volume;
    this.master.connect(this.ctx.destination);
    const len = this.ctx.sampleRate * 1.5;
    this.noise = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    this.loadSamples();
  }
  burst({ freq = 1200, q = 0.7, dur = 0.12, vol = 0.6, type = 'lowpass', delay = 0 }) {
    if (!this.ctx || vol <= 0.01) return;
    const t = this.ctx.currentTime + delay;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noise;
    const f = this.ctx.createBiquadFilter();
    f.type = type; f.frequency.value = freq; f.Q.value = q;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    src.connect(f); f.connect(g); g.connect(this.master);
    src.start(t, Math.random() * 0.5, dur + 0.05);
  }
  tone({ freq = 440, freq2 = null, dur = 0.1, vol = 0.2, type = 'sine', delay = 0 }) {
    if (!this.ctx || vol <= 0.01) return;
    const t = this.ctx.currentTime + delay;
    const o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (freq2) o.frequency.exponentialRampToValueAtTime(freq2, t + dur);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g); g.connect(this.master);
    o.start(t); o.stop(t + dur + 0.02);
  }
  // Recorded gunshot: near sample up close, distant sample + muffling far away; suppressors filter + quieten.
  shot(weapon, vol = 1, { suppressed = false, dist = 0 } = {}) {
    const gs = GUN_SOUND[weapon];
    if (gs && this.buffers[gs[0] + '_near']) {
      const rate = gs[1] * (0.97 + Math.random() * 0.06);
      if (suppressed) {
        this.play(gs[0] + '_near', { vol: vol * 0.32, rate: rate * 1.1, lowpass: 1100, highpass: 160 });
        this.burst({ freq: 3500, dur: 0.05, vol: 0.12 * vol, type: 'highpass' });
        return;
      }
      const lp = dist < 25 ? 20000 : Math.max(1800, 16000 - dist * 90);
      if (dist < 40) this.play(gs[0] + '_near', { vol: vol * 0.9, rate });
      this.play(gs[0] + '_far', { vol: vol * (dist < 40 ? 0.35 : 0.9), rate, lowpass: lp });
      return;
    }
    return this.shotSynth(weapon, vol);
  }
  reload(cls) {
    const pistol = cls === 'Pistol' || cls === 'Revolver';
    if (cls === 'Shotgun') { if (!this.play('rack', { vol: 0.5, rate: 1.1 })) this.reloadSynth(); return; }
    if (!this.play(pistol ? 'reload_pistol' : 'reload_rifle', { vol: 0.6 })) this.reloadSynth();
  }
  rack(mode) {
    if (!this.play('rack', { vol: 0.45, rate: mode === 'bolt' ? 1.35 : 1 })) this.burst({ freq: 2200, dur: 0.06, vol: 0.2, type: 'bandpass', q: 3 });
  }
  shotSynth(weapon, vol = 1) {
    const prof = {
      peashooter: [2200, 0.09], buzz: [2600, 0.07], doorknock: [700, 0.25], ranger: [1500, 0.12],
      longshot: [900, 0.35], hauler: [1200, 0.14], gilded: [1700, 0.12], machine: [3200, 0.06], merc: [1500, 0.11],
    }[weapon] ?? [1500, 0.12];
    this.burst({ freq: prof[0], dur: prof[1], vol: 0.55 * vol, q: 0.9 });
    this.tone({ freq: 140, freq2: 50, dur: prof[1] * 1.2, vol: 0.25 * vol, type: 'triangle' });
  }
  hit(kind) {
    if (kind === 'kill') { this.tone({ freq: 880, dur: 0.08, vol: 0.25, type: 'square' }); this.tone({ freq: 1320, dur: 0.12, vol: 0.2, type: 'square', delay: 0.07 }); }
    else if (kind === 'head' || kind === 'weak') this.tone({ freq: 1600, dur: 0.06, vol: 0.2, type: 'square' });
    else if (kind === 'shield') this.tone({ freq: 600, dur: 0.05, vol: 0.15, type: 'triangle' });
    else this.tone({ freq: 1000, dur: 0.04, vol: 0.15, type: 'square' });
  }
  hurt() { this.burst({ freq: 400, dur: 0.15, vol: 0.4 }); }
  boom(vol = 1) { this.burst({ freq: 300, dur: 0.9, vol: 0.9 * vol, q: 0.5 }); this.tone({ freq: 80, freq2: 30, dur: 0.8, vol: 0.5 * vol, type: 'sine' }); }
  alarm(vol = 1) { for (let i = 0; i < 4; i++) this.tone({ freq: 900, freq2: 1400, dur: 0.18, vol: 0.18 * vol, type: 'sawtooth', delay: i * 0.22 }); }
  click() { this.tone({ freq: 300, dur: 0.03, vol: 0.15, type: 'square' }); }
  reloadSynth() { this.burst({ freq: 2500, dur: 0.05, vol: 0.2, type: 'bandpass', q: 3 }); this.burst({ freq: 1800, dur: 0.06, vol: 0.2, type: 'bandpass', q: 3, delay: 0.25 }); }
  horn() { this.tone({ freq: 220, dur: 1.2, vol: 0.25, type: 'sawtooth' }); this.tone({ freq: 277, dur: 1.2, vol: 0.2, type: 'sawtooth' }); }
  ui() { this.tone({ freq: 700, dur: 0.04, vol: 0.08, type: 'sine' }); }
}
