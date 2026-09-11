/** A reversible, user-controlled demonstration. No camera or timed intro. */
export function initIntro() {
  const intro = document.getElementById('intro')!;
  const app = document.getElementById('app')!;
  const handle = document.getElementById('demoHandle')!;
  const stage = document.getElementById('demoMachine')!;
  const status = document.getElementById('demoStatus')!;
  const toggle = document.getElementById('demoToggle') as HTMLButtonElement;
  let value = 0;
  let pointer: number | null = null;
  let keyboard = false;

  function setValue(next: number, released = false) {
    value = Math.max(0, Math.min(100, next));
    const p = value / 100;
    stage.style.setProperty('--compression', String(p));
    stage.style.setProperty('--standing', String(1 - Math.min(1, p / .55)));
    stage.style.setProperty('--crouched', String(Math.min(1, p / .55) * (1 - Math.max(0, (p - .78) / .12))));
    stage.dataset.pose = value >= 90 ? 'zipped' : value > 5 ? 'crouching' : 'standing';
    handle.setAttribute('aria-valuenow', String(Math.round(value)));
    handle.setAttribute('aria-valuetext', value >= 90 ? 'Human zipped. Release to extract.' : value > 5 ? 'Human crouching' : 'Human standing');
    toggle.textContent = value >= 90 ? 'Extract human ↑' : 'Zip human ↓';
    toggle.setAttribute('aria-pressed', String(value >= 90));
    status.textContent = released ? 'Human restored. In the real game, unfold to extract.'
      : value >= 90 ? 'human.zip created. Let go to extract.'
      : value > 5 ? 'Getting smaller. In the game, tuck your arms and bend your knees.'
      : 'Drag the yellow handle down. You’re in control.';
  }
  function release() {
    pointer = null; keyboard = false; stage.classList.remove('is-dragging');
    setValue(0, true);
  }
  function move(y: number) {
    const rect = handle.getBoundingClientRect();
    setValue((y - rect.top - 25) / Math.max(1, rect.height - 50) * 100);
  }
  handle.addEventListener('pointerdown', e => {
    if (pointer !== null || (e.pointerType === 'mouse' && e.button !== 0)) return;
    e.preventDefault(); pointer = e.pointerId;
    stage.classList.add('is-dragging'); handle.setPointerCapture(e.pointerId); handle.focus({ preventScroll: true }); move(e.clientY);
  });
  handle.addEventListener('pointermove', e => { if (pointer === e.pointerId) move(e.clientY); });
  handle.addEventListener('pointerup', e => { if (pointer === e.pointerId) release(); });
  handle.addEventListener('pointercancel', release);
  handle.addEventListener('lostpointercapture', () => { if (pointer !== null) release(); });
  const keys = ['ArrowDown', 'ArrowRight', 'ArrowUp', 'ArrowLeft', 'Home', 'End', ' '];
  handle.addEventListener('keydown', e => {
    if (!keys.includes(e.key)) return;
    e.preventDefault(); keyboard = true; stage.classList.add('is-dragging');
    setValue(e.key === 'End' || e.key === ' ' ? 100 : e.key === 'Home' ? 0 : value + (e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 10 : -10));
  });
  handle.addEventListener('keyup', e => { if (keys.includes(e.key)) { e.preventDefault(); release(); } });
  handle.addEventListener('blur', () => { if (keyboard) release(); });
  toggle.onclick = () => { stage.classList.remove('is-dragging'); setValue(value >= 90 ? 0 : 100, value >= 90); };
  document.addEventListener('visibilitychange', () => { if (document.hidden) release(); });

  function enter() {
    release(); intro.hidden = true; app.hidden = false; app.inert = false;
    try { sessionStorage.setItem('physical-zip.intro-seen', '1'); } catch {}
    window.dispatchEvent(new Event('resize'));
    document.getElementById('btnCam')!.focus({ preventScroll: true });
  }
  function showDemo() {
    intro.hidden = false; app.hidden = true; app.inert = true; setValue(0);
    document.getElementById('enterMachine')!.focus({ preventScroll: true });
  }
  document.getElementById('enterMachine')!.onclick = enter;
  document.getElementById('skipIntro')!.onclick = enter;
  document.getElementById('replayIntro')!.onclick = showDemo;
  document.querySelector<HTMLAnchorElement>('.skip-link')!.onclick = e => { e.preventDefault(); enter(); };
  let seen = false;
  try { seen = sessionStorage.getItem('physical-zip.intro-seen') === '1'; } catch {}
  if (seen) enter(); else { app.inert = true; setValue(0); }
}
