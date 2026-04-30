'use strict';

// ============================================================================
// MC2 Viewfinder Trainer 2.0 — Tutorial Level Definitions
//
// Each level has:
//   id        — short key
//   step      — display label (e.g. "LEVEL 1 / 5")
//   title     — big prompt above the viewfinder
//   hint      — secondary line (camera tip / mechanic explanation)
//   layer     — viewfinder HUD layer to show (hides chrome past this lesson)
//   holdMs    — how long the user must stay in spec to pass
//   passText  — feedback strip label while not yet passing
//   reachText — feedback strip label while in spec, accumulating hold time
//   readouts  — which live numeric readouts to show below the viewfinder
//   check     — given pose state, return:
//                 { pass: bool, progress: 0..1, reason: string|null }
//               pass=true means "currently in spec"; the hold timer runs while
//               pass is continuously true. progress is for UI hints only.
//
// pose argument shape (when QR detected):
//   { sidCm, tiltDeg, roll, aimLocal:{x,y}, half, fieldHalf, inBounds }
// pose is null when QR not detected.
//
// Tunable thresholds at top of file so you can tweak game feel.
// ============================================================================

const TUNING = {
  // Level 1: AIM — crosshair just needs to land on the cassette
  aimRadiusCm:        12.0,  // target = within this radius of cassette center
  aimHoldMs:          1200,

  // Level 2: CENTER — crosshair on the dead center
  centerRadiusCm:     2.5,   // tight tolerance (snap behavior)
  centerHoldMs:       1800,

  // Level 3: PERPENDICULAR — flatten tilt below threshold
  perpTiltDeg:        8.0,   // matches IFU "external cross completes below 8°"
  perpHoldMs:         1500,

  // Level 4: SID — 60 cm target ±5 cm
  sidTargetCm:        60.0,
  sidToleranceCm:     5.0,
  sidHoldMs:          1500,

  // Level 5: SAFE EXPOSURE — all four green simultaneously
  ssdMinCm:           30.0,
  patientThicknessCm: 5.0,
  finalHoldMs:        1500,
};

// Helper: distance of aim point from cassette center, in cm
function aimRadius(pose) {
  if (!pose) return Infinity;
  return Math.hypot(pose.aimLocal.x, pose.aimLocal.y);
}

const LEVELS = [
  // -----------------------------------------------------------------------
  // L1: AIM
  // -----------------------------------------------------------------------
  {
    id:       'aim',
    step:     'LEVEL 1 / 5',
    title:    'Aim at the cassette',
    hint:     'Move your phone so the crosshair lands inside the dashed circle.',
    layer:    'aim',
    holdMs:   TUNING.aimHoldMs,
    passText: 'Aim the crosshair at the cassette',
    reachText:'Holding aim…',
    readouts: ['aim'],
    check: (pose) => {
      if (!pose) return { pass: false, progress: 0, reason: 'no-cassette' };
      const r = aimRadius(pose);
      const pass = r <= TUNING.aimRadiusCm;
      const progress = pass ? 1 : Math.max(0, 1 - (r - TUNING.aimRadiusCm) / 20);
      return { pass, progress, reason: pass ? null : 'far-from-cassette', radiusCm: r };
    },
  },

  // -----------------------------------------------------------------------
  // L2: CENTER
  // -----------------------------------------------------------------------
  {
    id:       'center',
    step:     'LEVEL 2 / 5',
    title:    'Line up dead center',
    hint:     'The small "+" snaps to the bullseye when you\'re centered.',
    layer:    'center',
    holdMs:   TUNING.centerHoldMs,
    passText: 'Move the crosshair to the center',
    reachText:'Holding center…',
    readouts: ['offset'],
    check: (pose) => {
      if (!pose) return { pass: false, progress: 0, reason: 'no-cassette' };
      const r = aimRadius(pose);
      const pass = r <= TUNING.centerRadiusCm;
      // progress = 1 at <= 2.5 cm, 0 at >= 12 cm
      const progress = Math.max(0, Math.min(1, 1 - (r - TUNING.centerRadiusCm) / 10));
      return { pass, progress, reason: pass ? null : 'off-center', radiusCm: r };
    },
  },

  // -----------------------------------------------------------------------
  // L3: PERPENDICULAR
  // -----------------------------------------------------------------------
  {
    id:       'perp',
    step:     'LEVEL 3 / 5',
    title:    'Hold parallel to the cassette',
    hint:     'Tilt under 8° so the external cross "completes" and the beam is square.',
    layer:    'perp',
    holdMs:   TUNING.perpHoldMs,
    passText: 'Reduce tilt — hold the phone flat over the cassette',
    reachText:'Holding perpendicular…',
    readouts: ['offset', 'tilt'],
    check: (pose) => {
      if (!pose) return { pass: false, progress: 0, reason: 'no-cassette' };
      // Maintain centering from L2 (loose) so the user can't cheat by drifting
      const r = aimRadius(pose);
      if (r > TUNING.aimRadiusCm) return { pass: false, progress: 0, reason: 'off-cassette', tiltDeg: pose.tiltDeg };
      const pass = pose.tiltDeg <= TUNING.perpTiltDeg;
      // progress 1 at <= 8°, 0 at >= 30°
      const progress = Math.max(0, Math.min(1, 1 - (pose.tiltDeg - TUNING.perpTiltDeg) / 22));
      return { pass, progress, reason: pass ? null : 'too-tilted', tiltDeg: pose.tiltDeg };
    },
  },

  // -----------------------------------------------------------------------
  // L4: SID
  // -----------------------------------------------------------------------
  {
    id:       'sid',
    step:     'LEVEL 4 / 5',
    title:    'Set distance to 60 cm',
    hint:     'Move the phone closer or farther until the SID readout turns green.',
    layer:    'sid',
    holdMs:   TUNING.sidHoldMs,
    passText: 'Move to 60 cm from the cassette',
    reachText:'Holding 60 cm…',
    readouts: ['offset', 'tilt', 'sid'],
    check: (pose) => {
      if (!pose) return { pass: false, progress: 0, reason: 'no-cassette' };
      // Don't gate on aim/tilt here — let the user focus on distance, but
      // they shouldn't be wildly off so we still require in-bounds.
      if (!pose.inBounds) return { pass: false, progress: 0, reason: 'aim-drift', sidCm: pose.sidCm };
      const err = Math.abs(pose.sidCm - TUNING.sidTargetCm);
      const pass = err <= TUNING.sidToleranceCm;
      // progress 1 at <= 5 cm err, 0 at >= 30 cm err
      const progress = Math.max(0, Math.min(1, 1 - (err - TUNING.sidToleranceCm) / 25));
      return { pass, progress, reason: pass ? null : (pose.sidCm > TUNING.sidTargetCm ? 'too-far' : 'too-close'), sidCm: pose.sidCm };
    },
  },

  // -----------------------------------------------------------------------
  // L5: SAFE EXPOSURE — all four metrics in spec, then EXPOSE
  // -----------------------------------------------------------------------
  {
    id:       'expose',
    step:     'LEVEL 5 / 5',
    title:    'Safe exposure — keep everything green',
    hint:     'Hold all four readings green, then press EXPOSE.',
    layer:    'full',
    holdMs:   TUNING.finalHoldMs,
    passText: 'Stabilize all four readings',
    reachText:'Stable — press EXPOSE',
    readouts: ['offset', 'tilt', 'sid', 'ssd'],
    showExpose: true,   // unhide the EXPOSE button at this level
    check: (pose) => {
      if (!pose) return { pass: false, progress: 0, reason: 'no-cassette' };
      const r = aimRadius(pose);
      const sidErr = Math.abs(pose.sidCm - TUNING.sidTargetCm);
      const ssdCm  = pose.sidCm - TUNING.patientThicknessCm;
      const aimOk  = r <= TUNING.centerRadiusCm * 1.6;        // slightly lenient
      const perpOk = pose.tiltDeg <= TUNING.perpTiltDeg + 1;  // slightly lenient
      const sidOk  = sidErr <= TUNING.sidToleranceCm;
      const ssdOk  = ssdCm >= TUNING.ssdMinCm;
      const pass   = aimOk && perpOk && sidOk && ssdOk;
      const score  = (aimOk?1:0) + (perpOk?1:0) + (sidOk?1:0) + (ssdOk?1:0);
      const reason =
        !aimOk  ? 'off-center' :
        !perpOk ? 'too-tilted' :
        !sidOk  ? (pose.sidCm > TUNING.sidTargetCm ? 'too-far' : 'too-close') :
        !ssdOk  ? 'too-close-anatomy' :
        null;
      return { pass, progress: score / 4, reason, sidCm: pose.sidCm, ssdCm, tiltDeg: pose.tiltDeg, radiusCm: r };
    },
  },
];

// Reason → human-readable feedback strip text
const REASON_TEXT = {
  'no-cassette':       'Cassette not detected — point camera at the QR',
  'far-from-cassette': 'Move the crosshair onto the cassette',
  'off-cassette':      'Drift! Bring the crosshair back on target',
  'off-center':        'A little off — nudge to the bullseye',
  'too-tilted':        'Tilt the phone flatter',
  'aim-drift':         'Drifted off — re-center first',
  'too-far':           'Too far — move closer',
  'too-close':         'Too close — back off',
  'too-close-anatomy': 'SSD too low — back off the patient',
};

window.MC2_LEVELS = LEVELS;
window.MC2_TUNING = TUNING;
window.MC2_REASON_TEXT = REASON_TEXT;
