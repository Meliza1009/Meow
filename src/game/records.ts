export type GameMode = 'classic' | 'personal-best';

export interface GameRecord {
  id: string;
  name: string;
  mode: GameMode;
  method: string;
  coverage: 'upper' | 'full';
  compressedPct: number;
  savedPct: number;
  createdAt: string;
}

const KEY = 'physical-zip.records.v1';

export function loadRecords(): GameRecord[] {
  try {
    const data = JSON.parse(localStorage.getItem(KEY) || '[]');
    return Array.isArray(data) ? data.slice(0, 20) : [];
  } catch { return []; }
}

export function saveRecord(record: GameRecord): GameRecord[] {
  const records = [...loadRecords(), record]
    .sort((a, b) => a.compressedPct - b.compressedPct)
    .slice(0, 20);
  try { localStorage.setItem(KEY, JSON.stringify(records)); } catch { /* storage may be blocked */ }
  return records;
}

export function clearRecords() {
  try { localStorage.removeItem(KEY); } catch { /* storage may be blocked */ }
}
