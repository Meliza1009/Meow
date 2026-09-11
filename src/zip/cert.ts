import { sanitizeName } from '../coach/methods';

export function downloadCert(zipName: string, originalPct: number, compressedPct: number, savedPct: number, method: string, snapshotUrl: string | null) {
  const clean = sanitizeName(zipName);
  const txt = [
    `${clean}.zip created successfully.`,
    ``,
    `PHYSICAL ZIP v1.0 — certificate of compression`,
    `object: HUMAN`,
    `method: ${method.toUpperCase()}`,
    `original size: ${originalPct}%`,
    `compressed size: ${compressedPct}%`,
    `space saved: ${savedPct}%`,
    `date: ${new Date().toISOString()}`,
    ``,
    `HUMAN -> COMPRESS -> .zip -> EXTRACT -> HUMAN`,
  ].join('\n');
  const blob = new Blob([txt], { type: 'text/plain' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${clean}.zip.txt`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  if (snapshotUrl) {
    const img = document.createElement('a');
    img.href = snapshotUrl;
    img.download = `${clean}-snapshot.png`;
    img.click();
  }
}

export function snapshotVideo(video: HTMLVideoElement, mirror = false): string | null {
  try {
    const c = document.createElement('canvas');
    c.width = video.videoWidth || 640;
    c.height = video.videoHeight || 480;
    const ctx = c.getContext('2d')!;
    if (mirror) { ctx.translate(c.width, 0); ctx.scale(-1, 1); }
    ctx.drawImage(video, 0, 0, c.width, c.height);
    return c.toDataURL('image/png');
  } catch { return null; }
}
