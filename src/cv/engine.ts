import { FilesetResolver, PoseLandmarker, ImageSegmenter } from '@mediapipe/tasks-vision';
import { poseFeatures, type Pt } from './metrics';

export interface FrameInfo {
  personFrac: number; // 0..1 fraction of frame = person (mask) or bbox fallback
  fromMask: boolean;
  segW: number; segH: number;
  landmarks: Pt[] | null;
  hasPerson: boolean;
  fps: number;
}

// JS wrapper (npm) and WASM glue must be the same version — WASM is self-hosted
// in public/wasm so the app never depends on a third-party CDN for the runtime.
const VISION_VERSION = '0.10.35';
const LOCAL_WASM = `${import.meta.env.BASE_URL || './'}wasm`;

function wasmMirrors(): string[] {
  return [
    LOCAL_WASM,
    `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${VISION_VERSION}/wasm`,
    `https://unpkg.com/@mediapipe/tasks-vision@${VISION_VERSION}/wasm`,
  ];
}
const POSE_URL = 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task';
const SEG_URL = 'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_multiclass_256x256/float32/1/selfie_multiclass_256x256.tflite';

export class CVEngine {
  video: HTMLVideoElement;
  pose: PoseLandmarker | null = null;
  segmenter: ImageSegmenter | null = null;
  maskOK = false;
  running = false;
  private raf = 0;
  private lastT = 0;
  private lastFpsT = performance.now();
  private frames = 0;
  fps = 0;
  onFrame: (f: FrameInfo) => void = () => {};
  onStatus: (s: string) => void = () => {};

  constructor(video: HTMLVideoElement) { this.video = video; }

  async init() {
    this.onStatus('loading vision runtime...');
    let fileset = null;
    for (const mirror of wasmMirrors()) {
      try {
        fileset = await FilesetResolver.forVisionTasks(mirror);
        break;
      } catch (e) {
        const detail = (typeof Event !== 'undefined' && e instanceof Event)
          ? 'script/binary failed to load (blocked or unreachable)'
          : ((e as any)?.message ?? e);
        console.warn(`vision runtime mirror failed: ${mirror} —`, detail);
        this.onStatus(`runtime mirror failed, trying next... (${mirror})`);
      }
    }
    if (!fileset) throw new Error('vision runtime unreachable (same-origin + jsdelivr + unpkg all failed)');
    this.onStatus('loading pose model...');
    try {
      this.pose = await PoseLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: POSE_URL, delegate: 'GPU' },
        runningMode: 'VIDEO', numPoses: 1,
        minPoseDetectionConfidence: 0.5, minPosePresenceConfidence: 0.5, minTrackingConfidence: 0.5,
      } as any);
    } catch {
      this.pose = await PoseLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: POSE_URL, delegate: 'CPU' },
        runningMode: 'VIDEO', numPoses: 1,
      } as any);
    }
    this.onStatus('loading segmentation model...');
    try {
      this.segmenter = await ImageSegmenter.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: SEG_URL, delegate: 'GPU' },
        runningMode: 'VIDEO',
        outputCategoryMask: true,
        outputConfidenceMasks: false,
      } as any);
      this.maskOK = true;
    } catch (e) {
      console.warn('segmenter failed, bbox fallback', e);
      this.maskOK = false;
    }
    this.onStatus(this.maskOK ? 'engine: mask+pose ready' : 'engine: pose-only (bbox fallback)');
  }

  async startCamera(): Promise<void> {
    if (!navigator.mediaDevices?.getUserMedia) {
      const ctx = window.isSecureContext ? '' : ' (page is not a secure context — camera requires HTTPS)';
      throw new Error(`camera API unavailable in this browser${ctx}`);
    }
    // property assignments (not just attributes) so autoplay policies accept play()
    this.video.muted = true;
    this.video.playsInline = true;
    this.video.setAttribute('playsinline', '');
    this.video.setAttribute('muted', '');

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' },
        audio: false,
      });
    } catch (e: any) {
      if (e?.name === 'OverconstrainedError' || e?.name === 'ConstraintNotSatisfiedError') {
        stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      } else throw e;
    }
    this.video.srcObject = stream;
    try {
      await this.video.play();
    } catch (e: any) {
      const me = this.video.error as any;
      const suffix = me && typeof me.code === 'number'
        ? ` (media error code ${me.code}${me.message ? ': ' + me.message : ''})`
        : '';
      stream.getTracks().forEach(t => t.stop());
      this.video.srcObject = null;
      throw new Error(`video.play failed${suffix}: ${e?.name ? `[${e.name}] ` : ''}${e?.message ?? e}`);
    }
    // confirm frames are actually flowing (catches killed/black tracks)
    await new Promise<void>((resolve, reject) => {
      if (this.video.readyState >= 2 && this.video.videoWidth > 0) return resolve();
      const to = window.setTimeout(() => reject(new Error('camera stream opened but no frames arrived (track ended?)')), 8000);
      const iv = window.setInterval(() => {
        if (this.video.readyState >= 2 && this.video.videoWidth > 0) {
          window.clearTimeout(to); window.clearInterval(iv); resolve();
        }
      }, 200);
    });
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.lastT = 0;
    const loop = () => {
      if (!this.running) return;
      this.raf = requestAnimationFrame(loop);
      const now = performance.now();
      if (now - this.lastT < 66) return; // ~15fps
      if (this.video.readyState < 2 || this.video.videoWidth === 0) return;
      this.lastT = now;
      this.frames++;
      if (now - this.lastFpsT > 1000) { this.fps = this.frames; this.frames = 0; this.lastFpsT = now; }
      this.process(now);
    };
    loop();
  }

  stop() { this.running = false; cancelAnimationFrame(this.raf); }

  private process(now: number) {
    let landmarks: Pt[] | null = null;
    let hasPerson = false;
    try {
      if (this.pose) {
        const r = this.pose.detectForVideo(this.video, now);
        const lm = r.landmarks?.[0] as any;
        if (lm && lm.length >= 29) {
          landmarks = lm.map((p: any) => ({ x: p.x, y: p.y, v: p.visibility ?? 1 }));
          const f = poseFeatures(landmarks);
          hasPerson = f.ok;
        }
      }
    } catch (e) { console.warn('pose err', e); }

    let personFrac = 0;
    let fromMask = false;
    let segW = 0, segH = 0;
    if (this.segmenter && this.maskOK) {
      try {
        const r = this.segmenter.segmentForVideo(this.video, now);
        const mask: any = (r as any).categoryMask;
        if (mask) {
          segW = mask.width; segH = mask.height;
          let arr: ArrayLike<number> | null = null;
          try {
            arr = mask.getAsUint8Array();
          } catch {
            try { arr = (mask as any).getAsFloat32Array(); } catch { arr = null; }
          }
          if (!arr) return;
          let c = 0;
          // sample every 2nd pixel for speed (ratio unaffected)
          for (let i = 0; i < arr.length; i += 2) if (arr[i] !== 0) c++;
          personFrac = (c * 2) / arr.length;
          fromMask = true;
          try { mask.close?.(); } catch {}
          try { (r as any).close?.(); } catch {}
          if (personFrac > 0.02) hasPerson = true;
        }
      } catch (e) { console.warn('seg err', e); }
    }

    if (!fromMask) {
      // bbox fallback
      if (landmarks) {
        const f = poseFeatures(landmarks);
        personFrac = f.ok ? Math.max(0.02, f.bboxArea) : 0;
        segW = 0; segH = 0;
      }
    }

    this.onFrame({ personFrac, fromMask, segW, segH, landmarks, hasPerson, fps: this.fps });
  }
}
