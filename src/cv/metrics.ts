export function ema(prev: number, next: number, alpha = 0.2): number {
  if (!isFinite(prev)) return next;
  return prev * (1 - alpha) + next * alpha;
}

export interface Pt { x: number; y: number; v?: number }

export function dist(a: Pt, b: Pt): number {
  const dx = a.x - b.x, dy = a.y - b.y;
  return Math.hypot(dx, dy);
}

export function angleDeg(a: Pt, b: Pt, c: Pt): number {
  // angle at b between a-b-c
  const v1x = a.x - b.x, v1y = a.y - b.y;
  const v2x = c.x - b.x, v2y = c.y - b.y;
  const d1 = Math.hypot(v1x, v1y) || 1e-6;
  const d2 = Math.hypot(v2x, v2y) || 1e-6;
  const cos = Math.max(-1, Math.min(1, (v1x * v2x + v1y * v2y) / (d1 * d2)));
  return (Math.acos(cos) * 180) / Math.PI;
}

// MediaPipe pose indices (33)
export const IDX = {
  nose: 0,
  lShoulder: 11, rShoulder: 12,
  lElbow: 13, rElbow: 14,
  lWrist: 15, rWrist: 16,
  lHip: 23, rHip: 24,
  lKnee: 25, rKnee: 26,
  lAnkle: 27, rAnkle: 28,
} as const;

export type Coverage = 'full' | 'upper' | 'head' | 'none';

export function inFrame(p: Pt | undefined): boolean {
  return !!p && p.x >= -0.05 && p.x <= 1.05 && p.y >= -0.05 && p.y <= 1.05;
}

export const KEY_JOINTS = [0, 11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28];
const FACE_JOINTS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

export interface PoseFeatures {
  ok: boolean;
  coverage: Coverage;
  hasHead: boolean; hasTorso: boolean; hasArms: boolean; hasLegs: boolean;
  validJoints: number;
  elbowSpread: number; // wrist-to-wrist / shoulder width
  kneeAngleL: number; kneeAngleR: number;
  torsoH: number; // avg shoulder-hip dist
  shoulderW: number;
  scaleRef: number; // torso-based when available, else shoulder width, else 0
  yaw: number; // shoulder width / hip width proxy for sideways (low = sideways)
  headY: number;
  bboxArea: number; // normalized 0..1, computed over in-frame joints only
}

export function poseFeatures(lm: Pt[] | null): PoseFeatures {
  const bad: PoseFeatures = { ok: false, coverage: 'none', hasHead: false, hasTorso: false, hasArms: false, hasLegs: false, validJoints: 0, elbowSpread: 0, kneeAngleL: 180, kneeAngleR: 180, torsoH: 0, shoulderW: 0, scaleRef: 0, yaw: 1, headY: 0, bboxArea: 0 };
  if (!lm || lm.length < 29) return bad;
  try {
    const g = (i: number) => lm[i];
    const shL = inFrame(g(IDX.lShoulder)), shR = inFrame(g(IDX.rShoulder));
    const hipL = inFrame(g(IDX.lHip)), hipR = inFrame(g(IDX.rHip));
    const kneeL = inFrame(g(IDX.lKnee)), kneeR = inFrame(g(IDX.rKnee));
    const ankL = inFrame(g(IDX.lAnkle)), ankR = inFrame(g(IDX.rAnkle));
    const elbL = inFrame(g(IDX.lElbow)), elbR = inFrame(g(IDX.rElbow));
    const wriL = inFrame(g(IDX.lWrist)), wriR = inFrame(g(IDX.rWrist));
    const hasHead = inFrame(g(IDX.nose)) || FACE_JOINTS.filter(i => inFrame(lm[i])).length >= 2;
    const shoulderW = dist(g(IDX.lShoulder), g(IDX.rShoulder));
    const wristSpread = dist(g(IDX.lWrist), g(IDX.rWrist));
    const torsoL = dist(g(IDX.lShoulder), g(IDX.lHip));
    const torsoR = dist(g(IDX.rShoulder), g(IDX.rHip));
    const torsoH = (torsoL + torsoR) / 2;
    const hasTorso = shL && shR && hipL && hipR && shoulderW > 0.015 && torsoH > 0.015;
    const hasLegs = hasTorso && kneeL && kneeR && ankL && ankR;
    const hasArms = elbL && elbR && wriL && wriR;
    const validJoints = KEY_JOINTS.filter(i => inFrame(lm[i])).length
      + FACE_JOINTS.filter(i => inFrame(lm[i])).length;
    const coverage: Coverage = hasLegs ? 'full'
      : (hasTorso || (shL && shR) ? 'upper'
        : (hasHead || shL || shR ? 'head' : 'none'));
    const kneeAngL = angleDeg(g(IDX.lHip), g(IDX.lKnee), g(IDX.lAnkle));
    const kneeAngR = angleDeg(g(IDX.rHip), g(IDX.rKnee), g(IDX.rAnkle));
    const hipW = (hipL && hipR) ? (dist(g(IDX.lHip), g(IDX.rHip)) || 1e-6) : NaN;
    const inPts = lm.slice(0, 29).filter(inFrame);
    let bboxArea = 0;
    if (inPts.length >= 2) {
      const xs = inPts.map(p => p.x), ys = inPts.map(p => p.y);
      bboxArea = Math.max(0, (Math.max(...xs) - Math.min(...xs)) * (Math.max(...ys) - Math.min(...ys)));
    }
    return {
      ok: coverage !== 'none' && validJoints >= 2,
      coverage, hasHead, hasTorso, hasArms, hasLegs, validJoints,
      elbowSpread: wristSpread / (shoulderW || 1e-6),
      kneeAngleL: kneeAngL, kneeAngleR: kneeAngR,
      torsoH, shoulderW,
      scaleRef: torsoH > 0.015 ? shoulderW + torsoH : (shoulderW > 0.015 ? shoulderW : 0),
      yaw: isFinite(shoulderW / hipW) ? shoulderW / hipW : 1,
      headY: hasHead ? g(IDX.nose).y : 0,
      bboxArea,
    };
  } catch { return bad; }
}

// ---- normalization + extract scoring (partial-body aware) ----
export function normalizePose(lm: Pt[]): Pt[] {
  const hips = { x: (lm[23].x + lm[24].x) / 2, y: (lm[23].y + lm[24].y) / 2 };
  const torsoH = (dist(lm[11], lm[23]) + dist(lm[12], lm[24])) / 2 || 1e-6;
  return lm.map(p => ({ x: (p.x - hips.x) / torsoH, y: (p.y - hips.y) / torsoH }));
}

const PARTS: Record<string, number[]> = {
  leftArm: [11, 13, 15],
  rightArm: [12, 14, 16],
  torso: [11, 12, 23, 24, 0],
  legs: [23, 24, 25, 26, 27, 28],
};

export function scoreParts(baseline: Pt[], live: Pt[]): Record<string, number> {
  const nb = normalizePose(baseline);
  const nl = normalizePose(live);
  const out: Record<string, number> = {};
  for (const [k, idxs] of Object.entries(PARTS)) {
    let s = 0;
    for (const i of idxs) s += dist(nb[i], nl[i]);
    const avg = s / idxs.length;
    out[k] = Math.max(0, Math.min(1, 1 - avg / 0.6));
  }
  return out;
}

function fitTransform(lm: Pt[], idx: number[]): { cx: number; cy: number; s: number } {
  let cx = 0, cy = 0;
  for (const i of idx) { cx += lm[i].x; cy += lm[i].y; }
  cx /= idx.length; cy /= idx.length;
  let v = 0;
  for (const i of idx) v += (lm[i].x - cx) ** 2 + (lm[i].y - cy) ** 2;
  v /= idx.length;
  return { cx, cy, s: Math.sqrt(v) || 1e-6 };
}

/** Score only the parts visible in the baseline (each pose normalized by its own
 *  centroid+spread, so matching is about body configuration, not screen position). */
export function scoreAvailableParts(baseline: Pt[], live: Pt[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, ids] of Object.entries(PARTS)) {
    const baseValid = ids.filter(i => baseline[i] && inFrame(baseline[i]));
    const valid = baseValid.filter(i => live[i] && inFrame(live[i]));
    if (valid.length === 0 || baseValid.length < 2) continue; // need spread for stable scale
    const Tb = fitTransform(baseline, baseValid);
    const Tl = fitTransform(live, valid);
    let s = 0;
    for (const i of valid) {
      const bx = (baseline[i].x - Tb.cx) / Tb.s, by = (baseline[i].y - Tb.cy) / Tb.s;
      const lx = (live[i].x - Tl.cx) / Tl.s, ly = (live[i].y - Tl.cy) / Tl.s;
      s += Math.hypot(bx - lx, by - ly);
    }
    out[k] = Math.max(0, Math.min(1, 1 - (s / valid.length) / 0.8));
  }
  return out;
}

/** Intersection-over-union of two binary mask thumbnails (0/1 per pixel). */
export function maskIoU(a: Uint8Array, b: Uint8Array): number {
  let inter = 0, union = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i] ? 1 : 0, y = b[i] ? 1 : 0;
    inter += x & y; union += x | y;
  }
  return union === 0 ? 0 : inter / union;
}
