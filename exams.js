'use strict';

// ============================================================================
// MC2 Viewfinder Trainer — Simulated Exam catalog
//
// Sourced from MC2_Positioning_Guide.csv (5 sections, 38 exams).  Each exam
// has SID + recommended kV/mAs for three modes (Single / DDR / Fluoro).
//
// Data shape:
//   sectionId → { id, label, exams: [exam, ...] }
//   exam → {
//     id, sectionId, anatomy, view, name,
//     sidCm,
//     settings: {
//       single: { kV, mAs },
//       ddr:    { kV, mAs },
//       fluoro: { kV, mAs },
//     },
//     notes: string|null,
//     assetSvg: 'assets/exams/<sectionId>/<id>.svg',  // anatomy SVG path
//   }
//
// Asset folder convention:
//   assets/exams/<sectionId>/<id>.svg     — anatomy-only, transparent BG, SVG
//   e.g., assets/exams/hands-fingers/pa-hand.svg
// ============================================================================

function makeId(s) {
  return String(s).toLowerCase()
    .replace(/['"]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

const EXAM_SECTIONS = [
  {
    id: 'hands-fingers',
    label: 'Hands & Fingers',
    sub: 'Distal upper extremity',
  },
  {
    id: 'wrist-elbow',
    label: 'Wrist & Elbow',
    sub: 'Proximal upper extremity',
  },
  {
    id: 'arm-shoulder',
    label: 'Arm & Shoulder',
    sub: 'Forearm, humerus, shoulder',
  },
  {
    id: 'feet-toes',
    label: 'Feet & Toes',
    sub: 'Distal lower extremity',
  },
  {
    id: 'ankle-leg-knee',
    label: 'Ankle, Leg & Knee',
    sub: 'Proximal lower extremity',
  },
];

// Mirrors MC2_Positioning_Guide.csv (one row per exam).
const EXAM_ROWS = [
  ['hands-fingers',  'PA',                       'Finger',        45, 40, 0.25, 50, 0.08, 50, 0.08, 'Use Proper Collimation'],
  ['hands-fingers',  'Oblique',                  'Finger',        45, 40, 0.25, 50, 0.08, 50, 0.08, 'Use Proper Collimation'],
  ['hands-fingers',  'Lateral',                  'Finger',        45, 40, 0.25, 50, 0.08, 50, 0.08, 'Use Proper Collimation'],
  ['hands-fingers',  'PA',                       'Hand',          45, 40, 0.25, 50, 0.08, 50, 0.08, null],
  ['hands-fingers',  'Oblique',                  'Hand',          45, 40, 0.25, 50, 0.08, 50, 0.08, null],
  ['hands-fingers',  'Lateral',                  'Hand',          45, 40, 0.25, 50, 0.08, 50, 0.08, null],

  ['wrist-elbow',    'PA',                       'Wrist',         45, 40, 0.4,  50, 0.08, 50, 0.08, null],
  ['wrist-elbow',    'Oblique',                  'Wrist',         45, 40, 0.4,  50, 0.08, 50, 0.08, null],
  ['wrist-elbow',    'Lateral',                  'Wrist',         45, 40, 0.08, 50, 0.08, 50, 0.08, null],
  ['wrist-elbow',    'Scaphoid',                 'Wrist',         45, 40, 0.4,  50, 0.08, 50, 0.08, '10–15° Ulnar Deviation. Elevate Hand 20°'],
  ['wrist-elbow',    'Carpal Canal',             'Wrist',         45, 40, 0.4,  50, 0.08, 50, 0.08, 'Hyperextend Wrist, Elevate 45°'],
  ['wrist-elbow',    'AP',                       'Elbow',         45, 60, 0.08, 60, 0.08, 60, 0.08, null],
  ['wrist-elbow',    'Oblique',                  'Elbow',         45, 40, 0.08, 50, 0.08, 50, 0.08, null],
  ['wrist-elbow',    'Lateral',                  'Elbow',         45, 60, 0.08, 60, 0.08, 60, 0.08, null],
  ['wrist-elbow',    "Coyle's (Radial Head)",    'Elbow',         45, 40, 0.4,  50, 0.08, 50, 0.08, '45° Angle Emitter; 45° Angle Anatomy'],

  ['arm-shoulder',   'AP',                       'Forearm',       45, 60, 0.08, 60, 0.08, 60, 0.08, null],
  ['arm-shoulder',   'Lateral',                  'Forearm',       45, 60, 0.08, 60, 0.08, 60, 0.08, null],
  ['arm-shoulder',   'AP',                       'Humerus',       45, 60, 0.25, 70, 0.08, 50, 0.08, null],
  ['arm-shoulder',   'Lateral',                  'Humerus',       45, 60, 0.25, 70, 0.08, 64, 0.08, null],
  ['arm-shoulder',   'AP — Internal',       'Shoulder',      45, 60, 0.25, 70, 0.08, 64, 0.08, null],
  ['arm-shoulder',   'AP — External',       'Shoulder',      45, 60, 0.25, 70, 0.08, 64, 0.08, null],

  ['feet-toes',      'AP',                       'Toe',           45, 50, 0.16, 60, 0.08, 64, 0.08, 'Use Proper Collimation'],
  ['feet-toes',      'Oblique',                  'Toe',           45, 50, 0.16, 60, 0.08, 64, 0.08, 'Use Proper Collimation'],
  ['feet-toes',      'Lateral',                  'Toe',           45, 50, 0.16, 60, 0.08, 64, 0.08, 'Use Proper Collimation'],
  ['feet-toes',      'AP',                       'Foot',          45, 50, 0.16, 60, 0.08, 64, 0.08, null],
  ['feet-toes',      'Oblique',                  'Foot',          45, 60, 0.16, 60, 0.08, 64, 0.08, null],
  ['feet-toes',      'Lateral',                  'Foot',          45, 60, 0.08, 60, 0.08, 64, 0.08, null],

  ['ankle-leg-knee', 'AP',                       'Ankle',         45, 60, 0.16, 60, 0.08, 64, 0.08, null],
  ['ankle-leg-knee', 'Oblique',                  'Mortise Ankle', 45, 60, 0.16, 60, 0.08, 64, 0.08, null],
  ['ankle-leg-knee', 'Lateral',                  'Ankle',         45, 60, 0.16, 60, 0.08, 64, 0.08, null],
  ['ankle-leg-knee', 'AP',                       'Tib-Fib',       45, 70, 0.16, 70, 0.08, 64, 0.08, null],
  ['ankle-leg-knee', 'Lateral',                  'Tib-Fib',       45, 70, 0.16, 70, 0.08, 64, 0.08, null],
  ['ankle-leg-knee', 'AP',                       'Knee',          45, 70, 0.16, 70, 0.08, 64, 0.08, null],
  ['ankle-leg-knee', 'Oblique',                  'Knee',          45, 70, 0.16, 70, 0.08, 64, 0.08, null],
  ['ankle-leg-knee', 'Lateral',                  'Knee',          45, 70, 0.16, 70, 0.08, 64, 0.08, null],
  ['ankle-leg-knee', 'Sunrise',                  'Knee',          45, 70, 0.16, 70, 0.08, 64, 0.08, null],
  ['ankle-leg-knee', 'Tunnel',                   'Knee',          45, 70, 0.16, 70, 0.08, 64, 0.08, null],
];

// Build the indexed catalog
const EXAMS_BY_SECTION = {};
EXAM_SECTIONS.forEach(function (s) { EXAMS_BY_SECTION[s.id] = Object.assign({}, s, { exams: [] }); });

EXAM_ROWS.forEach(function (row) {
  const sectionId = row[0];
  const view = row[1];
  const anatomy = row[2];
  const sidCm = row[3];
  const single = { kV: row[4],  mAs: row[5]  };
  const ddr    = { kV: row[6],  mAs: row[7]  };
  const fluoro = { kV: row[8],  mAs: row[9]  };
  const notes  = row[10];
  const name = view + ' ' + anatomy;
  const id = makeId(view) + '-' + makeId(anatomy);
  const exam = {
    id: id,
    sectionId: sectionId,
    anatomy: anatomy,
    view: view,
    name: name,
    sidCm: sidCm,
    settings: { single: single, ddr: ddr, fluoro: fluoro },
    notes: notes,
    assetSvg: 'assets/exams/' + sectionId + '/' + id + '.svg',
  };
  EXAMS_BY_SECTION[sectionId].exams.push(exam);
});

window.MC2_EXAM_SECTIONS    = EXAM_SECTIONS;
window.MC2_EXAMS_BY_SECTION = EXAMS_BY_SECTION;
