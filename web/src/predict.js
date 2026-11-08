import { ownerAddress } from './brand.js';
// Predictive Intelligence on the page: every 30 min (while the page is open) the server computes the signals (tool predict_scan: no AI, real data);
// new important ones are logged on the HUD, shown as a notification and handed to the voice model as a system note (spoken when a conversation is open).
// Once an evening the 予測担当 agent runs silently and writes 予測/日付.md (with the pre-research); it speaks up only for a 【要対応】.
const SEEN = 'elvar_predict_seen', AGENT_DAY = 'elvar_predict_agent_day', PINTEL_DAY = 'elvar_pintel_day';
const JST = 9 * 3600e3;
const readSeen = () => { try { return JSON.parse(localStorage.getItem(SEEN) || '{}') || {}; } catch { return {}; } };
const writeSeen = (o) => { try { localStorage.setItem(SEEN, JSON.stringify(o)); } catch {} };
const jst = (ms) => new Date(ms + JST);

/** Which signals to announce now. High ones always (once per 6 h each); medium ones only in the evening (for tomorrow's preparation / deadlines). Max 2. Pure (tested). */
export function pickAlerts(signals, seen, nowMs = Date.now(), { max = 2 } = {}) {
  const hour = jst(nowMs).getUTCHours(), evening = hour >= 18;
  const out = [];
  for (const s of signals || []) {
    const ok = s.severity === 'high' || (evening && s.severity === 'med' && (s.kind === 'prep' || s.kind === 'deadline'));
    if (!ok || (seen[s.id] && nowMs - seen[s.id] < 6 * 3600e3)) continue;
    out.push(s); if (out.length >= max) break;
  }
  return out;
}

export function noteForAlerts(list) {
  const lines = list.map((s, i) => `${i + 1}. ${s.title}。${s.detail}。提案：${s.suggestion}`).join(' ');
  return `[システム] 予測アシスタントからのお知らせです（実際の予定・タスクから計算した兆候）。${lines} ${ownerAddress()}に、いちばん重要なものから、2文以内で短く、理由と提案を伝えてください。数字は、ここに書かれたものだけを使い、作らないでください。詳しく聞かれたら predict_scan で確認してください。`;
}

/** Is it time for the daily silent run of the prediction agent (evening, once per JST date, something worth preparing)? Pure (tested). */
export function predictAgentDue({ nowMs = Date.now(), lastDay = '', signals = [], available = false, locked = false }) {
  if (!available || locked) return false;
  const d = jst(nowMs), day = d.toISOString().slice(0, 10);
  if (d.getUTCHours() < 18 || lastDay === day) return false;
  return signals.some((s) => s.kind === 'prep' || s.severity === 'high' || s.kind === 'deadline');
}

/** Daily silent run of the project-intelligence agent (progress logs + the cross-project dashboard), after 20:00 JST, once per date. Pure (tested). */
export function projectIntelDue({ nowMs = Date.now(), lastDay = '', available = false, locked = false }) {
  if (!available || locked) return false;
  const d = jst(nowMs); return d.getUTCHours() >= 20 && lastDay !== d.toISOString().slice(0, 10);
}

export function initPredict({ run, hudLive, queueNote, inbox = null, agents, store, available = () => false, availableAgent = () => false, locked = () => window.__elvarDeviceLocked, intervalMs = 30 * 60_000 }) {
  let busy = false, off = 0;
  async function poll() {
    if (busy || locked()) return null; busy = true;
    try {
      const r = await run('predict_scan', {});
      if (!r || !Array.isArray(r.signals)) { if (++off >= 3) off = 99; return null; }
      off = 0;
      const now = Date.now(), seen = readSeen(); for (const k of Object.keys(seen)) if (now - seen[k] > 2 * 864e5) delete seen[k];
      const alerts = pickAlerts(r.signals, seen, now);
      if (alerts.length) {
        for (const s of alerts) { seen[s.id] = now; try { hudLive?.logActivity({ icon: 'gear', title: `予測：${s.title}`.slice(0, 40), sub: s.suggestion.slice(0, 40) }); } catch {} }
        try { if (typeof Notification !== 'undefined' && Notification.permission === 'granted') new Notification('E.L.V.A.R. 予測', { body: alerts[0].title + (alerts.length > 1 ? ` ほか${alerts.length - 1}件` : '') }); } catch {}
        for (const s of alerts) { try { inbox?.add({ kind: 'alert', key: `predict:${s.id}`, title: s.title, body: s.suggestion }); } catch {} }
        queueNote(noteForAlerts(alerts));
      }
      writeSeen(seen);
      if (predictAgentDue({ nowMs: now, lastDay: (store.get(AGENT_DAY) || ''), signals: r.signals, available: available(), locked: locked() })) {
        store.set(AGENT_DAY, jst(now).toISOString().slice(0, 10));
        agents.start({ agent: 'predict', task: '明日と今後数日の予測を行ってください。明日の準備、締切のリスク、必要になりそうな情報の事前調査をまとめてください。', silent: true });
      }
      if (projectIntelDue({ nowMs: now, lastDay: store.get(PINTEL_DAY) || '', available: availableAgent('pintel'), locked: locked() })) {
        store.set(PINTEL_DAY, jst(now).toISOString().slice(0, 10));
        agents.start({ agent: 'pintel', task: '全プロジェクトを横断して、進捗ログを更新し、統合ダッシュボードをまとめてください。', silent: true });
      }
      return r;
    } catch (e) { console.warn('[predict] poll', e?.message ?? e); return null; }
    finally { busy = false; }
  }
  function loop() { if (off >= 99) return; setTimeout(async () => { await poll(); loop(); }, intervalMs); }
  setTimeout(async () => { await poll(); loop(); }, 70_000);
  return { poll };
}
