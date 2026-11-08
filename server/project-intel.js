// Project Intelligence: looks ACROSS the owner's projects (プロジェクト/<名前>/ in the second brain) and computes, from the real notes:
// health + risks per project, the next action, how recently each was talked about (conversation logs), and which projects are related.
// Plain code on the actual text (no model guessing); the 統合担当 agent / the voice model turn it into advice and progress entries.
import { parseProjectNotes } from './brain.js';
import { localDate } from '../shared/tz.js';
import { TZ } from './profile/index.js';

const DAY = 864e5;
const tzDate = (ms) => localDate(ms, TZ());
const STOP = new Set(['プロジェクト', 'アイデア', 'メモ', '概要', '進捗', 'ログ', '記録', '作成', '作成日', '状態', '新規', '次にやること', 'やること', 'ノート', 'このフォルダのノート', '関連ノート', 'きっかけ', '一言で', 'これから', '追記', '予定', '確認', '会話', '内容', '今日', '明日', '今回', '全体', '目的', '機能', '必要', '場合', 'こと', 'もの', 'ため', 'それ', 'これ', 'する', 'できる', 'いる', 'ある', 'など', 'について', 'として', 'エルヴァー', 'アプリ', 'システム', 'ページ', '作る']);

/** Distinctive terms of a text: katakana words, kanji runs, latin words (frequency-weighted, stop words removed). Pure (tested). */
export function termsOf(text, limit = 30) {
  const freq = new Map();
  for (const m of String(text || '').replace(/\[\[[^\]]*\]\]/g, ' ').matchAll(/[ァ-ヴー]{3,}|[一-龠々]{2,}|[A-Za-z][A-Za-z0-9.+#-]{2,}/g)) {
    const w = m[0].toLowerCase(); if (STOP.has(m[0]) || STOP.has(w) || /^(the|and|for|with|http|https|www|com|md)$/.test(w)) continue;
    freq.set(w, (freq.get(w) || 0) + 1);
  }
  return [...freq].sort((a, b) => b[1] - a[1] || b[0].length - a[0].length).slice(0, limit).map(([w]) => w);
}

const DEADLINE = /(期限|締切|〆切|締め切り|納期|リリース|公開|提出|完成)\s*[:：は]?\s*(?:(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})日?|(\d{1,2})月(\d{1,2})日)/g;
/** Dates the notes themselves name as deadlines/targets (YYYY-MM-DD). */
export function deadlinesIn(text, nowMs = Date.now()) {
  const out = []; const y0 = Number(tzDate(nowMs).slice(0, 4));
  for (const m of String(text || '').matchAll(DEADLINE)) {
    const y = m[2] ? +m[2] : y0, mo = +(m[3] || m[5]), d = +(m[4] || m[6]); if (mo < 1 || mo > 12 || d < 1 || d > 31) continue;
    let date = `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    if (!m[2] && Date.parse(date + 'T00:00:00Z') < Date.parse(tzDate(nowMs) + 'T00:00:00Z') - 60 * DAY) date = `${y0 + 1}-${date.slice(5)}`;   // "1月5日" written in November means next year
    out.push({ label: m[1], date });
  }
  return out;
}
const BLOCKER = /(詰まっ|ブロック|未解決|困って|行き詰|保留|返事待ち|待ち状態|課題[:：]|問題[:：]|リスク[:：]|懸念)/;

/**
 * @param {{projects:{name:string, notes:{path:string,text:string}[], lastUpdated:string|null}[], conversations:{date:string,text:string}[], nowMs:number}} d
 */
export function analyzeProjects({ projects = [], conversations = [], nowMs = Date.now() } = {}) {
  const today = tzDate(nowMs), convRecent = conversations.filter((c) => c.date >= tzDate(nowMs - 14 * DAY));
  const out = projects.map((p) => {
    const texts = p.notes.map((n) => n.text), all = texts.join('\n'), parsed = parseProjectNotes(texts);
    const days = p.lastUpdated ? Math.floor((nowMs - Date.parse(p.lastUpdated)) / DAY) : null;
    const terms = termsOf(all), nameKey = p.name.toLowerCase();
    // how recently / how often the owner talked about it (conversation logs): by name, or by 2+ of its distinctive terms in the same turn
    let mentions = 0, lastMention = null;
    for (const c of convRecent) for (const line of c.text.split('\n')) {
      const l = line.toLowerCase(); if (!/^- \*\*/.test(line)) continue;
      if (l.includes(nameKey) || terms.slice(0, 8).filter((t) => l.includes(t)).length >= 2) { mentions++; if (!lastMention || c.date > lastMention) lastMention = c.date; }
    }
    const deadlines = deadlinesIn(all, nowMs).map((d) => ({ ...d, inDays: Math.round((Date.parse(d.date + 'T00:00:00Z') - Date.parse(today + 'T00:00:00Z')) / DAY) }));
    const nextDeadline = deadlines.filter((d) => d.inDays >= -3).sort((a, b) => a.inDays - b.inDays)[0] || null;
    const blockers = all.split('\n').filter((l) => BLOCKER.test(l) && !/^\s*[-*]\s*\[x\]/i.test(l)).map((l) => l.replace(/^[\s#>*-]+/, '').trim()).slice(0, 3);
    const risks = []; let score = 100;
    const risk = (sev, text, pts) => { risks.push({ severity: sev, text }); score -= pts; };
    if (days != null && days > 30) risk('med', `${days}日間、更新がありません${parsed.openTasks > 0 ? `（未完了 ${parsed.openTasks} 件）` : '（完了にも、次の一手にもなっていません）'}`, 25);
    else if (days != null && days > 14 && parsed.openTasks > 0) risk('low', `${days}日、更新がありません（未完了 ${parsed.openTasks} 件）`, 15);
    if (!parsed.nextActions.length) risk('low', '「次にやること」が決まっていません', 15);
    if (parsed.openTasks >= 8 && parsed.doneTasks === 0) risk('low', `未完了が ${parsed.openTasks} 件で、完了が 0 件です（手が付いていません）`, 10);
    if (nextDeadline && parsed.openTasks > 0 && nextDeadline.inDays <= 3) risk(nextDeadline.inDays < 0 ? 'high' : 'med', nextDeadline.inDays < 0 ? `${nextDeadline.label}（${nextDeadline.date}）を過ぎています。未完了 ${parsed.openTasks} 件` : `${nextDeadline.label}が${nextDeadline.inDays === 0 ? '今日' : nextDeadline.inDays + '日後'}（${nextDeadline.date}）。未完了 ${parsed.openTasks} 件`, nextDeadline.inDays < 0 ? 30 : 20);
    if (blockers.length) risk('low', `課題・停滞の記述があります：${blockers[0].slice(0, 50)}`, 10);
    score = Math.max(0, score);
    const health = score >= 75 ? '良好' : score >= 50 ? '注意' : '危険';
    const next = parsed.nextActions[0] || (parsed.openTasks ? '未完了の項目から、最初の1つを決める' : '次の一手を1つ決める');
    return { name: p.name, notes: p.notes.length, lastUpdated: p.lastUpdated ? p.lastUpdated.slice(0, 10) : null, daysSinceUpdate: days, openTasks: parsed.openTasks, doneTasks: parsed.doneTasks, nextActions: parsed.nextActions, nextAction: next,
      deadline: nextDeadline, blockers, risks, score, health, mentionsLast14d: mentions, lastMentionedAt: lastMention, terms: terms.slice(0, 12), _terms: new Set(terms.slice(0, 25)), _text: all };
  });
  // ---- relations between projects: shared distinctive terms, or one project's notes naming the other
  const relations = [];
  for (let i = 0; i < out.length; i++) for (let j = i + 1; j < out.length; j++) {
    const a = out[i], b = out[j], shared = [...a._terms].filter((t) => b._terms.has(t));
    const explicit = a._text.toLowerCase().includes(b.name.toLowerCase()) || b._text.toLowerCase().includes(a.name.toLowerCase()) || a._text.includes(`プロジェクト/${b.name}/`) || b._text.includes(`プロジェクト/${a.name}/`);
    const score = shared.length / Math.max(1, Math.min(a._terms.size, b._terms.size));
    if (explicit || (shared.length >= 3 && score >= 0.2)) relations.push({ a: a.name, b: b.name, score: Math.round(score * 100) / 100, shared: shared.slice(0, 8), explicit, reason: explicit ? '一方のノートに、もう一方の名前（またはリンク）が出てきます' : `共通する言葉：${shared.slice(0, 5).join('・')}` });
  }
  relations.sort((x, y) => Number(y.explicit) - Number(x.explicit) || y.score - x.score);
  for (const p of out) { delete p._terms; delete p._text; }
  const ranked = [...out].sort((a, b) => a.score - b.score);
  const atRisk = out.filter((p) => p.health !== '良好');
  const focus = [...out].filter((p) => p.openTasks > 0 || p.nextActions.length).sort((a, b) => (a.deadline?.inDays ?? 99) - (b.deadline?.inDays ?? 99) || a.score - b.score)[0] || null;
  return {
    today, count: out.length, projects: out.sort((a, b) => a.score - b.score), relations: relations.slice(0, 10),
    summary: { atRisk: atRisk.map((p) => `${p.name}（${p.health}）`), weakest: ranked[0]?.name || null, focus: focus ? { project: focus.name, action: focus.nextAction } : null, idle: out.filter((p) => p.mentionsLast14d === 0 && p.daysSinceUpdate != null && p.daysSinceUpdate > 14).map((p) => p.name) },
    note: '健康度・リスク・関連は、ノートと会話ログの実際の内容から計算した値です。「関連」は、共通する言葉や名前の出現にもとづく手がかりで、因果ではありません',
  };
}
