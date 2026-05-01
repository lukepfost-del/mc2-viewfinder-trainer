'use strict';

// Surface any uncaught script error visibly — iOS Safari has no JS console
// without dev-tools, so silent errors are invisible.  This banner sits above
// the start screen so a real error stops being mysterious.
// In-page debug surface. iOS Safari has no JS console without dev-tools, so
// we route uncaught errors and lifecycle messages to a visible bar at the
// top of the screen.  Tap to dismiss.
function mc2Status(msg, kind) {
  try {
    let bar = document.getElementById('mc2-error-bar');
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'mc2-error-bar';
      bar.style.cssText =
        'position:fixed;left:0;right:0;top:0;z-index:9999;' +
        'padding:8px 12px;cursor:pointer;' +
        'font:600 12px/1.4 -apple-system,system-ui,sans-serif;' +
        'white-space:pre-wrap;max-height:40vh;overflow:auto;color:#fff;';
      bar.addEventListener('click', function () { bar.style.display = 'none'; });
      document.body && document.body.appendChild(bar);
    }
    // Only one kind exists now: errors (red).  No green/info banners.
    bar.style.background = '#ff4757';
    bar.style.display = 'block';
    bar.textContent = msg;
  } catch (_) {}
}
window.addEventListener('error', function (e) {
  const msg = (e && e.message) || String(e);
  const src = e && (e.filename || '') + (e.lineno ? ':' + e.lineno : '');
  mc2Status('JS error: ' + msg + (src ? '\n' + src : ''), 'error');
});
window.addEventListener('unhandledrejection', function (e) {
  mc2Status('Promise rejection: ' + (e && e.reason && (e.reason.message || e.reason)), 'error');
});

// =============================================================================
// MC2 Viewfinder Trainer 2.0
//
// Two routes:
//   - tutorial: 5 gated levels (aim → center → perp → SID → safe expose)
//   - play:     free practice with full HUD (matches v1 behavior)
//
// Pose math (ArUco detection, homography, tilt, SID, aim) is ported verbatim
// from v1 / app.js; only the UI shell, tutorial gating, and prompt strips are
// new in 2.0.
// =============================================================================

// ---- DOM ----
const startScreen   = document.getElementById('start-screen');
const routeTutorial = document.getElementById('route-tutorial');
const routePlay     = document.getElementById('route-play');
const tileStars     = document.getElementById('tile-stars');

const appShell      = document.getElementById('app');
const backBtn       = document.getElementById('back-btn');
const muteBtn       = document.getElementById('mute-btn');
const levelPill     = document.getElementById('level-pill');

const promptStrip   = document.getElementById('prompt-strip');
const promptStep    = document.getElementById('prompt-step');
const promptText    = document.getElementById('prompt-text');
const promptHint    = document.getElementById('prompt-hint');

const viewfinderEl  = document.getElementById('viewfinder');
const lcd           = document.getElementById('lcd');
const video         = document.getElementById('video');
const cassetteImg   = document.getElementById('cassette-img');
const overlay       = document.getElementById('overlay');
const ctx           = overlay.getContext('2d');
const flash         = document.getElementById('flash');

const ssdVal        = document.getElementById('ssd-value');
const sidReadout    = document.getElementById('sid-readout');
const interlock     = document.getElementById('interlock');
const badgeDetect   = document.getElementById('badge-detect');
const tutTarget     = document.getElementById('tutorial-target');
const lcOverlay     = document.getElementById('level-complete');
const lcStarsEl     = document.getElementById('lc-stars');
const lcTitle       = document.getElementById('lc-title');
const lcSubEl       = document.getElementById('lc-sub');
const lcContinueBtn = document.getElementById('lc-continue');
const lcRetryBtn    = document.getElementById('lc-retry');
const repDots       = document.getElementById('rep-dots');
const feedbackLabel = document.getElementById('feedback-label');
const sidTargetMarker = document.getElementById('sid-target-marker');

const kvValEl       = document.getElementById('kv-value');
const masValEl      = document.getElementById('mas-value');
const modeValEl     = document.getElementById('mode-value');
const ssdBg         = document.getElementById('ssd-bg');
const modeShield    = document.getElementById('mode-shield');
const kvSlots       = [1,2,3,4,5].map(i => document.getElementById('kv-slot-'+i));
const masSlots      = [1,2,3,4,5].map(i => document.getElementById('mas-slot-'+i));

const crosshair     = document.getElementById('crosshair');
const extCrossImg   = document.getElementById('external-cross');
const ctrCrossImg   = document.getElementById('center-cross');

const holdMeter     = document.getElementById('hold-meter');
const holdFill      = document.getElementById('hold-fill');
const holdLabel     = document.getElementById('hold-label');
const liveReadouts  = document.getElementById('live-readouts');

const skipBtn       = document.getElementById('skip-btn');
const triggerBtn    = document.getElementById('trigger');

// ---- Settings (fixed; no scale input — printed cards are 9 cm) ----
const SETTINGS = {
  qrPhysicalCm: 6.0,    // printed marker size in cm — must match qr-target.pdf
  activeAreaCm: 21.35,
  cassetteImgActiveFrac: 0.36,
  cassetteImgActiveCx:   0.485,
  cassetteImgActiveCy:   0.585,
  minFieldCmPerSid: 0.24,
  sidMin: 30, sidMax: 80,
  ssdMin: 30,
  patientThicknessCm: 5,
  focalRel: 0.85,
  oeMinCutoff: 1.2, oeBeta: 0.04, oeDerivCutoff: 1.0,
  procMaxDim: 720,
  cassetteImgPx: 720,
  activeAreaScreenFrac: 0.33,
};

const COLORS = {
  collim: '#077B51',
  green:  '#3DB06B',
  red:    '#ff4757',
  amber:  '#ffb302',
};

// ---- Top-level mode + state ----
const MODE = { NONE: 0, TUTORIAL: 1, PLAY: 2 };
const state = {
  mode: MODE.NONE,
  running: false,

  // pose
  qr: null, pose: null, lastDetectT: 0,
  frameW: 0, frameH: 0, meanLuma: 0,
  prevAllowed: false,

  // play HUD values
  kv: 60, kvOpts: [40,50,60,70,80],
  mas: 0.16, masOpts: [0.04,0.08,0.16,0.25,0.40],
  modeIdx: 1, modes: ['Single','DDR','Fluoro','Photo'],
  capturing: false,

  // tutorial — objective-based: each level has an array of targets, each
  // graded by accuracy on EXPOSE.
  levelIdx: 0,
  objIdx: 0,                 // current objective within the level
  objectives: [],            // built per-level via lvl.buildObjectives()
  objAccuracies: [],         // accuracy 0..1 per objective (stored on EXPOSE)
  levelAccuracies: {},       // {levelId: avgAccuracy} — used for retry-weakest at end
  retryFromFinal: false,     // true when user is replaying a level via the retry button
  repArmed: false,           // is pose currently in spec? (drives button color)
  prevArmed: false,          // for arm-tick edge detection
  paused: false,             // true during level-complete overlay
  stars: loadStars(),        // best stars per level (kept for tile display)
};

// ============================================================================
// One-Euro filter (from v1)
// ============================================================================
class OneEuro {
  constructor(minCutoff, beta, dCutoff) {
    this.minCutoff = minCutoff; this.beta = beta; this.dCutoff = dCutoff;
    this.x = null; this.dx = 0; this.tPrev = null;
  }
  alpha(cutoff, dt){ const tau = 1/(2*Math.PI*cutoff); return 1/(1 + tau/dt); }
  filter(x, t) {
    if (this.tPrev == null) { this.tPrev = t; this.x = x; return x; }
    const dt = Math.max(1e-3, (t - this.tPrev)/1000);
    const dxRaw = (x - this.x)/dt;
    const aD = this.alpha(this.dCutoff, dt);
    this.dx = aD * dxRaw + (1 - aD) * this.dx;
    const cutoff = this.minCutoff + this.beta * Math.abs(this.dx);
    const a = this.alpha(cutoff, dt);
    this.x = a * x + (1 - a) * this.x;
    this.tPrev = t;
    return this.x;
  }
}
function makeCornerFilters() {
  return Array.from({length:4}, () => ({
    x: new OneEuro(SETTINGS.oeMinCutoff, SETTINGS.oeBeta, SETTINGS.oeDerivCutoff),
    y: new OneEuro(SETTINGS.oeMinCutoff, SETTINGS.oeBeta, SETTINGS.oeDerivCutoff),
  }));
}
let cornerFilters = makeCornerFilters();
const sidFilter   = new OneEuro(0.8, 0.02, 1.0);
const tiltFilter  = new OneEuro(0.8, 0.02, 1.0);
// Per-axis tilt has its own filters — the magnitude alone isn't enough to
// stabilize the inner-crosshair direction near perpendicular.  Lower min
// cutoffs make the smoothing more aggressive (less jitter, more lag).
const tiltXFilter = new OneEuro(0.4, 0.02, 1.0);
const tiltYFilter = new OneEuro(0.4, 0.02, 1.0);
// Roll is a circular quantity; smooth via sin/cos so it can't jump at
// the +π/-π wrap point.
const rollSinFilter = new OneEuro(0.6, 0.02, 1.0);
const rollCosFilter = new OneEuro(0.6, 0.02, 1.0);

// ============================================================================
// Camera + canvas resize
// ============================================================================
async function startCamera() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } }
    });
    video.srcObject = stream;
    try { await video.play(); } catch(_) {}
    await new Promise(res => {
      if (video.videoWidth > 0) return res();
      const onMeta = () => { video.removeEventListener('loadedmetadata', onMeta); res(); };
      video.addEventListener('loadedmetadata', onMeta);
    });
    state.running = true;
    resizeCanvas();
    requestAnimationFrame(loop);
  } catch (err) {
    const msg = (err && (err.name + ': ' + err.message)) || String(err);
    mc2Status(
      'Camera unavailable — ' + msg +
      '\nFix: Settings → Safari → Camera → Allow, then reload.',
      'error'
    );
    showStartScreen();
  }
}

function stopCamera() {
  state.running = false;
  if (video.srcObject) {
    try { video.srcObject.getTracks().forEach(t => t.stop()); } catch(_) {}
    video.srcObject = null;
  }
}

function resizeCanvas() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const W = lcd.clientWidth, H = lcd.clientHeight;
  overlay.width  = Math.round(W * dpr);
  overlay.height = Math.round(H * dpr);
  overlay.style.width  = W + 'px';
  overlay.style.height = H + 'px';
  ctx.setTransform(dpr,0,0,dpr,0,0);
}
window.addEventListener('resize', resizeCanvas);
window.addEventListener('orientationchange', () => setTimeout(resizeCanvas, 200));
if (window.visualViewport) window.visualViewport.addEventListener('resize', resizeCanvas);

// ============================================================================
// ArUco detection (from v1)
// ============================================================================
const work = document.createElement('canvas');
const wctx = work.getContext('2d', { willReadFrequently: true });
const arDetector = new AR.Detector({ dictionaryName: 'ARUCO_4X4_1000' });
const TARGET_MARKER_ID = 0;

function detectQR() {
  const vw = video.videoWidth, vh = video.videoHeight;
  if (!vw || !vh) return null;
  const targetMax = SETTINGS.procMaxDim;
  const scale = targetMax / Math.max(vw, vh);
  const w = Math.round(vw * scale), h = Math.round(vh * scale);
  if (work.width !== w || work.height !== h) { work.width = w; work.height = h; }
  state.frameW = w; state.frameH = h;
  wctx.drawImage(video, 0, 0, w, h);
  let imgData;
  try { imgData = wctx.getImageData(0, 0, w, h); } catch(e){ return null; }

  let luma = 0, samples = 0;
  for (let i=0; i<imgData.data.length; i+=64*4) {
    luma += 0.299*imgData.data[i] + 0.587*imgData.data[i+1] + 0.114*imgData.data[i+2];
    samples++;
  }
  state.meanLuma = samples ? luma/samples : 0;

  let markers;
  try { markers = arDetector.detectImage(w, h, imgData.data); }
  catch(e) { return null; }
  if (!markers || !markers.length) return null;

  let m = markers.find(mk => mk.id === TARGET_MARKER_ID);
  if (!m) m = markers[0];
  if (!m || !m.corners || m.corners.length !== 4) return null;

  const rawCorners = m.corners.map(c => ({ x: c.x, y: c.y }));
  const t = performance.now();
  const smoothed = rawCorners.map((p, i) => ({
    x: cornerFilters[i].x.filter(p.x, t),
    y: cornerFilters[i].y.filter(p.y, t),
  }));
  return { corners: smoothed, raw: rawCorners, id: m.id, t, scaleVid: 1/scale };
}

// ============================================================================
// Linear algebra (from v1)
// ============================================================================
function solve8(A, b) {
  const n = 8;
  const M = new Float64Array(n*(n+1));
  for (let i=0;i<n;i++){ for (let j=0;j<n;j++) M[i*(n+1)+j] = A[i*n+j]; M[i*(n+1)+n] = b[i]; }
  for (let i=0;i<n;i++){
    let p = i, pv = Math.abs(M[i*(n+1)+i]);
    for (let r=i+1;r<n;r++){ const v = Math.abs(M[r*(n+1)+i]); if (v>pv){pv=v;p=r;} }
    if (pv < 1e-12) return null;
    if (p !== i) { for (let j=0;j<=n;j++){ const t=M[i*(n+1)+j]; M[i*(n+1)+j]=M[p*(n+1)+j]; M[p*(n+1)+j]=t; } }
    const inv = 1/M[i*(n+1)+i];
    for (let j=i;j<=n;j++) M[i*(n+1)+j] *= inv;
    for (let r=0;r<n;r++){ if (r===i) continue; const f = M[r*(n+1)+i]; if (!f) continue;
      for (let j=i;j<=n;j++) M[r*(n+1)+j] -= f*M[i*(n+1)+j];
    }
  }
  const x = new Float64Array(n);
  for (let i=0;i<n;i++) x[i] = M[i*(n+1)+n];
  return x;
}
function homography4(src, dst) {
  const A = new Float64Array(64), b = new Float64Array(8);
  for (let i=0;i<4;i++){
    const X=src[i].x, Y=src[i].y, x=dst[i].x, y=dst[i].y;
    const r1 = i*2;
    A[r1*8+0]=X; A[r1*8+1]=Y; A[r1*8+2]=1; A[r1*8+3]=0; A[r1*8+4]=0; A[r1*8+5]=0;
    A[r1*8+6]=-x*X; A[r1*8+7]=-x*Y; b[r1]=x;
    const r2 = i*2+1;
    A[r2*8+0]=0; A[r2*8+1]=0; A[r2*8+2]=0; A[r2*8+3]=X; A[r2*8+4]=Y; A[r2*8+5]=1;
    A[r2*8+6]=-y*X; A[r2*8+7]=-y*Y; b[r2]=y;
  }
  const h = solve8(A,b);
  if (!h) return null;
  return [h[0],h[1],h[2], h[3],h[4],h[5], h[6],h[7],1];
}
function applyH(H, x, y) { const w = H[6]*x + H[7]*y + H[8]; return { x:(H[0]*x+H[1]*y+H[2])/w, y:(H[3]*x+H[4]*y+H[5])/w }; }
function invert3(H) {
  const a=H[0],b=H[1],c=H[2], d=H[3],e=H[4],f=H[5], g=H[6],h=H[7],i=H[8];
  const A=(e*i-f*h),B=-(d*i-f*g),C=(d*h-e*g);
  const det = a*A + b*B + c*C; if (Math.abs(det) < 1e-12) return null;
  const D=-(b*i-c*h),E=(a*i-c*g),F=-(a*h-b*g),G=(b*f-c*e),I=-(a*f-c*d),J=(a*e-b*d);
  const inv = [A,D,G, B,E,I, C,F,J];
  for (let k=0;k<9;k++) inv[k] /= det;
  return inv;
}
function mul3x3(P, Q) {
  return [
    P[0]*Q[0]+P[1]*Q[3]+P[2]*Q[6], P[0]*Q[1]+P[1]*Q[4]+P[2]*Q[7], P[0]*Q[2]+P[1]*Q[5]+P[2]*Q[8],
    P[3]*Q[0]+P[4]*Q[3]+P[5]*Q[6], P[3]*Q[1]+P[4]*Q[4]+P[5]*Q[7], P[3]*Q[2]+P[4]*Q[5]+P[5]*Q[8],
    P[6]*Q[0]+P[7]*Q[3]+P[8]*Q[6], P[6]*Q[1]+P[7]*Q[4]+P[8]*Q[7], P[6]*Q[2]+P[7]*Q[5]+P[8]*Q[8],
  ];
}
function dist(a,b){ const dx=a.x-b.x, dy=a.y-b.y; return Math.hypot(dx,dy); }
function clamp01(v){ return Math.max(0, Math.min(1, v)); }

// Returns {deg, x, y} where deg is total tilt magnitude and (x, y) are the
// per-axis components in degrees.  x = rotation about the camera Y-axis (cassette
// tilted left/right in image), y = rotation about the camera X-axis (tilted up/
// down).  Matches the (tilt.x, tilt.y) signature the device's TiltGuideOverlay
// expects.
function tiltFromH(H, fx, fy, cx, cy) {
  const Hn = [
    (H[0]-cx*H[6])/fx, (H[1]-cx*H[7])/fx, (H[2]-cx*H[8])/fx,
    (H[3]-cy*H[6])/fy, (H[4]-cy*H[7])/fy, (H[5]-cy*H[8])/fy,
    H[6], H[7], H[8],
  ];
  const r1 = [Hn[0], Hn[3], Hn[6]], r2 = [Hn[1], Hn[4], Hn[7]];
  const len1 = Math.hypot(r1[0],r1[1],r1[2]) || 1;
  const len2 = Math.hypot(r2[0],r2[1],r2[2]) || 1;
  const lam = 2/(len1+len2);
  const r1n = r1.map(v=>v*lam), r2n = r2.map(v=>v*lam);
  const n = [
    r1n[1]*r2n[2]-r1n[2]*r2n[1],
    r1n[2]*r2n[0]-r1n[0]*r2n[2],
    r1n[0]*r2n[1]-r1n[1]*r2n[0],
  ];
  const nlen = Math.hypot(n[0],n[1],n[2]) || 1;
  let nx = n[0]/nlen, ny = n[1]/nlen, nz = n[2]/nlen;
  // Force the cassette-plane normal to point AT the camera (nz > 0).  Without
  // this the cross product can come out either way and the per-axis tilt
  // sign jitters around perpendicular — visible as the outer crosshair
  // teleporting to its mirror position.
  if (nz < 0) { nx = -nx; ny = -ny; nz = -nz; }
  const deg = Math.acos(Math.max(0, Math.min(1, nz))) * 180 / Math.PI;
  const tiltX = Math.atan2(nx, nz) * 180 / Math.PI;
  const tiltY = Math.atan2(ny, nz) * 180 / Math.PI;
  return { deg: deg, x: tiltX, y: tiltY };
}

// ============================================================================
// Pose: SID, tilt, aim point, in-bounds, fit-to-bounds collimator field
// (verbatim port from v1)
// ============================================================================
function buildPose(qr) {
  const q = SETTINGS.qrPhysicalCm / 2;
  const qrLocal = [{ x:-q, y:-q }, { x: q, y:-q }, { x: q, y: q }, { x:-q, y: q }];
  const qrImg = qr.corners;

  const H_l_to_img = homography4(qrLocal, qrImg);
  if (!H_l_to_img) return null;
  const H_img_to_l = invert3(H_l_to_img);
  if (!H_img_to_l) return null;

  const s = qr.scaleVid;
  const H_l_to_videoPx = [
    H_l_to_img[0]*s, H_l_to_img[1]*s, H_l_to_img[2]*s,
    H_l_to_img[3]*s, H_l_to_img[4]*s, H_l_to_img[5]*s,
    H_l_to_img[6],   H_l_to_img[7],   H_l_to_img[8],
  ];
  const H_videoPx_to_l = invert3(H_l_to_videoPx);

  const sides = [dist(qrImg[0],qrImg[1]), dist(qrImg[1],qrImg[2]), dist(qrImg[2],qrImg[3]), dist(qrImg[3],qrImg[0])];
  const avgSidePx = (sides[0]+sides[1]+sides[2]+sides[3])/4;
  const focalPx = SETTINGS.focalRel * Math.max(state.frameW, state.frameH);
  let sidCm = focalPx * SETTINGS.qrPhysicalCm / Math.max(avgSidePx, 1);
  const tiltAll = tiltFromH(H_l_to_img, focalPx, focalPx, state.frameW/2, state.frameH/2);
  let tiltDeg = tiltAll.deg;

  const t = performance.now();
  sidCm = sidFilter.filter(sidCm, t);
  tiltDeg = tiltFilter.filter(tiltDeg, t);
  // Per-axis tilt smoothed independently so the device-style crosshair snap
  // doesn't jitter.
  const tiltVec = {
    x: tiltXFilter.filter(tiltAll.x, t),
    y: tiltYFilter.filter(tiltAll.y, t),
  };

  const aimImg = { x: state.frameW/2, y: state.frameH/2 };
  const aimLocal = applyH(H_img_to_l, aimImg.x, aimImg.y);

  const half = SETTINGS.activeAreaCm / 2;
  const minHalf = SETTINGS.minFieldCmPerSid * sidCm / 2;
  const maxFitHalfX = half - Math.abs(aimLocal.x);
  const maxFitHalfY = half - Math.abs(aimLocal.y);
  const maxFitHalf = Math.min(maxFitHalfX, maxFitHalfY);
  const willFit = maxFitHalf >= minHalf;
  const fieldHalf = willFit ? Math.max(minHalf, Math.min(half, maxFitHalf)) : 0;
  const inBounds = willFit;

  const dx = qrImg[1].x - qrImg[0].x;
  const dy = qrImg[1].y - qrImg[0].y;
  const rawLen = Math.hypot(dx, dy) || 1;
  // Smooth roll via sin/cos — atan2 wraps at ±π and can flip the cassette
  // image orientation suddenly; smoothing in cartesian space avoids that.
  const ss = rollSinFilter.filter(dy / rawLen, t);
  const sc = rollCosFilter.filter(dx / rawLen, t);
  const roll = Math.atan2(ss, sc);

  return {
    H_l_to_img, H_img_to_l, H_l_to_videoPx, H_videoPx_to_l,
    sidCm, tiltDeg, tiltVec, roll,
    aimLocal, fieldHalf, half, inBounds,
  };
}

// ============================================================================
// Rectification (from v1)
// ============================================================================
function buildLocalToScreen(p) {
  const W = lcd.clientWidth, H = lcd.clientHeight;
  const aaSide = SETTINGS.activeAreaScreenFrac * Math.min(W, H);
  const scale = aaSide / SETTINGS.activeAreaCm;
  const cx = W / 2, cy = H / 2;
  const cosR = Math.cos(p.roll), sinR = Math.sin(p.roll);
  const H_l_to_s = [
    scale * cosR, -scale * sinR, cx,
    scale * sinR,  scale * cosR, cy,
    0,             0,            1,
  ];
  return { H_l_to_s, scale, cx, cy, W, H, aaSide };
}

function matrix3dFromH(H) {
  const a=H[0],b=H[1],c=H[2], d=H[3],e=H[4],f=H[5], g=H[6],h=H[7],i=H[8];
  return 'matrix3d(' + [a,d,0,g, b,e,0,h, 0,0,1,0, c,f,0,i].join(',') + ')';
}

function applyCassetteTransform(p, l2s) {
  const Wpx = SETTINGS.cassetteImgPx;
  const imgSpanCm = SETTINGS.activeAreaCm / SETTINGS.cassetteImgActiveFrac;
  const aaCxImg = Wpx * (SETTINGS.cassetteImgActiveCx ?? 0.5);
  const aaCyImg = Wpx * SETTINGS.cassetteImgActiveCy;
  const pxToCm = imgSpanCm / Wpx;
  const T_i_to_l = [
    pxToCm, 0, -aaCxImg * pxToCm,
    0, pxToCm, -aaCyImg * pxToCm,
    0, 0, 1,
  ];
  const T_i_to_s = mul3x3(l2s.H_l_to_s, T_i_to_l);
  cassetteImg.style.transform = matrix3dFromH(T_i_to_s);
  cassetteImg.classList.add('show');
}

function clearTransforms() {
  cassetteImg.classList.remove('show');
}

// ============================================================================
// Drawing (from v1)
// ============================================================================
function pts2screen(localPts, l2s) {
  return localPts.map(p => applyH(l2s.H_l_to_s, p.x, p.y));
}

function drawActiveAreaOutline(quad) {
  ctx.save();
  ctx.lineJoin = 'round';
  ctx.beginPath();
  quad.forEach((p,i) => i===0 ? ctx.moveTo(p.x,p.y) : ctx.lineTo(p.x,p.y));
  ctx.closePath();
  ctx.strokeStyle = '#000'; ctx.lineWidth = 5; ctx.stroke();
  ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.stroke();
  ctx.restore();
}

function drawCollimationPillow(quad, bowFraction, lineWidth, color) {
  let sx=0, sy=0; for (const p of quad) { sx += p.x; sy += p.y; }
  const c = { x: sx/4, y: sy/4 };
  ctx.save();
  ctx.strokeStyle = color; ctx.lineWidth = lineWidth; ctx.lineJoin = 'round';
  ctx.beginPath();
  for (let i = 0; i < 4; i++) {
    const a = quad[i], b = quad[(i+1) % 4];
    const mid = { x: (a.x+b.x)/2, y: (a.y+b.y)/2 };
    let nx = mid.x - c.x, ny = mid.y - c.y;
    const nlen = Math.hypot(nx, ny) || 1; nx /= nlen; ny /= nlen;
    const edgeLen = Math.hypot(b.x-a.x, b.y-a.y);
    const cp = { x: mid.x + nx * edgeLen * bowFraction, y: mid.y + ny * edgeLen * bowFraction };
    if (i === 0) ctx.moveTo(a.x, a.y);
    ctx.quadraticCurveTo(cp.x, cp.y, b.x, b.y);
  }
  ctx.closePath(); ctx.stroke(); ctx.restore();
}

// Draw a target ring on the cassette plane at level objective
function drawLevelTarget(l2s) {
  const lvl = MC2_LEVELS[state.levelIdx];
  if (!lvl) return;
  const obj = state.objectives[state.objIdx];
  if (!obj) return;

  // Map a (cm, cm) point on the cassette plane to screen pixels via l2s.
  function localToScreen(x, y) { return applyH(l2s.H_l_to_s, x, y); }

  ctx.save();

  if (lvl.id === 'aim') {
    // Yellow dashed ring at the target spot on the cassette.
    const sp = localToScreen(obj.targetX, obj.targetY);
    const rPx = MC2_TUNING.aimL1LockRadiusCm * l2s.scale;
    const dx = state.pose ? state.pose.aimLocal.x - obj.targetX : 999;
    const dy = state.pose ? state.pose.aimLocal.y - obj.targetY : 999;
    const onTarget = Math.hypot(dx, dy) <= MC2_TUNING.aimL1LockRadiusCm;
    ctx.setLineDash([6, 6]);
    ctx.strokeStyle = onTarget ? COLORS.green : COLORS.amber;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(sp.x, sp.y, rPx, 0, Math.PI * 2);
    ctx.stroke();
    // Center cross to make the target unmistakable
    ctx.setLineDash([]);
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(sp.x - 8, sp.y); ctx.lineTo(sp.x + 8, sp.y);
    ctx.moveTo(sp.x, sp.y - 8); ctx.lineTo(sp.x, sp.y + 8);
    ctx.stroke();
  }
  else if (lvl.id === 'collim') {
    // Ghost dashed rectangle anchored to a specific edge of the active area.
    // The actual field box always sits centered on the aim point and shrinks
    // toward the active-area corner — so the dashed target shape mirrors that
    // behavior, anchored to whichever edge corresponds to the objective's
    // anchor direction.
    const half = state.pose ? state.pose.half : (21.35 / 2);
    const tHalf = obj.targetPct * half;
    const offset = half - tHalf;
    let cx = 0, cy = 0;
    if (obj.anchor === 'right')  cx =  offset;
    else if (obj.anchor === 'left')   cx = -offset;
    else if (obj.anchor === 'top')    cy = -offset;
    else if (obj.anchor === 'bottom') cy =  offset;
    // 'center' → cx=cy=0

    const corners = [
      { x: cx - tHalf, y: cy - tHalf }, { x: cx + tHalf, y: cy - tHalf },
      { x: cx + tHalf, y: cy + tHalf }, { x: cx - tHalf, y: cy + tHalf },
    ].map(function (p) { return localToScreen(p.x, p.y); });

    // On-target tint feedback: green when aim is close, amber otherwise.
    const aimErr = state.pose
      ? Math.hypot(state.pose.aimLocal.x - cx, state.pose.aimLocal.y - cy)
      : Infinity;
    const onTarget = aimErr <= 2.5;
    ctx.setLineDash([8, 6]);
    ctx.strokeStyle = onTarget ? COLORS.green : COLORS.amber;
    ctx.lineWidth = 3;
    ctx.beginPath();
    corners.forEach(function (p, i) { i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y); });
    ctx.closePath();
    ctx.stroke();

    // Aim crosshair at target center to make the destination obvious
    const center = localToScreen(cx, cy);
    ctx.setLineDash([]);
    ctx.lineWidth = 2;
    ctx.strokeStyle = onTarget ? COLORS.green : COLORS.amber;
    ctx.beginPath();
    ctx.moveTo(center.x - 6, center.y); ctx.lineTo(center.x + 6, center.y);
    ctx.moveTo(center.x, center.y - 6); ctx.lineTo(center.x, center.y + 6);
    ctx.stroke();

    // Label "Target XX%"
    const pct = Math.round(obj.targetPct * 100) + '%';
    ctx.font = 'bold 12px -apple-system, system-ui, sans-serif';
    ctx.fillStyle = onTarget ? COLORS.green : COLORS.amber;
    ctx.textAlign = 'center';
    ctx.fillText('Target ' + pct, center.x, center.y - tHalf * l2s.scale - 6);
  }

  ctx.restore();
}

// Big, prominent on-viewfinder labels for whichever metric is the focus of
// the current tutorial level (currently L3 = tilt).  Drawn on the overlay
// canvas so it sits above the cassette image but below the crosshair.
function drawTutorialOverlay(W, H, pose) {
  const lvl = MC2_LEVELS[state.levelIdx];
  if (!lvl) return;
  const obj = state.objectives[state.objIdx];
  if (!obj) return;

  if (lvl.id === 'perp') {
    const cur = pose ? pose.tiltDeg : null;
    const targ = obj.targetTilt;
    const tol = obj.tolDeg || 5;
    const onTarget = cur != null && Math.abs(cur - targ) <= tol;

    // Sizes scale with viewfinder so text always fits.  Pill is wide
    // enough to hold "TARGET 10°  ·  Now 12.3°" comfortably.
    const fontBig   = Math.max(20, Math.min(32, Math.round(W * 0.072)));
    const fontSmall = Math.max(11, Math.min(15, Math.round(W * 0.034)));
    const padX      = Math.max(14, Math.round(W * 0.04));
    const padY      = Math.max(8,  Math.round(W * 0.022));

    const targetText = targ.toFixed(0) + '°';
    const nowText    = cur != null ? 'Now ' + cur.toFixed(1) + '°' : 'Now —';
    const labelText  = 'TARGET TILT';

    ctx.save();
    // First measure all text so the pill can size to fit.
    ctx.font = 'bold ' + fontBig + 'px -apple-system, system-ui, sans-serif';
    const tw = ctx.measureText(targetText).width;
    ctx.font = '600 ' + fontSmall + 'px -apple-system, system-ui, sans-serif';
    const lw = ctx.measureText(labelText).width;
    const nw = ctx.measureText(nowText).width;

    // Layout: label on top row, big target + now-readout on bottom row.
    const rowGap   = Math.round(fontSmall * 0.4);
    const bottomW  = tw + Math.round(fontSmall * 1.4) + nw;
    const contentW = Math.max(lw, bottomW);
    const pillW    = Math.min(W * 0.86, contentW + padX * 2);
    const pillH    = padY * 2 + fontSmall + rowGap + fontBig + 2;
    const pillX    = (W - pillW) / 2;
    const pillY    = Math.max(8, Math.round(H * 0.04));

    // Pill background
    ctx.fillStyle   = 'rgba(0, 0, 0, 0.78)';
    ctx.strokeStyle = onTarget ? COLORS.green : COLORS.amber;
    ctx.lineWidth   = 2;
    roundRect(pillX, pillY, pillW, pillH, 10);
    ctx.fill();
    ctx.stroke();

    // Top row: TARGET TILT label
    ctx.fillStyle = onTarget ? COLORS.green : COLORS.amber;
    ctx.font = '600 ' + fontSmall + 'px -apple-system, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText(labelText, pillX + pillW / 2, pillY + padY);

    // Bottom row: big "10°" on the left, "Now X.X°" on the right
    const baseY = pillY + padY + fontSmall + rowGap;
    const sectionW = bottomW;
    const bx = pillX + (pillW - sectionW) / 2;
    // Big target number
    ctx.font = 'bold ' + fontBig + 'px -apple-system, system-ui, sans-serif';
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText(targetText, bx, baseY);
    // Now readout
    ctx.font = '600 ' + fontSmall + 'px -apple-system, system-ui, sans-serif';
    ctx.fillStyle = onTarget ? COLORS.green : '#cbd1dc';
    // baseline-align with the bigger number's optical center
    ctx.textBaseline = 'middle';
    ctx.fillText(nowText, bx + tw + Math.round(fontSmall * 1.4), baseY + fontBig * 0.55);

    ctx.restore();
  }
}

function roundRect(x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y,     x + w, y + r,     r);
  ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
  ctx.arcTo(x,     y + h, x, y + h - r,     r);
  ctx.arcTo(x,     y,     x + r, y,         r);
  ctx.closePath();
}

function updateSidGauge(sidCm, ok) {
  if (!Number.isFinite(sidCm)) {
    sidReadout.style.top = '47.83%';
    sidReadout.textContent = '--';
    sidReadout.classList.remove('bad');
    sidReadout.classList.remove('good');
    return;
  }
  const t = clamp01((sidCm - 30) / (80 - 30));
  const topPct = 73.61 - t * (73.61 - 31.94);
  sidReadout.style.top = (topPct - 4.86 / 2) + '%';
  sidReadout.textContent = sidCm.toFixed(0);
  sidReadout.classList.toggle('good', ok);
  sidReadout.classList.toggle('bad', !ok);
}

// Position the L4 target marker on the SID gauge.  topPct math mirrors the
// updateSidGauge mapping so the user can visually compare actual vs target.
function updateSidTargetMarker(targetSid, hit) {
  if (!sidTargetMarker) return;
  if (!Number.isFinite(targetSid)) { sidTargetMarker.classList.add('hidden'); return; }
  const t = Math.max(0, Math.min(1, (targetSid - 30) / (80 - 30)));
  const topPct = 73.61 - t * (73.61 - 31.94);
  sidTargetMarker.style.top = (topPct - 1.5 / 2) + '%';
  sidTargetMarker.classList.remove('hidden');
  sidTargetMarker.classList.toggle('hit', !!hit);
}

function updateKvMasFills() {
  const kvIdx  = state.kvOpts.indexOf(state.kv);
  const masIdx = state.masOpts.indexOf(state.mas);
  const kvCount  = kvIdx  < 0 ? 0 : (kvIdx  + 1);
  const masCount = masIdx < 0 ? 0 : (masIdx + 1);
  for (let i = 0; i < 5; i++) {
    kvSlots[i].classList.toggle('on', i < kvCount);
    masSlots[i].classList.toggle('on', i < masCount);
  }
}

// ============================================================================
// Main render — also drives the HUD chrome based on current pose
// ============================================================================
function drawScene() {
  const W = lcd.clientWidth, H = lcd.clientHeight;
  ctx.clearRect(0,0,W,H);
  let allowed = false;

  if (state.pose) {
    const p = state.pose;
    const l2s = buildLocalToScreen(p);
    applyCassetteTransform(p, l2s);

    // Active area outline (always)
    const half = p.half;
    const activeLocal = [{ x:-half, y:-half }, { x: half, y:-half }, { x: half, y: half }, { x:-half, y: half }];
    const activeScreen = pts2screen(activeLocal, l2s);
    drawActiveAreaOutline(activeScreen);

    // Tutorial: ghost-target ring at level objective
    if (state.mode === MODE.TUTORIAL) {
      drawLevelTarget(l2s);
      drawTutorialOverlay(W, H, p);
    }

    // Collimation pillow (only in bounds)
    if (p.inBounds && p.fieldHalf > 0) {
      const fh = p.fieldHalf, ax = p.aimLocal.x, ay = p.aimLocal.y;
      const fLocal = [{ x: ax-fh, y: ay-fh }, { x: ax+fh, y: ay-fh }, { x: ax+fh, y: ay+fh }, { x: ax-fh, y: ay+fh }];
      const fScreen = pts2screen(fLocal, l2s);
      drawCollimationPillow(fScreen, 0.025, 3, COLORS.collim);
    }

    // Crosshair: center "+" tracks the beam intersection on the cassette.
    // External cross "completes" (snaps to center) when both per-axis tilts
    // are below the snap angle; otherwise it slides AWAY from center
    // proportional to the 2D tilt vector.  Matches device-side TiltGuideOverlay.
    extCrossImg.classList.remove('hidden');
    ctrCrossImg.classList.remove('hidden');
    crosshair.style.opacity = '1';
    const aimScreen = applyH(l2s.H_l_to_s, p.aimLocal.x, p.aimLocal.y);
    const dx = aimScreen.x - W / 2;
    const dy = aimScreen.y - H / 2;
    crosshair.style.transform =
      `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;

    // Crosshair behavior — mirrors device TiltGuideOverlay::render but tighter.
    // Outer arms (external-cross) stay anchored at the beam intersection.
    // Inner "+" slides in the tilt direction by a small amount, hard-clamped
    // so the two glyphs always read as a single guide.
    //
    // Skip the tilt offset entirely when the external cross is hidden
    // (Levels 1 "aim" and 2 "collim" — only the inner "+" is visible there,
    // so a moving inner cross would feel buggy with no anchor to relate to).
    const SNAP_DEG     = 5.0;
    const tiltScalePx  = Math.min(W, H) * 0.0035;   // ~1.5 px/° at 420 px vf
    const maxRadiusPx  = Math.min(W, H) * 0.020;    // ~8 px hard cap
    const tx = (p.tiltVec && p.tiltVec.x) || 0;
    const ty = (p.tiltVec && p.tiltVec.y) || 0;

    const lvlNow = (state.mode === MODE.TUTORIAL) ? MC2_LEVELS[state.levelIdx] : null;
    const tiltVisible = !lvlNow || (lvlNow.id !== 'aim' && lvlNow.id !== 'collim');

    let cdx = 0, cdy = 0;
    if (tiltVisible && (Math.abs(tx) >= SNAP_DEG || Math.abs(ty) >= SNAP_DEG)) {
      cdx = tx * tiltScalePx;
      cdy = ty * tiltScalePx;
      const mag = Math.hypot(cdx, cdy);
      if (mag > maxRadiusPx) {
        const k = maxRadiusPx / mag;
        cdx *= k; cdy *= k;
      }
    }
    extCrossImg.style.transform = 'translate(-50%, -50%)';
    ctrCrossImg.style.transform =
      `translate(calc(-50% + ${cdx}px), calc(-50% + ${cdy}px))`;

    // HUD readouts (Play mode + final tutorial level)
    const ssdCm = p.sidCm - SETTINGS.patientThicknessCm;
    ssdVal.textContent = ssdCm.toFixed(0);
    const sidOk = p.sidCm >= SETTINGS.sidMin && p.sidCm <= SETTINGS.sidMax;
    const ssdOk = ssdCm >= SETTINGS.ssdMin;
    ssdVal.style.color = '#fff';
    ssdBg.src = ssdOk ? 'assets/ssd-bg-green.svg' : 'assets/ssd-bg-red.svg';
    updateSidGauge(p.sidCm, sidOk);

    // Interlock priority (Play only — tutorial uses its own prompt)
    let warning = null;
    if (state.mode === MODE.PLAY) {
      if (!p.inBounds) warning = 'OUT OF BOUNDS — ALIGN BEAM';
      else if (p.sidCm > SETTINGS.sidMax) warning = 'TOO FAR FROM CASSETTE';
      else if (p.sidCm < SETTINGS.sidMin) warning = 'TOO CLOSE TO CASSETTE';
      else if (ssdCm < SETTINGS.ssdMin) warning = 'TOO CLOSE TO ANATOMY';
      else if (state.meanLuma > 220) warning = 'HARSH LIGHTING';
    }
    if (warning) { interlock.textContent = warning; interlock.classList.remove('hidden'); }
    else { interlock.classList.add('hidden'); }

    allowed = p.inBounds && sidOk && ssdOk;
    modeShield.src = allowed ? 'assets/mode-shield-green.svg'
                             : 'assets/mode-shield-red.svg';
    badgeDetect.classList.add('hidden');
  } else {
    clearTransforms();
    ssdVal.textContent = '--';
    ssdVal.style.color = '#fff';
    ssdBg.src = 'assets/ssd-bg-black.svg';
    modeShield.src = 'assets/mode-shield-red.svg';
    crosshair.style.opacity = '0.45';
    updateSidGauge(NaN, false);
    extCrossImg.classList.remove('hidden');
    extCrossImg.style.opacity = '0.45';
    ctrCrossImg.classList.add('hidden');
    const lostFor = performance.now() - state.lastDetectT;
    if (lostFor > 1200 && state.mode === MODE.PLAY) {
      interlock.textContent = state.meanLuma > 220 ? 'HARSH LIGHTING — CASSETTE NOT VISIBLE'
        : state.meanLuma < 25 ? 'EMITTER FRONT FACE COVERED'
        : 'CASSETTE NOT DETECTED';
      interlock.classList.remove('hidden');
    } else { interlock.classList.add('hidden'); }
    badgeDetect.classList.toggle('hidden', state.mode === MODE.TUTORIAL);
  }

  // Border color: tutorial uses its own logic, play uses interlocks
  if (state.mode === MODE.PLAY) {
    viewfinderEl.classList.toggle('armed',     allowed);
    viewfinderEl.classList.toggle('blocked',   !!state.pose && !allowed);
    viewfinderEl.classList.toggle('searching', !state.pose);
    triggerBtn.classList.toggle('armed', allowed);
    if (allowed && !state.prevAllowed) MC2Audio.armTick();
    state.prevAllowed = allowed;
  }
}

// ============================================================================
// Tutorial state machine — REP-BASED
//
// Each level requires N reps.  One rep:
//   1. User brings pose into spec → button arms green, subtle armTick().
//   2. User presses EXPOSE → rep locks, repsDone++, awaitingReset=true.
//   3. User must drift OUT of spec (per level.resetCheck) before the next rep
//      can arm — prevents spamming EXPOSE while still in spec.
//   4. After all reps: show "Level Complete" overlay with Continue button.
//   5. After final level: transition to Play mode.
//
// No hold meters, no time boxes.  The user is the lock action.
// ============================================================================
function startTutorial() {
  state.mode = MODE.TUTORIAL;
  state.levelIdx = 0;
  state.levelAccuracies = {};
  if (lcRetryBtn) lcRetryBtn.classList.add('hidden');
  state.repsDone = 0;
  state.repArmed = false;
  state.awaitingReset = false;
  state.prevArmed = false;
  state.paused = false;
  setLevelUI();
  enterApp();
}

function startPlay(opts) {
  opts = opts || {};
  state.mode = MODE.PLAY;
  // Show full HUD
  viewfinderEl.classList.remove('layer-aim','layer-center','layer-perp','layer-sid');
  // Reset prompts
  promptStrip.classList.add('hidden');
  promptStep.textContent = '';
  promptText.textContent = '';
  promptHint.textContent = '';
  levelPill.textContent  = 'PLAY';
  skipBtn.classList.add('hidden');
  triggerBtn.classList.remove('hidden', 'armed');
  // Hide tutorial-only UI
  tutTarget.classList.add('hidden');
  holdMeter.style.display = 'none';
  liveReadouts.style.display = 'flex';
  // If transitioning from tutorial, camera is already running — don't restart it
  if (opts.keepCamera) {
    appShell.classList.remove('hidden');
    startScreen.classList.add('hidden');
  } else {
    enterApp();
  }
}

function setLevelUI() {
  const lvl = MC2_LEVELS[state.levelIdx];
  promptStrip.classList.remove('hidden');
  promptStep.textContent = lvl.step;
  promptText.textContent = lvl.title;
  promptHint.textContent = lvl.hint;

  // Layer the HUD chrome
  viewfinderEl.classList.remove('layer-aim','layer-center','layer-perp','layer-sid');
  if (lvl.layer !== 'full') viewfinderEl.classList.add('layer-' + lvl.layer);

  // Tutorial target visibility — used for L1 (aim), repurposed below for L2
  tutTarget.classList.add('hidden');

  // Feedback strip: hide hold meter; show rep counter + readouts only.
  holdMeter.style.display = 'none';
  liveReadouts.style.display = 'flex';

  // EXPOSE button is the lock action for ALL tutorial levels.
  triggerBtn.classList.remove('hidden', 'armed');
  skipBtn.classList.remove('hidden');

  // Build the level's objectives (may be random)
  state.objectives    = lvl.buildObjectives ? lvl.buildObjectives() : [{}];
  state.objIdx        = 0;
  state.objAccuracies = [];
  state.repArmed      = false;
  state.prevArmed     = false;

  updateLevelPill();
  renderRepDots();
  updateObjectivePrompt();
}

function updateLevelPill() {
  const lvl = MC2_LEVELS[state.levelIdx];
  if (!lvl) return;
  const total = state.objectives.length || 1;
  levelPill.textContent =
    `${lvl.step.replace(/\s+/g,' ')} · ${state.objIdx}/${total}`;
}

function renderRepDots() {
  if (!state.objectives.length) { repDots.innerHTML = ''; return; }
  let html = '';
  for (let i = 0; i < state.objectives.length; i++) {
    html += `<span class="rep-dot ${i < state.objIdx ? 'done' : ''}"></span>`;
  }
  repDots.innerHTML = html;
}

// Per-objective text shown under the level title
function updateObjectivePrompt() {
  const lvl = MC2_LEVELS[state.levelIdx];
  const obj = state.objectives[state.objIdx];
  if (!lvl || !obj) return;
  let line = '';
  if (lvl.id === 'aim')    line = `Target ${state.objIdx + 1} of ${state.objectives.length}: aim at the yellow ring.`;
  else if (lvl.id === 'collim') {
    const pct = Math.round(obj.targetPct * 100);
    line = `Target ${state.objIdx + 1} of ${state.objectives.length}: collimator at ${pct}% of max.`;
  }
  else if (lvl.id === 'perp') line = obj.label || `Target tilt ${obj.targetTilt}°`;
  else if (lvl.id === 'sid')  line = `Target ${state.objIdx + 1} of ${state.objectives.length}: ${obj.targetSid} cm.`;
  else if (lvl.id === 'expose') line = 'One attempt — make it count.';
  promptHint.textContent = line || lvl.hint;
}


// ============================================================================
// Tutorial state machine — OBJECTIVE-BASED
// Each level has an array of objectives.  One EXPOSE press = one objective
// graded by accuracy.  No hold meters, no rearm gating between objectives
// (each new objective has a different target so the button naturally unarms).
// ============================================================================
function tickTutorial(_dtMs) {
  if (state.paused) return;
  const lvl = MC2_LEVELS[state.levelIdx];
  if (!lvl) return;
  const obj = state.objectives[state.objIdx];
  if (!obj) return;

  const result = lvl.evaluate(state.pose, obj);

  // Live readouts — augment with current objective context
  renderReadouts(lvl.readouts, state.pose, result, obj);

  // L4: position the SID target marker on the gauge so users can visually
  // line the live SID pill up with the target tick.
  if (lvl.id === 'sid' && obj && obj.targetSid != null) {
    updateSidTargetMarker(obj.targetSid, !!result.ok);
  } else if (sidTargetMarker) {
    sidTargetMarker.classList.add('hidden');
  }

  // Update arm state
  state.repArmed = !!result.ok;
  if (result.ok && !state.prevArmed) MC2Audio.armTick();
  state.prevArmed = result.ok;

  // Visual feedback
  triggerBtn.classList.toggle('armed', !!result.ok);
  viewfinderEl.classList.remove('armed','blocked','searching');
  if (!state.pose)         viewfinderEl.classList.add('searching');
  else if (result.ok)      viewfinderEl.classList.add('armed');
  else                     viewfinderEl.classList.add('blocked');

  // Hint label dynamic
  const labelText = result.ok
    ? 'On target — press EXPOSE'
    : (MC2_REASON_TEXT[result.reason] || lvl.hint);
  feedbackLabel.textContent = labelText;
}

// Called when EXPOSE is pressed during tutorial.
function tryLockRep() {
  if (state.paused) return;
  const lvl = MC2_LEVELS[state.levelIdx];
  if (!lvl) return;
  const obj = state.objectives[state.objIdx];
  if (!obj) return;

  // Final level (single shot) — record whatever accuracy we get and end.
  // Other levels: must be in spec to lock; otherwise soft-fail.
  const result = lvl.evaluate(state.pose, obj);

  if (!result.ok && !lvl.isFinal) {
    MC2Audio.failPress();
    flashFeedback('Not on target yet');
    return;
  }

  // Record accuracy and advance
  state.objAccuracies.push(result.accuracy || 0);
  state.objIdx++;
  state.repArmed = false;
  state.prevArmed = false;
  triggerBtn.classList.remove('armed');
  MC2Audio.lockRep();
  renderRepDots();
  updateLevelPill();

  const accPct = Math.round((result.accuracy || 0) * 100);
  flashFeedback(`Locked — accuracy ${accPct}%`);

  // Final level always shutters; others shutter on the last objective only
  if (lvl.isFinal) fireShutterEffect();

  if (state.objIdx >= state.objectives.length) {
    setTimeout(showLevelComplete, 350);
  } else {
    updateObjectivePrompt();
  }
}

let _flashTimer = null;
function flashFeedback(text) {
  feedbackLabel.textContent = text;
  feedbackLabel.classList.add('flash');
  clearTimeout(_flashTimer);
  _flashTimer = setTimeout(function () { feedbackLabel.classList.remove('flash'); }, 700);
}

function fireShutterEffect() {
  flash.classList.add('on');
  setTimeout(function () { flash.classList.remove('on'); }, 180);
}

function showLevelComplete() {
  state.paused = true;
  const lvl = MC2_LEVELS[state.levelIdx];
  let avg = 0;
  if (state.objAccuracies.length) {
    let sum = 0;
    for (let i = 0; i < state.objAccuracies.length; i++) sum += state.objAccuracies[i];
    avg = sum / state.objAccuracies.length;
  }
  const stars = (typeof MC2_accuracyToStars === 'function') ? MC2_accuracyToStars(avg) : 0;
  if ((state.stars[lvl.id] || 0) < stars) state.stars[lvl.id] = stars;
  saveStars();

  // Track per-level accuracy for the end-of-tutorial retry-weakest prompt.
  state.levelAccuracies[lvl.id] = avg;

  const accPct = Math.round(avg * 100);
  lcStarsEl.textContent  = '★ ★ ★ ☆ ☆ ☆'.split(' ').slice(0, 3).map(function (_, i) {
    return i < stars ? '★' : '☆';
  }).join('');

  // On the final level, look across all level accuracies and surface a
  // "Retry weakest" option if any level scored below the threshold.
  let weakest = null;
  if (lvl.isFinal) {
    const RETRY_THRESHOLD = 0.70;
    let minAcc = Infinity;
    for (const L of MC2_LEVELS) {
      const a = state.levelAccuracies[L.id];
      if (typeof a === 'number' && a < minAcc) {
        minAcc = a;
        if (a < RETRY_THRESHOLD) weakest = L;
      }
    }
  }

  lcTitle.textContent = lvl.isFinal ? 'Tutorial Complete!' : 'Level Complete!';
  if (lvl.isFinal) {
    if (weakest) {
      lcSubEl.textContent =
        'Average accuracy on this level: ' + accPct + '%\n' +
        'You looked least sure on "' + weakest.title + '" — want another pass at it?';
    } else {
      lcSubEl.textContent =
        'Solid run! Tap Continue to start free practice in Play mode.\n' +
        'Accuracy: ' + accPct + '%';
    }
  } else {
    lcSubEl.textContent = 'Average accuracy: ' + accPct + '%\n' +
      (stars === 3 ? 'Excellent!' : stars === 2 ? 'Solid — try for 3 stars next round.' :
       stars === 1 ? 'Got it. Practice for tighter accuracy.' :
       'A bit off — try again to raise your score.');
  }

  lcContinueBtn.textContent = lvl.isFinal ? 'Enter Play mode →' : 'Continue →';

  if (lcRetryBtn) {
    if (weakest) {
      lcRetryBtn.textContent = 'Retry: ' + weakest.title;
      lcRetryBtn.dataset.retryLevelId = weakest.id;
      lcRetryBtn.classList.remove('hidden');
    } else {
      lcRetryBtn.classList.add('hidden');
      lcRetryBtn.dataset.retryLevelId = '';
    }
  }

  lcOverlay.classList.remove('hidden');
  MC2Audio.levelComplete();
}

function onContinue() {
  lcOverlay.classList.add('hidden');
  state.paused = false;
  // If the user just finished a "retry weakest" pass, return them to the
  // final-tutorial summary screen with their updated scores rather than
  // advancing into Play.
  if (state.retryFromFinal) {
    state.retryFromFinal = false;
    state.levelIdx = MC2_LEVELS.length - 1;
    showLevelComplete();
    return;
  }
  const lvl = MC2_LEVELS[state.levelIdx];
  if (lvl.isFinal) {
    startPlay({ keepCamera: true });
    return;
  }
  state.levelIdx++;
  setLevelUI();
}

function skipLevel() {
  if (state.paused) return;
  if (state.mode !== MODE.TUTORIAL) return;
  // Skipping a level still shows the level-complete pop. No accuracy recorded
  // for skipped objectives → 0 stars.
  state.objIdx = state.objectives.length;
  showLevelComplete();
}

// ============================================================================
// Live readouts — bottom feedback strip
// ============================================================================
function renderReadouts(types, pose, result, obj) {
  if (!types || !types.length) { liveReadouts.innerHTML = ''; return; }
  const items = [];
  for (let i = 0; i < types.length; i++) {
    const t = types[i];
    if (t === 'aim') {
      // For L1: distance from current target spot
      const tx = obj && obj.targetX != null ? obj.targetX : 0;
      const ty = obj && obj.targetY != null ? obj.targetY : 0;
      const d = pose ? Math.hypot(pose.aimLocal.x - tx, pose.aimLocal.y - ty) : null;
      const ok = d != null && d <= MC2_TUNING.aimL1LockRadiusCm;
      items.push(readoutEl('TARGET',
        d != null ? d.toFixed(1) + ' cm' : '—',
        d == null ? 'bad' : ok ? 'ok' : 'warn'));
    } else if (t === 'offset') {
      const r = pose ? Math.hypot(pose.aimLocal.x, pose.aimLocal.y) : null;
      const ok = r != null && r <= 4.0;
      items.push(readoutEl('OFF',
        r != null ? r.toFixed(1) + ' cm' : '—',
        r == null ? 'bad' : ok ? 'ok' : 'warn'));
    } else if (t === 'tilt') {
      const v = pose ? pose.tiltDeg : null;
      const targ = obj && obj.targetTilt != null ? obj.targetTilt : 0;
      const ok = v != null && Math.abs(v - targ) <= (obj && obj.tolDeg ? obj.tolDeg : MC2_TUNING.perpTiltLockDeg);
      const label = (obj && obj.targetTilt != null && obj.targetTilt > 0) ? 'TILT→' + targ + '°' : 'TILT';
      items.push(readoutEl(label,
        v != null ? v.toFixed(1) + '°' : '—',
        v == null ? 'bad' : ok ? 'ok' : 'warn'));
    } else if (t === 'sid') {
      const v = pose ? pose.sidCm : null;
      const targ = obj && obj.targetSid != null ? obj.targetSid : MC2_TUNING.finalSidTargetCm;
      const ok = v != null && Math.abs(v - targ) <= MC2_TUNING.sidLockTolCm;
      const label = (obj && obj.targetSid != null) ? 'SID→' + targ : 'SID';
      items.push(readoutEl(label,
        v != null ? v.toFixed(0) + ' cm' : '—',
        v == null ? 'bad' : ok ? 'ok' : 'warn'));
    } else if (t === 'ssd') {
      const v = pose ? (pose.sidCm - MC2_TUNING.patientThicknessCm) : null;
      const ok = v != null && v >= MC2_TUNING.ssdMinCm;
      items.push(readoutEl('SSD',
        v != null ? v.toFixed(0) + ' cm' : '—',
        v == null ? 'bad' : ok ? 'ok' : 'warn'));
    } else if (t === 'collim') {
      // current vs target collimator %
      const cur = pose && pose.half ? Math.round((pose.fieldHalf / pose.half) * 100) : null;
      const targ = obj && obj.targetPct != null ? Math.round(obj.targetPct * 100) : null;
      const err = (cur != null && targ != null) ? Math.abs(cur - targ) : null;
      const ok = err != null && err <= 7;
      items.push(readoutEl('COLLIM→' + (targ != null ? targ + '%' : ''),
        cur != null ? cur + '%' : '—',
        cur == null ? 'bad' : ok ? 'ok' : 'warn'));
    }
  }
  liveReadouts.innerHTML = items.join('');
}

function readoutEl(label, val, cls) {
  return '<div class="readout ' + cls + '"><span class="lbl">' + label + '</span>' + val + '</div>';
}

// ============================================================================
// Stars + camera profile persistence
// ============================================================================
function loadStars() {
  try { return JSON.parse(localStorage.getItem('mc2v2-stars')) || {}; }
  catch (_) { return {}; }
}
function saveStars() {
  try { localStorage.setItem('mc2v2-stars', JSON.stringify(state.stars)); } catch (_) {}
}
function renderTileStars() {
  let total = 0;
  const possible = 3 * MC2_LEVELS.length;
  for (const lvl of MC2_LEVELS) total += (state.stars[lvl.id] || 0);
  tileStars.textContent = total === 0 ? '' : ('★ ' + total + ' / ' + possible);
}

// ============================================================================
// Main loop
// ============================================================================
let lastFrameT = 0;
function loop(t) {
  if (!state.running) return;
  const dt = lastFrameT ? (t - lastFrameT) : 16;
  lastFrameT = t;

  const qr = detectQR();
  const now = performance.now();
  if (qr) {
    state.qr = qr;
    state.pose = buildPose(qr);
    state.lastDetectT = now;
  } else if (now - state.lastDetectT > 400) {
    state.pose = null; state.qr = null;
    cornerFilters = makeCornerFilters();
  }
  drawScene();

  if (state.mode === MODE.TUTORIAL) tickTutorial(dt);

  requestAnimationFrame(loop);
}

// ============================================================================
// Routing / boot
// ============================================================================
function enterApp() {
  startScreen.classList.add('hidden');
  appShell.classList.remove('hidden');
  // Hide any leftover error banner when entering the app shell.
  const bar = document.getElementById('mc2-error-bar');
  if (bar) bar.style.display = 'none';
  requestAnimationFrame(function () {
    resizeCanvas();
    if (!state.running) startCamera();
  });
}

function showStartScreen() {
  state.mode = MODE.NONE;
  stopCamera();
  appShell.classList.add('hidden');
  startScreen.classList.remove('hidden');
  renderTileStars();
  viewfinderEl.classList.remove('layer-aim','layer-center','layer-perp','layer-sid','armed','blocked','searching');
  promptStrip.classList.add('hidden');
  tutTarget.classList.add('hidden');
  lcOverlay.classList.add('hidden');
}

routeTutorial.addEventListener('click', function () {
  try { MC2Audio.unlock(); } catch (e) { mc2Status('Audio unlock failed: ' + e, 'error'); }
  try { startTutorial(); } catch (e) { mc2Status('startTutorial threw: ' + (e && e.message), 'error'); }
});
routePlay.addEventListener('click', function () {
  try { MC2Audio.unlock(); } catch (e) { mc2Status('Audio unlock failed: ' + e, 'error'); }
  try { startPlay(); } catch (e) { mc2Status('startPlay threw: ' + (e && e.message), 'error'); }
});
backBtn.addEventListener('click', function () { showStartScreen(); });
muteBtn.addEventListener('click', function () {
  const m = !MC2Audio.isMuted();
  MC2Audio.setMuted(m);
  muteBtn.textContent = m ? '🔇' : '🔊';
});
skipBtn.addEventListener('click', skipLevel);

document.querySelectorAll('[data-act]').forEach(function (el) {
  el.addEventListener('click', function (e) {
    if (state.mode !== MODE.PLAY) return;
    e.stopPropagation();
    const act = e.currentTarget.dataset.act;
    if (act === 'kv') {
      state.kv = stepArr(state.kvOpts, state.kv, 1);
      kvValEl.textContent = state.kv;
      updateKvMasFills();
    } else if (act === 'mas') {
      state.mas = stepArr(state.masOpts, state.mas, 1);
      masValEl.textContent = state.mas;
      updateKvMasFills();
    } else if (act === 'mode') {
      state.modeIdx = (state.modeIdx + 1) % state.modes.length;
      modeValEl.textContent = state.modes[state.modeIdx];
    }
  });
});
updateKvMasFills();

triggerBtn.addEventListener('click', function () {
  if (state.mode === MODE.TUTORIAL) {
    tryLockRep();
    return;
  }
  if (state.mode === MODE.PLAY) {
    if (!triggerBtn.classList.contains('armed')) { MC2Audio.failPress(); return; }
    if (state.capturing) return;
    state.capturing = true;
    MC2Audio.expose();
    fireShutterEffect();
    setTimeout(function () { state.capturing = false; }, 220);
  }
});

if (lcContinueBtn) lcContinueBtn.addEventListener('click', onContinue);
if (lcRetryBtn) lcRetryBtn.addEventListener('click', function () {
  const id = lcRetryBtn.dataset.retryLevelId;
  if (!id) return;
  const idx = MC2_LEVELS.findIndex(function (L) { return L.id === id; });
  if (idx < 0) return;
  lcOverlay.classList.add('hidden');
  state.paused = false;
  state.levelIdx = idx;
  state.retryFromFinal = true;
  lcRetryBtn.classList.add('hidden');
  setLevelUI();
});

function stepArr(arr, val, dir) {
  const i = arr.indexOf(val);
  const n = arr.length;
  const j = ((i < 0 ? 0 : i) + dir + n) % n;
  return arr[j];
}

// Focal length is now a fixed default (~75° FOV — typical phone main camera).
// SETTINGS.focalRel was already set above; nothing else to do at boot.
showStartScreen();
