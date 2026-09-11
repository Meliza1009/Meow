import type { GameRecord } from './records';

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = reject;
    image.src = src;
  });
}

export async function makeResultCard(record: GameRecord, before?: string | null, after?: string | null): Promise<Blob> {
  const canvas = document.createElement('canvas');
  canvas.width = 1080; canvas.height = 1350;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#080b09'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = '#234c31'; ctx.lineWidth = 3; ctx.strokeRect(42, 42, 996, 1266);
  ctx.fillStyle = '#86efac'; ctx.font = '600 34px ui-monospace, monospace';
  ctx.fillText('PHYSICAL_ZIP / RESULT', 82, 110);
  ctx.fillStyle = '#f0f5f1'; ctx.font = '800 180px ui-monospace, monospace';
  ctx.fillText(`${record.compressedPct}%`, 72, 330);
  ctx.fillStyle = '#86efac'; ctx.font = '500 44px ui-monospace, monospace';
  ctx.fillText(`HUMAN COMPRESSED · ${record.savedPct}% SAVED`, 82, 410);

  if (before && after) {
    const [a, b] = await Promise.all([loadImage(before), loadImage(after)]);
    const drawCover = (img: HTMLImageElement, x: number) => {
      const w = 438, h = 520;
      const scale = Math.max(w / img.width, h / img.height);
      const sw = w / scale, sh = h / scale;
      ctx.drawImage(img, (img.width - sw) / 2, (img.height - sh) / 2, sw, sh, x, 480, w, h);
    };
    drawCover(a, 82); drawCover(b, 560);
  } else {
    ctx.fillStyle = '#102217'; ctx.fillRect(82, 480, 916, 520);
    ctx.strokeStyle = '#397b50'; ctx.setLineDash([18, 18]); ctx.strokeRect(112, 510, 856, 460);
    ctx.setLineDash([]); ctx.fillStyle = '#86efac'; ctx.font = '500 40px ui-monospace, monospace';
    ctx.fillText('HUMAN → .ZIP', 350, 755);
  }

  ctx.fillStyle = '#b6c2b9'; ctx.font = '500 30px ui-monospace, monospace';
  ctx.fillText(`${record.name}.zip`, 82, 1080);
  ctx.fillText(`${record.mode === 'classic' ? record.method : 'PERSONAL BEST'} · ${record.coverage.toUpperCase()} BODY`, 82, 1130);
  ctx.fillStyle = '#5c7563'; ctx.font = '400 25px ui-monospace, monospace';
  ctx.fillText(new Date(record.createdAt).toLocaleString(), 82, 1225);
  return new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('result card failed')), 'image/png'));
}

export async function shareResult(record: GameRecord, card: Blob) {
  const file = new File([card], `${record.name}-physical-zip.png`, { type: 'image/png' });
  if (navigator.share && (!navigator.canShare || navigator.canShare({ files: [file] }))) {
    try {
      await navigator.share({ title: 'PHYSICAL ZIP result', text: `I compressed to ${record.compressedPct}% in PHYSICAL ZIP.`, files: [file] });
      return 'shared';
    } catch (error: any) {
      if (error?.name === 'AbortError') throw error;
    }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(card); a.download = file.name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  return 'downloaded';
}
