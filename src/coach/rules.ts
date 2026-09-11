import type { MethodSpec } from '../coach/methods';
import { poseFeatures, type Pt } from '../cv/metrics';

export function pickCue(feat: ReturnType<typeof poseFeatures>, base: ReturnType<typeof poseFeatures> | null, spec: MethodSpec, ratio: number): { cue: string; log: string } {
  if (!feat.ok) return { cue: 'STEP INTO FRAME — FULL BODY VISIBLE', log: 'waiting for subject...' };
  const elbowThresh = 1.6 * spec.elbowFactor;
  if (feat.elbowSpread > elbowThresh)
    return { cue: '➤ TUCK ELBOWS IN — ARMS BEHIND TORSO', log: 'Relocating elbow... redundant limb detected' };
  const kneeMin = Math.min(feat.kneeAngleL, feat.kneeAngleR);
  if (kneeMin > spec.kneeStraightDeg)
    return { cue: '➤ BEND KNEES — FOLD LOWER EXTREMITIES', log: 'Folding lower extremities... knees at ' + Math.round(kneeMin) + '°' };
  if (base && feat.torsoH > base.torsoH * spec.torsoUpright)
    return { cue: ratio > 0.8 ? '➤ CROUCH DOWN — OPTIMIZE TORSO' : '➤ CROUCH DEEPER + ROTATE SIDEWAYS', log: 'Optimizing torso orientation...' };
  if (feat.yaw > 1.15)
    return { cue: '➤ ROTATE SIDEWAYS — MINIMIZE FRONTAL AREA', log: 'Minimizing frontal projection...' };
  return { cue: '➤ MAKE YOURSELF NARROWER — TUCK CHIN, SQUEEZE IN', log: 'Removing unnecessary whitespace...' };
}

export function milestoneLog(savedPct: number): string | null {
  if (savedPct >= 58) return 'MAXIMUM COMPRESSION ZONE — subject barely occupies frame';
  if (savedPct >= 40) return 'Good delta. Whitespace reclaimed: ' + Math.round(savedPct) + '%';
  if (savedPct >= 25) return 'Analyzing redundant limbs... ' + Math.round(savedPct) + '% saved';
  return null;
}
