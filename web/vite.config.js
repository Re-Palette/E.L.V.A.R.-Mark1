import { defineConfig } from 'vite';
import { createReadStream, copyFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

// ヒューマンプロトコルの手のトラッキング: MediaPipe's WASM is served from this site (/mediapipe/…), not from a CDN.
// It is copied out of node_modules into the build (and served from there by the dev server); it is fetched only when hand tracking starts.
const MP_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'node_modules', '@mediapipe', 'tasks-vision', 'wasm');
const MP_FILES = ['vision_wasm_module_internal.js', 'vision_wasm_module_internal.wasm'];   // the ES-module build: loadable in a module Worker
function mediapipeWasm() {
  let outDir = 'dist';
  return {
    name: 'elvar-mediapipe-wasm',
    configResolved(c) { outDir = resolve(c.root, c.build.outDir); },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const m = req.url && req.url.match(/^\/mediapipe\/(vision_wasm_module_internal\.(?:js|wasm))(?:\?.*)?$/);
        if (!m || !existsSync(join(MP_DIR, m[1]))) return next();
        res.setHeader('content-type', m[1].endsWith('.wasm') ? 'application/wasm' : 'text/javascript');
        createReadStream(join(MP_DIR, m[1])).pipe(res);
      });
    },
    writeBundle() {
      if (!existsSync(MP_DIR)) { console.warn('[mediapipe] @mediapipe/tasks-vision not installed: hand tracking will be unavailable'); return; }
      const dst = join(outDir, 'mediapipe'); mkdirSync(dst, { recursive: true });
      for (const f of MP_FILES) copyFileSync(join(MP_DIR, f), join(dst, f));
    },
  };
}

// ファイルの中身の読み取り(PDF): pdfjs-dist's character maps (needed to read Japanese text of PDFs that do not embed their fonts) are served from this site
// (/pdfjs-cmaps/...) and fetched one by one only when such a PDF is read. Copied out of node_modules into the build, like the MediaPipe files above.
const CMAP_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'node_modules', 'pdfjs-dist', 'cmaps');
function pdfjsCmaps() {
  let outDir = 'dist';
  return {
    name: 'elvar-pdfjs-cmaps',
    configResolved(c) { outDir = resolve(c.root, c.build.outDir); },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const m = req.url && req.url.match(/^\/pdfjs-cmaps\/([\w-]+\.bcmap)(?:\?.*)?$/);
        if (!m || !existsSync(join(CMAP_DIR, m[1]))) return next();
        res.setHeader('content-type', 'application/octet-stream');
        createReadStream(join(CMAP_DIR, m[1])).pipe(res);
      });
    },
    writeBundle() {
      if (!existsSync(CMAP_DIR)) { console.warn('[pdfjs] pdfjs-dist cmaps not found: Japanese PDFs without embedded fonts may not be readable'); return; }
      const dst = join(outDir, 'pdfjs-cmaps'); mkdirSync(dst, { recursive: true });
      for (const f of readdirSync(CMAP_DIR)) if (f.endsWith('.bcmap')) copyFileSync(join(CMAP_DIR, f), join(dst, f));
    },
  };
}

export default defineConfig({
  plugins: [mediapipeWasm(), pdfjsCmaps()],
  worker: { format: 'es' },   // the file-reading worker lazy-loads pdfjs (code splitting needs ES workers)
  server: {
    port: 5173,
    fs: { allow: ['..'] },   // ../shared (tz, profile schema) is imported by the app
    // The API server trusts a request from this machine as the owner only before setup. Requests that reach Vite from another device
    // (vite --host) are marked with x-forwarded-for so the API server does not mistake them for local ones.
    proxy: { '/api': { target: 'http://127.0.0.1:8787', configure: (proxy) => proxy.on('proxyReq', (pReq, req) => {
      const a = req.socket?.remoteAddress || '';
      if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(a)) pReq.setHeader('x-forwarded-for', a || 'unknown');
    }) } },
  },
  build: { outDir: 'dist', emptyOutDir: true },
});
