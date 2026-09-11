export function logLine(el: HTMLElement, msg: string, cls = 'text-green-400') {
  const t = new Date().toLocaleTimeString('en-GB', { hour12: false });
  const div = document.createElement('div');
  div.className = cls;
  div.textContent = `[${t}] ${msg}`;
  el.appendChild(div);
  el.scrollTop = el.scrollHeight;
  while (el.children.length > 220) el.removeChild(el.firstChild!);
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
