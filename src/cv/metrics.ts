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

export interface PoseFeatures {
  ok: boolean;
  elbowSpread: number; // wrist-to-wrist / shoulder width
  kneeAngleL: number; kneeAngleR: number;
  torsoH: number; // avg shoulder-hip dist
  shoulderW: number;
  scaleRef: number; // shoulderW + torsoH (camera-distance proxy)
  yaw: number; // shoulder width / hip width proxy for sideways (low = sideways)
  headY: number;
  bboxArea: number; // normalized 0..1
}

export function poseFeatures(lm: Pt[] | null): PoseFeatures {
  const bad: PoseFeatures = { ok: false, elbowSpread: 0, kneeAngleL: 180, kneeAngleR: 180, torsoH: 0, shoulderW: 0, scaleRef: 0, yaw: 1, headY: 0, bboxArea: 0 };
  if (!lm || lm.length < 29) return bad;
  try {
    const g = (i: number) => lm[i];
    const shoulderW = dist(g(IDX.lShoulder), g(IDX.rShoulder));
    const wristSpread = dist(g(IDX.lWrist), g(IDX.rWrist));
    const torsoL = dist(g(IDX.lShoulder), g(IDX.lHip));
    const torsoR = dist(g(IDX.rShoulder), g(IDX.rHip));
    const torsoH = (torsoL + torsoR) / 2;
    const kneeL = angleDeg(g(IDX.lHip), g(IDX.lKnee), g(IDX.lAnkle));
    const kneeR = angleDeg(g(IDX.rHip), g(IDX.rKnee), g(IDX.rAnkle));
    const hipW = dist(g(IDX.lHip), g(IDX.rHip)) || 1e-6;
    const xs = lm.slice(0, 29).map(p => p.x);
    const ys = lm.slice(0, 29).map(p => p.y);
    const bw = Math.max(...xs) - Math.min(...xs);
    const bh = Math.max(...ys) - Math.min(...ys);
    return {
      ok: shoulderW > 0.02 && torsoH > 0.02,
      elbowSpread: wristSpread / (shoulderW || 1e-6),
      kneeAngleL: kneeL, kneeAngleR: kneeR,
      torsoH, shoulderW,
      scaleRef: shoulderW + torsoH,
      yaw: shoulderW / hipW,
      headY: g(IDX.nose).y,
      bboxArea: Math.max(0, bw * bh),
    };
  } catch { return bad; }
}

// ---- normalization + extract scoring ----
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
