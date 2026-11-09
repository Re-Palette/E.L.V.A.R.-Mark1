// Pure helpers of the 連携アプリ screen (no DOM; tested in test/connectors-ui.test.mjs).

export const STATUS = {
  connected: ['接続中', 'ok'], needs_reapproval: ['再承認が必要', 'warn'], error: ['エラー', 'warn'], needs_auth: ['認証が必要', 'warn'], off: ['無効', 'off'],
};
/** [label, chip class] for a connector view from the server. */
export const statusOf = (c) => (!c.enabled && c.status === 'connected' ? STATUS.off : STATUS[c.status] || STATUS.error);

export const APPROVAL_LABEL = { ask: '毎回確認する', ask_high: '毎回確認する（強い警告）', auto: '確認なしで実行（読み取りのみ）', off: '使わない' };
/** The approval choices a tool may be given: "auto" only when the tool says it is read-only (the server enforces the same). */
export function approvalChoices(t) {
  const out = ['ask'];
  if (t.danger === 'high') out.push('ask_high');
  if (t.readOnly && t.danger !== 'high') out.push('auto');
  out.push('off');
  return out;
}
/** A stored "ask" on a dangerous tool is shown as the strong-warning level. */
export const shownApproval = (t) => (t.danger === 'high' && t.approval === 'ask' ? 'ask_high' : t.approval);

/** What changed between the approved definition and the new one (for the re-approval screen). @returns {{description:boolean, params:string[], hints:boolean}} */
export function diffTool(t) {
  const p = t.prevDef; if (!p) return { description: false, params: [], hints: false };
  const keys = (s) => Object.keys(s?.properties || {});
  const was = new Set(keys(p.inputSchema)), now = new Set(keys(t.inputSchema));
  const params = [...new Set([...now].filter((k) => !was.has(k)).map((k) => `+${k}`).concat([...was].filter((k) => !now.has(k)).map((k) => `-${k}`)))];
  if (!params.length && JSON.stringify(p.inputSchema) !== JSON.stringify(t.inputSchema)) params.push('（引数の中身が変わりました）');
  return { description: p.description !== t.description, params, hints: JSON.stringify(p.annotations || {}) !== JSON.stringify(t.annotations || {}) };
}

/** The PATCH body for the review screen: the choices as they are on screen. A tool waiting for re-approval is enabled only with the hash the owner looked at. */
export function toolPrefsFrom(tools, edits) {
  const out = {};
  for (const t of tools) {
    const e = edits[t.name]; if (!e) continue;
    const p = {};
    if (e.enabled !== undefined && e.enabled !== t.enabled) p.enabled = e.enabled;
    if (e.approval !== undefined && e.approval !== shownApproval(t)) p.approval = e.approval;
    if (e.expose !== undefined && e.expose !== t.expose) p.expose = e.expose;
    if (t.needsReapproval && e.enabled === true) { p.enabled = true; p.ackHash = t.hash; }
    if (Object.keys(p).length) out[t.name] = p;
  }
  return out;
}

export const EXAMPLE_TOOLS = JSON.stringify([
  { name: 'light_on', description: '照明をつける', method: 'POST', path: '/api/services/light/turn_on', body: { entity_id: '{{args.entity}}' },
    inputSchema: { type: 'object', properties: { entity: { type: 'string', maxLength: 80 } }, required: ['entity'] } },
  { name: 'light_state', description: '照明の状態を見る', method: 'GET', path: '/api/states/{{args.entity}}', readOnly: true, response: { pick: 'state' },
    inputSchema: { type: 'object', properties: { entity: { type: 'string', maxLength: 80 } }, required: ['entity'] } },
], null, 2);

/** Parse the tools box of an HTTP connector. @returns {{ok:true, tools:object[]}|{ok:false, message:string}} */
export function parseToolsJson(text) {
  const t = String(text || '').trim(); if (!t) return { ok: true, tools: [] };
  try { const j = JSON.parse(t); if (!Array.isArray(j)) return { ok: false, message: '道具は [ ... ] の配列で書いてください' }; return { ok: true, tools: j }; }
  catch (e) { return { ok: false, message: 'JSONの形が正しくありません：' + String(e.message).slice(0, 80) }; }
}

/** First error message of a failed save (the server returns { errors:[{path,message}] }). */
export const firstError = (body) => body?.errors?.[0] ? `${body.errors[0].message}` : body?.message || '保存できませんでした';
