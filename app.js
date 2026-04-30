'use strict';

// =============================================================================
// MC2 Viewfinder Trainer v4
// - Square viewfinder profile (matches device LCD)
// - Detector-centric rectification: cassette plane fixed-size on screen,
//   tilt/distance corrected, phone roll preserved (option B)
// - Full uncropped cassette image rides on the rectified plane
// - Vertical SID gauge with floating marker
// =============================================================================

// ---- DOM ----
const startScreen = document.getElementById('start-screen');
const startBtn    = document.getElementById('start-btn');
const calibInput  = document.getElementById('calib-input');
const thickInput  = document.getElementById('thick-input');
// v8: overlay/canvas/cassette all live inside the camera-window (the central
// 56% region of the viewfinder square that mirrors Official Viewfinder.svg).
const viewfinder  = document.getElementById('camera-window');
const video       = document.getElementById('video');
const cassetteImg = document.getElementById('cassette-img');
const overlay     = document.getElementById('overlay');
const flash       = document.getElementById('flash');
const ctx         = overlay.getContext('2d');
const ssdVal      = document.getElementById('ssd-val');
const pillSSD     = document.getElementById('pill-ssd');
const sidReadout  = document.getElementById('sid-readout');
const interlock   = document.getElementById('interlock');
const badgeDetect = document.getElementById('badge-detect');
const kvValEl     = document.getElementById('kv-val');
const masValEl    = document.getElementById('mas-val');
const modeValEl   = document.getElementById('mode-val');
const ctrlMode    = document.getElementById('ctrl-mode');
const triggerBtn  = document.getElementById('trigger');

// ---- Settings ----
const SETTINGS = {
  qrPhysicalCm: 9.0,
  activeAreaCm: 21.35,
  // The "WEIGHT BEARING ZONE" box (the actual active area) spans ~40% of the
  // full uncropped cassette image's width, centered at ~55% from top
  // (handle offset). Measured from the rendered cassette image.
  cassetteImgActiveFrac: 0.40,
  cassetteImgActiveCy: 0.55,
  minFieldCmPerSid: 0.24,
  sidMin: 30, sidMax: 80,
  ssdMin: 30,
  patientThicknessCm: 5,
  focalRel: 0.85,
  oeMinCutoff: 1.2, oeBeta: 0.04, oeDerivCutoff: 1.0,
  procMaxDim: 720,
  cassetteImgPx: 720,
  // Active area takes this fraction of the viewfinder side.  With
  // cassetteImgActiveFrac = 0.40, the full cassette image extends to
  // (activeAreaScreenFrac / 0.40) of the viewfinder side - i.e. ~83% of
  // the viewfinder, which puts the cassette at roughly half the phone
  // screen height (matches the user-spec "half overall screen height").
  activeAreaScreenFrac: 0.33,
};

const COLORS = {
  collim:     '#077B51',
  green:      '#3DB06B',
  red:        '#ff4757',
  black:      '#000000',
};

// ---- State ----
const state = {
  running: false,
  kv: 60, kvOpts: [40,50,60,70,80],
  mas: 0.16, masOpts: [0.04,0.08,0.16,0.25,0.40],
  modeIdx: 1, modes: ['Single','DDR','Fluoro','Photo'],
  qr: null, pose: null, lastDetectT: 0,
  frameW: 0, frameH: 0,
  capturing: false, prevAllowed: false, meanLuma: 0,
};

// ---- One-Euro filter ----
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
const sidFilter  = new OneEuro(0.8, 0.02, 1.0);
const tiltFilter = new OneEuro(0.8, 0.02, 1.0);

// ---- Camera ----
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
    // Video stays full-cover inside the viewfinder; we don't rectify it
    // (matches the tablet prototype's MC2 Static behavior - cassette image
    // is the rectified element, the live video shows whatever the camera sees).

    const mm = parseFloat(calibInput.value);
    if (Number.isFinite(mm) && mm >= 10 && mm <= 200) SETTINGS.qrPhysicalCm = mm / 10;
    const th = parseFloat(thickInput.value);
    if (Number.isFinite(th) && th >= 0 && th <= 40) SETTINGS.patientThicknessCm = th;

    state.running = true;
    resizeCanvas();
    requestAnimationFrame(loop);
  } catch (err) {
    alert('Camera unavailable: ' + (err && err.message ? err.message : err));
    startScreen.classList.remove('hidden');
  }
}

function resizeCanvas() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const W = viewfinder.clientWidth, H = viewfinder.clientHeight;
  overlay.width  = Math.round(W * dpr);
  overlay.height = Math.round(H * dpr);
  overlay.style.width  = W + 'px';
  overlay.style.height = H + 'px';
  ctx.setTransform(dpr,0,0,dpr,0,0);
}
window.addEventListener('resize', resizeCanvas);
window.addEventListener('orientationchange', () => setTimeout(resizeCanvas, 200));
if (window.visualViewport) window.visualViewport.addEventListener('resize', resizeCanvas);

// ---- QR detection (One-Euro smoothed corners) ----
const work = document.createElement('canvas');
const wctx = work.getContext('2d', { willReadFrequently: true });

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
  return { corners: smoothed, raw: rawCorners, data: code.data, t, scaleVid: 1/scale };
}

// ---- Linear algebra: 8x8 solver, 3x3 homography, inverse, 3x3 multiply ----
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

// Tilt from homography decomposition (pinhole intrinsics)
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
// ============================================================================
function buildPose(qr) {
  const q = SETTINGS.qrPhysicalCm / 2;
  const qrLocal = [{ x:-q, y:-q }, { x: q, y:-q }, { x: q, y: q }, { x:-q, y: q }];
  const qrImg = qr.corners; // working-frame px

  const H_l_to_img = homography4(qrLocal, qrImg);
  if (!H_l_to_img) return null;
  const H_img_to_l = invert3(H_l_to_img);
  if (!H_img_to_l) return null;

  // Scale homography to native video px (matrix3d targets video pixel space).
  const s = qr.scaleVid; // working->video px scale factor
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

  // Aim point = where image center maps onto cassette plane
  const aimImg = { x: state.frameW/2, y: state.frameH/2 };
  const aimLocal = applyH(H_img_to_l, aimImg.x, aimImg.y);

  // Auto-collimator with fit-to-bounds (per IFU + user spec)
  const half = SETTINGS.activeAreaCm / 2;
  const minHalf = SETTINGS.minFieldCmPerSid * sidCm / 2;
  const maxFitHalfX = half - Math.abs(aimLocal.x);
  const maxFitHalfY = half - Math.abs(aimLocal.y);
  const maxFitHalf = Math.min(maxFitHalfX, maxFitHalfY);
  const willFit = maxFitHalf >= minHalf;
  const fieldHalf = willFit ? Math.max(minHalf, Math.min(half, maxFitHalf)) : 0;
  const inBounds = willFit;

  // Roll: angle of QR's top edge in image space (preserved on screen, option B)
  const dx = qrImg[1].x - qrImg[0].x;
  const dy = qrImg[1].y - qrImg[0].y;
  const roll = Math.atan2(dy, dx);

  return {
    H_l_to_img, H_img_to_l, H_l_to_videoPx, H_videoPx_to_l,
    sidCm, tiltDeg, roll,
    aimLocal,
    fieldHalf, half, inBounds,
  };
}

// ============================================================================
// Rectification: build local->screen similarity (rotation + scale + translate)
// to be the same transform for both video (via matrix3d) and overlay drawing.
// ============================================================================
function buildLocalToScreen(p) {
  const W = viewfinder.clientWidth, H = viewfinder.clientHeight;
  // Active area side projected on screen
  const aaSide = SETTINGS.activeAreaScreenFrac * Math.min(W, H);
  // cm -> px: aaSide / activeAreaCm
  const scale = aaSide / SETTINGS.activeAreaCm;
  const cx = W / 2, cy = H / 2;
  const cosR = Math.cos(p.roll), sinR = Math.sin(p.roll);
  // 3x3 H_local_to_screen (similarity)
  const H_l_to_s = [
    scale * cosR, -scale * sinR, cx,
    scale * sinR,  scale * cosR, cy,
    0,             0,            1,
  ];
  return { H_l_to_s, scale, cx, cy, W, H, aaSide };
}

// matrix3d builder for a 3x3 row-major homography that maps natural element px
// (0..elementWidth, 0..elementHeight) -> screen px when applied with
// transform-origin: 0 0.
function matrix3dFromH(H) {
  const a=H[0],b=H[1],c=H[2], d=H[3],e=H[4],f=H[5], g=H[6],h=H[7],i=H[8];
  return 'matrix3d(' + [a,d,0,g, b,e,0,h, 0,0,1,0, c,f,0,i].join(',') + ')';
}

// Apply CSS transform to the cassette image (similarity, 2D only).
function applyCassetteTransform(p, l2s) {
  // Cassette image's natural pixels (0..720, 0..720) cover cassetteImgSpanCm.
  // The active area is cassetteImgActiveFrac of the image, centered horizontally
  // but offset vertically by cassetteImgActiveCy.
  const Wpx = SETTINGS.cassetteImgPx;
  const imgSpanCm = SETTINGS.activeAreaCm / SETTINGS.cassetteImgActiveFrac;
  // Map image px -> cassette local cm
  // active-area center in image px: (Wpx/2, Wpx * cassetteImgActiveCy)
  const aaCxImg = Wpx / 2;
  const aaCyImg = Wpx * SETTINGS.cassetteImgActiveCy;
  // px -> cm scale: imgSpanCm / Wpx
  const pxToCm = imgSpanCm / Wpx;
  // T_imgPx_to_local: shift by -(aaCxImg, aaCyImg), then scale by pxToCm
  // T_imgPx_to_local = [pxToCm, 0, -aaCxImg*pxToCm; 0, pxToCm, -aaCyImg*pxToCm; 0,0,1]
  const T_i_to_l = [
    pxToCm, 0,      -aaCxImg * pxToCm,
    0,      pxToCm, -aaCyImg * pxToCm,
    0,      0,      1,
  ];
  // Compose: T_i_to_s = H_l_to_s * T_i_to_l
  const T_i_to_s = mul3x3(l2s.H_l_to_s, T_i_to_l);
  cassetteImg.style.transform = matrix3dFromH(T_i_to_s);
  cassetteImg.classList.add('show');
}

// Apply CSS transform to the video element (perspective rectification).
function applyVideoTransform(p, l2s) {
  // T_videoPx_to_screen = H_l_to_s * H_videoPx_to_l
  const T = mul3x3(l2s.H_l_to_s, p.H_videoPx_to_l);
  video.style.transform = matrix3dFromH(T);
}

function clearTransforms() {
  cassetteImg.classList.remove('show');
}

// ============================================================================
// Drawing primitives (in screen px - we map cassette local through l2s)
// ============================================================================
function pts2screen(localPts, l2s) {
  return localPts.map(p => applyH(l2s.H_l_to_s, p.x, p.y));
}
function pathQuad(quad){
  ctx.beginPath();
  quad.forEach((p,i) => i===0 ? ctx.moveTo(p.x,p.y) : ctx.lineTo(p.x,p.y));
  ctx.closePath();
}

function drawCornerTicks(quad, color, len) {
  ctx.save();
  ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.lineCap = 'butt';
  for (let i = 0; i < 4; i++) {
    const a = quad[i], b = quad[(i+1)%4], c2 = quad[(i+3)%4];
    const dab = norm(sub(b,a)), dac = norm(sub(c2,a));
    ctx.beginPath();
    ctx.moveTo(a.x, a.y); ctx.lineTo(a.x + dab.x*len, a.y + dab.y*len);
    ctx.moveTo(a.x, a.y); ctx.lineTo(a.x + dac.x*len, a.y + dac.y*len);
    ctx.stroke();
  }
  ctx.restore();
}
function sub(a,b){ return {x:a.x-b.x, y:a.y-b.y}; }
function norm(v){ const n=Math.hypot(v.x,v.y)||1; return {x:v.x/n, y:v.y/n}; }

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

// External cross: 4 white-filled, black-outlined pill arms with a notch at
// center.  Geometry from `External cross.svg` (arm width 6, length 38, gap
// 51 in 720-unit reference).  White fill + black stroke matches the actual
// SVG and stays visible against any camera background.
function drawExternalCross(cx, cy, vfSide, _unused) {
  ctx.save();
  function pill(x0, y0, w, h) {
    const r = Math.min(w, h) / 2;
    ctx.beginPath();
    ctx.moveTo(x0 + r, y0); ctx.lineTo(x0 + w - r, y0);
    ctx.arc(x0 + w - r, y0 + r, r, -Math.PI/2, Math.PI/2);
    ctx.lineTo(x0 + r, y0 + h);
    ctx.arc(x0 + r, y0 + r, r, Math.PI/2, -Math.PI/2);
    ctx.closePath();
    ctx.fillStyle = '#fff';
    ctx.fill();
    ctx.strokeStyle = '#000';
    ctx.lineWidth = Math.max(1, vfSide * (1.5 / 720));
    ctx.stroke();
  }
  // Bumped slightly from SVG ref (6->7 width, 38->44 length) so the crosshair
  // reads at typical phone-screen viewfinder sizes (vfSide ~ 360-420 px).
  const gap  = vfSide * (51 / 720);
  const armW = Math.max(4, vfSide * (7 / 720));
  const armL = Math.max(20, vfSide * (44 / 720));
  pill(cx - armW/2, cy - gap - armL, armW, armL);
  pill(cx - armW/2, cy + gap, armW, armL);
  pill(cx - gap - armL, cy - armW/2, armL, armW);
  pill(cx + gap, cy - armW/2, armL, armW);
  ctx.restore();
}

// Small "+" at beam landing point. White fill + black stroke matching
// Official Viewfinder.svg's inner plus (6 wide x 30 long in 720-unit ref).
function drawCenterPlus(cx, cy, vfSide, _unused) {
  ctx.save();
  function pill(x0, y0, w, h) {
    const r = Math.min(w, h) / 2;
    ctx.beginPath();
    ctx.moveTo(x0 + r, y0); ctx.lineTo(x0 + w - r, y0);
    ctx.arc(x0 + w - r, y0 + r, r, -Math.PI/2, Math.PI/2);
    ctx.lineTo(x0 + r, y0 + h);
    ctx.arc(x0 + r, y0 + r, r, Math.PI/2, -Math.PI/2);
    ctx.closePath();
    ctx.fillStyle = '#fff';
    ctx.fill();
    ctx.strokeStyle = '#000';
    ctx.lineWidth = Math.max(1, vfSide * (1.5 / 720));
    ctx.stroke();
  }
  const armW = Math.max(4, vfSide * (7 / 720));
  const armL = Math.max(16, vfSide * (34 / 720));
  pill(cx - armW/2, cy - armL/2, armW, armL);
  pill(cx - armL/2, cy - armW/2, armL, armW);
  ctx.restore();
}

function drawEdgeRing(W, H, color) {
  ctx.save();
  ctx.strokeStyle = color; ctx.lineWidth = 4;
  ctx.shadowColor = color; ctx.shadowBlur = 10;
  ctx.strokeRect(2, 2, W-4, H-4);
  ctx.restore();
}

// SID gauge: position the floating readout pill on the vertical bar.
// Bar runs from top 21.53% to top 84.03% of the LCD (62.5% tall).
// Map SID 30..80 cm to that range; clamp out-of-range to the bar ends.
function updateSidGauge(sidCm, ok) {
  if (!Number.isFinite(sidCm)) {
    sidReadout.style.top = '47.83%';
    sidReadout.textContent = '--';
    sidReadout.classList.remove('bad');
    return;
  }
  const t = clamp01((sidCm - 30) / (80 - 30)); // 0 at 30, 1 at 80
  // Bar active range is 31.94%..73.61% (40% tall).  Map SID to that.
  const topPct = 31.94 + t * (73.61 - 31.94);
  // Center the readout pill (4.86% tall) on that y position.
  sidReadout.style.top = (topPct - 4.86 / 2) + '%';
  sidReadout.textContent = sidCm.toFixed(0);
  sidReadout.classList.toggle('bad', !ok);
}

// ============================================================================
// Main render
// ============================================================================
function drawScene() {
  const W = viewfinder.clientWidth, H = viewfinder.clientHeight;
  ctx.clearRect(0,0,W,H);
  let allowed = false;

  if (state.pose) {
    const p = state.pose;
    const l2s = buildLocalToScreen(p);

    // Cassette image rides on the rectified plane; video stays unrectified
    // (matches tablet prototype "MC2 Static" behavior).
    applyCassetteTransform(p, l2s);

    // Active area quad in cassette local cm
    const half = p.half;
    const activeLocal = [{ x:-half, y:-half }, { x: half, y:-half }, { x: half, y: half }, { x:-half, y: half }];
    const activeScreen = pts2screen(activeLocal, l2s);

    // Active-area corner ticks - black, matches the real device
    drawCornerTicks(activeScreen, p.inBounds ? '#000' : COLORS.red, 18);

    // Collimation pillow (only in bounds)
    if (p.inBounds && p.fieldHalf > 0) {
      const fh = p.fieldHalf, ax = p.aimLocal.x, ay = p.aimLocal.y;
      const fLocal = [{ x: ax-fh, y: ay-fh }, { x: ax+fh, y: ay-fh }, { x: ax+fh, y: ay+fh }, { x: ax-fh, y: ay+fh }];
      const fScreen = pts2screen(fLocal, l2s);
      drawCollimationPillow(fScreen, 0.025, 3, COLORS.collim);
    }

    // External cross at viewfinder center (camera optical axis)
    drawExternalCross(W/2, H/2, Math.min(W, H), COLORS.black);
    // Small + at aim point on cassette (after rectification, this lies in
    // cassette local coords).  When perpendicular, aim point projects to
    // viewfinder center, completing the cross visually.
    const aimScreen = applyH(l2s.H_l_to_s, p.aimLocal.x, p.aimLocal.y);
    drawCenterPlus(aimScreen.x, aimScreen.y, Math.min(W, H), p.inBounds ? COLORS.black : COLORS.red);

    // HUD readouts
    const ssdCm = p.sidCm - SETTINGS.patientThicknessCm;
    ssdVal.textContent = ssdCm.toFixed(0);
    const sidOk = p.sidCm >= SETTINGS.sidMin && p.sidCm <= SETTINGS.sidMax;
    const ssdOk = ssdCm >= SETTINGS.ssdMin;
    pillSSD.classList.toggle('good', ssdOk);
    pillSSD.classList.toggle('bad', !ssdOk);
    updateSidGauge(p.sidCm, sidOk);

    // Interlock priority
    let warning = null;
    if (!p.inBounds) warning = 'OUT OF BOUNDS - ALIGN BEAM';
    else if (p.sidCm > SETTINGS.sidMax) warning = 'TOO FAR FROM CASSETTE';
    else if (p.sidCm < SETTINGS.sidMin) warning = 'TOO CLOSE TO CASSETTE';
    else if (ssdCm < SETTINGS.ssdMin) warning = 'TOO CLOSE TO ANATOMY';
    else if (state.meanLuma > 220) warning = 'HARSH LIGHTING';
    if (warning) { interlock.textContent = warning; interlock.classList.remove('hidden'); }
    else { interlock.classList.add('hidden'); }

    allowed = p.inBounds && sidOk && ssdOk;
    badgeDetect.classList.add('hidden');
  } else {
    clearTransforms();
    ssdVal.textContent = '--';
    pillSSD.classList.remove('good','bad');
    updateSidGauge(NaN, false);
    drawExternalCross(W/2, H/2, Math.min(W, H), 'rgba(255,255,255,0.6)');
    const lostFor = performance.now() - state.lastDetectT;
    if (lostFor > 1200) {
      interlock.textContent = state.meanLuma > 220 ? 'HARSH LIGHTING - CASSETTE NOT VISIBLE'
        : state.meanLuma < 25 ? 'EMITTER FRONT FACE COVERED'
        : 'CASSETTE NOT DETECTED';
      interlock.classList.remove('hidden');
    } else { interlock.classList.add('hidden'); }
    badgeDetect.classList.remove('hidden');
  }

  // Edge ring color
  const ringColor = allowed ? 'rgba(41,211,106,0.95)'
    : (state.pose ? 'rgba(255,71,87,0.7)' : 'rgba(255,179,2,0.6)');
  drawEdgeRing(W, H, ringColor);

  triggerBtn.classList.toggle('armed', allowed);
  if (allowed && !state.prevAllowed && navigator.vibrate) {
    try { navigator.vibrate(35); } catch(_) {}
  }
  state.prevAllowed = allowed;
}

// ============================================================================
// Main loop
// ============================================================================
function loop() {
  if (!state.running) return;
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
  requestAnimationFrame(loop);
}

// ============================================================================
// Controls (auto-only collimator; no A/M toggle)
// ============================================================================
function bindControls() {
  document.querySelectorAll('[data-act]').forEach(b => {
    b.addEventListener('click', e => {
      e.stopPropagation();
      const act = e.currentTarget.dataset.act;
      if (act === 'kv+')  state.kv  = stepArr(state.kvOpts,  state.kv,   1);
      if (act === 'kv-')  state.kv  = stepArr(state.kvOpts,  state.kv,  -1);
      if (act === 'mas+') state.mas = stepArr(state.masOpts, state.mas,  1);
      if (act === 'mas-') state.mas = stepArr(state.masOpts, state.mas, -1);
      kvValEl.textContent  = state.kv;
      masValEl.textContent = state.mas;
    });
  });
  // Tap the orange mode shield to cycle modes.
  if (ctrlMode) {
    ctrlMode.style.pointerEvents = 'auto';
    ctrlMode.addEventListener('click', () => {
      state.modeIdx = (state.modeIdx + 1) % state.modes.length;
      modeValEl.textContent = state.modes[state.modeIdx];
    });
  }
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
}
function stepArr(arr, val, dir){
  const i = arr.indexOf(val);
  const j = Math.max(0, Math.min(arr.length-1, (i<0?0:i)+dir));
  return arr[j];
}

// ============================================================================
// Boot
// ============================================================================
startBtn.addEventListener('click', async () => {
  startScreen.classList.add('hidden');
  await startCamera();
});
bindControls();
