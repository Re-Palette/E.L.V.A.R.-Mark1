// ヒューマンプロトコル: the hand detector in a Worker, so its heavy start (a 14 MB WASM, the model, a GPU context) and every
// inference run off the page's main thread (no freeze of the animation). Frames arrive as ImageBitmaps (transferred, closed after use);
// only landmark coordinates go back. No network use here except MediaPipe loading its own WASM / model. Nothing is stored.
import { FilesetResolver, HandLandmarker } from '@mediapipe/tasks-vision';

let lm = null;
async function init({ wasmBase, model }) {
  const files = await FilesetResolver.forVisionTasks(wasmBase, true);   // the ES-module build of the WASM loader (works in a module worker)
  const make = (delegate) => HandLandmarker.createFromOptions(files, { baseOptions: { modelAssetPath: model, delegate }, runningMode: 'VIDEO', numHands: 2, minHandDetectionConfidence: 0.55, minHandPresenceConfidence: 0.5, minTrackingConfidence: 0.5 });
  try { lm = await make('GPU'); } catch { lm = await make('CPU'); }
}

self.onmessage = async (e) => {
  const m = e.data || {};
  if (m.type === 'init') {
    try { await init(m); self.postMessage({ type: 'ready' }); } catch (err) { self.postMessage({ type: 'error', message: String(err?.message ?? err) }); }
  } else if (m.type === 'frame') {
    let hands = [];
    try { if (lm) hands = (lm.detectForVideo(m.bitmap, m.ts)?.landmarks || []).map((h) => h.map((p) => ({ x: p.x, y: p.y, z: p.z }))); } catch {}
    finally { try { m.bitmap.close(); } catch {} }
    self.postMessage({ type: 'hands', hands, ts: m.ts });
  } else if (m.type === 'close') {
    try { lm?.close(); } catch {}
    lm = null; self.close();
  }
};
