export type MethodId = 'comfortable' | 'balanced' | 'maximum';

export interface MethodSpec {
  id: MethodId;
  label: string;
  targetSize: number; // e.g. 0.60 means must shrink to 60% of baseline
  holdSec: number;
  timeSec: number;
  elbowFactor: number; // multiplier for elbow-spread threshold (lower = stricter)
  kneeStraightDeg: number; // above this = "bend knees"
  torsoUpright: number; // above this ratio = "crouch"
  desc: string;
}

export const METHODS: Record<MethodId, MethodSpec> = {
  comfortable: {
    id: 'comfortable', label: 'Comfortable',
    targetSize: 0.75, holdSec: 2, timeSec: 60,
    elbowFactor: 1.25, kneeStraightDeg: 160, torsoUpright: 0.95,
    desc: 'Comfortable: reach 75% size (save 25%), hold 2s. Generous thresholds.'
  },
  balanced: {
    id: 'balanced', label: 'Balanced',
    targetSize: 0.60, holdSec: 3, timeSec: 45,
    elbowFactor: 1.0, kneeStraightDeg: 150, torsoUpright: 0.88,
    desc: 'Balanced: reach 60% size (save 40%), hold 3s. Real thresholds, not flavor.'
  },
  maximum: {
    id: 'maximum', label: 'Maximum',
    targetSize: 0.42, holdSec: 5, timeSec: 60,
    elbowFactor: 0.8, kneeStraightDeg: 140, torsoUpright: 0.78,
    desc: 'Maximum: reach 42% size (save 58%), hold 5s. Requires sideways + deep crouch.'
  }
};

export function sanitizeName(raw: string): string {
  const clean = (raw || 'human').toLowerCase().replace(/[^a-z0-9-_]+/g, '').slice(0, 20) || 'human';
  return clean;
}
