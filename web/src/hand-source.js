// ヒューマンプロトコル: the camera + hand detector ("HandSource": start() / stop() / onFrame(cb)).
// Privacy: the front camera runs only while the protocol is on; frames are analysed here in the browser by MediaPipe HandLandmarker and
// are never sent anywhere, stored or recorded — this module makes no network request except loading the detector itself
// (its WASM from this site, its model file). Only landmark coordinates leave this module, and only to the page (hand-gesture.js).
// Loaded with import() the first time hand tracking starts; MediaPipe itself is imported only then too.

const WASM_BASE = '/mediapipe';   // vision_wasm_module_internal.js / .wasm (the ES-module build), copied into the build by web/vite.config.js
// The model is not part of the npm package: the official file (Google's model storage); a copy at /mediapipe/hand_landmarker.task is used first if present.
const MODEL_LOCAL = '/mediapipe/hand_landmarker.task';
const MODEL_REMOTE = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';
const FPS = 24;

async function modelUrl() {
  const local = await fetch(MODEL_LOCAL, { method: 'HEAD' }).then((r) => r.ok && !/text\/html/.test(r.headers.get('content-type') || '')).catch(() => false);
  return local ? new URL(MODEL_LOCAL, location.href).href : MODEL_REMOTE;
}

// The detector runs in a Worker (its start — a 14 MB WASM, the model, a GPU context — and each inference stay off the main thread);
// where Workers / ImageBitmaps are missing it runs here, as before. Either way: detect(video, ts) → Promise<hands>.
let detectorP = null;
function getDetector() {
  detectorP ||= (async () => {
    const model = await modelUrl(), wasmBase = new URL(WASM_BASE, location.href).href;
    if (typeof Worker === 'function' && typeof createImageBitmap === 'function') {
      try {
        const w = new Worker(new URL('./hand-worker.js', import.meta.url), { type: 'module' });
        await new Promise((ok, fail) => {
          const to = setTimeout(() => fail(new Error('worker start timed out')), 60000);
          w.onmessage = (e) => { if (e.data?.type === 'ready') { clearTimeout(to); ok(); } else if (e.data?.type === 'error') { clearTimeout(to); fail(new Error(e.data.message)); } };
          w.onerror = (e) => { clearTimeout(to); fail(new Error(e.message || 'worker error')); };
          w.postMessage({ type: 'init', wasmBase, model });
        });
        const waiting = new Map();
        w.onmessage = (e) => { const r = e.data; if (r?.type === 'hands') { waiting.get(r.ts)?.(r.hands); waiting.delete(r.ts); } };
        return {
          kind: 'worker',
          async detect(video, ts) { const bitmap = await createImageBitmap(video); return new Promise((ok) => { waiting.set(ts, ok); w.postMessage({ type: 'frame', bitmap, ts }, [bitmap]); }); },
        };
      } catch (e) { console.warn('[hand] worker detector unavailable, running it on the page:', e?.message ?? e); }
    }
    const { FilesetResolver, HandLandmarker } = await import('@mediapipe/tasks-vision');
    const files = await FilesetResolver.forVisionTasks(wasmBase, true);
    const make = (delegate) => HandLandmarker.createFromOptions(files, { baseOptions: { modelAssetPath: model, delegate }, runningMode: 'VIDEO', numHands: 2, minHandDetectionConfidence: 0.55, minHandPresenceConfidence: 0.5, minTrackingConfidence: 0.5 });
    let lm; try { lm = await make('GPU'); } catch (e) { console.warn('[hand] GPU delegate unavailable, using CPU:', e?.message ?? e); lm = await make('CPU'); }
    return { kind: 'page', async detect(video, ts) { return (lm.detectForVideo(video, ts)?.landmarks || []).map((h) => h.map((p) => ({ x: p.x, y: p.y, z: p.z }))); } };
  })().catch((e) => { detectorP = null; throw e; });
  return detectorP;
}

/**
 * @param {{ preview?: HTMLElement|null }} [opts]  preview: an element to show a small mirrored camera preview in (debug only)
 * @returns {{ start(): Promise<boolean>, stop(): void, onFrame(cb: (hands: Array<Array<{x:number,y:number,z:number}>>, tSec: number) => void): void, readonly active: boolean, readonly stream: MediaStream|null }}
 */
export function createMediaPipeHandSource({ preview = null } = {}) {
  let stream = null, video = null, cb = () => {}, running = false, rvfc = 0, timer = 0, lastAt = 0, seq = 0, busy = false, kind = '';
  async function start() {
    if (running) return true;
    const my = ++seq;
    if (!navigator.mediaDevices?.getUserMedia) { console.warn('[hand] no camera API'); return false; }
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 30, max: 30 } } });
    } catch (e) { console.warn('[hand] camera not available:', e?.name || e?.message || e); stream = null; return false; }
    if (my !== seq) { stop(); return false; }   // stopped while the permission prompt was open
    video = document.createElement('video'); video.muted = true; video.playsInline = true; video.autoplay = true; video.srcObject = stream;
    if (preview) { video.style.cssText = 'width:100%;height:100%;object-fit:cover;transform:scaleX(-1);display:block'; preview.replaceChildren(video); }
    try { await video.play(); } catch {}
    let det;   // (kept in `kind` for the debug view)
    try { det = await getDetector(); kind = det.kind; } catch (e) { console.warn('[hand] hand detector could not be loaded:', e?.message ?? e); stop(); return false; }
    if (my !== seq) { stop(); return false; }
    running = true;
    const tick = () => {
      if (!running) return;
      const now = performance.now();
      if (!busy && now - lastAt >= 1000 / FPS - 2 && video.readyState >= 2) {   // one frame in flight at a time: a slow device just analyses fewer
        lastAt = now; busy = true;
        det.detect(video, now).then((hands) => { busy = false; if (running) cb(hands, now / 1000); }, (e) => { busy = false; console.warn('[hand] detection failed:', e?.message ?? e); });
      }
      if (video.requestVideoFrameCallback) rvfc = video.requestVideoFrameCallback(tick); else timer = setTimeout(tick, 1000 / FPS);
    };
    tick();
    return true;
  }
  function stop() {
    seq++; running = false;
    try { if (rvfc && video?.cancelVideoFrameCallback) video.cancelVideoFrameCallback(rvfc); } catch {}
    clearTimeout(timer); rvfc = 0;
    for (const tr of stream?.getTracks?.() || []) { try { tr.stop(); } catch {} }   // the camera light goes off at once
    stream = null;
    if (video) { video.srcObject = null; video.remove(); video = null; }
  }
  return { start, stop, onFrame(f) { cb = typeof f === 'function' ? f : () => {}; }, get active() { return running; }, get detector() { return kind; }, get stream() { return stream; } };
}
