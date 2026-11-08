// Starts the analysis of a file in a Web Worker (falls back to the main thread, in small steps, when workers are not available). Returns a handle with cancel().
const yieldFn = () => new Promise((r) => setTimeout(r, 0));

/**
 * @param {File|Blob} file
 * @param {{name:string,mime?:string,docFreq?:object,docCount?:number,onProgress?:(p:{stage:string,done?:number,total?:number})=>void}} o
 * @returns {{promise:Promise<{sha256:string,index:object,text:string}>, cancel:()=>void}}  the promise rejects with {cancelled:true} when cancelled
 */
export function startAnalysis(file, o) {
  let worker = null, ctrl = null, settled = false, rejectFn = null;
  const promise = new Promise((resolve, reject) => {
    rejectFn = reject;
    const fallback = async () => {
      ctrl = new AbortController();
      try {
        const [{ analyzeBlob }, { loadPdfjs, CMAP_URL }] = await Promise.all([import('./file-analyze.js'), import('./file-pdfjs.js')]);
        resolve(await analyzeBlob(file, { name: o.name, type: o.mime, docFreq: o.docFreq, docCount: o.docCount, signal: ctrl.signal, loadPdfjs, cMapUrl: CMAP_URL, onProgress: o.onProgress, yieldFn }));
      } catch (e) { reject(e); }
    };
    try {
      worker = new Worker(new URL('./file-worker.js', import.meta.url), { type: 'module' });
    } catch { fallback(); return; }
    worker.onmessage = (e) => {
      const m = e.data || {};
      if (m.type === 'progress') o.onProgress?.(m);
      else if (m.type === 'done') { settled = true; worker.terminate(); resolve(m.result); }
      else if (m.type === 'cancelled') { settled = true; worker.terminate(); reject(Object.assign(new Error('中止しました'), { cancelled: true })); }
      else if (m.type === 'error') { settled = true; worker.terminate(); reject(new Error(m.error || '読み取りに失敗しました')); }
    };
    worker.onerror = (ev) => { if (settled) return; settled = true; try { worker.terminate(); } catch { /* ignore */ } worker = null; ev.preventDefault?.(); fallback(); };   // the worker could not start (blocked / unsupported): do it here, in small steps
    worker.postMessage({ type: 'analyze', blob: file, name: o.name, mime: o.mime, docFreq: o.docFreq, docCount: o.docCount });
  });
  const cancel = () => {
    if (ctrl) ctrl.abort();
    if (worker && !settled) { try { worker.postMessage({ type: 'cancel' }); } catch { /* ignore */ } const w = worker; setTimeout(() => { if (!settled) { settled = true; try { w.terminate(); } catch { /* ignore */ } rejectFn?.(Object.assign(new Error('中止しました'), { cancelled: true })); } }, 400); }
  };
  return { promise, cancel };
}
