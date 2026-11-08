// Shared in-process implementation of the store interface for MemoryStore and FileStore.
// The whole data set is a plain object: key -> { t:'s', v:<json string>, x:<expiry ms|null> } | { t:'z', m:[[score, member]...], x }.
// Every mutation is synchronous, so each method is atomic within one process (a single local server).

const parseScore = (s) => (s === '-inf' ? -Infinity : s === '+inf' ? Infinity : Number(s));

export class LocalStore {
  constructor() { this.data = Object.create(null); }
  _persist() {}   // FileStore overrides
  _live(key, now = Date.now()) {
    const e = this.data[key];
    if (!e) return null;
    if (e.x != null && e.x <= now) { delete this.data[key]; return null; }
    return e;
  }

  async get(key) { const e = this._live(key); if (!e || e.t !== 's') return null; try { return JSON.parse(e.v); } catch { return null; } }
  async set(key, value, { ttlSec, nx } = {}) {
    if (nx && this._live(key)) return false;
    this.data[key] = { t: 's', v: JSON.stringify(value), x: ttlSec ? Date.now() + ttlSec * 1000 : null };
    this._persist(); return true;
  }
  async del(key) { const had = Boolean(this._live(key)); delete this.data[key]; this._persist(); return had; }
  async incr(key, ttlSec) {
    const e = this._live(key); const n = (e && e.t === 's' ? Number(JSON.parse(e.v)) || 0 : 0) + 1;
    this.data[key] = { t: 's', v: JSON.stringify(n), x: e ? e.x : ttlSec ? Date.now() + ttlSec * 1000 : null };
    this._persist(); return n;
  }
  /** Compare-and-set on the record's numeric `ver` (absent record = version 0). `value.ver` is the new version. */
  async cas(key, expectedVer, value) {
    const cur = await this.get(key); const curVer = cur && Number.isFinite(cur.ver) ? cur.ver : 0;
    if (curVer !== (Number(expectedVer) || 0)) return false;
    this.data[key] = { t: 's', v: JSON.stringify(value), x: null }; this._persist(); return true;
  }

  /** The Redis command subset used by the notification relay: ZADD ZREMRANGEBYSCORE ZREMRANGEBYRANK ZRANGEBYSCORE (LIMIT) ZCARD EXPIRE DEL. */
  async cmd(cmds) {
    const out = [];
    for (const c of cmds) out.push(this._one(c));
    this._persist(); return out;
  }
  _z(key, create) {
    let e = this._live(key);
    if (e && e.t !== 'z') e = null;
    if (!e && create) e = this.data[key] = { t: 'z', m: [], x: null };
    return e;
  }
  _one([op, key, ...a]) {
    switch (String(op).toUpperCase()) {
      case 'ZADD': { const z = this._z(key, true); const score = Number(a[0]), member = String(a[1]); const i = z.m.findIndex((x) => x[1] === member); if (i >= 0) z.m[i][0] = score; else z.m.push([score, member]); z.m.sort((p, q) => p[0] - q[0] || (p[1] < q[1] ? -1 : 1)); return i >= 0 ? 0 : 1; }
      case 'ZREMRANGEBYSCORE': { const z = this._z(key); if (!z) return 0; const lo = parseScore(a[0]), hi = parseScore(a[1]), n = z.m.length; z.m = z.m.filter((x) => x[0] < lo || x[0] > hi); return n - z.m.length; }
      case 'ZREMRANGEBYRANK': { const z = this._z(key); if (!z) return 0; const n = z.m.length; let s = Number(a[0]), e = Number(a[1]); if (s < 0) s += n; if (e < 0) e += n; s = Math.max(0, s); const keep = z.m.filter((_, i) => i < s || i > e); const removed = n - keep.length; z.m = keep; return removed; }
      case 'ZRANGEBYSCORE': { const z = this._z(key); if (!z) return []; const lo = parseScore(a[0]), hi = parseScore(a[1]); let r = z.m.filter((x) => x[0] >= lo && x[0] <= hi).map((x) => x[1]); const li = a.findIndex((x) => String(x).toUpperCase() === 'LIMIT'); if (li >= 0) { const off = Number(a[li + 1]) || 0, cnt = Number(a[li + 2]); r = r.slice(off, cnt >= 0 ? off + cnt : undefined); } return r; }
      case 'ZCARD': { const z = this._z(key); return z ? z.m.length : 0; }
      case 'EXPIRE': { const e = this._live(key); if (!e) return 0; e.x = Date.now() + Number(a[0]) * 1000; return 1; }
      case 'DEL': { const had = this._live(key) ? 1 : 0; delete this.data[key]; return had; }
      default: throw new Error(`unsupported store command: ${op}`);
    }
  }
}
