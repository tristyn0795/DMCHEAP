// Procedural WebAudio SFX, so the game ships with no audio assets.
export class Sfx {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.noise = null;
    this.volume = 0.5;
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
  shot(weapon, vol = 1) {
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
  reload() { this.burst({ freq: 2500, dur: 0.05, vol: 0.2, type: 'bandpass', q: 3 }); this.burst({ freq: 1800, dur: 0.06, vol: 0.2, type: 'bandpass', q: 3, delay: 0.25 }); }
  horn() { this.tone({ freq: 220, dur: 1.2, vol: 0.25, type: 'sawtooth' }); this.tone({ freq: 277, dur: 1.2, vol: 0.2, type: 'sawtooth' }); }
  ui() { this.tone({ freq: 700, dur: 0.04, vol: 0.08, type: 'sine' }); }
}
