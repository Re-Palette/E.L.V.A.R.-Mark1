// UpstashStore: Vercel (Upstash Redis REST). Values are JSON strings. Atomic operations use small Lua scripts.
const INCR_LUA = "local n=redis.call('INCRBY',KEYS[1],ARGV[2]); if redis.call('TTL',KEYS[1])<0 then redis.call('EXPIRE',KEYS[1],ARGV[1]) end; return n";
const CAS_LUA = "local c=redis.call('GET',KEYS[1]); local v=0; if c then v=cjson.decode(c).ver or 0 end; if v==tonumber(ARGV[1]) then redis.call('SET',KEYS[1],ARGV[2]); return 1 end; return 0";

export class UpstashStore {
  constructor(url, token) { this.url = String(url).replace(/\/+$/, ''); this.token = token; }
  get kind() { return 'upstash'; }
  async pipeline(cmds) {
    let r;
    try { r = await fetch(this.url + '/pipeline', { method: 'POST', signal: AbortSignal.timeout(8000), headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' }, body: JSON.stringify(cmds) }); }
    catch (e) { throw Object.assign(new Error(`Redisに接続できません: ${e?.cause?.code || e?.message || e}`), { status: 502 }); }
    const j = await r.json().catch(() => null);
    if (!r.ok || !Array.isArray(j)) throw Object.assign(new Error(`Redisのエラー (${r.status})`), { status: 502 });
    const bad = j.find((x) => x?.error); if (bad) throw Object.assign(new Error(`Redisのエラー: ${String(bad.error).slice(0, 80)}`), { status: 502 });
    return j.map((x) => x.result);
  }
  async get(key) { const [v] = await this.pipeline([['GET', key]]); if (v == null) return null; try { return JSON.parse(v); } catch { return null; } }
  async set(key, value, { ttlSec, nx } = {}) {
    const c = ['SET', key, JSON.stringify(value)]; if (ttlSec) c.push('EX', String(Math.ceil(ttlSec))); if (nx) c.push('NX');
    const [r] = await this.pipeline([c]); return r === 'OK';
  }
  async del(key) { const [n] = await this.pipeline([['DEL', key]]); return Number(n) > 0; }
  async incr(key, ttlSec, by = 1) { const [n] = await this.pipeline([['EVAL', INCR_LUA, '1', key, String(Math.ceil(ttlSec || 86400)), String(Math.trunc(Number(by) || 0))]]); return Number(n); }
  async cas(key, expectedVer, value) { const [r] = await this.pipeline([['EVAL', CAS_LUA, '1', key, String(Number(expectedVer) || 0), JSON.stringify(value)]]); return Number(r) === 1; }
  async cmd(cmds) { return this.pipeline(cmds); }
}
