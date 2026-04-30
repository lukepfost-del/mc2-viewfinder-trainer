'use strict';

// ============================================================================
// MC2 Trainer 2.0 — WebAudio + haptic cues
//
// All audio is synthesized inline (no asset deps).  Bails gracefully when
// AudioContext or vibrate is unavailable (e.g. iOS Safari with sound off).
//
// Public API:
//   MC2Audio.unlock()      — call once on first user gesture (iOS requires this)
//   MC2Audio.setMuted(bool)
//   MC2Audio.lock()        — short positive tick, "lock-on" feel
//   MC2Audio.tickHold(p)   — held progress: pitch ramps with p in 0..1
//   MC2Audio.complete()    — level-complete chime
//   MC2Audio.error()       — error tick (drift / fail)
//   MC2Audio.expose()      — exposure shutter sound
// ============================================================================

const MC2Audio = (() => {
  let ctx = null;
  let muted = false;
  let lastHoldT = 0;

  function ensureCtx() {
    if (ctx) return ctx;
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return null;
      ctx = new Ctx();
    } catch(e) { return null; }
    return ctx;
  }

  // Beep helper: f = freq, dur = seconds, type = 'sine'/'square'/'triangle'/'sawtooth'
  function beep(freq, dur, { type='sine', gain=0.18, attack=0.005, release=0.04, freqEnd=null } = {}) {
    if (muted) return;
    const c = ensureCtx();
    if (!c) return;
    try {
      const o = c.createOscillator();
      const g = c.createGain();
      o.type = type;
      o.frequency.setValueAtTime(freq, c.currentTime);
      if (freqEnd != null) o.frequency.exponentialRampToValueAtTime(Math.max(1, freqEnd), c.currentTime + dur);
      g.gain.setValueAtTime(0, c.currentTime);
      g.gain.linearRampToValueAtTime(gain, c.currentTime + attack);
      g.gain.linearRampToValueAtTime(0,    c.currentTime + dur);
      o.connect(g).connect(c.destination);
      o.start();
      o.stop(c.currentTime + dur + 0.05);
    } catch(_) {}
  }

  function vibrate(pattern) {
    if (muted) return;
    if (!navigator.vibrate) return;
    try { navigator.vibrate(pattern); } catch(_) {}
  }

  return {
    unlock() {
      const c = ensureCtx();
      if (!c) return;
      // iOS unlock: short silent buffer
      try {
        const buf = c.createBuffer(1, 1, 22050);
        const src = c.createBufferSource();
        src.buffer = buf; src.connect(c.destination); src.start(0);
        if (c.state === 'suspended') c.resume();
      } catch(_) {}
    },
    setMuted(m) { muted = !!m; },
    isMuted() { return muted; },

    lock() {
      beep(880, 0.10, { type: 'triangle', gain: 0.20, freqEnd: 1320 });
      vibrate(20);
    },

    // Pitch climbs with hold progress; throttled so it doesn't spam
    tickHold(p) {
      const now = performance.now();
      if (now - lastHoldT < 90) return;
      lastHoldT = now;
      const f = 520 + p * 440;
      beep(f, 0.05, { type: 'sine', gain: 0.10 });
    },

    complete() {
      // Three-note arpeggio
      beep(660,  0.10, { type: 'triangle', gain: 0.22 });
      setTimeout(() => beep(880,  0.10, { type: 'triangle', gain: 0.22 }), 90);
      setTimeout(() => beep(1320, 0.18, { type: 'triangle', gain: 0.24, release: 0.10 }), 180);
      vibrate([10, 30, 10, 30, 30]);
    },

    error() {
      beep(220, 0.08, { type: 'square', gain: 0.10, freqEnd: 165 });
      vibrate([20, 40, 20]);
    },

    expose() {
      // Camera shutter-ish: short broadband click then low thud
      beep(1800, 0.04, { type: 'square', gain: 0.16 });
      setTimeout(() => beep(120, 0.10, { type: 'sine', gain: 0.18, freqEnd: 60 }), 30);
      vibrate(80);
    },
  };
})();

window.MC2Audio = MC2Audio;
