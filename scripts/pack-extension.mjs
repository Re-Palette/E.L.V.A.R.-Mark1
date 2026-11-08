// Zips ./extension into web/public/elvar-extension.zip (top folder "elvar-extension/") so the deployed app can serve it.
// Dependency-free ZIP writer (deflate); deterministic timestamps. Runs as part of `npm run build`.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = path.join(root, 'extension');
const outFile = path.join(root, 'web', 'public', 'elvar-extension.zip');

const table = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (buf) => { let c = 0xffffffff; for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };

const DOS_TIME = (12 << 11) | (0 << 5) | 0;              // 12:00:00
const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1;    // 2026-01-01 (fixed => reproducible)

function walk(dir, base = '') {
  return fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap((e) =>
    e.isDirectory() ? walk(path.join(dir, e.name), base + e.name + '/') : [{ name: base + e.name, data: fs.readFileSync(path.join(dir, e.name)) }]);
}

const files = walk(srcDir).filter((f) => !f.name.endsWith('.DS_Store'));
const locals = [], centrals = []; let offset = 0;
for (const f of files) {
  const name = Buffer.from('elvar-extension/' + f.name, 'utf8');
  const comp = zlib.deflateRawSync(f.data, { level: 9 });
  const crc = crc32(f.data);
  const lh = Buffer.alloc(30);
  lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(8, 8);
  lh.writeUInt16LE(DOS_TIME, 10); lh.writeUInt16LE(DOS_DATE, 12); lh.writeUInt32LE(crc, 14);
  lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(f.data.length, 22); lh.writeUInt16LE(name.length, 26); lh.writeUInt16LE(0, 28);
  locals.push(lh, name, comp);
  const ch = Buffer.alloc(46);
  ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8); ch.writeUInt16LE(8, 10);
  ch.writeUInt16LE(DOS_TIME, 12); ch.writeUInt16LE(DOS_DATE, 14); ch.writeUInt32LE(crc, 16);
  ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(f.data.length, 24); ch.writeUInt16LE(name.length, 28);
  ch.writeUInt32LE(offset, 42);
  centrals.push(ch, name);
  offset += lh.length + name.length + comp.length;
}
const cd = Buffer.concat(centrals);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, Buffer.concat([...locals, cd, end]));
fs.copyFileSync(path.join(root, 'scripts', 'google-auth.mjs'), path.join(root, 'web', 'public', 'google-auth.mjs'));   // served at /google-auth.mjs
console.log(`[pack-extension] ${files.length} files -> ${path.relative(root, outFile)} (${fs.statSync(outFile).size} bytes)`);
