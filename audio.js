'use strict';

// ============================================================================
// MC2 Trainer 2.0 — subtle audio + haptic cues
// All cues are short, low-volume, soft sine waves.
// ============================================================================

const MC2Audio = (function () {
  let ctx = null;
  let muted = false;
  let masterGain = null;

  function ensureCtx() {
    if (ctx) return ctx;
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return null;
      ctx = new Ctx();
      masterGain = ctx.createGain();
      masterGain.gain.value = 0.10;
      masterGain.connect(ctx.destination);
    } catch (e) { return null; }
    return ctx;
  }

  function tone(freq, dur, opts) {
    if (muted) return;
    const c = ensureCtx();
    if (!c) return;
    const o2 = opts || {};
    const type    = o2.type    || 'sine';
    const gain    = o2.gain    != null ? o2.gain    : 0.5;
    const attack  = o2.attack  != null ? o2.attack  : 0.012;
    const release = o2.release != null ? o2.release : 0.06;
    const freqEnd = o2.freqEnd != null ? o2.freqEnd : null;
    try {
      const o = c.createOscillator();
      const g = c.createGain();
      o.type = type;
      o.frequency.setValueAtTime(freq, c.currentTime);
      if (freqEnd != null) {
        o.frequency.exponentialRampToValueAtTime(Math.max(1, freqEnd), c.currentTime + dur);
      }
      g.gain.setValueAtTime(0, c.currentTime);
      g.gain.linearRampToValueAtTime(gain, c.currentTime + attack);
      g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + dur + release);
      o.connect(g).connect(masterGain);
      o.start();
      o.stop(c.currentTime + dur + release + 0.05);
    } catch (_) {}
  }

  function vibrate(pattern) {
    if (muted) return;
    if (!navigator.vibrate) return;
    try { navigator.vibrate(pattern); } catch (_) {}
  }

  return {
    unlock: function () {
      const c = ensureCtx();
      if (!c) return;
      try {
        const buf = c.createBuffer(1, 1, 22050);
        const src = c.createBufferSource();
        src.buffer = buf; src.connect(c.destination); src.start(0);
        if (c.state === 'suspended') c.resume();
      } catch (_) {}
    },
    setMuted: function (m) { muted = !!m; },
    isMuted:  function () { return muted; },

    armTick: function () {
      tone(660, 0.04, { type: 'sine', gain: 0.4 });
    },

    lockRep: function () {
      tone(880, 0.06, { type: 'sine', gain: 0.6 });
      vibrate(15);
    },

    failPress: function () {
      tone(220, 0.06, { type: 'sine', gain: 0.4, freqEnd: 180 });
      vibrate(25);
    },

    levelComplete: function () {
      tone(660, 0.08, { type: 'sine', gain: 0.55 });
      setTimeout(function () { tone(880, 0.10, { type: 'sine', gain: 0.55 }); }, 90);
      vibrate([12, 50, 12]);
    },

    expose: function () {
      tone(1100, 0.05, { type: 'sine', gain: 0.55 });
      setTimeout(function () { tone(440, 0.10, { type: 'sine', gain: 0.45, freqEnd: 330 }); }, 40);
      vibrate(40);
    },
  };
})();

window.MC2Audio = MC2Audio;
