import { ownerAddress, timeZone } from './brand.js';
import { localDate, localHM } from '../../shared/tz.js';
// Watches the build requests handed to Claude Code (tool build_status): when one changes state (picked up / PR opened / finished) or Claude Code
// posts a new report, ELVAR logs it on the HUD, shows a notification, saves finished results to the vault, and queues a spoken report.
// Polling only runs while this page is open (a closed page cannot poll); GitHub's own mobile / e-mail notifications cover the rest.
const KEY = 'elvar_build_sigs';
const read = () => { try { return JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch { return {}; } };
const write = (o) => { try { localStorage.setItem(KEY, JSON.stringify(o)); } catch {} };

/** What changed since `known` (signature per issue number). First sight of an old finished build is silent. Pure (tested). */
export function diffBuilds(builds, known) {
  const out = [];
  for (const b of builds) {
    const prev = known[b.key ?? b.number];
    if (prev === b.signature) continue;
    const firstSeen = prev === undefined;
    if (firstSeen && (b.state === 'done' || b.state === 'queued')) continue;   // an old finished one, or just requested by us a moment ago: nothing new to say
    out.push({ build: b, firstSeen });
  }
  return out;
}

export function noteForBuild(b) {
  const bits = [`[システム] ${b.self ? 'E.L.V.A.R.自身の改造依頼' : '製作依頼'}「${b.title}」に更新があります。状態：${b.stateLabel}。`];
  if (b.self && b.pr) bits.push('これはE.L.V.A.R.自身の変更です。PRを' + ownerAddress() + 'がマージし、再デプロイして初めて反映されます（マージするまで、今の動作は変わりません）。');
  if (b.summary) bits.push(`Claude Codeの最新の報告（要約）：${b.summary}`);
  if (b.pr) bits.push(`Pull Request #${b.pr.number} があります（${b.pr.merged ? 'マージ済み' : b.pr.draft ? '下書き' : ownerAddress() + 'の確認待ち'}）。`);
  bits.push(ownerAddress() + 'に、2文以内で、状態と、' + ownerAddress() + 'がすること（PRの確認、動かして試す、など）を伝えてください。作業の成功を保証せず、確認は未了だと正直に。詳細を聞かれたら build_status で調べてください。');
  return bits.join('');
}

export function initBuilds({ run, hudLive, queueNote, inbox = null, locked = () => window.__elvarDeviceLocked, intervalMs = 120_000 }) {
  let timer = 0, busy = false, enabled = null, inflight = false, misses = 0;
  async function poll() {
    if (busy || locked()) return;
    busy = true;
    try {
      const r = await run('build_status', {});
      if (!r || !Array.isArray(r.builds)) { if (++misses >= 3) enabled = false; return; }   // not configured on the server (3 misses in a row): stop polling
      enabled = true; misses = 0;
      const known = read(), next = { ...known };
      for (const { build: b } of diffBuilds(r.builds, known)) {
        try { hudLive?.logActivity({ icon: 'nodes', title: `製作：${b.title}`, sub: b.stateLabel }); } catch {}
        try { if (typeof Notification !== 'undefined' && Notification.permission === 'granted') new Notification('E.L.V.A.R. 製作', { body: `${b.title}：${b.stateLabel}`, silent: false }); } catch {}
        try { inbox?.add({ kind: b.state === 'done' || b.state === 'review' ? 'deliverable' : 'build', key: `build:${b.key ?? b.number}`, title: `${b.self ? '自己改造' : '製作'}：${b.title}（${b.stateLabel}）`, body: b.summary || '', url: b.pr?.url || b.url || '' }); } catch {}
        queueNote(noteForBuild(b));
        if (b.state === 'done' || b.state === 'review') {   // keep the result in the vault, next to the 企画書
          run('brain_write', { path: `製作/${b.title}/結果.md`, mode: 'append', content: `- ${`${localDate(Date.now(), timeZone())} ${localHM(Date.now(), timeZone())}`} ${b.stateLabel}${b.pr ? ` PR #${b.pr.number} ${b.pr.url}` : ''}\n  ${b.summary || ''}` }).catch(() => {});
        }
      }
      for (const b of r.builds) next[b.key ?? b.number] = b.signature;
      write(next);
      inflight = r.builds.some((b) => b.state !== 'done');
    } catch (e) { console.warn('[builds] poll', e?.message ?? e); }
    finally { busy = false; }
  }
  function loop() { clearTimeout(timer); if (enabled === false) return; timer = setTimeout(async () => { await poll(); loop(); }, inflight ? intervalMs : intervalMs * 5); }
  setTimeout(async () => { await poll(); loop(); }, 25_000);
  return { poll, state: () => ({ enabled, inflight }) };
}
