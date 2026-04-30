'use strict';

// =============================================================================
// MC2 Viewfinder Trainer v3
// - Auto-only collimator with fit-to-bounds field sizing (per IFU + user notes)
// - Cassette image overlay via CSS matrix3d riding on the QR plane
// - Real SVG-derived external cross + collimation pillow geometry
// =============================================================================

// ===== UI elements =====
const startScreen = document.getElementById('start-screen');
const startBtn    = document.getElementById('start-btn');
const calibInput  = document.getElementById('calib-input');
const thickInput  = document.getElementById('thick-input');
const video       = document.getElementById('video');
const cassetteImg = document.getElementById('cassette');
const overlay     = document.getElementById('overlay');
const flash       = document.getElementById('flash');
const ctx         = overlay.getContext('2d');
const ssdVal      = document.getElementById('ssd-val');
const sidVal      = document.getElementById('sid-val');
const tiltVal     = document.getElementById('tilt-val');
const pillSSD     = document.getElementById('pill-ssd');
const pillSID     = document.getElementById('pill-sid');
const pillTilt    = document.getElementById('pill-tilt');
const interlock   = document.getElementById('interlock');
const badgeDetect = document.getElementById('badge-detect');
const kvValEl     = document.getElementById('kv-val');
const masValEl    = document.getElementById('mas-val');
const modeValEl   = document.getElementById('mode-val');
const triggerBtn  = document.getElementById('trigger');
const diag        = document.getElementById('diag');

// ===== Settings =====
const SETTINGS = {
  qrPhysicalCm: 9.0,
  // Real MC2 active area is 21.35 x 21.35 cm.
  activeAreaCm: 21.35,
  // The cropped cassette image's active-area square spans ~65% of the image.
  // Project the whole image to (activeAreaCm / 0.65) cm so the inner active
  // area lines up with the trainer's active-area math.
  cassetteImgActiveFrac: 0.65,
  // Min collimator field projects to 0.24 * SID cm at the cassette plane
  // (from IFU table - the 0% row scales linearly with SID at 0.24 cm/cm).
  minFieldCmPerSid: 0.24,
  sidMin: 30, sidMax: 80,
  ssdMin: 30,
  patientThicknessCm: 5,
  focalRel: 0.85,
  perpThresholdDeg: 8,
  perpFadeMaxDeg: 25,
  oeMinCutoff: 1.2,
  oeBeta: 0.04,
  oeDerivCutoff: 1.0,
  procMaxDim: 720,
  cassetteImgPx: 600, // natural pixel size of cassette.webp
};

const COLORS = {
  green:       '#077B51',
  greenPill:   '#3DB06B',
  orange:      '#EE6C4D',
  centerBlack: '#000000',
  active:      'rgba(180, 220, 255, 0.10)',
  outBoundsBg: 'rgba(255, 71, 87, 0.10)',
  outline:     'rgba(255,255,255,0.30)',
};

// ===== State =====
const state = {
  running: false,
  kv: 60, kvOpts: [40,50,60,70,80],
  mas: 0.16, masOpts: [0.04,0.08,0.16,0.25,0.40],
  modeIdx: 1, modes: ['Single','DDR','Fluoro','Photo'],
  qr: null, pose: null, lastDetectT: 0,
  frameW: 0, frameH: 0,
  perpAlpha: 0,
  capturing: false,
  prevAllowed: false,
  meanLuma: 0,
};

// =============================================================================
// One-Euro filter
// =============================================================================
class OneEuro {
  constructor(minCutoff, beta, dCutoff) {
    this.minCutoff = minCutoff; this.beta = beta; this.dCutoff = dCutoff;
    this.x = null; this.dx = 0; this.tPrev = null;
  }
  alpha(cutoff, dt){
    const tau = 1 / (2 * Math.PI * cutoff);
    return 1 / (1 + tau / dt);
  }
  filter(x, t) {
    if (this.tPrev == null) { this.tPrev = t; this.x = x; return x; }
    const dt = Math.max(1e-3, (t - this.tPrev) / 1000);
    const dxRaw = (x - this.x) / dt;
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
  const arr = [];
  for (let i=0;i<4;i++){
    arr.push({
      x: new OneEuro(SETTINGS.oeMinCutoff, SETTINGS.oeBeta, SETTINGS.oeDerivCutoff),
      y: new OneEuro(SETTINGS.oeMinCutoff, SETTINGS.oeBeta, SETTINGS.oeDerivCutoff),
    });
  }
  return arr;
}
let cornerFilters = makeCornerFilters();
const sidFilter   = new OneEuro(0.8, 0.02, 1.0);
const tiltFilter  = new OneEuro(0.8, 0.02, 1.0);

// =============================================================================
// Camera
// =============================================================================
async function startCamera() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode: { ideal: 'environment' },
        width:  { ideal: 1920 },
        height: { ideal: 1080 },
      }
    });
    video.srcObject = stream;
    try { await video.play(); } catch(_) {}
    await new Promise(res => {
      if (video.videoWidth > 0) return res();
      const onMeta = () => { video.removeEventListener('loadedmetadata', onMeta); res(); };
      video.addEventListener('loadedmetadata', onMeta);
    });
    const mm = parseFloat(calibInput.value);
    if (Number.isFinite(mm) && mm >= 10 && mm <= 200) SETTINGS.qrPhysicalCm = mm / 10;
    const th = parseFloat(thickInput.value);
    if (Number.isFinite(th) && th >= 0 && th <= 40) SETTINGS.patientThicknessCm = th;

    state.running = true;
    resizeCanvas();
    requestAnimationFrame(loop);
  } catch (err) {
    alert('Camera unavailable: ' + (err && err.message ? err.message : err) +
          '\n\nThis demo requires HTTPS (or localhost) and a working rear camera.');
    startScreen.classList.remove('hidden');
  }
}

function resizeCanvas() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  overlay.width  = Math.round(window.innerWidth  * dpr);
  overlay.height = Math.round(window.innerHeight * dpr);
  overlay.style.width  = window.innerWidth  + 'px';
  overlay.style.height = window.innerHeight + 'px';
  ctx.setTransform(dpr,0,0,dpr,0,0);
}
window.addEventListener('resize', resizeCanvas);
window.addEventListener('orientationchange', () => setTimeout(resizeCanvas, 200));
if (window.visualViewport) window.visualViewport.addEventListener('resize', resizeCanvas);

// =============================================================================
// QR detection with One-Euro corner smoothing
// =============================================================================
const work = document.createElement('canvas');
const wctx = work.getContext('2d', { willReadFrequently: true });

function detectQR() {
  const vw = video.videoWidth, vh = video.videoHeight;
  if (!vw || !vh) return null;
  const targetMax = SETTINGS.procMaxDim;
  const scale = targetMax / Math.max(vw, vh);
  const w = Math.round(vw * scale);
  const h = Math.round(vh * scale);
  if (work.width !== w || work.height !== h) { work.width = w; work.height = h; }
  state.frameW = w; state.frameH = h;
  wctx.drawImage(video, 0, 0, w, h);
  let imgData;
  try { imgData = wctx.getImageData(0, 0, w, h); }
  catch(e){ return null; }

  let luma = 0, samples = 0;
  for (let i=0; i<imgData.data.length; i+=64*4) {
    luma += 0.299*imgData.data[i] + 0.587*imgData.data[i+1] + 0.114*imgData.data[i+2];
    samples++;
  }
  state.meanLuma = samples ? luma/samples : 0;

  const code = jsQR(imgData.data, w, h, { inversionAttempts: 'dontInvert' });
  if (!code) return null;

  const rawCorners = [
    code.location.topLeftCorner,
    code.location.topRightCorner,
    code.location.bottomRightCorner,
    code.location.bottomLeftCorner,
  ];
  const t = performance.now();
  const smoothed = rawCorners.map((p, i) => ({
    x: cornerFilters[i].x.filter(p.x, t),
    y: cornerFilters[i].y.filter(p.y, t),
  }));
  return { corners: smoothed, raw: rawCorners, data: code.data, t };
}

// =============================================================================
// Geometry: 8x8 solver, homography, inverse, tilt-from-H, quad-to-quad-3D
// =============================================================================
function solve8(A, b) {
  const n = 8;
  const M = new Float64Array(n*(n+1));
  for (let i=0;i<n;i++){
    for (let j=0;j<n;j++) M[i*(n+1)+j] = A[i*n+j];
    M[i*(n+1)+n] = b[i];
  }
  for (let i=0;i<n;i++){
    let p = i, pv = Math.abs(M[i*(n+1)+i]);
    for (let r=i+1;r<n;r++){ const v = Math.abs(M[r*(n+1)+i]); if (v>pv){pv=v;p=r;} }
    if (pv < 1e-12) return null;
    if (p !== i) { for (let j=0;j<=n;j++){ const t=M[i*(n+1)+j]; M[i*(n+1)+j]=M[p*(n+1)+j]; M[p*(n+1)+j]=t; } }
    const inv = 1/M[i*(n+1)+i];
    for (let j=i;j<=n;j++) M[i*(n+1)+j] *= inv;
    for (let r=0;r<n;r++){ if (r===i) continue;
      const f = M[r*(n+1)+i]; if (!f) continue;
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
function applyH(H, x, y) {
  const w = H[6]*x + H[7]*y + H[8];
  return { x:(H[0]*x+H[1]*y+H[2])/w, y:(H[3]*x+H[4]*y+H[5])/w };
}
function invert3(H) {
  const a=H[0],b=H[1],c=H[2], d=H[3],e=H[4],f=H[5], g=H[6],h=H[7],i=H[8];
  const A = (e*i - f*h), B = -(d*i - f*g), C = (d*h - e*g);
  const det = a*A + b*B + c*C;
  if (Math.abs(det) < 1e-12) return null;
  const D = -(b*i - c*h), E = (a*i - c*g), F = -(a*h - b*g);
  const G = (b*f - c*e), I = -(a*f - c*d), J = (a*e - b*d);
  const inv = [A,D,G, B,E,I, C,F,J];
  for (let k=0;k<9;k++) inv[k] /= det;
  return inv;
}
function dist(a,b){ const dx=a.x-b.x, dy=a.y-b.y; return Math.hypot(dx,dy); }
function clamp01(v){ return Math.max(0, Math.min(1, v)); }
function lerp(a,b,t){ return a + (b-a)*t; }

function tiltFromH(H, fx, fy, cx, cy) {
  const Hn = [
    (H[0] - cx*H[6]) / fx, (H[1] - cx*H[7]) / fx, (H[2] - cx*H[8]) / fx,
    (H[3] - cy*H[6]) / fy, (H[4] - cy*H[7]) / fy, (H[5] - cy*H[8]) / fy,
    H[6], H[7], H[8],
  ];
  const r1 = [Hn[0], Hn[3], Hn[6]], r2 = [Hn[1], Hn[4], Hn[7]];
  const len1 = Math.hypot(r1[0],r1[1],r1[2]) || 1;
  const len2 = Math.hypot(r2[0],r2[1],r2[2]) || 1;
  const lam = 2 / (len1 + len2);
  const r1n = r1.map(v=>v*lam), r2n = r2.map(v=>v*lam);
  const n = [
    r1n[1]*r2n[2] - r1n[2]*r2n[1],
    r1n[2]*r2n[0] - r1n[0]*r2n[2],
    r1n[0]*r2n[1] - r1n[1]*r2n[0],
  ];
  const nlen = Math.hypot(n[0],n[1],n[2]) || 1;
  const nz = Math.abs(n[2] / nlen);
  return Math.acos(Math.max(0, Math.min(1, nz))) * 180 / Math.PI;
}

// Quad-to-quad: returns the 8 unknowns of a 3x3 homography (h00..h21, with h22=1)
// that maps the 4 source points to the 4 destination points.  Used to drive
// CSS `matrix3d` for the cassette image overlay.
function quadHomography(from, to) {
  return homography4(from, to); // already returns the 9-element row-major H
}
// Convert a 3x3 homography mapping the source rect (0,0..W,H) to a CSS matrix3d
// transform string. Element with width=W, height=H, transform-origin: 0 0 will
// land its 4 corners on the 4 destination points.
function matrix3dFromH(H) {
  // CSS matrix3d takes 16 values column-major: m11,m12,m13,m14, m21,...
  // Mapping a 3x3 affine homography H (row-major a..i) to 4x4:
  //   m11=a, m12=d, m13=0, m14=g
  //   m21=b, m22=e, m23=0, m24=h
  //   m31=0, m32=0, m33=1, m34=0
  //   m41=c, m42=f, m43=0, m44=i
  const a=H[0],b=H[1],c=H[2], d=H[3],e=H[4],f=H[5], g=H[6],h=H[7],i=H[8];
  return 'matrix3d(' +
    [ a,d,0,g,
      b,e,0,h,
      0,0,1,0,
      c,f,0,i ].join(',') + ')';
}

// =============================================================================
// Pose: SID, tilt, aim point, in-bounds, collimator field with fit-to-bounds
// =============================================================================
function buildPose(qr) {
  const q = SETTINGS.qrPhysicalCm / 2;
  const qrLocal = [
    { x:-q, y:-q }, { x: q, y:-q }, { x: q, y: q }, { x:-q, y: q },
  ];
  const qrImg = qr.corners;

  const H_local_to_img = homography4(qrLocal, qrImg);
  if (!H_local_to_img) return null;
  const H_img_to_local = invert3(H_local_to_img);
  if (!H_img_to_local) return null;

  const sides = [
    dist(qrImg[0], qrImg[1]), dist(qrImg[1], qrImg[2]),
    dist(qrImg[2], qrImg[3]), dist(qrImg[3], qrImg[0]),
  ];
  const avgSidePx = (sides[0]+sides[1]+sides[2]+sides[3]) / 4;
  const focalPx = SETTINGS.focalRel * Math.max(state.frameW, state.frameH);
  let sidCm = focalPx * SETTINGS.qrPhysicalCm / Math.max(avgSidePx, 1);
  let tiltDeg = tiltFromH(H_local_to_img, focalPx, focalPx,
    state.frameW / 2, state.frameH / 2);

  const t = performance.now();
  sidCm  = sidFilter.filter(sidCm, t);
  tiltDeg = tiltFilter.filter(tiltDeg, t);

  const aimImg = { x: state.frameW / 2, y: state.frameH / 2 };
  const aimLocal = applyH(H_img_to_local, aimImg.x, aimImg.y);

  // Active area in cassette local cm (centered on QR center)
  const half = SETTINGS.activeAreaCm / 2;
  const activeLocal = [
    { x:-half, y:-half }, { x: half, y:-half }, { x: half, y: half }, { x:-half, y: half },
  ];
  const activeImg = activeLocal.map(p => applyH(H_local_to_img, p.x, p.y));

  // ---------- Auto-collimator with fit-to-bounds (per IFU + user notes) ----------
  // The auto collimator opens as wide as it can while keeping the projected
  // X-ray rectangle inside the active area. The smallest possible field at
  // a given SID is approximately `0.24 * SID` cm (from IFU table, 0% row).
  // We're out of bounds only when even the minimum field can't fit, which
  // happens when the aim point is so close to or past the active-area edge
  // that |aim| > half - minFieldHalf in either axis.
  const minFieldCm  = SETTINGS.minFieldCmPerSid * sidCm;
  const minHalf     = minFieldCm / 2;
  const maxFitHalfX = half - Math.abs(aimLocal.x);
  const maxFitHalfY = half - Math.abs(aimLocal.y);
  const maxFitHalf  = Math.min(maxFitHalfX, maxFitHalfY);
  const willFit     = maxFitHalf >= minHalf;
  // Field grows toward full active area as you center; clamps to fit-bound;
  // floors at minHalf so the visible rectangle never disappears while in bounds.
  const fieldHalf = willFit ? Math.max(minHalf, Math.min(half, maxFitHalf)) : 0;
  const fieldCm = fieldHalf * 2;
  const inBounds = willFit;

  // Cassette image projection: project the whole image such that its inner
  // active-area square (cassetteImgActiveFrac of image) maps to activeAreaCm.
  const imgSpanCm = SETTINGS.activeAreaCm / SETTINGS.cassetteImgActiveFrac;
  const imgHalf   = imgSpanCm / 2;
  const cassetteLocal = [
    { x:-imgHalf, y:-imgHalf }, { x: imgHalf, y:-imgHalf },
    { x: imgHalf, y: imgHalf }, { x:-imgHalf, y: imgHalf },
  ];

  return {
    H_local_to_img, H_img_to_local,
    sidCm, tiltDeg,
    aimLocal, aimImg,
    activeLocal, activeImg,
    cassetteLocal,
    fieldCm, fieldHalf, half,
    minFieldCm, maxFitHalf,
    inBounds, willFit,
    qrImg,
  };
}

// =============================================================================
// Frame -> screen mapping (object-fit: cover)
// =============================================================================
function frameToScreenScale() {
  const vw = video.videoWidth, vh = video.videoHeight;
  const sw = window.innerWidth, sh = window.innerHeight;
  if (!vw || !vh || !state.frameW || !state.frameH) return null;
  const scaleVid = state.frameW / vw;
  const cover = Math.max(sw / vw, sh / vh);
  const dispW = vw * cover, dispH = vh * cover;
  const offX = (sw - dispW) / 2, offY = (sh - dispH) / 2;
  return (p) => ({
    x: offX + (p.x / scaleVid) * cover,
    y: offY + (p.y / scaleVid) * cover,
  });
}

// =============================================================================
// SVG-derived primitives (geometry sourced from External cross.svg and
// Collimation Line.svg in the Viewfinder asset set)
// =============================================================================

// External cross: 4 pill-shaped arms (4 wide, ~38 long) with a notch around
// the center matching the SVG (gap of 18 from center).  Drawn in screen pixels.
function drawExternalCross(cx, cy, scale, color, alpha) {
  if (alpha <= 0.02) return;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.fillStyle = color;
  // Each arm = a 4x36 pill (rounded rect) starting at the gap distance from cx,cy
  function pill(x0, y0, w, h) {
    const r = Math.min(w, h) / 2;
    ctx.beginPath();
    ctx.moveTo(x0 + r, y0);
    ctx.lineTo(x0 + w - r, y0);
    ctx.arc(x0 + w - r, y0 + r, r, -Math.PI/2, Math.PI/2);
    ctx.lineTo(x0 + r, y0 + h);
    ctx.arc(x0 + r, y0 + r, r, Math.PI/2, -Math.PI/2);
    ctx.closePath();
    ctx.fill();
  }
  const gap   = 18 * scale;
  const armW  = 4  * scale;
  const armL  = 36 * scale;
  // Up / Down (vertical pills) and Left / Right (horizontal pills)
  pill(cx - armW/2, cy - gap - armL, armW, armL);          // up
  pill(cx - armW/2, cy + gap,        armW, armL);          // down
  pill(cx - gap - armL, cy - armW/2, armL, armW);          // left
  pill(cx + gap, cy - armW/2,        armL, armW);          // right
  ctx.restore();
}

// Center plus + ring (small "snap" mark at the beam landing point).
function drawCenterPlus(cx, cy, color) {
  ctx.save();
  ctx.lineCap = 'round';
  ctx.strokeStyle = color;
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  ctx.moveTo(cx, cy - 8); ctx.lineTo(cx, cy + 8);
  ctx.moveTo(cx - 8, cy); ctx.lineTo(cx + 8, cy);
  ctx.stroke();
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(cx, cy, 13, 0, Math.PI*2);
  ctx.stroke();
  ctx.restore();
}

// Collimation pillow: 4 quadratic-bezier edges bowing slightly outward, in the
// MC2 collimation green (#077B51).  `quad` is the 4 screen-space corners of
// the field rectangle; `bowFraction` is how far the bezier control point sits
// out from each edge midpoint, as a fraction of edge length.
function drawCollimationPillow(quad, bowFraction, lineWidth, color) {
  const c = centroid(quad);
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = lineWidth;
  ctx.lineJoin = 'round';
  ctx.beginPath();
  for (let i = 0; i < 4; i++) {
    const a = quad[i];
    const b = quad[(i+1) % 4];
    const mid = { x: (a.x+b.x)/2, y: (a.y+b.y)/2 };
    let nx = mid.x - c.x, ny = mid.y - c.y;
    const nlen = Math.hypot(nx, ny) || 1;
    nx /= nlen; ny /= nlen;
    const edgeLen = Math.hypot(b.x-a.x, b.y-a.y);
    const bow = edgeLen * bowFraction;
    const cp = { x: mid.x + nx * bow, y: mid.y + ny * bow };
    if (i === 0) ctx.moveTo(a.x, a.y);
    ctx.quadraticCurveTo(cp.x, cp.y, b.x, b.y);
  }
  ctx.closePath();
  ctx.stroke();
  ctx.restore();
}
function centroid(pts){
  let sx=0, sy=0;
  for (const p of pts) { sx += p.x; sy += p.y; }
  return { x: sx/pts.length, y: sy/pts.length };
}

function drawCornerTicks(quad, color, len) {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 3;
  ctx.lineCap = 'round';
  for (let i = 0; i < 4; i++) {
    const a = quad[i];
    const b = quad[(i+1)%4];
    const c2 = quad[(i+3)%4];
    const dab = norm(sub(b,a)); const dac = norm(sub(c2,a));
    ctx.beginPath();
    ctx.moveTo(a.x, a.y); ctx.lineTo(a.x + dab.x*len, a.y + dab.y*len);
    ctx.moveTo(a.x, a.y); ctx.lineTo(a.x + dac.x*len, a.y + dac.y*len);
    ctx.stroke();
  }
  ctx.restore();
}
function sub(a,b){ return {x:a.x-b.x, y:a.y-b.y}; }
function norm(v){ const n=Math.hypot(v.x,v.y)||1; return {x:v.x/n, y:v.y/n}; }

function drawEdgeRing(W, H, color) {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 6;
  ctx.shadowColor = color;
  ctx.shadowBlur = 14;
  ctx.strokeRect(3, 3, W-6, H-6);
  ctx.restore();
}

// =============================================================================
// Render
// =============================================================================
function applyCassetteTransform(p, map) {
  // Compute screen-space corners of the cassette image quad and derive the
  // homography from natural-image coords (0..px, 0..px) to those 4 corners.
  const Wpx = SETTINGS.cassetteImgPx, Hpx = SETTINGS.cassetteImgPx;
  const screenCorners = p.cassetteLocal.map(pt => map(applyH(p.H_local_to_img, pt.x, pt.y)));
  const src = [
    { x: 0,   y: 0 },
    { x: Wpx, y: 0 },
    { x: Wpx, y: Hpx },
    { x: 0,   y: Hpx },
  ];
  const H = quadHomography(src, screenCorners);
  if (!H) return;
  cassetteImg.style.transform = matrix3dFromH(H);
  cassetteImg.classList.add('show');
}

function drawScene() {
  const W = window.innerWidth, H = window.innerHeight;
  ctx.clearRect(0,0,W,H);
  const map = frameToScreenScale();
  const cx = W/2, cy = H/2;

  let inBounds = false;
  let allowed = false;

  if (state.pose && map) {
    const p = state.pose;
    const activeScreen = p.activeImg.map(map);

    const aimImgPt = applyH(p.H_local_to_img, p.aimLocal.x, p.aimLocal.y);
    const aimScreen = map(aimImgPt);

    const fHalf = p.fieldHalf;
    const fieldLocal = [
      { x: p.aimLocal.x - fHalf, y: p.aimLocal.y - fHalf },
      { x: p.aimLocal.x + fHalf, y: p.aimLocal.y - fHalf },
      { x: p.aimLocal.x + fHalf, y: p.aimLocal.y + fHalf },
      { x: p.aimLocal.x - fHalf, y: p.aimLocal.y + fHalf },
    ];
    const fieldScreen = fieldLocal.map(pt => map(applyH(p.H_local_to_img, pt.x, pt.y)));
    inBounds = p.inBounds;

    // Cassette image: project onto the cassette plane
    applyCassetteTransform(p, map);

    // Light tint over the active area to read state at a glance
    pathQuad(activeScreen);
    ctx.fillStyle = inBounds ? COLORS.active : COLORS.outBoundsBg;
    ctx.fill();

    // Active-area corner ticks (green when capture allowed, red otherwise)
    drawCornerTicks(activeScreen, inBounds ? COLORS.green : '#ff4757', 22);

    // Collimation pillow (only when in bounds)
    if (inBounds && fHalf > 0) {
      drawCollimationPillow(fieldScreen, 0.025, 3, COLORS.green);
    }

    // Snap-and-complete center mark: small + ring at beam landing point;
    // large external cross at screen center fades in below perpThresholdDeg
    // and is fully gone by perpFadeMaxDeg.
    const targetAlpha = clamp01(
      1 - (p.tiltDeg - SETTINGS.perpThresholdDeg) /
          (SETTINGS.perpFadeMaxDeg - SETTINGS.perpThresholdDeg)
    );
    state.perpAlpha = lerp(state.perpAlpha, targetAlpha, 0.25);

    drawCenterPlus(aimScreen.x, aimScreen.y, inBounds ? COLORS.centerBlack : '#ff4757');
    drawExternalCross(cx, cy, 1.0, COLORS.centerBlack, state.perpAlpha);

    // HUD readouts
    const sidCm = p.sidCm;
    const ssdCm = sidCm - SETTINGS.patientThicknessCm;
    sidVal.textContent  = sidCm.toFixed(0);
    ssdVal.textContent  = ssdCm.toFixed(0);
    tiltVal.textContent = p.tiltDeg.toFixed(0);

    setPillState(pillSID, sidCm < SETTINGS.sidMin || sidCm > SETTINGS.sidMax ? 'bad' : 'good');
    setPillState(pillSSD, ssdCm < SETTINGS.ssdMin ? 'bad' : 'good');
    setPillState(pillTilt,
      p.tiltDeg <= SETTINGS.perpThresholdDeg ? 'good'
        : p.tiltDeg <= SETTINGS.perpFadeMaxDeg ? 'warn' : 'bad');

    let warning = null;
    if (!inBounds) warning = 'OUT OF BOUNDS - ALIGN X-RAY BEAM';
    else if (sidCm > SETTINGS.sidMax) warning = 'EMITTER TOO FAR FROM CASSETTE';
    else if (sidCm < SETTINGS.sidMin) warning = 'EMITTER TOO CLOSE TO CASSETTE';
    else if (ssdCm < SETTINGS.ssdMin) warning = 'TOO CLOSE TO ANATOMY';
    else if (state.meanLuma > 220) warning = 'HARSH LIGHTING - REPOSITION';
    if (warning) {
      interlock.textContent = warning;
      interlock.classList.remove('hidden');
    } else {
      interlock.classList.add('hidden');
    }

    allowed = inBounds &&
      sidCm >= SETTINGS.sidMin && sidCm <= SETTINGS.sidMax &&
      ssdCm >= SETTINGS.ssdMin;

    badgeDetect.classList.add('hidden');
  } else {
    cassetteImg.classList.remove('show');
    ssdVal.textContent  = '--';
    sidVal.textContent  = '--';
    tiltVal.textContent = '--';
    setPillState(pillSID, '');
    setPillState(pillSSD, '');
    setPillState(pillTilt, '');

    const lostFor = performance.now() - state.lastDetectT;
    if (lostFor > 1200) {
      interlock.textContent = state.meanLuma > 220
        ? 'HARSH LIGHTING - CASSETTE NOT VISIBLE'
        : (state.meanLuma < 25
            ? 'EMITTER FRONT FACE COVERED'
            : 'CASSETTE NOT DETECTED');
      interlock.classList.remove('hidden');
    } else {
      interlock.classList.add('hidden');
    }

    state.perpAlpha = 0;
    drawExternalCross(cx, cy, 1.0, 'rgba(255,255,255,0.55)', 1);
    badgeDetect.classList.remove('hidden');
  }

  // Grayscale-outside-active-area effect (still useful even with cassette overlay)
  video.classList.toggle('dim', !inBounds);

  // Edge ring as overall capture-allowed indicator
  const ringColor = allowed
    ? 'rgba(41, 211, 106, 0.95)'
    : (state.pose ? 'rgba(255, 71, 87, 0.7)' : 'rgba(255,179,2,0.6)');
  drawEdgeRing(W, H, ringColor);

  triggerBtn.classList.toggle('armed', allowed);
  if (allowed && !state.prevAllowed && navigator.vibrate) {
    try { navigator.vibrate(35); } catch(_) {}
  }
  state.prevAllowed = allowed;
}

function setPillState(el, cls) {
  el.classList.remove('good','warn','bad');
  if (cls) el.classList.add(cls);
}

function pathQuad(quad){
  ctx.beginPath();
  quad.forEach((p,i) => i===0 ? ctx.moveTo(p.x,p.y) : ctx.lineTo(p.x,p.y));
  ctx.closePath();
}

// =============================================================================
// Main loop
// =============================================================================
function loop() {
  if (!state.running) return;
  const qr = detectQR();
  const now = performance.now();
  if (qr) {
    state.qr = qr;
    state.pose = buildPose(qr);
    state.lastDetectT = now;
  } else if (now - state.lastDetectT > 400) {
    state.pose = null;
    state.qr = null;
    cornerFilters = makeCornerFilters();
  }
  drawScene();
  requestAnimationFrame(loop);
}

// =============================================================================
// Controls (auto-only collimator; no A/M toggle)
// =============================================================================
function bindControls() {
  document.querySelectorAll('[data-act]').forEach(b => {
    b.addEventListener('click', e => {
      const act = e.currentTarget.dataset.act;
      if (act === 'kv+')  state.kv  = stepArr(state.kvOpts,  state.kv,   1);
      if (act === 'kv-')  state.kv  = stepArr(state.kvOpts,  state.kv,  -1);
      if (act === 'mas+') state.mas = stepArr(state.masOpts, state.mas,  1);
      if (act === 'mas-') state.mas = stepArr(state.masOpts, state.mas, -1);
      if (act === 'mode') state.modeIdx = (state.modeIdx + 1) % state.modes.length;
      kvValEl.textContent  = state.kv;
      masValEl.textContent = state.mas;
      modeValEl.textContent = state.modes[state.modeIdx];
    });
  });
  triggerBtn.addEventListener('click', () => {
    if (!triggerBtn.classList.contains('armed')) {
      if (navigator.vibrate) try { navigator.vibrate([20,40,20]); } catch(_) {}
      return;
    }
    if (state.capturing) return;
    state.capturing = true;
    if (navigator.vibrate) try { navigator.vibrate(80); } catch(_) {}
    flash.classList.add('on');
    setTimeout(()=>{ flash.classList.remove('on'); state.capturing=false; }, 220);
  });
  let pressT;
  triggerBtn.addEventListener('touchstart', () => {
    pressT = setTimeout(()=>diag.classList.toggle('hidden'), 1500);
  });
  triggerBtn.addEventListener('touchend', () => clearTimeout(pressT));
}
function stepArr(arr, val, dir){
  const i = arr.indexOf(val);
  const j = Math.max(0, Math.min(arr.length-1, (i<0?0:i)+dir));
  return arr[j];
}

// =============================================================================
// Boot
// =============================================================================
startBtn.addEventListener('click', async () => {
  startScreen.classList.add('hidden');
  await startCamera();
});
bindControls();
