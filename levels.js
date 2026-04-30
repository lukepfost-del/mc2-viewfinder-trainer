'use strict';

// ============================================================================
// MC2 Viewfinder Trainer 2.0 — Tutorial Level Definitions
//
// Each level is a SKILL the user practices THREE times.
// One rep:
//   1. Show the prompt "Line up X, then press EXPOSE"
//   2. Wait for the user to bring the pose within spec (button arms green)
//   3. User presses EXPOSE — that locks in the rep ("Rep 1/3 ✓")
//   4. Pose must be reset (move out of spec) before the next rep can start,
//      so the user actually re-acquires each time
//   5. After 3 reps: show "Level Complete" screen with Continue button
//
// Hold-meters and time-boxes are gone — the user is the lock action.
//
// Each level has:
//   id        — short key
//   step      — display label ("LEVEL 1 / 5")
//   title     — big prompt above the viewfinder
//   hint      — secondary line (mechanic explanation)
//   layer     — viewfinder HUD layer to show (hides chrome past this lesson)
//   reps      — required reps (default 3)
//   readouts  — which live numeric readouts to show below
//   inSpec(pose) → { ok, reason, ...metrics }
//   resetCheck(pose) → bool (true if pose is far enough out of spec to allow
//                            the next rep to arm)
//
// pose argument shape (when QR detected):
//   { sidCm, tiltDeg, roll, aimLocal:{x,y}, half, fieldHalf, inBounds }
// pose is null when QR not detected.
//
// Device-side equivalents shown in comments — note the device default for
// tilt snap is 5° per-axis; user requested 3° for tighter trainer feel.
// ============================================================================

const TUNING = {
  defaultReps: 3,

  // Level 1: AIM — crosshair anywhere on the cassette
  aimRadiusCm: 12.0,

  // Level 2: CENTER — crosshair on dead center
  centerRadiusCm: 2.5,

  // Level 3: PERPENDICULAR — total tilt below threshold
  // (Device default per-axis snap is 5°; trainer uses tighter 3°.)
  perpTiltDeg: 3.0,

  // Level 4: SID — 60 cm ± 5 cm
  sidTargetCm: 60.0,
  sidToleranceCm: 5.0,

  // Level 5: SAFE EXPOSURE — all four metrics in spec
  ssdMinCm: 30.0,
  patientThicknessCm: 5.0,

  // Reset tolerance: between reps the pose must drift OUT of spec by at
  // least this multiplier before the next rep arms.
  resetMultiplier: 1.5,
};

function aimRadius(pose) {
  if (!pose) return Infinity;
  return Math.hypot(pose.aimLocal.x, pose.aimLocal.y);
}

const LEVELS = [
  {
    id: 'aim',
    step: 'LEVEL 1 / 5',
    title: 'Aim at the cassette',
    hint: 'Move the phone so the crosshair lands inside the dashed circle, then press EXPOSE.',
    layer: 'aim',
    reps: TUNING.defaultReps,
    readouts: ['aim'],
    inSpec: function (pose) {
      if (!pose) return { ok: false, reason: 'no-cassette' };
      const r = aimRadius(pose);
      const ok = r <= TUNING.aimRadiusCm;
      return { ok: ok, reason: ok ? null : 'far-from-cassette', radiusCm: r };
    },
    resetCheck: function (pose) {
      return !pose || aimRadius(pose) > TUNING.aimRadiusCm * TUNING.resetMultiplier;
    },
  },

  {
    id: 'center',
    step: 'LEVEL 2 / 5',
    title: 'Line up dead center',
    hint: 'The small "+" snaps to the bullseye when centered. Press EXPOSE to lock the shot.',
    layer: 'center',
    reps: TUNING.defaultReps,
    readouts: ['offset'],
    inSpec: function (pose) {
      if (!pose) return { ok: false, reason: 'no-cassette' };
      const r = aimRadius(pose);
      const ok = r <= TUNING.centerRadiusCm;
      return { ok: ok, reason: ok ? null : 'off-center', radiusCm: r };
    },
    resetCheck: function (pose) {
      return !pose || aimRadius(pose) > TUNING.centerRadiusCm * TUNING.resetMultiplier;
    },
  },

  {
    id: 'perp',
    step: 'LEVEL 3 / 5',
    title: 'Hold parallel to the cassette',
    hint: 'Tilt under 3° so the cross "completes". Press EXPOSE while square.',
    layer: 'perp',
    reps: TUNING.defaultReps,
    readouts: ['offset', 'tilt'],
    inSpec: function (pose) {
      if (!pose) return { ok: false, reason: 'no-cassette' };
      const r = aimRadius(pose);
      if (r > TUNING.aimRadiusCm) return { ok: false, reason: 'off-cassette', tiltDeg: pose.tiltDeg };
      const ok = pose.tiltDeg <= TUNING.perpTiltDeg;
      return { ok: ok, reason: ok ? null : 'too-tilted', tiltDeg: pose.tiltDeg };
    },
    resetCheck: function (pose) {
      return !pose || pose.tiltDeg > TUNING.perpTiltDeg * 2.5;
    },
  },

  {
    id: 'sid',
    step: 'LEVEL 4 / 5',
    title: 'Set distance to 60 cm',
    hint: 'Move closer or farther until SID reads 60 ± 5 cm, then press EXPOSE.',
    layer: 'sid',
    reps: TUNING.defaultReps,
    readouts: ['offset', 'tilt', 'sid'],
    inSpec: function (pose) {
      if (!pose) return { ok: false, reason: 'no-cassette' };
      if (!pose.inBounds) return { ok: false, reason: 'aim-drift', sidCm: pose.sidCm };
      const err = Math.abs(pose.sidCm - TUNING.sidTargetCm);
      const ok = err <= TUNING.sidToleranceCm;
      const reason = ok ? null : (pose.sidCm > TUNING.sidTargetCm ? 'too-far' : 'too-close');
      return { ok: ok, reason: reason, sidCm: pose.sidCm };
    },
    resetCheck: function (pose) {
      if (!pose) return true;
      const err = Math.abs(pose.sidCm - TUNING.sidTargetCm);
      return err > TUNING.sidToleranceCm * TUNING.resetMultiplier;
    },
  },

  {
    id: 'expose',
    step: 'LEVEL 5 / 5',
    title: 'Safe exposure — all four green',
    hint: 'Stabilize Aim, Tilt, SID, and SSD together. Then press EXPOSE.',
    layer: 'full',
    reps: TUNING.defaultReps,
    readouts: ['offset', 'tilt', 'sid', 'ssd'],
    isFinal: true,
    inSpec: function (pose) {
      if (!pose) return { ok: false, reason: 'no-cassette' };
      const r = aimRadius(pose);
      const sidErr = Math.abs(pose.sidCm - TUNING.sidTargetCm);
      const ssdCm  = pose.sidCm - TUNING.patientThicknessCm;
      const aimOk  = r <= TUNING.centerRadiusCm * 1.6;
      const perpOk = pose.tiltDeg <= TUNING.perpTiltDeg + 1;
      const sidOk  = sidErr <= TUNING.sidToleranceCm;
      const ssdOk  = ssdCm >= TUNING.ssdMinCm;
      const ok = aimOk && perpOk && sidOk && ssdOk;
      let reason = null;
      if      (!aimOk)  reason = 'off-center';
      else if (!perpOk) reason = 'too-tilted';
      else if (!sidOk)  reason = (pose.sidCm > TUNING.sidTargetCm ? 'too-far' : 'too-close');
      else if (!ssdOk)  reason = 'too-close-anatomy';
      return { ok: ok, reason: reason, sidCm: pose.sidCm, ssdCm: ssdCm, tiltDeg: pose.tiltDeg, radiusCm: r };
    },
    resetCheck: function (pose) {
      if (!pose) return true;
      const r = aimRadius(pose);
      if (r > TUNING.centerRadiusCm * 2.5) return true;
      if (pose.tiltDeg > TUNING.perpTiltDeg * 2.5) return true;
      if (Math.abs(pose.sidCm - TUNING.sidTargetCm) > TUNING.sidToleranceCm * 2.5) return true;
      return false;
    },
  },
];

const REASON_TEXT = {
  'no-cassette':       'Cassette not detected — point camera at the QR',
  'far-from-cassette': 'Move the crosshair onto the cassette',
  'off-cassette':      'Bring the crosshair back on target',
  'off-center':        'A little off — nudge to the bullseye',
  'too-tilted':        'Tilt the phone flatter',
  'aim-drift':         'Drifted off — re-center first',
  'too-far':           'Too far — move closer',
  'too-close':         'Too close — back off',
  'too-close-anatomy': 'SSD too low — back off the patient',
};

const CAMERA_PROFILES = [
  { id: 'default',   label: 'Default phone (~75° FOV)', focalRel: 0.85 },
  { id: 'wide',      label: 'Wide phone (~85° FOV)',    focalRel: 0.65 },
  { id: 'ultrawide', label: 'Ultra-wide (~110° FOV)',   focalRel: 0.45 },
  { id: 'tele',      label: 'Telephoto (~50° FOV)',     focalRel: 1.30 },
];

window.MC2_LEVELS          = LEVELS;
window.MC2_TUNING          = TUNING;
window.MC2_REASON_TEXT     = REASON_TEXT;
window.MC2_CAMERA_PROFILES = CAMERA_PROFILES;
