'use strict';

// Surface any uncaught script error visibly — iOS Safari has no JS console
// without dev-tools, so silent errors are invisible.  This banner sits above
// the start screen so a real error stops being mysterious.
window.addEventListener('error', function (e) {
  try {
    let bar = document.getElementById('mc2-error-bar');
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'mc2-error-bar';
      bar.style.cssText =
        'position:fixed;left:0;right:0;top:0;z-index:9999;' +
        'background:#ff4757;color:#fff;padding:8px 12px;' +
        'font:600 12px/1.4 -apple-system,system-ui,sans-serif;' +
        'white-space:pre-wrap;max-height:40vh;overflow:auto;';
      document.body && document.body.appendChild(bar);
    }
    const msg = (e && e.message) || String(e);
    const src = e && (e.filename || '') + (e.lineno ? ':' + e.lineno : '');
    bar.textContent = 'JS error: ' + msg + (src ? '\n' + src : '');
  } catch (_) {}
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
const repDots       = document.getElementById('rep-dots');
const feedbackLabel = document.getElementById('feedback-label');
const camProfileSel = document.getElementById('camera-profile');

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
  qrPhysicalCm: 9.0,
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

  // tutorial
  levelIdx: 0,
  repsDone: 0,               // reps completed in current level
  repArmed: false,           // is pose currently in spec? (drives button color)
  awaitingReset: false,      // after locking a rep, must drift out before next can arm
  prevArmed: false,          // for arm-tick edge detection
  paused: false,             // true during level-complete overlay
  stars: loadStars(),        // best stars per level (kept for tile display)

  // camera profile (FOV approximation)
  cameraProfileId: loadCameraProfile(),
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
const sidFilter  = new OneEuro(0.8, 0.02, 1.0);
const tiltFilter = new OneEuro(0.8, 0.02, 1.0);

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
    alert('Camera unavailable: ' + (err && err.message ? err.message : err));
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
  const nz = Math.abs(n[2]/nlen);
  return Math.acos(Math.max(0, Math.min(1, nz))) * 180 / Math.PI;
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
  let tiltDeg = tiltFromH(H_l_to_img, focalPx, focalPx, state.frameW/2, state.frameH/2);

  const t = performance.now();
  sidCm = sidFilter.filter(sidCm, t);
  tiltDeg = tiltFilter.filter(tiltDeg, t);

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
  const roll = Math.atan2(dy, dx);

  return {
    H_l_to_img, H_img_to_l, H_l_to_videoPx, H_videoPx_to_l,
    sidCm, tiltDeg, roll,
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
  let radiusCm = null;
  if      (lvl.id === 'aim')    radiusCm = MC2_TUNING.aimRadiusCm;
  else if (lvl.id === 'center') radiusCm = MC2_TUNING.centerRadiusCm;
  if (radiusCm == null) return;

  const cx = l2s.cx, cy = l2s.cy;
  const rPx = radiusCm * l2s.scale;

  const r = state.pose ? Math.hypot(state.pose.aimLocal.x, state.pose.aimLocal.y) : Infinity;
  const inSpec = r <= radiusCm;

  ctx.save();
  ctx.setLineDash([6, 6]);
  ctx.strokeStyle = inSpec ? COLORS.green : COLORS.amber;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(cx, cy, rPx, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
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
    if (state.mode === MODE.TUTORIAL) drawLevelTarget(l2s);

    // Collimation pillow (only in bounds)
    if (p.inBounds && p.fieldHalf > 0) {
      const fh = p.fieldHalf, ax = p.aimLocal.x, ay = p.aimLocal.y;
      const fLocal = [{ x: ax-fh, y: ay-fh }, { x: ax+fh, y: ay-fh }, { x: ax+fh, y: ay+fh }, { x: ax-fh, y: ay+fh }];
      const fScreen = pts2screen(fLocal, l2s);
      drawCollimationPillow(fScreen, 0.025, 3, COLORS.collim);
    }

    // Crosshair tracks aim point
    extCrossImg.classList.remove('hidden');
    ctrCrossImg.classList.remove('hidden');
    crosshair.style.opacity = '1';
    const aimScreen = applyH(l2s.H_l_to_s, p.aimLocal.x, p.aimLocal.y);
    const dx = aimScreen.x - W / 2;
    const dy = aimScreen.y - H / 2;
    crosshair.style.transform =
      `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;

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
  updateLevelPill();

  // Layer the HUD chrome
  viewfinderEl.classList.remove('layer-aim','layer-center','layer-perp','layer-sid');
  if (lvl.layer !== 'full') viewfinderEl.classList.add('layer-' + lvl.layer);

  // Tutorial target visibility (rings on cassette plane)
  if (lvl.id === 'aim' || lvl.id === 'center') tutTarget.classList.remove('hidden');
  else                                          tutTarget.classList.add('hidden');

  // Feedback strip: hide hold meter; show rep counter + readouts only.
  holdMeter.style.display = 'none';
  liveReadouts.style.display = 'flex';

  // EXPOSE button is the lock action for ALL tutorial levels now.
  triggerBtn.classList.remove('hidden', 'armed');
  skipBtn.classList.remove('hidden');

  // Reset per-level rep state
  state.repsDone = 0;
  state.repArmed = false;
  state.awaitingReset = false;
  state.prevArmed = false;

  renderRepDots();
}

function updateLevelPill() {
  const lvl = MC2_LEVELS[state.levelIdx];
  if (!lvl) return;
  levelPill.textContent =
    `${lvl.step.replace(/\s+/g,' ')} · ${state.repsDone}/${lvl.reps}`;
}

function renderRepDots() {
  const lvl = MC2_LEVELS[state.levelIdx];
  if (!lvl) { repDots.innerHTML = ''; return; }
  let html = '';
  for (let i = 0; i < lvl.reps; i++) {
    html += `<span class="rep-dot ${i < state.repsDone ? 'done' : ''}"></span>`;
  }
  repDots.innerHTML = html;
}

function tickTutorial(_dtMs) {
  if (state.paused) return;
  const lvl = MC2_LEVELS[state.levelIdx];
  if (!lvl) return;

  const result = lvl.inSpec(state.pose);

  // Live readouts
  renderReadouts(lvl.readouts, state.pose, result);

  // Rearm gating: after a rep is locked, user must drift OUT of spec before
  // the button can arm again.  This keeps each rep deliberate.
  if (state.awaitingReset) {
    if (lvl.resetCheck(state.pose)) {
      state.awaitingReset = false;
    }
  }

  // Update arm state
  const armable = result.ok && !state.awaitingReset;
  state.repArmed = armable;

  // Subtle armTick ONLY on the rising edge (don't repeat)
  if (armable && !state.prevArmed) {
    MC2Audio.armTick();
  }
  state.prevArmed = armable;

  // Visual feedback
  triggerBtn.classList.toggle('armed', armable);
  viewfinderEl.classList.remove('armed','blocked','searching');
  if (!state.pose)         viewfinderEl.classList.add('searching');
  else if (result.ok)      viewfinderEl.classList.add('armed');
  else                     viewfinderEl.classList.add('blocked');

  // Hint label updates dynamically with reason when out of spec
  const labelText = state.awaitingReset
    ? `Rep ${state.repsDone} locked — move off target to start next rep`
    : (result.ok
        ? 'Hold steady — press EXPOSE'
        : (MC2_REASON_TEXT[result.reason] || lvl.hint));
  feedbackLabel.textContent = labelText;

  // Tutorial target ring on cassette plane: locked when in spec
  if (lvl.id === 'aim' || lvl.id === 'center') {
    tutTarget.classList.toggle('locked', !!result.ok);
  }
}

// Called when EXPOSE is pressed during tutorial.
// If we're armed, lock a rep; otherwise play the soft fail tone.
function tryLockRep() {
  if (state.paused) return;
  const lvl = MC2_LEVELS[state.levelIdx];
  if (!lvl) return;

  if (!state.repArmed) {
    MC2Audio.failPress();
    flashFeedback('Not in spec yet');
    return;
  }

  // Lock the rep
  state.repsDone++;
  state.awaitingReset = true;
  state.repArmed = false;
  state.prevArmed = false;
  triggerBtn.classList.remove('armed');
  MC2Audio.lockRep();
  renderRepDots();
  updateLevelPill();
  flashFeedback(`Rep ${state.repsDone} / ${lvl.reps} locked`);

  // Final-level taps also fire the shutter flash so it FEELS like an exposure
  if (lvl.isFinal) fireShutterEffect();

  if (state.repsDone >= lvl.reps) {
    // Brief delay so the user sees the last rep land before the overlay
    setTimeout(showLevelComplete, 350);
  }
}

let _flashTimer = null;
function flashFeedback(text) {
  feedbackLabel.textContent = text;
  feedbackLabel.classList.add('flash');
  clearTimeout(_flashTimer);
  _flashTimer = setTimeout(() => feedbackLabel.classList.remove('flash'), 600);
}

function fireShutterEffect() {
  flash.classList.add('on');
  setTimeout(() => flash.classList.remove('on'), 180);
}

function showLevelComplete() {
  state.paused = true;
  const lvl = MC2_LEVELS[state.levelIdx];
  state.stars[lvl.id] = 3;   // earning a level = 3 stars (no drift penalty in rep model)
  saveStars();

  lcStarsEl.textContent  = '★ ★ ★';
  lcTitle.textContent    = lvl.isFinal ? 'Tutorial Complete!' : 'Level Complete!';
  lcSubEl.textContent    = lvl.isFinal
    ? "You've practiced every skill. Tap Continue to start free practice in Play mode."
    : `You nailed ${lvl.reps} reps of ${lvl.title.toLowerCase()}. Press Continue when ready.`;
  lcContinueBtn.textContent = lvl.isFinal ? 'Enter Play mode →' : 'Continue →';
  lcOverlay.classList.remove('hidden');
  MC2Audio.levelComplete();
}

// Continue button on the level-complete overlay
function onContinue() {
  lcOverlay.classList.add('hidden');
  state.paused = false;
  const lvl = MC2_LEVELS[state.levelIdx];
  if (lvl.isFinal) {
    // After the tutorial: drop straight into Play mode
    startPlay({ keepCamera: true });
    return;
  }
  state.levelIdx++;
  setLevelUI();
}

function skipLevel() {
  if (state.paused) return;
  if (state.mode !== MODE.TUTORIAL) return;
  // Skipping a level still shows the level-complete pop so the flow is consistent.
  // (User explicitly chose to skip; star not awarded for skipped levels.)
  state.repsDone = MC2_LEVELS[state.levelIdx].reps;
  showLevelComplete();
}

// ============================================================================
// Live readouts
// ============================================================================
function renderReadouts(types, pose, result) {
  if (!types || !types.length) { liveReadouts.innerHTML = ''; return; }
  const items = [];
  const lvl = MC2_LEVELS[state.levelIdx];

  for (const t of types) {
    if (t === 'aim') {
      const r = pose ? Math.hypot(pose.aimLocal.x, pose.aimLocal.y) : null;
      const ok = r != null && r <= MC2_TUNING.aimRadiusCm;
      items.push(readoutEl('AIM',  r != null ? `${r.toFixed(1)} cm` : '—', r == null ? 'bad' : ok ? 'ok' : 'warn'));
    } else if (t === 'offset') {
      const r = pose ? Math.hypot(pose.aimLocal.x, pose.aimLocal.y) : null;
      const ok = r != null && r <= MC2_TUNING.centerRadiusCm;
      items.push(readoutEl('OFF',  r != null ? `${r.toFixed(1)} cm` : '—', r == null ? 'bad' : ok ? 'ok' : 'warn'));
    } else if (t === 'tilt') {
      const v = pose ? pose.tiltDeg : null;
      const ok = v != null && v <= MC2_TUNING.perpTiltDeg;
      items.push(readoutEl('TILT', v != null ? `${v.toFixed(1)}°` : '—', v == null ? 'bad' : ok ? 'ok' : 'warn'));
    } else if (t === 'sid') {
      const v = pose ? pose.sidCm : null;
      const err = v != null ? Math.abs(v - MC2_TUNING.sidTargetCm) : null;
      const ok = err != null && err <= MC2_TUNING.sidToleranceCm;
      items.push(readoutEl('SID', v != null ? `${v.toFixed(0)} cm` : '—', v == null ? 'bad' : ok ? 'ok' : 'warn'));
    } else if (t === 'ssd') {
      const v = pose ? (pose.sidCm - MC2_TUNING.patientThicknessCm) : null;
      const ok = v != null && v >= MC2_TUNING.ssdMinCm;
      items.push(readoutEl('SSD', v != null ? `${v.toFixed(0)} cm` : '—', v == null ? 'bad' : ok ? 'ok' : 'warn'));
    }
  }
  liveReadouts.innerHTML = items.join('');
}

function readoutEl(label, val, cls) {
  return `<div class="readout ${cls}"><span class="lbl">${label}</span>${val}</div>`;
}

// ============================================================================
// Stars + camera profile persistence
// ============================================================================
function loadStars() {
  try { return JSON.parse(localStorage.getItem('mc2v2-stars')) || {}; }
  catch(_) { return {}; }
}
function saveStars() {
  try { localStorage.setItem('mc2v2-stars', JSON.stringify(state.stars)); } catch(_) {}
}
function renderTileStars() {
  let total = 0, possible = 3 * MC2_LEVELS.length;
  for (const lvl of MC2_LEVELS) total += (state.stars[lvl.id] || 0);
  if (total === 0) {
    tileStars.textContent = '';
  } else {
    tileStars.textContent = `★ ${total} / ${possible}`;
  }
}

function loadCameraProfile() {
  try {
    const id = localStorage.getItem('mc2v2-cam-profile');
    if (id && MC2_CAMERA_PROFILES.find(p => p.id === id)) return id;
  } catch(_) {}
  return MC2_CAMERA_PROFILES[0].id;
}
function getCameraProfile() {
  return MC2_CAMERA_PROFILES.find(p => p.id === state.cameraProfileId) || MC2_CAMERA_PROFILES[0];
}
function applyCameraProfile() {
  const p = getCameraProfile();
  SETTINGS.focalRel = p.focalRel;
}
function setCameraProfile(id) {
  state.cameraProfileId = id;
  applyCameraProfile();
  try { localStorage.setItem('mc2v2-cam-profile', id); } catch(_) {}
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
  MC2Audio.unlock();
  startTutorial();
});
routePlay.addEventListener('click', function () {
  MC2Audio.unlock();
  startPlay();
});
backBtn.addEventListener('click', function () {
  showStartScreen();
});
muteBtn.addEventListener('click', function () {
  const m = !MC2Audio.isMuted();
  MC2Audio.setMuted(m);
  muteBtn.textContent = m ? '🔇' : '🔊';
});
skipBtn.addEventListener('click', skipLevel);

// Play-mode HUD controls (kV / mAs / mode tap-zones)
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

// EXPOSE button — locks a tutorial rep, or fires Play-mode shutter
triggerBtn.addEventListener('click', function () {
  if (state.mode === MODE.TUTORIAL) {
    tryLockRep();
    return;
  }
  if (state.mode === MODE.PLAY) {
    if (state.capturing) return;
    state.capturing = true;
    MC2Audio.expose();
    fireShutterEffect();
    setTimeout(function () { state.capturing = false; }, 220);
  }
});

if (lcContinueBtn) lcContinueBtn.addEventListener('click', onContinue);

function stepArr(arr, val, dir) {
  const i = arr.indexOf(val);
  const n = arr.length;
  const j = ((i < 0 ? 0 : i) + dir + n) % n;
  return arr[j];
}

// Camera profile picker (start screen).
// Options are declared statically in index.html so they're visible even if
// this script fails to run.  Here we only sync the saved selection and wire
// up the change handler.
if (camProfileSel) {
  if (camProfileSel.options.length === 0 && Array.isArray(MC2_CAMERA_PROFILES)) {
    for (const p of MC2_CAMERA_PROFILES) {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = p.label;
      camProfileSel.appendChild(opt);
    }
  }
  try { camProfileSel.value = state.cameraProfileId; } catch (_) {}
  camProfileSel.addEventListener('change', function () {
    setCameraProfile(camProfileSel.value);
  });
}

applyCameraProfile();
showStartScreen();
