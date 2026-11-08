// pdfjs-dist, loaded only when a PDF is read (a lazy chunk, never part of the main bundle). The worker module runs inside the caller (we are already in a Web Worker).
let p = null;
export function loadPdfjs() {
  return p ??= (async () => {
    const [lib, worker] = await Promise.all([import('pdfjs-dist/legacy/build/pdf.mjs'), import('pdfjs-dist/legacy/build/pdf.worker.mjs')]);
    globalThis.pdfjsWorker = { WorkerMessageHandler: worker.WorkerMessageHandler };
    return lib;
  })();
}
export const CMAP_URL = '/pdfjs-cmaps/';
