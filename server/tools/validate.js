// Argument validation shared by every tool entry point (Google tools, connector tools, the connector gateway).
export function validateArgs(schema, args) {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return '引数はオブジェクトで指定してください';
  for (const k of schema.required || []) if (args[k] === undefined || args[k] === null || args[k] === '') return `必須の項目がありません: ${k}`;
  for (const [k, v] of Object.entries(args)) {
    const p = schema.properties?.[k];
    if (!p) return `未知の項目です: ${k}`;
    if (p.type === 'string' && typeof v !== 'string') return `${k} は文字列で指定してください`;
    if (p.type === 'number' && (typeof v !== 'number' || !Number.isFinite(v))) return `${k} は数値で指定してください`;
    if (p.type === 'integer' && !Number.isInteger(v)) return `${k} は整数で指定してください`;
    if ((p.type === 'number' || p.type === 'integer') && typeof v === 'number') { if (p.minimum !== undefined && v < p.minimum) return `${k} は ${p.minimum} 以上です`; if (p.maximum !== undefined && v > p.maximum) return `${k} は ${p.maximum} 以下です`; }
    if (p.type === 'boolean' && typeof v !== 'boolean') return `${k} は true/false で指定してください`;
    if (p.type === 'object' && (v === null || typeof v !== 'object' || Array.isArray(v))) return `${k} はオブジェクトで指定してください`;
    if (p.type === 'array') {
      if (!Array.isArray(v)) return `${k} は配列で指定してください`;
      if (p.maxItems !== undefined && v.length > p.maxItems) return `${k} の個数が多すぎます`;
      if (p.minItems !== undefined && v.length < p.minItems) return `${k} の個数が足りません`;
      const it = p.items?.type; if (it && ['string', 'number', 'integer', 'boolean'].includes(it) && v.some((x) => (it === 'integer' ? !Number.isInteger(x) : typeof x !== it))) return `${k} の中身の型が正しくありません`;
    }
    if (p.enum && !p.enum.includes(v)) return `${k} は ${p.enum.join(' / ')} のいずれかです`;
    if (typeof v === 'string') { if (v.length > (p.maxLength || 20000)) return `${k} が長すぎます`; if (p.minLength !== undefined && v.length < p.minLength) return `${k} が短すぎます`; }
    if (JSON.stringify(v).length > 100_000) return `${k} が大きすぎます`;
  }
  return null;
}

/** Voice models often send "580円" / "1,200" for a number, a JSON string for an array, "true" for a boolean: convert what is clearly meant. Pure (tested). */
export function coerceArgs(schema, args) {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return args;
  const out = { ...args };
  for (const [k, p] of Object.entries(schema?.properties || {})) {
    const v = out[k]; if (v === undefined || v === null) continue;
    if ((p.type === 'number' || p.type === 'integer') && typeof v === 'string') { const t = v.replace(/[,，円¥￥\s]/g, ''); if (/^-?\d+(\.\d+)?$/.test(t)) out[k] = Number(t); }
    else if (p.type === 'array' && typeof v === 'string') { try { const j = JSON.parse(v); if (Array.isArray(j)) out[k] = j; } catch { /* leave it: validation explains */ } }
    else if (p.type === 'boolean' && typeof v === 'string' && /^(true|false)$/i.test(v)) out[k] = /^true$/i.test(v);
  }
  return out;
}
