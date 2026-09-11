export function logLine(el: HTMLElement, msg: string, cls = 'text-green-400') {
  const t = new Date().toLocaleTimeString('en-GB', { hour12: false });
  const div = document.createElement('div');
  div.className = cls;
  div.textContent = `[${t}] ${msg}`;
  el.appendChild(div);
  el.scrollTop = el.scrollHeight;
  while (el.children.length > 220) el.removeChild(el.firstChild!);
}

export function describeError(e: any): string {
  if (e == null) return 'unknown error';
  if (typeof e === 'string') return e;
  // DOM Event as rejection reason (e.g. media element error) - never stringify raw
  if (typeof Event !== 'undefined' && e instanceof Event) {
    const t = e.target as any;
    if (t?.error && typeof t.error.code === 'number') {
      const tag = t.tagName ? `<${String(t.tagName).toLowerCase()}>` : 'media element';
      return `${e.type || 'error'} event on ${tag} (media error code ${t.error.code}${t.error.message ? ': ' + t.error.message : ''})`;
    }
    const tag = t?.tagName ? `<${String(t.tagName).toLowerCase()}>` : 'unknown target';
    return `${e.type || 'error'} event on ${tag}`;
  }
  // MediaError {code, message}
  if (typeof e?.code === 'number' && !e?.message && e?.MEDIA_ERR_ABORTED !== undefined)
    return `media error code ${e.code}`;
  const name = e?.name ? `[${e.name}] ` : '';
  const msg = e?.message ?? String(e);
  return `${name}${msg}`;
}

export function cameraHint(e: any): string {
  switch (e?.name) {
    case 'NotAllowedError':
      return ' - permission denied. Allow the camera via the lock icon in the address bar, check OS privacy settings, then RETRY.';
    case 'NotFoundError':
    case 'DevicesNotFoundError':
      return ' - no camera found on this device/browser.';
    case 'NotReadableError':
    case 'TrackStartError':
      return ' - camera is busy (close Zoom/Teams/other tabs using it) then RETRY.';
    case 'OverconstrainedError':
    case 'ConstraintNotSatisfiedError':
      return ' - camera rejected the requested mode; retrying with defaults...';
    case 'SecurityError':
      return ' - camera needs HTTPS. Open the https://....vercel.app URL directly.';
    default:
      return ' - allow camera + use HTTPS (Vercel).';
  }
}
let ctx: AudioContext | null = null;
export function blip(freq = 660, dur = 0.07) {
  try {
    ctx = ctx || new (window.AudioContext || (window as any).webkitAudioContext)();
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = 'square'; o.frequency.value = freq;
    g.gain.value = 0.04;
    o.connect(g); g.connect(ctx.destination);
    o.start();
    o.stop(ctx.currentTime + dur);
  } catch { /* audio off */ }
}
