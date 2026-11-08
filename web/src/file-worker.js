// Web Worker: analyses one file (hash + text extraction + index) off the main thread. Messages: {type:'analyze', blob, name, mime, docFreq, docCount} | {type:'cancel'}
// -> {type:'progress', stage, done?, total?} ... {type:'done', result} | {type:'cancelled'} | {type:'error', error}
import { analyzeBlob } from './file-analyze.js';
import { loadPdfjs, CMAP_URL } from './file-pdfjs.js';

let ctrl = null;
self.onmessage = async (e) => {
  const m = e.data || {};
  if (m.type === 'cancel') { ctrl?.abort(); return; }
  if (m.type !== 'analyze') return;
  ctrl = new AbortController();
  try {
    const result = await analyzeBlob(m.blob, { name: m.name, type: m.mime, docFreq: m.docFreq, docCount: m.docCount, signal: ctrl.signal, loadPdfjs, cMapUrl: CMAP_URL, onProgress: (p) => self.postMessage({ type: 'progress', ...p }) });
    self.postMessage({ type: 'done', result });
  } catch (err) { self.postMessage({ type: err?.cancelled ? 'cancelled' : 'error', error: String(err?.message || err) }); }
};
