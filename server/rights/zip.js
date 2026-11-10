// A small zip writer (no dependency): the parts of the data export (docs/ELVAR_MULTIUSER.md 7.3). Entries are deflated (or stored, for data that is already compressed),
// names are UTF-8 (so Japanese file names survive), the checksum is zlib's CRC-32. One zip is held in memory until finish(): the export step closes a part before it gets big
// (about 100 MB), it never builds the whole export in one piece. Plain zip (no zip64): a part stays far below 4 GB and the export closes a part at MAX_ENTRIES (60,000)
// entries, before the 65,535 the format allows. Entry names are made safe for every system that opens the zip (safeEntryName): a name is renamed, never a reason to fail the export.
import zlib from 'node:zlib';

const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; };
/** MS-DOS date / time of an instant (zip stores local-looking fields; UTC is fine). */
function dos(ms) { const d = new Date(ms); return { time: (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | (d.getUTCSeconds() >> 1), date: (Math.max(0, d.getUTCFullYear() - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate() }; }

/** The entries one plain zip can hold is 65,535: the export closes a part before this many. */
export const MAX_ENTRIES = 60000;
const WIN_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
/**
 * A name that Windows, macOS and Linux unzip tools all accept: `\` and the characters Windows forbids (< > : " | ? * and control characters) become `_`, a segment never ends
 * in a dot or a space, device names (CON, NUL, ...) get a leading `_`, empty segments are dropped, `.` and `..` become `_` / `__` (no traversal), and a name longer than
 * 500 bytes is shortened (the extension stays). Returns '' when nothing is left.
 */
export function safeEntryName(name) {
  const segs = String(name).split('/').map((seg) => {
    let s = seg.replace(/[\u0000-\u001f\u007f<>:"|?*\\]/g, '_').replace(/[. ]+$/, (m) => '_'.repeat(m.length));
    if (s === '.') s = '_'; if (s === '..') s = '__';
    return WIN_RESERVED.test(s) ? '_' + s : s;
  }).filter((s) => s !== '');
  let out = segs.join('/');
  if (Buffer.byteLength(out) > 500) {
    const last = segs.pop() || '', dot = last.lastIndexOf('.'), ext = dot > 0 && last.length - dot <= 12 ? last.slice(dot) : '', head = segs.length ? segs.join('/') + '/' : '';
    let stem = ext ? last.slice(0, dot) : last;
    while (stem.length > 1 && Buffer.byteLength(head + stem + ext) > 500) stem = stem.slice(0, -1);
    out = head + stem + ext;
    if (Buffer.byteLength(out) > 500) out = out.slice(0, 120);   // an absurd directory part: keep something that fits
  }
  return out;
}

/** Data that is compressed already: storing it saves time and does not make it bigger. */
export const isCompressed = (name) => /\.(zip|gz|png|jpe?g|webp|gif|pdf|docx|xlsx|pptx|mp3|mp4|m4a)$/i.test(String(name));

export function createZip({ now = () => Date.now() } = {}) {
  const chunks = [], central = []; let offset = 0, size = 0; const names = new Set();
  return {
    /** @param {string} name path inside the zip (made safe by safeEntryName; a name already taken in this part becomes "name (2).ext")  @param {Buffer|Uint8Array|string} data @returns {string} the name used */
    add(name, data, { store = isCompressed(name) } = {}) {
      name = safeEntryName(name);
      if (!name) throw new Error('bad zip entry name');
      if (names.has(name)) {
        const dot = name.lastIndexOf('.'), slash = name.lastIndexOf('/'), ext = dot > slash + 1 ? name.slice(dot) : '', stem = ext ? name.slice(0, dot) : name;
        for (let i = 2; ; i++) { const cand = safeEntryName(`${stem} (${i})${ext}`); if (!names.has(cand)) { name = cand; break; } }
      }
      names.add(name);
      const raw = Buffer.isBuffer(data) ? data : Buffer.from(data), crc = zlib.crc32(raw), body = store || raw.length < 64 ? raw : zlib.deflateRawSync(raw, { level: 6 });
      const method = body === raw ? 0 : 8, nm = Buffer.from(name), t = dos(now());
      const local = Buffer.concat([u32(0x04034b50), u16(20), u16(0x0800), u16(method), u16(t.time), u16(t.date), u32(crc), u32(body.length), u32(raw.length), u16(nm.length), u16(0), nm]);
      central.push({ nm, method, crc, csize: body.length, usize: raw.length, off: offset, t });
      chunks.push(local, body); offset += local.length + body.length; size += local.length + body.length;
      return name;
    },
    get entries() { return central.length; },
    /** Bytes written so far (compressed): the caller closes the part when this is big enough. */
    get size() { return size; },
    finish() {
      const start = offset, cd = [];
      for (const e of central) cd.push(Buffer.concat([u32(0x02014b50), u16(20), u16(20), u16(0x0800), u16(e.method), u16(e.t.time), u16(e.t.date), u32(e.crc), u32(e.csize), u32(e.usize), u16(e.nm.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(e.off), e.nm]));
      const dir = Buffer.concat(cd), end = Buffer.concat([u32(0x06054b50), u16(0), u16(0), u16(central.length), u16(central.length), u32(dir.length), u32(start), u16(0)]);
      return Buffer.concat([...chunks, dir, end]);
    },
  };
}

/** Read a zip made by createZip (tests and the export self-check): { name -> Buffer }. Checks every CRC-32. */
export function readZip(buf) {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06])); if (eocd < 0) throw new Error('not a zip');
  const n = buf.readUInt16LE(eocd + 10), dirOff = buf.readUInt32LE(eocd + 16), out = {};
  let p = dirOff;
  for (let i = 0; i < n; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('bad central directory');
    const method = buf.readUInt16LE(p + 10), crc = buf.readUInt32LE(p + 16), csize = buf.readUInt32LE(p + 20), nlen = buf.readUInt16LE(p + 28), elen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32), off = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nlen).toString('utf8'), lnlen = buf.readUInt16LE(off + 26), lelen = buf.readUInt16LE(off + 28), data = buf.subarray(off + 30 + lnlen + lelen, off + 30 + lnlen + lelen + csize);
    const raw = method === 8 ? zlib.inflateRawSync(data) : Buffer.from(data);
    if (zlib.crc32(raw) !== crc) throw new Error(`bad checksum: ${name}`);
    out[name] = raw; p += 46 + nlen + elen + clen;
  }
  return out;
}
