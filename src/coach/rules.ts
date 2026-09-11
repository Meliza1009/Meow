import type { MethodSpec } from '../coach/methods';
import { poseFeatures, type Pt } from '../cv/metrics';

export function pickCue(feat: ReturnType<typeof poseFeatures>, base: ReturnType<typeof poseFeatures> | null, spec: MethodSpec, ratio: number, cycle = 0): { cue: string; log: string } {
  if (!feat.ok) return { cue: 'SHOW YOURSELF - ANY FRAMING WORKS', log: 'waiting for subject...' };
  if (feat.coverage !== 'full') return partialCue(feat, ratio, cycle);
  const elbowThresh = 1.6 * spec.elbowFactor;
  if (feat.hasArms && feat.elbowSpread > elbowThresh)
    return { cue: '➤ TUCK ELBOWS IN - ARMS BEHIND TORSO', log: 'Relocating elbow... redundant limb detected' };
  const kneeMin = Math.min(feat.kneeAngleL, feat.kneeAngleR);
  if (feat.hasLegs && kneeMin > spec.kneeStraightDeg)
    return { cue: '➤ BEND KNEES - FOLD LOWER EXTREMITIES', log: 'Folding lower extremities... knees at ' + Math.round(kneeMin) + '°' };
  if (base && base.hasTorso && feat.hasTorso && feat.torsoH > base.torsoH * spec.torsoUpright)
    return { cue: ratio > 0.8 ? '➤ CROUCH DOWN - OPTIMIZE TORSO' : '➤ CROUCH DEEPER + ROTATE SIDEWAYS', log: 'Optimizing torso orientation...' };
  if (feat.yaw > 1.15)
    return { cue: '➤ ROTATE SIDEWAYS - MINIMIZE FRONTAL AREA', log: 'Minimizing frontal projection...' };
  return { cue: '➤ MAKE YOURSELF NARROWER - TUCK CHIN, SQUEEZE IN', log: 'Removing unnecessary whitespace...' };
}

function partialCue(feat: ReturnType<typeof poseFeatures>, ratio: number, cycle: number): { cue: string; log: string } {
  const elbowThresh = 1.6;
  const opts: { cue: string; log: string }[] = [];
  if (feat.hasArms && feat.elbowSpread > elbowThresh)
    opts.push({ cue: '➤ TUCK ELBOWS - HANDS INTO BODY', log: 'Relocating elbow... redundant limb detected' });
  if (feat.coverage === 'upper' && feat.yaw > 1.15)
    opts.push({ cue: '➤ TURN SIDEWAYS - SHRINK WIDTH', log: 'Minimizing frontal projection...' });
  if (feat.hasHead)
    opts.push({ cue: '➤ TUCK CHIN - HUNCH DOWN', log: 'Compressing header... unnecessary height detected' });
  if (feat.hasArms)
    opts.push({ cue: '➤ HANDS OUT OF FRAME - DELETE REDUNDANT PIXELS', log: 'Cropping extremities...' });
  if (ratio > 0.9)
    opts.push({ cue: '➤ LEAN BACK / SINK DOWN A LITTLE', log: 'Optimizing subject footprint...' });
  opts.push({ cue: '➤ MAKE WHAT WE SEE SMALLER - SQUEEZE IN', log: 'Removing unnecessary whitespace...' });
  return opts[cycle % opts.length];
}

export function milestoneLog(savedPct: number): string | null {
  if (savedPct >= 58) return 'MAXIMUM COMPRESSION ZONE - subject barely occupies frame';
  if (savedPct >= 40) return 'Good delta. Whitespace reclaimed: ' + Math.round(savedPct) + '%';
  if (savedPct >= 25) return 'Analyzing redundant limbs... ' + Math.round(savedPct) + '% saved';
  return null;
}
