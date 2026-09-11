import './style.css';
import { CVEngine, type FrameInfo } from './cv/engine';
import { ema, poseFeatures, scoreParts, IDX, type Pt } from './cv/metrics';
import { METHODS, sanitizeName, type MethodId } from './coach/methods';
import { pickCue, milestoneLog } from './coach/rules';
import { logLine, blip } from './ui/terminal';
import { downloadCert, snapshotVideo } from './zip/cert';

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
const btnCam = $('btnCam') as HTMLButtonElement, btnCal = $('btnCal') as HTMLButtonElement;
const btnGo = $('btnGo') as HTMLButtonElement, btnReset = $('btnReset') as HTMLButtonElement;
const nameInput = $('name') as HTMLInputElement, zipPreview = $('zipPreview');
const methodDesc = $('methodDesc'), engineStatus = $('engineStatus');
const camLabel = $('camLabel'), modeLabel = $('modeLabel'), fpsEl = $('fps');
const extractPanel = $('extractPanel'), partsEl = $('parts');
const btnExtract = $('btnExtract') as HTMLButtonElement, btnDl = $('btnDl') as HTMLButtonElement;

type State = 'idle' | 'calibrating' | 'ready' | 'compressing' | 'zipped' | 'extracting' | 'done';
let state: State = 'idle';
let method: MethodId = 'balanced';
let engine: CVEngine | null = null;
let camOn = false, modelsReady = false;

// tracker
let emaFrac = NaN;
let baselineFrac = 0;
let baselineScale = 0;
let baselinePose: Pt[] | null = null;
let baselineFeat: ReturnType<typeof poseFeatures> | null = null;
let lastLandmarks: Pt[] | null = null;
let lastFrame: FrameInfo | null = null;

// calibrate accumulation
let calSamples: number[] = [];
let calPoses: Pt[][] = [];
let calScales: number[] = [];
let calTimer: any = null;

// compress run
let runStart = 0, runTimer: any = null, timeLeft = 0;
let bestRatio = 1, holdStart: number | null = null;
let lastCueT = 0, lastMilestone = 0;
let noPersonSince: number | null = null;

// extract run
let extracting = false;
let partHoldStart: number | null = null;
let finalRatio = 1;

// ---------- helpers ----------
function setState(s: State) {
  state = s;
  modeLabel.textContent = 'MODE: ' + s.toUpperCase();
  btnCal.disabled = !(camOn && modelsReady && (s === 'idle' || s === 'ready'));
  btnCal.classList.toggle('opacity-40', btnCal.disabled);
  btnGo.disabled = !(camOn && modelsReady && baselineFrac > 0 && (s === 'ready' || s === 'idle'));
  btnGo.classList.toggle('opacity-40', btnGo.disabled);
}

function fitCanvas() {
  const r = overlay.parentElement!.getBoundingClientRect();
  overlay.width = Math.max(320, Math.floor(r.width));
  overlay.height = Math.max(240, Math.floor(r.height));
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
  const W = overlay.width, H = overlay.height;
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
  if (extracting && baselinePose) drawSkeleton(baselinePose, '#22c55e', 5, 0.35);
  if (lastLandmarks) drawSkeleton(lastLandmarks, extracting ? '#ffffff' : '#4ade80', 3, 1);
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
      warnEl.textContent = '⚠ NO SUBJECT — step into frame, full body visible';
    }
    return;
  }
  noPersonSince = null;

  // smooth
  emaFrac = ema(emaFrac, f.personFrac, 0.2);

  if (state === 'calibrating') {
    calSamples.push(f.personFrac);
    if (f.landmarks) {
      calPoses.push(f.landmarks);
      const feat = poseFeatures(f.landmarks);
      if (feat.ok) calScales.push(feat.scaleRef);
    }
    return;
  }
  if (!baselineFrac) return;

  const ratio = emaFrac / baselineFrac;
  const clamped = Math.max(0.05, Math.min(1.5, ratio));
  const saved = Math.max(0, 1 - clamped);

  bigPct.textContent = `${Math.round(clamped * 100)}%`;
  savedPct.textContent = `saved ${Math.round(saved * 100)}%`;
  bar.style.width = `${Math.round(saved * 100)}%`;

  // moved-distance guard
  if (f.landmarks) {
    const feat = poseFeatures(f.landmarks);
    if (feat.ok && baselineScale > 0) {
      const drift = feat.scaleRef / baselineScale;
      if (drift < 0.85) {
        warnEl.textContent = '⚠ SUBJECT MOVED BACK — step forward to your marker (paused)';
        holdStart = null; partHoldStart = null;
        return;
      } else if (drift > 1.3) {
        warnEl.textContent = '⚠ TOO CLOSE — step back to your marker (paused)';
        holdStart = null; partHoldStart = null;
        return;
      } else warnEl.textContent = '';
    }
  }

  if (state === 'compressing') compressTick(clamped, saved);
  if (state === 'extracting' && extracting) extractTick();
}

function compressTick(ratio: number, saved: number) {
  const spec = METHODS[method];
  if (ratio < bestRatio) bestRatio = ratio;
  const now = performance.now();

  // coaching cue every 2.5s
  if (now - lastCueT > 2500 && lastFrame?.landmarks) {
    lastCueT = now;
    const feat = poseFeatures(lastFrame.landmarks);
    const { cue, log } = pickCue(feat, baselineFeat, spec, ratio);
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
      logLine(logEl, `TARGET ${Math.round(spec.targetSize * 100)}% REACHED — HOLD IT...`, 'text-amber-300');
      blip(880);
    }
    const held = (now - holdStart) / 1000;
    cueEl.textContent = `HOLD IT — ${(spec.holdSec - held).toFixed(1)}s  (${Math.round(ratio * 100)}%)`;
    if (held >= spec.holdSec) finishCompress(ratio);
  } else holdStart = null;
}

function extractTick() {
  if (!baselinePose || !lastLandmarks) return;
  const scores = scoreParts(baselinePose, lastLandmarks);
  const labels: Record<string, string> = { leftArm: 'left arm', rightArm: 'right arm', torso: 'torso+head', legs: 'legs' };
  partsEl.innerHTML = '';
  let allOk = true;
  for (const [k, v] of Object.entries(scores)) {
    const ok = v > 0.9;
    if (!ok) allOk = false;
    const d = document.createElement('div');
    d.className = ok ? 'text-green-400' : 'text-amber-300';
    d.textContent = `${ok ? '✓' : '…'} Restoring ${labels[k]} — ${Math.round(v * 100)}%`;
    partsEl.appendChild(d);
  }
  if (allOk) {
    if (partHoldStart === null) {
      partHoldStart = performance.now();
      logLine(logEl, 'all parts aligned — HOLD...', 'text-amber-300');
    }
    const held = (performance.now() - partHoldStart) / 1000;
    cueEl.textContent = `HOLD RESTORE — ${(2 - held).toFixed(1)}s`;
    if (held >= 2) finishExtract();
  } else partHoldStart = null;
}

// ---------- flows ----------
async function ensureEngine() {
  if (engine) return;
  engine = new CVEngine(video);
  engine.onStatus = (s) => { engineStatus.textContent = s; };
  engine.onFrame = onFrame;
  await engine.init();
  modelsReady = true;
  setState(state);
}

btnCam.onclick = async () => {
  btnCam.disabled = true;
  logLine(logEl, '> physical_zip --scan HUMAN', 'text-zinc-400');
  try {
    await ensureEngine();
    await engine!.startCamera();
    camOn = true;
    fitCanvas();
    engine!.start();
    camLabel.textContent = '/dev/human0 — live';
    logLine(logEl, 'camera live. models ready. stand back, full body in frame.', 'text-green-300');
    logLine(logEl, 'next: CALIBRATE 100% (stand tall, arms slightly out)', 'text-zinc-400');
    setState('ready');
  } catch (e: any) {
    logLine(logEl, 'camera failed: ' + (e?.message || e) + ' — allow camera + use HTTPS (Vercel).', 'text-red-400');
    btnCam.disabled = false;
  }
};

btnCal.onclick = () => {
  if (!camOn || !modelsReady || state === 'calibrating') return;
  setState('calibrating');
  calSamples = []; calPoses = []; calScales = [];
  emaFrac = NaN;
  logLine(logEl, 'ANALYZING REDUNDANT LIMBS... stand tall, arms slightly out. 3s...', 'text-amber-300');
  cueEl.textContent = 'STAND TALL — ARMS SLIGHTLY OUT — 3…';
  let n = 3;
  calTimer = setInterval(() => {
    n--;
    if (n > 0) { cueEl.textContent = `STAND TALL — ${n}…`; return; }
    clearInterval(calTimer);
    if (calSamples.length < 10) {
      logLine(logEl, 'calibration failed — no subject. try better light / step back.', 'text-red-400');
      setState('ready');
      return;
    }
    calSamples.sort((a, b) => a - b);
    baselineFrac = calSamples.slice(2, -2).reduce((a, b) => a + b, 0) / Math.max(1, calSamples.length - 4);
    calScales.sort((a, b) => a - b);
    baselineScale = calScales.length ? calScales[Math.floor(calScales.length / 2)] : 0;
    baselinePose = calPoses[Math.floor(calPoses.length / 2)] || null;
    baselineFeat = baselinePose ? poseFeatures(baselinePose) : null;
    emaFrac = baselineFrac;
    bestRatio = 1;
    bigPct.textContent = '100%'; savedPct.textContent = 'saved 0%'; bar.style.width = '0%';
    logLine(logEl, `Original human size = 100% (frac ${baselineFrac.toFixed(4)}${lastFrame?.fromMask ? ', mask' : ', bbox'})`, 'text-green-300');
    cueEl.textContent = 'CALIBRATED — press START COMPRESSION and shrink.';
    setState('ready');
    blip(740);
  }, 1000);
};

btnGo.onclick = () => {
  if (!baselineFrac || state === 'compressing') return;
  const spec = METHODS[method];
  const zip = sanitizeName(nameInput.value) + '.zip';
  setState('compressing');
  extractPanel.classList.add('hidden');
  bestRatio = 1; holdStart = null; lastMilestone = 0; lastCueT = 0;
  timeLeft = spec.timeSec;
  runStart = Date.now();
  logLine(logEl, `> zip -9 ${zip} HUMAN  (method: ${spec.label})`, 'text-zinc-300');
  logLine(logEl, `target: ${Math.round(spec.targetSize * 100)}% size — hold ${spec.holdSec}s — ${spec.timeSec}s limit`, 'text-amber-300');
  cueEl.textContent = 'SHRINK! elbows in, bend knees, crouch!';
  clearInterval(runTimer);
  runTimer = setInterval(() => {
    timeLeft = spec.timeSec - Math.floor((Date.now() - runStart) / 1000);
    if (timeLeft <= 0) {
      clearInterval(runTimer);
      if (state === 'compressing') {
        logLine(logEl, `TIMEOUT — best was ${Math.round(bestRatio * 100)}%. press START COMPRESSION to retry.`, 'text-red-400');
        setState('ready');
        cueEl.textContent = 'TIMEOUT — retry, you can beat it.';
      }
    }
  }, 500);
};

function finishCompress(ratio: number) {
  clearInterval(runTimer);
  finalRatio = ratio;
  const zip = sanitizeName(nameInput.value);
  const saved = 1 - ratio;
  setState('zipped');
  cueEl.textContent = `${zip}.zip created successfully.`;
  logLine(logEl, `${zip}.zip created successfully.`, 'text-green-300');
  logLine(logEl, `Original: 100%  Compressed: ${Math.round(ratio * 100)}%  Saved: ${Math.round(saved * 100)}%`, 'text-amber-300');
  blip(990, 0.15);
  setTimeout(() => blip(1320, 0.2), 150);
  extractPanel.classList.remove('hidden');
  logLine(logEl, 'press EXTRACT HUMAN to restore. ghost of your original pose saved.', 'text-zinc-300');
}

btnExtract.onclick = () => {
  if (!baselinePose || (state !== 'zipped' && state !== 'done')) return;
  setState('extracting');
  extracting = true;
  partHoldStart = null;
  logLine(logEl, '> unzip human.zip — restoring... match the GREEN ghost.', 'text-amber-300');
  cueEl.textContent = 'UNFOLD — match the green ghost skeleton!';
};

function finishExtract() {
  extracting = false;
  setState('done');
  cueEl.textContent = 'Extraction complete. HUMAN RESTORED.';
  logLine(logEl, 'Extraction complete. HUMAN RESTORED. 🎉', 'text-green-300');
  blip(660, 0.12); setTimeout(() => blip(880, 0.12), 130); setTimeout(() => blip(1100, 0.2), 260);
}

btnDl.onclick = () => {
  const zip = sanitizeName(nameInput.value);
  const c = Math.round(finalRatio * 100), s = Math.round((1 - finalRatio) * 100);
  downloadCert(zip, 100, c, s, method, snapshotVideo(video));
  logLine(logEl, `downloaded ${zip}.zip.txt + snapshot`, 'text-zinc-400');
};

btnReset.onclick = () => {
  clearInterval(runTimer); clearInterval(calTimer);
  extracting = false; baselineFrac = 0; baselinePose = null;
  emaFrac = NaN; bestRatio = 1;
  bigPct.textContent = '100%'; savedPct.textContent = 'saved 0%'; bar.style.width = '0%';
  cueEl.textContent = 'reset. calibrate again when ready.';
  warnEl.textContent = '';
  extractPanel.classList.add('hidden');
  logLine(logEl, '-- reset --', 'text-zinc-500');
  setState(camOn && modelsReady ? 'ready' : 'idle');
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
    b.innerHTML = b.innerHTML.replace('○', '◉');
    method = (b as HTMLElement).dataset.m as MethodId;
    methodDesc.textContent = METHODS[method].desc;
  };
});
document.querySelector('[data-m="balanced"]')?.classList.add('active');

fitCanvas();
requestAnimationFrame(fitCanvas); // re-fit after layout/fonts settle
setState('idle');
logLine(logEl, 'PHYSICAL ZIP v1.0 — Select object: [x] HUMAN', 'text-green-300');
logLine(logEl, 'host: vercel static · compute: your browser · uploads: none', 'text-zinc-500');
