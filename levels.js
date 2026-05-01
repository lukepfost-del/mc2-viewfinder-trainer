'use strict';

// ============================================================================
// MC2 Viewfinder Trainer 2.0 — Tutorial Level Definitions
//
// Each level has a sequence of OBJECTIVES.  One objective = one shot.  The
// user practices each, presses EXPOSE to lock that shot.  After all
// objectives in the level are exposed, an "accuracy" score (average across
// objectives) determines the star rating — NOT mere completion.
//
// Level structure:
//   id, step, title, hint, layer, readouts, isFinal
//   buildObjectives() → array of objective specs (may be random)
//   evaluate(pose, objective) → {
//     ok: boolean,           // user can press EXPOSE now
//     accuracy: 0..1,        // graded score for star rating
//     reason: string|null,   // when not ok, what to show in feedback
//     ...metrics             // for live readouts
//   }
//
// pose: { sidCm, tiltDeg, roll, aimLocal:{x,y}, half, fieldHalf, inBounds }
//       (null when QR not detected)
// ============================================================================

const TUNING = {
  // Level 1: AIM at random points
  aimL1NumTargets:    3,
  aimL1FullRangeCm:   8.0,    // random points within +/- this cm of cassette center
  aimL1LockRadiusCm:  4.0,    // user can EXPOSE within this distance of target
  aimL1MissRadiusCm:  6.0,    // accuracy = 0 beyond this (linear in between)

  // Level 2: COLLIMATION SIZE — match target % of max field
  collimTargets:      [0.40, 0.70, 1.00],   // small, medium, max — last is largest
  collimLockTolPct:   0.07,                 // within 7% to arm EXPOSE
  collimMissTolPct:   0.20,                 // accuracy=0 at 20% off

  // Level 3: TILT — perpendicular AND 10° off
  perpTiltDeg:        5.0,                  // back to device default
  perpTiltLockDeg:    5.0,
  perpTiltMissDeg:    8.0,                  // accuracy=0 at 8° off target
  offAngleTargetDeg:  10.0,
  offAngleTolDeg:     3.0,                  // within 3° of 10° to lock

  // Level 4: SID — 3 different heights
  sidHeights:         [45, 60, 75],         // cm
  sidLockTolCm:       5.0,
  sidMissCm:          12.0,

  // Level 5: SAFE EXPOSURE — single attempt, all four green
  ssdMinCm:           30.0,
  patientThicknessCm: 5.0,
  finalSidTargetCm:   60.0,
  finalSidTolCm:      5.0,
};

function aimRadius(pose) {
  if (!pose) return Infinity;
  return Math.hypot(pose.aimLocal.x, pose.aimLocal.y);
}

const LEVELS = [
  // ----------------------------------------------------------------------
  // L1: AIM AT MARKED TARGETS (random spots)
  // ----------------------------------------------------------------------
  {
    id:       'aim',
    step:     'LEVEL 1 / 5',
    title:    'Aim at the marked targets',
    hint:     'A yellow ring shows where to aim. Land the crosshair on it, then press EXPOSE.',
    layer:    'aim',
    readouts: ['aim'],
    buildObjectives: function () {
      // Random points within the active-area-bounded box, but not too close
      // to the edge (so the crosshair stays inside the active area).  Also
      // ensure objectives are not clustered together.
      const out = [];
      const range = TUNING.aimL1FullRangeCm;
      const minSep = 4.0;
      const maxAttempts = 30;
      for (let i = 0; i < TUNING.aimL1NumTargets; i++) {
        let pick = null;
        for (let a = 0; a < maxAttempts; a++) {
          const cand = {
            targetX: (Math.random() * 2 - 1) * range,
            targetY: (Math.random() * 2 - 1) * range,
          };
          let okSep = true;
          for (const prev of out) {
            if (Math.hypot(cand.targetX - prev.targetX, cand.targetY - prev.targetY) < minSep) {
              okSep = false; break;
            }
          }
          if (okSep) { pick = cand; break; }
        }
        out.push(pick || { targetX: 0, targetY: 0 });
      }
      return out;
    },
    evaluate: function (pose, obj) {
      if (!pose) return { ok: false, accuracy: 0, reason: 'no-cassette' };
      const dx = pose.aimLocal.x - obj.targetX;
      const dy = pose.aimLocal.y - obj.targetY;
      const dist = Math.hypot(dx, dy);
      const accuracy = Math.max(0, Math.min(1, 1 - dist / TUNING.aimL1MissRadiusCm));
      const ok = dist <= TUNING.aimL1LockRadiusCm;
      return {
        ok: ok, accuracy: accuracy,
        reason: ok ? null : 'far-from-target',
        targetX: obj.targetX, targetY: obj.targetY, distCm: dist,
      };
    },
  },

  // ----------------------------------------------------------------------
  // L2: COLLIMATION SIZE (match the ghost rectangle)
  // ----------------------------------------------------------------------
  {
    id:       'collim',
    step:     'LEVEL 2 / 5',
    title:    'Match the collimator size',
    hint:     'Aim center to grow the field, off-center to shrink. Match the dashed shape.',
    layer:    'center',
    readouts: ['collim'],
    buildObjectives: function () {
      return TUNING.collimTargets.map(function (pct) { return { targetPct: pct }; });
    },
    evaluate: function (pose, obj) {
      if (!pose) return { ok: false, accuracy: 0, reason: 'no-cassette' };
      if (!pose.inBounds) {
        return { ok: false, accuracy: 0, reason: 'off-cassette',
                 targetPct: obj.targetPct, actualPct: 0 };
      }
      const actualPct = pose.fieldHalf / pose.half;   // 0..1
      const errPct = Math.abs(actualPct - obj.targetPct);
      const accuracy = Math.max(0, Math.min(1, 1 - errPct / TUNING.collimMissTolPct));
      const ok = errPct <= TUNING.collimLockTolPct;
      const reason = ok ? null
                        : (actualPct < obj.targetPct ? 'collim-too-small' : 'collim-too-big');
      return {
        ok: ok, accuracy: accuracy, reason: reason,
        targetPct: obj.targetPct, actualPct: actualPct,
      };
    },
  },

  // ----------------------------------------------------------------------
  // L3: TILT — perpendicular + 10° off
  // ----------------------------------------------------------------------
  {
    id:       'perp',
    step:     'LEVEL 3 / 5',
    title:    'Match the tilt target',
    hint:     'Hit the angle shown, then press EXPOSE.',
    layer:    'perp',
    readouts: ['offset', 'tilt'],
    buildObjectives: function () {
      return [
        { targetTilt: 0.0,  tolDeg: TUNING.perpTiltLockDeg, label: 'Hold parallel (under 5°)' },
        { targetTilt: 10.0, tolDeg: TUNING.offAngleTolDeg,  label: 'Tilt to 10°' },
      ];
    },
    evaluate: function (pose, obj) {
      if (!pose) return { ok: false, accuracy: 0, reason: 'no-cassette' };
      const r = aimRadius(pose);
      if (r > 12) return { ok: false, accuracy: 0, reason: 'off-cassette', tiltDeg: pose.tiltDeg, targetTilt: obj.targetTilt };
      const errDeg = Math.abs(pose.tiltDeg - obj.targetTilt);
      const accuracy = Math.max(0, Math.min(1, 1 - errDeg / TUNING.perpTiltMissDeg));
      const ok = errDeg <= obj.tolDeg;
      const reason = ok ? null
                        : (pose.tiltDeg > obj.targetTilt ? 'tilt-high' : 'tilt-low');
      return {
        ok: ok, accuracy: accuracy, reason: reason,
        targetTilt: obj.targetTilt, tiltDeg: pose.tiltDeg, errDeg: errDeg,
      };
    },
  },

  // ----------------------------------------------------------------------
  // L4: SID HEIGHTS — 3 different distances
  // ----------------------------------------------------------------------
  {
    id:       'sid',
    step:     'LEVEL 4 / 5',
    title:    'Match the distance target',
    hint:     'Move the phone closer or farther to match the target SID.',
    layer:    'sid',
    readouts: ['offset', 'tilt', 'sid'],
    buildObjectives: function () {
      return TUNING.sidHeights.map(function (h) { return { targetSid: h }; });
    },
    evaluate: function (pose, obj) {
      if (!pose) return { ok: false, accuracy: 0, reason: 'no-cassette' };
      if (!pose.inBounds) return { ok: false, accuracy: 0, reason: 'aim-drift', sidCm: pose.sidCm, targetSid: obj.targetSid };
      const errCm = Math.abs(pose.sidCm - obj.targetSid);
      const accuracy = Math.max(0, Math.min(1, 1 - errCm / TUNING.sidMissCm));
      const ok = errCm <= TUNING.sidLockTolCm;
      const reason = ok ? null
                        : (pose.sidCm > obj.targetSid ? 'too-far' : 'too-close');
      return {
        ok: ok, accuracy: accuracy, reason: reason,
        targetSid: obj.targetSid, sidCm: pose.sidCm, errCm: errCm,
      };
    },
  },

  // ----------------------------------------------------------------------
  // L5: SAFE EXPOSURE — single attempt, all four green simultaneously
  // ----------------------------------------------------------------------
  {
    id:       'expose',
    step:     'LEVEL 5 / 5',
    title:    'Safe exposure — final shot',
    hint:     'You only get one attempt. Stabilize all four readings, then EXPOSE.',
    layer:    'full',
    readouts: ['offset', 'tilt', 'sid', 'ssd'],
    isFinal:  true,
    buildObjectives: function () {
      return [{ singleShot: true }];
    },
    evaluate: function (pose, _obj) {
      if (!pose) return { ok: false, accuracy: 0, reason: 'no-cassette' };
      const r = aimRadius(pose);
      const sidErr = Math.abs(pose.sidCm - TUNING.finalSidTargetCm);
      const ssdCm  = pose.sidCm - TUNING.patientThicknessCm;
      const aimOk  = r <= 4.0;
      const perpOk = pose.tiltDeg <= TUNING.perpTiltDeg + 1;
      const sidOk  = sidErr <= TUNING.finalSidTolCm;
      const ssdOk  = ssdCm >= TUNING.ssdMinCm;
      const ok     = aimOk && perpOk && sidOk && ssdOk;
      // Composite accuracy (each component contributes 25%)
      const aimScore  = Math.max(0, 1 - r / 4);
      const perpScore = Math.max(0, 1 - pose.tiltDeg / 6);
      const sidScore  = Math.max(0, 1 - sidErr / 10);
      const ssdScore  = ssdOk ? 1 : 0;
      const accuracy = (aimScore + perpScore + sidScore + ssdScore) / 4;
      let reason = null;
      if      (!aimOk)  reason = 'off-center';
      else if (!perpOk) reason = 'too-tilted';
      else if (!sidOk)  reason = (pose.sidCm > TUNING.finalSidTargetCm ? 'too-far' : 'too-close');
      else if (!ssdOk)  reason = 'too-close-anatomy';
      return {
        ok: ok, accuracy: accuracy, reason: reason,
        sidCm: pose.sidCm, ssdCm: ssdCm, tiltDeg: pose.tiltDeg, radiusCm: r,
      };
    },
  },
];

// Average accuracy across objectives → star rating (0..3)
function accuracyToStars(avgAcc) {
  if (avgAcc >= 0.90) return 3;
  if (avgAcc >= 0.70) return 2;
  if (avgAcc >= 0.50) return 1;
  return 0;
}

const REASON_TEXT = {
  'no-cassette':       'Cassette not detected — point camera at the QR',
  'far-from-target':   'Move the crosshair onto the yellow target',
  'off-cassette':      'Bring the crosshair onto the cassette',
  'collim-too-small':  'Field too small — aim closer to center',
  'collim-too-big':    'Field too big — aim further from center',
  'tilt-high':         'Reduce tilt',
  'tilt-low':          'Increase tilt',
  'too-tilted':        'Tilt the phone flatter',
  'aim-drift':         'Drifted off — re-center first',
  'too-far':           'Too far — move closer',
  'too-close':         'Too close — back off',
  'too-close-anatomy': 'SSD too low — back off the patient',
  'off-center':        'Off-center — nudge to the bullseye',
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
window.MC2_accuracyToStars = accuracyToStars;
