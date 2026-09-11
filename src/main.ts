import './machine.css';
import './demo.css';
import { initIntro } from './ui/intro';
import { CVEngine, THUMB_W, THUMB_H, type FrameInfo, type MaskThumb } from './cv/engine';
import { ema, poseFeatures, compressionProgress, scoreAvailableParts, maskIoU, type Pt, type Coverage } from './cv/metrics';
import { METHODS, sanitizeName, type MethodId } from './coach/methods';
import { pickCue, milestoneLog } from './coach/rules';
import { logLine, blip, describeError, cameraHint } from './ui/terminal';
import { downloadCert, snapshotVideo } from './zip/cert';
import { clearRecords, loadRecords, saveRecord, type GameMode, type GameRecord } from './game/records';
import { makeResultCard, shareResult } from './game/share';

// surface boot/runtime errors in-page instead of silent black screen
window.addEventListener('error', (e) => {
  try { warnEl.textContent = '⚠ ' + (e.message || 'script error'); } catch { /* noop */ }
});
window.addEventListener('unhandledrejection', (e: PromiseRejectionEvent) => {
  try { warnEl.textContent = '⚠ ' + ((e.reason as any)?.message || e.reason || 'load error'); } catch { /* noop */ }
});

// ---------- dom ----------
const $ = (id: string) => document.getElementById(id)!;
const video = $('video') as HTMLVideoElement;
const overlay = $('overlay') as HTMLCanvasElement;
const octx = overlay.getContext('2d')!;
const logEl = $('log'), cueEl = $('cue'), warnEl = $('warn');
const bigPct = $('bigPct'), savedPct = $('savedPct'), bar = $('bar');
const scoreDetails = $('scoreDetails');
const btnCam = $('btnCam') as HTMLButtonElement, btnCal = $('btnCal') as HTMLButtonElement;
const btnGo = $('btnGo') as HTMLButtonElement, btnReset = $('btnReset') as HTMLButtonElement;
const nameInput = $('name') as HTMLInputElement, zipPreview = $('zipPreview');
const methodDesc = $('methodDesc'), engineStatus = $('engineStatus');
const camLabel = $('camLabel'), modeLabel = $('modeLabel'), fpsEl = $('fps');
const extractPanel = $('extractPanel'), partsEl = $('parts');
const btnExtract = $('btnExtract') as HTMLButtonElement, btnDl = $('btnDl') as HTMLButtonElement;
const ghostPhoto = $('ghostPhoto') as HTMLImageElement;
const btnManualDone = $('btnManualDone') as HTMLButtonElement;
const resultPanel = $('resultPanel');
const originalPhoto = $('originalPhoto') as HTMLImageElement;
const compressedPhoto = $('compressedPhoto') as HTMLImageElement;
const compressedCaption = $('compressedCaption');
const cameraStage = $('cameraStage'), timerEl = $('timer');
const btnFlip = $('btnFlip') as HTMLButtonElement, btnStop = $('btnStop') as HTMLButtonElement;
const btnShare = $('btnShare') as HTMLButtonElement, includePhotos = $('includePhotos') as HTMLInputElement;
const resultSummary = $('resultSummary'), recordsList = $('recordsList'), btnClearRecords = $('btnClearRecords') as HTMLButtonElement;
const methodsEl = $('methods');
const resultPhotos = $('resultPhotos'), terminalPanel = document.querySelector<HTMLDetailsElement>('.terminal-panel')!;

type State = 'idle' | 'calibrating' | 'ready' | 'compressing' | 'zipped' | 'extracting' | 'done';
let state: State = 'idle';
let method: MethodId = 'balanced';
let gameMode: GameMode = 'classic';
let facing: 'user' | 'environment' = 'user';
let engine: CVEngine | null = null;
let camOn = false, modelsReady = false;
let cameraBusy = false;

// tracker
let emaFrac = NaN;
let baselineFrac = 0;
let baselineScale = 0;
let baselinePose: Pt[] | null = null;
let baselineFeat: ReturnType<typeof poseFeatures> | null = null;
let baselineCoverage: Coverage = 'none';
let baselineThumb: MaskThumb | null = null;
let baselinePhoto: string | null = null;
let extractMode: 'pose' | 'silhouette' | 'manual' | 'none' = 'none';
let cueCycle = 0;
let lastLandmarks: Pt[] | null = null;
let lastFrame: FrameInfo | null = null;

// calibrate accumulation
let calSamples: number[] = [];
let calPoses: Pt[][] = [];
let calPoseScore: number[] = [];
let calScales: number[] = [];
let calThumbs: Uint8Array[] = [];
let calTimer: any = null;

// compress run
let timeLeft = 0, runElapsedMs = 0, lastValidFrameAt = 0;
let bestRatio = 1, holdStart: number | null = null;
let lastCueT = 0, lastMilestone = 0;
let noPersonSince: number | null = null;
let startAfterCalibration = false;
let pbCandidate = 1, pbCandidateStart: number | null = null, pbQualified = 1;
let pbPhoto: string | null = null;

// extract run
let extracting = false;
let partHoldStart: number | null = null;
let finalRatio = 1;
let currentRecord: GameRecord | null = null;

// ---------- helpers ----------
function setState(s: State) {
  state = s;
  document.body.dataset.gameState = s;
  document.getElementById('cameraStage')!.dataset.live = String(camOn);
  (document.getElementById('replayIntro') as HTMLButtonElement).disabled = camOn;
  modeLabel.textContent = 'MODE: ' + s.toUpperCase();
  btnCal.disabled = !(camOn && modelsReady && (s === 'idle' || s === 'ready'));
  btnCal.classList.toggle('opacity-40', btnCal.disabled);
  btnGo.disabled = !(camOn && modelsReady && (s === 'ready' || s === 'idle'));
  btnGo.classList.toggle('opacity-40', btnGo.disabled);
  const roundActive = s === 'calibrating' || s === 'compressing' || s === 'extracting';
  btnFlip.disabled = roundActive;
  document.querySelectorAll<HTMLButtonElement>('.mbtn, .gmode').forEach(button => button.disabled = roundActive);
  nameInput.disabled = roundActive;
}

function fitCanvas() {
  const r = overlay.parentElement!.getBoundingClientRect();
  overlay.width = Math.max(1, Math.floor(r.width));
  overlay.height = Math.max(1, Math.floor(r.height));
}
window.addEventListener('resize', fitCanvas);

const SKELETON: [number, number][] = [
  [11, 12], [11, 13], [13, 15], [12, 14], [14, 16],
  [11, 23], [12, 24], [23, 24],
  [23, 25], [25, 27], [24, 26], [26, 28],
];

function drawSkeleton(lm: Pt[], color: string, width = 3, alpha = 1) {
  octx.save();
  octx.globalAlpha = alpha;
  octx.strokeStyle = color; octx.lineWidth = width;
  octx.lineCap = 'round';
  const scale = Math.min(overlay.width / (video.videoWidth || overlay.width), overlay.height / (video.videoHeight || overlay.height));
  const W = (video.videoWidth || overlay.width) * scale, H = (video.videoHeight || overlay.height) * scale;
  const offsetX = (overlay.width - W) / 2, offsetY = (overlay.height - H) / 2;
  octx.translate(offsetX, offsetY);
  octx.beginPath();
  for (const [a, b] of SKELETON) {
    if (!lm[a] || !lm[b]) continue;
    octx.moveTo(lm[a].x * W, lm[a].y * H);
    octx.lineTo(lm[b].x * W, lm[b].y * H);
  }
  octx.stroke();
  octx.fillStyle = color;
  for (const i of [0, 11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28]) {
    if (!lm[i]) continue;
    octx.beginPath();
    octx.arc(lm[i].x * W, lm[i].y * H, width + 1, 0, Math.PI * 2);
    octx.fill();
  }
  octx.restore();
}

function render() {
  octx.clearRect(0, 0, overlay.width, overlay.height);
  if (extracting && extractMode === 'pose' && baselinePose) drawSkeleton(baselinePose, '#F2C94C', 5, 0.35);
  if (lastLandmarks) drawSkeleton(lastLandmarks, extracting ? '#ffffff' : '#F2C94C', 3, 1);
}

// ---------- frame handling ----------
function onFrame(f: FrameInfo) {
  lastFrame = f;
  lastLandmarks = f.landmarks;
  fpsEl.textContent = `${f.fps} fps${f.fromMask ? '' : ' · bbox'}`;
  render();

  if (!f.hasPerson) {
    if (noPersonSince === null) noPersonSince = performance.now();
    if (state === 'compressing' || state === 'extracting' || state === 'calibrating') {
      warnEl.textContent = 'No subject found. Show your shoulders and arms.';
      scoreDetails.textContent = 'TRACKING: paused - subject not found';
      holdStart = null;
      pbCandidateStart = null;
      lastValidFrameAt = 0;
      timerEl.textContent = 'PAUSED';
    }
    return;
  }
  noPersonSince = null;

  const feat = poseFeatures(f.landmarks);

  if (state === 'calibrating') {
    if (!feat.ok || feat.coverage === 'head' || f.personFrac <= 0.015) {
      scoreDetails.textContent = 'CALIBRATING: show shoulders and arms clearly';
      return;
    }
    calSamples.push(f.personFrac);
    if (f.thumb) calThumbs.push(f.thumb.data);
    if (f.landmarks) {
      calPoses.push(f.landmarks);
      calPoseScore.push(feat.validJoints);
      if (feat.ok && feat.scaleRef > 0) calScales.push(feat.scaleRef);
    }
    scoreDetails.textContent = `CALIBRATING: stable tracking ${Math.min(100, Math.round(calSamples.length / 15 * 100))}%`;
    return;
  }
  if (!baselineFrac) return;

  const scaleRatio = baselineScale > 0 ? feat.scaleRef / baselineScale : 1;
  const areaRatio = f.personFrac / baselineFrac;
  if (!feat.ok || feat.coverage === 'head' || scaleRatio < 0.78 || scaleRatio > 1.28 || areaRatio < 0.2) {
    if (state === 'compressing') {
      warnEl.textContent = scaleRatio < 0.78 || areaRatio < 0.2
        ? '⚠ SUBJECT TOO FAR AWAY - return to the marker (paused)'
        : scaleRatio > 1.28
          ? '⚠ TOO CLOSE - step back to the marker (paused)'
          : '⚠ TRACKING UNSTABLE - show shoulders and arms (paused)';
      scoreDetails.textContent = 'TRACKING: paused - score held';
      holdStart = null;
      pbCandidateStart = null;
      lastValidFrameAt = 0;
      timerEl.textContent = 'PAUSED';
    }
    return;
  }

  const progress = baselineFeat ? compressionProgress(baselineFeat, feat, areaRatio) : null;
  if (!progress) return;
  const smoothProgress = ema(emaFrac, progress.combined, 0.18);
  emaFrac = smoothProgress;
  const clamped = Math.max(0.3, Math.min(1, 1 - smoothProgress * 0.7));
  const saved = Math.max(0, 1 - clamped);

  bigPct.textContent = `${Math.round(clamped * 100)}%`;
  savedPct.textContent = `saved ${Math.round(saved * 100)}%`;
  bar.style.width = `${Math.round(saved * 100)}%`;
  scoreDetails.textContent = `TRACKING: locked · fold ${Math.round(progress.folding * 100)}% · silhouette ${Math.round(progress.silhouette * 100)}%`;
  warnEl.textContent = '';

  if (state === 'compressing') {
    const now = performance.now();
    if (lastValidFrameAt) runElapsedMs += Math.min(250, now - lastValidFrameAt);
    lastValidFrameAt = now;
    const limit = gameMode === 'personal-best' ? 45 : METHODS[method].timeSec;
    timeLeft = Math.max(0, limit - runElapsedMs / 1000);
    timerEl.textContent = `${Math.ceil(timeLeft)}s`;
    if (gameMode === 'personal-best') personalBestTick(clamped);
    else compressTick(clamped, saved);
    if (timeLeft <= 0 && state === 'compressing') {
      if (gameMode === 'personal-best') finishCompress(pbQualified);
      else {
        logLine(logEl, `TIMEOUT - best was ${Math.round(bestRatio * 100)}%. press START COMPRESSION to retry.`, 'text-red-400');
        setState('ready');
        cueEl.textContent = 'TIMEOUT - retry, you can beat it.';
        timerEl.textContent = 'READY';
      }
    }
  }
  if (state === 'extracting' && extracting) extractTick();
}

function personalBestTick(ratio: number) {
  const now = performance.now();
  bestRatio = Math.min(bestRatio, ratio);
  if (ratio < pbCandidate - 0.02) {
    pbCandidate = ratio;
    pbCandidateStart = now;
  } else if (pbCandidateStart && ratio <= pbCandidate + 0.03) {
    const held = (now - pbCandidateStart) / 1000;
    cueEl.textContent = held < 2 ? `HOLD SCORE - ${(2 - held).toFixed(1)}s` : 'SCORE LOCKED - go smaller';
    if (held >= 2 && pbCandidate < pbQualified) {
      pbQualified = pbCandidate;
      pbPhoto = snapshotVideo(video, facing === 'user');
      pbCandidateStart = null;
      logLine(logEl, `score locked: ${Math.round(pbQualified * 100)}%`, 'text-amber-300');
      blip(820);
    }
  } else if (ratio > pbCandidate + 0.03) {
    pbCandidate = ratio;
    pbCandidateStart = now;
  }
}

function compressTick(ratio: number, saved: number) {
  const spec = METHODS[method];
  if (ratio < bestRatio) bestRatio = ratio;
  const now = performance.now();

  // coaching cue every 2.5s
  if (now - lastCueT > 2500 && lastFrame?.landmarks) {
    lastCueT = now;
    const feat = poseFeatures(lastFrame.landmarks);
    const { cue, log } = pickCue(feat, baselineFeat, spec, ratio, cueCycle++);
    cueEl.textContent = cue;
    logLine(logEl, log, 'text-green-300');
  }
  // milestones
  const savedPctN = Math.round(saved * 100);
  if (savedPctN >= lastMilestone + 10) {
    lastMilestone = savedPctN - (savedPctN % 10);
    const m = milestoneLog(savedPctN);
    if (m) logLine(logEl, m, 'text-amber-300');
    blip(520 + savedPctN * 6);
  }
  // win / hold
  if (ratio <= spec.targetSize) {
    if (holdStart === null) {
      holdStart = now;
      logLine(logEl, `TARGET ${Math.round(spec.targetSize * 100)}% REACHED - HOLD IT...`, 'text-amber-300');
      blip(880);
    }
    const held = (now - holdStart) / 1000;
    cueEl.textContent = `HOLD IT - ${(spec.holdSec - held).toFixed(1)}s  (${Math.round(ratio * 100)}%)`;
    if (held >= spec.holdSec) finishCompress(ratio);
  } else holdStart = null;
}

function extractTick() {
  if (extractMode === 'silhouette') {
    const t = lastFrame?.thumb;
    if (!baselineThumb || !t) return;
    const iou = maskIoU(baselineThumb.data, t.data);
    partsEl.innerHTML = '';
    const d = document.createElement('div');
    const ok = iou > 0.85;
    d.className = ok ? 'text-green-400' : 'text-amber-300';
    d.textContent = `${ok ? '✓' : '…'} Restoring silhouette - ${Math.round(iou * 100)}%`;
    partsEl.appendChild(d);
    if (ok) {
      if (partHoldStart === null) {
        partHoldStart = performance.now();
        logLine(logEl, 'silhouette aligned - HOLD...', 'text-amber-300');
      }
      const held = (performance.now() - partHoldStart) / 1000;
      cueEl.textContent = `HOLD RESTORE - ${(2 - held).toFixed(1)}s`;
      if (held >= 2) finishExtract();
    } else partHoldStart = null;
    return;
  }
  if (extractMode !== 'pose' || !baselinePose || !lastLandmarks) return;
  const scores = scoreAvailableParts(baselinePose, lastLandmarks);
  const keys = Object.keys(scores);
  const labels: Record<string, string> = { leftArm: 'left arm', rightArm: 'right arm', torso: 'torso+head', legs: 'legs' };
  partsEl.innerHTML = '';
  if (!keys.length) {
    const d = document.createElement('div');
    d.className = 'text-amber-300';
    d.textContent = '… waiting for visible joints...';
    partsEl.appendChild(d);
    partHoldStart = null;
    return;
  }
  let allOk = true;
  for (const [k, v] of Object.entries(scores)) {
    const ok = v > 0.85;
    if (!ok) allOk = false;
    const d = document.createElement('div');
    d.className = ok ? 'text-green-400' : 'text-amber-300';
    d.textContent = `${ok ? '✓' : '…'} Restoring ${labels[k]} - ${Math.round(v * 100)}%`;
    partsEl.appendChild(d);
  }
  if (allOk) {
    if (partHoldStart === null) {
      partHoldStart = performance.now();
      logLine(logEl, 'all parts aligned - HOLD...', 'text-amber-300');
    }
    const held = (performance.now() - partHoldStart) / 1000;
    cueEl.textContent = `HOLD RESTORE - ${(2 - held).toFixed(1)}s`;
    if (held >= 2) finishExtract();
  } else partHoldStart = null;
}

// ---------- flows ----------
async function ensureEngine() {
  if (!engine) {
    engine = new CVEngine(video);
    engine.onStatus = (s) => { engineStatus.textContent = s; };
    engine.onFrame = onFrame;
    engine.onCameraEnded = () => {
      camOn = false; lastValidFrameAt = 0;
      baselineFrac = 0; baselinePose = null; baselineFeat = null; baselinePhoto = null;
      setState('idle');
      timerEl.textContent = 'CAMERA LOST';
      warnEl.textContent = '⚠ CAMERA STOPPED - reconnect and calibrate again';
      btnCam.disabled = false; btnCam.textContent = '▶ RECONNECT CAMERA';
      btnFlip.classList.add('hidden'); btnStop.classList.add('hidden');
    };
  }
  if (modelsReady) return;
  try {
    await engine.init();
  } catch (e) {
    modelsReady = false;
    throw e;
  }
  modelsReady = true;
  setState(state);
}

async function startCamera() {
  if (cameraBusy) return;
  cameraBusy = true;
  btnCam.disabled = true;
  btnCam.textContent = '◌ WORKING...';
  logLine(logEl, '> physical_zip --scan HUMAN', 'text-zinc-400');
  // Start the camera and model loading together so the user gets an immediate preview.
  logLine(logEl, 'opening camera while tracking loads...', 'text-zinc-500');
  const modelPromise = ensureEngine();
  try {
    facing = await engine!.startCamera(facing);
  } catch (e) {
    logLine(logEl, `camera failed: ${describeError(e)}${cameraHint(e)}`, 'text-red-400');
    btnCam.disabled = false;
    btnCam.textContent = '▶ RETRY CAMERA';
    cameraBusy = false;
    return;
  }
  camOn = true;
  cameraStage.dataset.live = 'true';
  (document.getElementById('replayIntro') as HTMLButtonElement).disabled = true;
  cameraStage.dataset.facing = facing;
  if (video.videoWidth && video.videoHeight) cameraStage.style.aspectRatio = `${video.videoWidth} / ${video.videoHeight}`;
  fitCanvas();
  requestAnimationFrame(fitCanvas);
  camLabel.textContent = '/dev/human0 - live';
  btnCam.textContent = '● CAMERA LIVE';
  btnFlip.classList.remove('hidden'); btnStop.classList.remove('hidden');
  logLine(logEl, 'camera live. preparing tracking...', 'text-green-300');
  try {
    await modelPromise;
    logLine(logEl, 'tracking ready.', 'text-green-300');
  } catch (e) {
    logLine(logEl, `model load failed: ${describeError(e)} - check connection / allow cdn.jsdelivr.net + storage.googleapis.com (adblock?), then retry.`, 'text-red-400');
    btnCam.textContent = '↻ RETRY TRACKING';
    btnCam.disabled = false;
    cameraBusy = false;
    return;
  }
  engine!.start();
  logLine(logEl, 'camera live. show your shoulders and arms; full body also works.', 'text-green-300');
  logLine(logEl, 'next: CALIBRATE 100% (hold still at this distance)', 'text-zinc-400');
  setState('ready');
  cameraBusy = false;
}
btnCam.onclick = startCamera;

btnFlip.onclick = async () => {
  if (cameraBusy || state === 'calibrating' || state === 'compressing' || state === 'extracting') return;
  facing = facing === 'user' ? 'environment' : 'user';
  baselineFrac = 0; baselinePose = null; baselineFeat = null; baselinePhoto = null;
  logLine(logEl, `switching to ${facing === 'user' ? 'front' : 'rear'} camera...`, 'text-zinc-400');
  await startCamera();
  cueEl.textContent = 'CAMERA SWITCHED - recalibrate before playing.';
};

btnStop.onclick = () => {
  engine?.stop(); engine?.stopCamera();
  camOn = false; cameraBusy = false;
  baselineFrac = 0; baselinePose = null; baselineFeat = null; baselinePhoto = null;
  btnCam.disabled = false; btnCam.textContent = '▶ START CAMERA';
  btnFlip.classList.add('hidden'); btnStop.classList.add('hidden');
  camLabel.textContent = '/dev/human0 - no signal';
  timerEl.textContent = 'READY'; setState('idle');
};

btnCal.onclick = () => {
  if (!camOn || !modelsReady || state === 'calibrating') return;
  setState('calibrating');
  calSamples = []; calPoses = []; calPoseScore = []; calScales = []; calThumbs = [];
  emaFrac = NaN;
  logLine(logEl, 'ANALYZING SUBJECT... hold still with shoulders and arms visible. 5s...', 'text-amber-300');
  cueEl.textContent = 'SHOW YOURSELF - HOLD STILL - 5…';
  let n = 5;
  timerEl.textContent = '5';
  calTimer = setInterval(() => {
    n--;
    if (n > 0) { cueEl.textContent = `HOLD STILL - ${n}…`; timerEl.textContent = String(n); return; }
    clearInterval(calTimer);
    if (calSamples.length < 15) {
      startAfterCalibration = false;
      logLine(logEl, 'calibration failed - no subject. try better light / move into frame.', 'text-red-400');
      setState('ready');
      timerEl.textContent = 'READY';
      return;
    }
    calSamples.sort((a, b) => a - b);
    baselineFrac = calSamples.slice(2, -2).reduce((a, b) => a + b, 0) / Math.max(1, calSamples.length - 4);
    calScales.sort((a, b) => a - b);
    baselineScale = calScales.length ? calScales[Math.floor(calScales.length / 2)] : 0;
    // best pose = most visible joints (works with partial bodies)
    let bestIdx = -1, bestScore = -1;
    calPoseScore.forEach((s, i) => { if (s > bestScore) { bestScore = s; bestIdx = i; } });
    baselinePose = bestIdx >= 0 ? calPoses[bestIdx] : null;
    baselineFeat = baselinePose ? poseFeatures(baselinePose) : null;
    // average silhouette thumbnail for silhouette-mode extract
    baselineThumb = null;
    if (calThumbs.length) {
      const len = calThumbs[0].length;
      const acc = new Float32Array(len);
      for (const t of calThumbs) for (let i = 0; i < len; i++) acc[i] += t[i];
      const data = new Uint8Array(len);
      for (let i = 0; i < len; i++) data[i] = acc[i] / calThumbs.length >= 0.5 ? 1 : 0;
      baselineThumb = { w: THUMB_W, h: THUMB_H, data };
    }
    baselinePhoto = snapshotVideo(video, facing === 'user');
    baselineCoverage = baselineFeat && baselineFeat.ok ? baselineFeat.coverage : 'upper';
    const covLabel = baselineCoverage === 'full' ? 'full body'
      : baselineCoverage === 'upper' ? 'upper body'
      : baselineCoverage === 'head' ? 'head/shoulders' : 'subject';
    emaFrac = 0;
    bestRatio = 1;
    bigPct.textContent = '100%'; savedPct.textContent = 'saved 0%'; bar.style.width = '0%';
    logLine(logEl, `Original subject = 100% (${covLabel}, ${lastFrame?.fromMask ? 'mask' : 'bbox'})`, 'text-green-300');
    cueEl.textContent = 'CALIBRATED - press START COMPRESSION and shrink.';
    setState('ready');
    timerEl.textContent = 'READY';
    blip(740);
    if (startAfterCalibration) {
      startAfterCalibration = false;
      startCompression();
    }
  }, 1000);
};

function startCompression() {
  if (!baselineFrac || state === 'compressing') return;
  const spec = METHODS[method];
  const zip = sanitizeName(nameInput.value) + '.zip';
  setState('compressing');
  extractPanel.classList.add('hidden');
  resultPanel.classList.add('hidden');
  ghostPhoto.classList.add('hidden');
  btnManualDone.classList.add('hidden');
  bestRatio = 1; holdStart = null; lastMilestone = 0; lastCueT = 0; cueCycle = 0;
  emaFrac = 0;
  runElapsedMs = 0; lastValidFrameAt = 0;
  pbCandidate = 1; pbCandidateStart = null; pbQualified = 1; pbPhoto = null;
  timeLeft = gameMode === 'personal-best' ? 45 : spec.timeSec;
  currentRecord = null;
  logLine(logEl, gameMode === 'personal-best' ? `> physical_zip --personal-best ${zip}` : `> zip -9 ${zip} HUMAN  (method: ${spec.label})`, 'text-zinc-300');
  logLine(logEl, gameMode === 'personal-best' ? '45s - hold a size for 2s to lock it' : `target: ${Math.round(spec.targetSize * 100)}% size - hold ${spec.holdSec}s - ${spec.timeSec}s limit`, 'text-amber-300');
  cueEl.textContent = 'SHRINK! elbows in, bend knees, crouch!';
  timerEl.textContent = `${timeLeft}s`;
}

btnGo.onclick = () => {
  if (state === 'compressing') return;
  if (!baselineFrac) {
    startAfterCalibration = true;
    btnCal.click();
    return;
  }
  startCompression();
};

function finishCompress(ratio: number) {
  finalRatio = ratio;
  const compressedSnapshot = gameMode === 'personal-best' && pbPhoto
    ? pbPhoto
    : snapshotVideo(video, facing === 'user');
  const zip = sanitizeName(nameInput.value);
  const saved = 1 - ratio;
  setState('zipped');
  timerEl.textContent = 'DONE';
  cueEl.textContent = `${zip}.zip created successfully.`;
  logLine(logEl, `${zip}.zip created successfully.`, 'text-green-300');
  logLine(logEl, `Original: 100%  Compressed: ${Math.round(ratio * 100)}%  Saved: ${Math.round(saved * 100)}%`, 'text-amber-300');
  blip(990, 0.15);
  setTimeout(() => blip(1320, 0.2), 150);
  extractPanel.classList.remove('hidden');
  resultPanel.classList.remove('hidden');
  if (baselinePhoto && compressedSnapshot) {
    resultPhotos.classList.remove('hidden');
    originalPhoto.src = baselinePhoto;
    compressedPhoto.src = compressedSnapshot;
    compressedCaption.textContent = `COMPRESSED - ${Math.round(ratio * 100)}%`;
  } else resultPhotos.classList.add('hidden');
  const coverage = baselineCoverage === 'full' ? 'full' : 'upper';
  currentRecord = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    name: zip, mode: gameMode, method, coverage,
    compressedPct: Math.round(ratio * 100), savedPct: Math.round(saved * 100),
    createdAt: new Date().toISOString(),
  };
  saveRecord(currentRecord);
  resultSummary.textContent = `${gameMode === 'classic' ? METHODS[method].label : 'Personal Best'} · ${coverage} body · saved on this device`;
  renderRecords();
  logLine(logEl, 'press EXTRACT HUMAN to restore. ghost of your original pose saved.', 'text-zinc-300');
}

btnExtract.onclick = () => {
  if (state !== 'zipped' && state !== 'done') return;
  const poseKeys = baselinePose ? Object.keys(scoreAvailableParts(baselinePose, baselinePose)) : [];
  if (baselinePose && poseKeys.length > 0) extractMode = 'pose';
  else if (baselineThumb) extractMode = 'silhouette';
  else if (baselinePhoto) extractMode = 'manual';
  else { logLine(logEl, 'nothing saved to restore - calibrate first.', 'text-red-400'); return; }
  setState('extracting');
  extracting = true;
  partHoldStart = null;
  partsEl.innerHTML = '';
  if (extractMode === 'pose') {
    ghostPhoto.classList.add('hidden');
    btnManualDone.classList.add('hidden');
    logLine(logEl, '> unzip human.zip - restoring... match the YELLOW ghost.', 'text-amber-300');
    cueEl.textContent = 'UNFOLD - match the yellow ghost skeleton!';
  } else {
    if (baselinePhoto) { ghostPhoto.src = baselinePhoto; ghostPhoto.classList.remove('hidden'); }
    if (extractMode === 'silhouette') {
      btnManualDone.classList.add('hidden');
      logLine(logEl, '> unzip human.zip - restoring... match the photo silhouette.', 'text-amber-300');
      cueEl.textContent = 'MOVE BACK INTO YOUR SAVED SILHOUETTE!';
    } else {
      btnManualDone.classList.remove('hidden');
      logLine(logEl, '> unzip human.zip - no tracking data, match the photo by eye.', 'text-amber-300');
      cueEl.textContent = 'MATCH THE PHOTO, then press ✓ I MATCH!';
    }
  }
};

btnManualDone.onclick = () => {
  if (state === 'extracting' && extractMode === 'manual') finishExtract();
};

function finishExtract() {
  extracting = false;
  extractMode = 'none';
  ghostPhoto.classList.add('hidden');
  btnManualDone.classList.add('hidden');
  setState('done');
  cueEl.textContent = 'Extraction complete. HUMAN RESTORED.';
  logLine(logEl, 'Extraction complete. HUMAN RESTORED. 🎉', 'text-green-300');
  blip(660, 0.12); setTimeout(() => blip(880, 0.12), 130); setTimeout(() => blip(1100, 0.2), 260);
}

btnDl.onclick = () => {
  const zip = sanitizeName(nameInput.value);
  const c = Math.round(finalRatio * 100), s = Math.round((1 - finalRatio) * 100);
  downloadCert(zip, 100, c, s, method, snapshotVideo(video, facing === 'user'));
  logLine(logEl, `downloaded ${zip}.zip.txt + snapshot`, 'text-zinc-400');
};

btnReset.onclick = () => {
  clearInterval(calTimer);
  startAfterCalibration = false;
  extracting = false; extractMode = 'none';
  baselineFrac = 0; baselinePose = null; baselineFeat = null;
  baselineCoverage = 'none'; baselineThumb = null; baselinePhoto = null;
  ghostPhoto.classList.add('hidden');
  btnManualDone.classList.add('hidden');
  ghostPhoto.removeAttribute('src');
  emaFrac = NaN; bestRatio = 1;
  bigPct.textContent = '100%'; savedPct.textContent = 'saved 0%'; bar.style.width = '0%';
  cueEl.textContent = 'reset. calibrate again when ready.';
  warnEl.textContent = '';
  extractPanel.classList.add('hidden');
  resultPanel.classList.add('hidden');
  originalPhoto.removeAttribute('src');
  compressedPhoto.removeAttribute('src');
  logLine(logEl, '-- reset --', 'text-zinc-500');
  timerEl.textContent = 'READY';
  setState(camOn && modelsReady ? 'ready' : 'idle');
};

function renderRecords() {
  const records = loadRecords();
  if (!records.length) {
    recordsList.innerHTML = '<p>No runs saved on this phone yet.</p>';
    return;
  }
  recordsList.innerHTML = '';
  records.slice(0, 5).forEach(record => {
    const row = document.createElement('div');
    row.className = 'record-row';
    const title = document.createElement('strong');
    title.textContent = `${record.compressedPct}% · ${record.name}.zip`;
    const date = document.createElement('small');
    date.textContent = new Date(record.createdAt).toLocaleDateString();
    const meta = document.createElement('span');
    meta.textContent = `${record.mode === 'classic' ? record.method : 'personal best'} · ${record.coverage}`;
    row.append(title, date, meta);
    recordsList.appendChild(row);
  });
}

btnClearRecords.onclick = () => {
  clearRecords();
  renderRecords();
  logLine(logEl, 'local records cleared. photos were never stored.', 'text-zinc-500');
};

btnShare.onclick = async () => {
  if (!currentRecord) return;
  btnShare.disabled = true;
  btnShare.textContent = '◌ PREPARING CARD...';
  try {
    const card = await makeResultCard(currentRecord, includePhotos.checked ? baselinePhoto : null, includePhotos.checked ? compressedPhoto.src : null);
    const result = await shareResult(currentRecord, card);
    btnShare.textContent = result === 'shared' ? '✓ SHARED' : '✓ CARD DOWNLOADED';
  } catch (e: any) {
    if (e?.name !== 'AbortError') {
      btnShare.textContent = '↗ TRY SHARE AGAIN';
      logLine(logEl, `share failed: ${describeError(e)}`, 'text-red-400');
    } else btnShare.textContent = '↗ SHARE RESULT';
  } finally { btnShare.disabled = false; }
};

// setup inputs
nameInput.addEventListener('input', () => {
  zipPreview.textContent = sanitizeName(nameInput.value) + '.zip';
});
document.querySelectorAll('.mbtn').forEach(b => {
  (b as HTMLButtonElement).onclick = () => {
    document.querySelectorAll('.mbtn').forEach(x => {
      x.classList.remove('active');
      x.innerHTML = (x as HTMLElement).innerHTML.replace('◉', '○');
    });
    b.classList.add('active');
    document.querySelectorAll('.mbtn').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
    b.innerHTML = b.innerHTML.replace('○', '◉');
    method = (b as HTMLElement).dataset.m as MethodId;
    methodDesc.textContent = METHODS[method].desc;
  };
});
document.querySelector('[data-m="balanced"]')?.classList.add('active');

document.querySelectorAll<HTMLButtonElement>('.gmode').forEach(button => {
  button.onclick = () => {
    gameMode = button.dataset.mode as GameMode;
    document.querySelectorAll('.gmode').forEach(x => x.classList.toggle('active', x === button));
    document.querySelectorAll('.gmode').forEach(x => x.setAttribute('aria-pressed', String(x === button)));
    methodsEl.classList.toggle('hidden', gameMode === 'personal-best');
    methodDesc.textContent = gameMode === 'personal-best'
      ? 'Get as small as possible in 45 seconds. Hold each score for two seconds to lock it.'
      : METHODS[method].desc;
    btnGo.textContent = gameMode === 'personal-best' ? 'Start 45s challenge' : 'Start compression';
  };
});

document.addEventListener('visibilitychange', () => {
  if (document.hidden && state === 'compressing') {
    lastValidFrameAt = 0;
    holdStart = null; pbCandidateStart = null;
    timerEl.textContent = 'PAUSED';
  }
});

fitCanvas();
requestAnimationFrame(fitCanvas); // re-fit after layout/fonts settle
setState('idle');
logLine(logEl, 'PHYSICAL ZIP v1.0 - Select object: [x] HUMAN', 'text-green-300');
logLine(logEl, 'host: vercel static · compute: your browser · uploads: none', 'text-zinc-500');
renderRecords();
initIntro();
if (matchMedia('(max-width: 639px)').matches) document.querySelector<HTMLDetailsElement>('.terminal-panel')?.removeAttribute('open');
