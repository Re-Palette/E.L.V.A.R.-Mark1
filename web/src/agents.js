import { ownerAddress } from './brand.js';
// Sub-agent jobs run on the server (/api/agent/run) in the background; the conversation goes on. When a job ends, the result is handed
// to the voice model as a system note so it reports by voice. If no session is open then, the note waits (this device) until the next one.
const KEY = 'elvar_agent_reports';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readQ = () => { try { const j = JSON.parse(localStorage.getItem(KEY) || '[]'); return Array.isArray(j) ? j : []; } catch { return []; } };
const writeQ = (q) => { try { localStorage.setItem(KEY, JSON.stringify(q.slice(-10))); } catch {} };

export function noteFor(res, presented = false) {
  const writes = (res.steps || []).filter((s) => s.tool === 'brain_write' && s.ok).length;
  return res.ok
    ? `[システム] ${res.label || 'サブエージェント'}の作業が完了しました。結果: ${res.summary}${writes ? `（ノートへの書き込み ${writes} 件）` : ''}${presented ? '。資料のPDFのカードを画面に表示しました。' + ownerAddress() + 'は「開く」「ダウンロード」「Googleドライブに保存」を押せます' : ''}。${ownerAddress()}に、要点だけを短く声で報告してください。`
    : `[システム] ${res.label || 'サブエージェント'}の作業は完了できませんでした。理由: ${res.error}。${ownerAddress()}に、短く正直に伝えてください。`;
}

export function initAgents({ live, authHeaders, hudLive, inbox = null, announceReady = null }) {
  let delivering = false, onArtifact = null;
  async function deliver() {
    if (delivering || (!live.session && !announceReady)) return;
    if (!live.session && !readQ().length) return;
    delivering = true;
    try {
      if (!live.session && !(await announceReady())) return;   // ELVAR is open but not in a conversation: it opens a voice-only session by itself to report (never turns the mic on)
      while (live.session && readQ().length) {
        for (let i = 0; i < 300 && live.session && (live.modelSpeaking || live.stretchActive || live.state === 'thinking'); i++) await sleep(100);   // never talk over a reply
        if (!live.session) break;
        const q = readQ(); const next = q.shift(); writeQ(q);
        await live.sendSystemNote(next);
        await sleep(1500);
      }
    } catch (e) { console.warn('[agents] deliver', e?.message ?? e); }
    finally { delivering = false; }
  }

  /** Start a job and return at once. */
  function start({ agent, task, silent = false }) {
    hudLive?.agentStart(agent);
    (async () => {
      let res;
      try {
        const r = await fetch('/api/agent/run', { method: 'POST', headers: { 'content-type': 'application/json', ...authHeaders() }, body: JSON.stringify({ agent, task }) });
        const j = await r.json().catch(() => ({}));
        res = r.status === 401 ? { ok: false, label: 'サブエージェント', error: 'アクセストークンが違います' } : (j && typeof j.ok === 'boolean' ? j : { ok: false, label: 'サブエージェント', error: j?.error || `サーバーエラー (${r.status})` });
      } catch (e) { res = { ok: false, label: 'サブエージェント', error: `通信に失敗しました：${e?.message ?? e}` }; }
      hudLive?.agentEnd(agent, !!res.ok, res.ok ? res.summary : res.error);
      try { const art = res.ok && res.artifacts?.[0]; inbox?.add({ kind: res.ok ? (art ? 'deliverable' : 'report') : 'alert', title: `${res.label || 'サブエージェント'}：${res.ok ? (art ? '完成しました' : '完了') : '完了できませんでした'}`, body: res.ok ? res.summary : res.error, quiet: silent && !(res.ok && /^【要対応】/.test(res.summary || '')), notePath: art ? (typeof art === 'string' ? art : art.path || '') : '' }); } catch {}
      if (silent && !(res.ok && /^【要対応】/.test(res.summary || ''))) return;   // background run: stay quiet, except a security alert (it is always reported)
      let presented = false;
      if (res.ok && res.artifacts?.length && onArtifact) { try { presented = !!(await onArtifact(res.artifacts[0], res)); } catch (e) { console.warn('[agents] artifact', e?.message ?? e); } }   // a finished document: show its PDF card
      writeQ([...readQ(), noteFor(res, presented)]);
      deliver();
    })();
    return { accepted: true, message: '受け付けました。裏で作業します。完了したら、システムから結果が届くので、そのときに報告してください。会話はこのまま続けられます。' };
  }
  /** A system note from elsewhere (e.g. a build update): spoken the same way as a finished sub-agent job. */
  function queueNote(text) { writeQ([...readQ(), String(text).slice(0, 1500)]); deliver(); }
  return { start, deliver, queueNote, pending: () => readQ().length, setArtifactHandler: (fn) => { onArtifact = fn; } };
}
