// The optional connector "github-brain" (docs/ELVAR_MULTIUSER.md 8.5): the user's notes <-> the user's OWN GitHub repository, with the user's OWN token
// (BRAIN_GITHUB_TOKEN, sealed per user) and repository (BRAIN_REPO, BRAIN_BRANCH, BRAIN_DIR). Nothing here is on by default and nothing uses a platform token.
//   import  the .md files of the repository become notes (new ones are added; a note that was changed here since it was last mirrored is NOT overwritten:
//           it is reported as a conflict). An imported note counts as already mirrored, so it is not pushed straight back.
//   push    notes changed here since the last mirror are written to the repository (one commit per note). One way: deleting a note here never deletes it
//           in the repository (the repository is the user's property). A 5-minute lock (kv_ephemeral) keeps the page's timer from pushing more often.
// Bidirectional sync is left out on purpose: it needs conflict resolution. Obsidian works through the repository or the export.
import { env } from './config/resolve.js';
import { cleanPath } from './brain.js';

const API = 'https://api.github.com';
const REPO_RE = /^(?!\.)[\w.-]+\/(?!\.{1,2}$)[\w.-]+$/;   // owner/name: no `.` or `..` segment (the name goes into an API path with the token)
const MAX_IMPORT = 300, MAX_PUSH = 40, MAX_FILE = 200_000;
const bad = (status, error, message) => ({ status, body: { error, ...(message ? { message } : {}) } });

export const syncConfigured = () => !!(env('BRAIN_GITHUB_TOKEN') && REPO_RE.test(env('BRAIN_REPO') || ''));
const cfg = () => { const dir = (env('BRAIN_DIR') || '').replace(/^\/+|\/+$/g, ''); return { repo: env('BRAIN_REPO'), branch: env('BRAIN_BRANCH') || 'main', dir: dir.split('/').some((s) => s === '..' || s === '.') ? '' : dir }; };
const full = (rel) => { const { dir } = cfg(); return dir ? `${dir}/${rel}` : rel; };
const enc = (p) => p.split('/').map(encodeURIComponent).join('/');

async function gh(method, path, body, fetchImpl = globalThis.fetch) {
  let r;
  try {
    r = await fetchImpl(API + path, {
      method, redirect: 'error', signal: AbortSignal.timeout(10000),
      headers: { authorization: `Bearer ${env('BRAIN_GITHUB_TOKEN')}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'elvar-brain-sync', ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) { throw Object.assign(new Error(`GitHubに接続できません: ${e?.cause?.code || e?.message || e}`), { status: 502 }); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(`GitHubのエラー (${r.status}): ${String(j?.message || '').slice(0, 140)}`), { status: r.status });
  return j;
}

/** Bring the repository's .md files in. dryRun: only count. @returns {Promise<{created:number, updated:number, same:number, conflicts:string[], skipped:number, more:number}>} */
export async function importFromGithub({ user, dryRun = false, fetchImpl, divert = null } = {}) {   // divert(rel, text) -> true: the caller takes this file (scripts/migrate-owner.mjs: conversation logs)
  const { repo, branch, dir } = cfg(), prefix = dir ? dir + '/' : '';
  const tree = await gh('GET', `/repos/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`, null, fetchImpl);
  const files = (tree.tree || []).filter((x) => x.type === 'blob' && /\.md$/i.test(x.path) && x.path.startsWith(prefix) && !x.path.slice(prefix.length).split('/').some((s) => s.startsWith('.')) && (x.size || 0) <= MAX_FILE)
    .map((x) => ({ rel: x.path.slice(prefix.length), full: x.path }));
  const out = { created: 0, updated: 0, same: 0, conflicts: [], skipped: 0, diverted: 0, more: Math.max(0, files.length - MAX_IMPORT) };
  for (const f of files.slice(0, MAX_IMPORT)) {
    let rel; try { rel = cleanPath(f.rel); } catch { out.skipped++; continue; }
    const j = await gh('GET', `/repos/${repo}/contents/${enc(f.full)}?ref=${encodeURIComponent(branch)}`, null, fetchImpl);
    if (Array.isArray(j) || j.type !== 'file') { out.skipped++; continue; }
    const text = Buffer.from(j.content || '', 'base64').toString('utf8'); if (!text.trim()) { out.skipped++; continue; }
    if (divert && divert(rel, text)) { out.diverted++; continue; }
    await user.db(async (r) => {
      const cur = await r.notes.get(rel, { withTrashed: true });
      if (!cur) { out.created++; if (!dryRun) await r.notes.put({ path: rel, content: text, synced: true }); return; }
      if (cur.content === text) { out.same++; if (!dryRun && !cur.deletedAt && cur.rev > (cur.pushedRev ?? 0)) await r.notes.markPushed(cur.id, cur.rev); return; }
      if (cur.rev > (cur.pushedRev ?? 0) || cur.deletedAt) { out.conflicts.push(rel); return; }   // changed here since the last mirror (or in the trash): keep the user's version
      out.updated++; if (!dryRun) await r.notes.put({ path: rel, content: text, synced: true });
    });
  }
  return out;
}

/** Write the notes changed here to the repository. @returns {Promise<{pushed:number, failed:number, remaining:number}>} */
export async function pushToGithub({ user, fetchImpl } = {}) {
  const { repo, branch } = cfg();
  const todo = await user.db((r) => r.notes.unpushed({ limit: MAX_PUSH }));
  let pushed = 0, failed = 0;
  for (const n of todo) {
    try {
      let sha;
      try { const cur = await gh('GET', `/repos/${repo}/contents/${enc(full(n.path))}?ref=${encodeURIComponent(branch)}`, null, fetchImpl); if (!Array.isArray(cur)) sha = cur.sha; } catch (e) { if (e.status !== 404) throw e; }
      await gh('PUT', `/repos/${repo}/contents/${enc(full(n.path))}`, { message: `brain: ${sha ? 'update' : 'create'} ${n.path}`, content: Buffer.from(n.content, 'utf8').toString('base64'), branch, ...(sha ? { sha } : {}) }, fetchImpl);
      await user.db((r) => r.notes.markPushed(n.id, n.rev)); pushed++;
    } catch (e) { failed++; if (e.status === 401 || e.status === 403) break; }   // a refused token will not work for the next note either
  }
  return { pushed, failed, remaining: await user.db((r) => r.notes.unpushedCount()) };
}

// ---------------------------------------------------------------- routes
const err = (e) => (e?.status ? bad(e.status === 401 || e.status === 403 ? 400 : e.status === 404 ? 400 : 502, 'github_error', e.message) : (() => { throw e; })());

export async function syncStatusRoute({ user }) {
  const configured = syncConfigured();
  return { status: 200, body: { configured, repo: configured ? env('BRAIN_REPO') : null, mirror: configured && env('BRAIN_MIRROR') === '1', unpushed: configured ? await user.db((r) => r.notes.unpushedCount()) : 0 } };
}
export async function syncImportRoute({ user, body }) {
  if (!syncConfigured()) return bad(400, 'not_configured', '自分のGitHubのリポジトリ（BRAIN_REPO）とトークン（BRAIN_GITHUB_TOKEN）を、設定に入れてください');
  if (!(await user.cfg.hit('brain-sync-import', 600, 5))) return bad(429, 'rate_limited', '取り込みの回数が多すぎます。少し待ってください');
  try { return { status: 200, body: { ok: true, dryRun: body?.dryRun === true, ...(await importFromGithub({ user, dryRun: body?.dryRun === true })) } }; } catch (e) { return err(e); }
}
export async function syncPushRoute({ user, body }) {
  if (!syncConfigured()) return bad(400, 'not_configured', '自分のGitHubのリポジトリ（BRAIN_REPO）とトークン（BRAIN_GITHUB_TOKEN）を、設定に入れてください');
  const force = body?.force === true;   // the button; the page's timer is held back by the 5-minute lock
  if (!force && !(await user.db((r) => r.kv.setNx('brainsync:lock', { at: Date.now() }, { ttlSec: 300 })))) return { status: 200, body: { ok: true, skipped: 'debounce', pushed: 0, failed: 0, remaining: await user.db((r) => r.notes.unpushedCount()) } };
  if (force && !(await user.cfg.hit('brain-sync-push', 60, 6))) return bad(429, 'rate_limited', '少し待ってください');
  try { return { status: 200, body: { ok: true, ...(await pushToGithub({ user })) } }; } catch (e) { return err(e); }
}
