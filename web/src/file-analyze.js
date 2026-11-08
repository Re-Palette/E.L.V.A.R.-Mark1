// One file in, its "memory" out: read the Blob in chunks (with progress and cancel), SHA-256, extract the text, build the index.
// Runs in file-worker.js (a Web Worker) so a 60 MB file never blocks the screen; the same function is the main-thread fallback (it then yields between steps).
import { sha256Hex, buildIndex } from './file-index.js';
import { extractFile } from './file-extract.js';
import { classify, extOf } from './file-lib.js';

const aborted = (signal) => { if (signal?.aborted) throw Object.assign(new Error('中止しました'), { cancelled: true }); };

/** Read a Blob into memory chunk by chunk, so progress can be shown and a cancel takes effect quickly. */
export async function readBlob(blob, { onProgress, signal, yieldFn } = {}) {
  const size = blob.size, buf = new Uint8Array(size), reader = blob.stream().getReader(); let n = 0, last = 0;
  for (;;) {
    aborted(signal);
    const { done, value } = await reader.read(); if (done) break;
    buf.set(value, n); n += value.length;
    if (n - last >= 1024 * 1024 || n === size) { last = n; onProgress?.({ stage: '読み込み中', done: n, total: size }); if (yieldFn) await yieldFn(); }
  }
  return buf;
}

/**
 * @returns {Promise<{sha256:string, index:object, text:string}>}  rejects only when cancelled (e.cancelled); extraction problems are recorded in index.status / index.error.
 */
export async function analyzeBlob(blob, { name, type = '', docFreq = null, docCount = 0, onProgress, signal, loadPdfjs, cMapUrl, yieldFn, now } = {}) {
  const c = classify(name, type), ext = extOf(name);
  const bytes = await readBlob(blob, { onProgress, signal, yieldFn });
  aborted(signal); onProgress?.({ stage: '同じファイルがないか確認中' });
  const sha256 = await sha256Hex(bytes);
  aborted(signal);
  const ex = await extractFile(blob, { name, type, signal, onProgress, loadPdfjs, cMapUrl, yieldFn, bytes: c.kind === 'pdf' ? bytes : undefined });
  if (ex.status === 'cancelled') throw Object.assign(new Error('中止しました'), { cancelled: true });
  onProgress?.({ stage: '記憶を作成中' });
  const r = buildIndex(ex, { name, ext, size: blob.size, sha256, docFreq, docCount, now });
  return { sha256, index: r.index, text: r.text };
}
