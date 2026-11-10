// The caller's own second brain, conversation log and notification box over HTTP (docs/ELVAR_MULTIUSER.md 7.2, principle 7): list, read, edit, trash and
// delete notes and messages one by one, see the older versions of a note, search, and the bell panel. Every call runs as the signed-in user (Row Level
// Security): another user's ids are simply "not found". The AI tools use the same notes through server/brain.js but cannot delete.
import { brainSearch, brainGraph, brainProjects, brainAppendConversation, cleanPath } from '../brain.js';
import { assertRoomForNote } from '../usage.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const bad = (status, error, message) => ({ status, body: { error, ...(message ? { message } : {}) } });
const nf = () => bad(404, 'not_found');
const ok = (body = { ok: true }) => ({ status: 200, body });
const id404 = (id) => !UUID.test(String(id));
const fail = (e) => (e?.name === 'UsageLimitError' ? bad(429, e.code, e.message) : e?.status && e.status < 500 ? bad(e.status, e.code || 'error') : (() => { throw e; })());
const guard = (fn) => async (a) => { try { return await fn(a); } catch (e) { return fail(e); } };

// ---------------------------------------------------------------- notes
export const listNotes = guard(async ({ user, query }) => {
  if (query.q) { const r = await brainSearch({ query: String(query.q).slice(0, 200), maxResults: 10 }); return ok({ results: r.results, queryTerms: r.queryTerms }); }
  const trash = query.trash === '1', folder = String(query.folder || '').slice(0, 300);
  return ok({ notes: await user.db((r) => r.notes.list({ folder, trash })), trash });
});

export const getNote = guard(async ({ user, params }) => {
  if (id404(params.id)) return nf();
  return user.db(async (r) => { const n = await r.notes.getById(params.id); return n ? ok({ note: n, revisions: await r.notes.revisions(n.id) }) : nf(); });
});

export const createNote = guard(async ({ user, body }) => {
  let path; try { path = cleanPath(body?.path); } catch (e) { return bad(400, 'bad_path', e.message); }
  if (typeof body?.content !== 'string' || !body.content.trim()) return bad(400, 'empty', '内容が空です');
  if (body.content.length > 200000) return bad(400, 'too_long', 'ノートが大きすぎます（20万字まで）');
  return user.db(async (r) => {
    if (await r.notes.get(path, { withTrashed: true })) return bad(409, 'exists', `すでに同じ名前のノートがあります: ${path}`);
    await assertRoomForNote(r);
    const w = await r.notes.put({ path, content: body.content.replace(/\s+$/, '') + '\n' });
    return ok({ note: await r.notes.getById(w.id) });
  });
});

/** The user's own edit: the whole text is replaced (the old text stays as a version). */
export const updateNote = guard(async ({ user, params, body }) => {
  if (id404(params.id)) return nf();
  if (typeof body?.content !== 'string' || !body.content.trim()) return bad(400, 'empty', '内容が空です');
  if (body.content.length > 200000) return bad(400, 'too_long', 'ノートが大きすぎます（20万字まで）');
  return user.db(async (r) => {
    const n = await r.notes.getById(params.id); if (!n) return nf();
    if (Number.isInteger(body.baseRev) && body.baseRev !== n.rev) return bad(409, 'changed', 'このノートは、開いたあとに別の場所で変更されました。開き直してください');
    await r.notes.put({ path: n.path, content: body.content.replace(/\s+$/, '') + '\n' });
    return ok({ note: await r.notes.getById(n.id) });
  });
});

/** Trash (restorable for 30 days) or, with ?permanent=1, gone for good together with its versions. */
export const deleteNote = guard(async ({ user, params, query }) => {
  if (id404(params.id)) return nf();
  return user.db(async (r) => ((query.permanent === '1' ? await r.notes.purge(params.id) : await r.notes.trash(params.id)) ? ok() : nf()));
});
export const restoreNote = guard(async ({ user, params }) => (id404(params.id) ? nf() : (await user.db((r) => r.notes.restore(params.id))) ? ok() : nf()));
export const emptyTrash = guard(async ({ user }) => ok({ ok: true, deleted: await user.db((r) => r.notes.emptyTrash()) }));
export const deleteAllNotes = guard(async ({ user, body }) => (body?.confirm === 'delete' ? ok({ ok: true, deleted: await user.db((r) => r.notes.delAll()) }) : bad(400, 'confirm_required', '確認のため confirm: "delete" を付けてください')));

export const getRevision = guard(async ({ user, params }) => {
  const rev = Number(params.rev); if (id404(params.id) || !Number.isInteger(rev) || rev < 0) return nf();
  const v = await user.db((r) => r.notes.revision(params.id, rev)); return v ? ok({ revision: v }) : nf();
});
export const restoreRevision = guard(async ({ user, params }) => {
  const rev = Number(params.rev); if (id404(params.id) || !Number.isInteger(rev) || rev < 0) return nf();
  return user.db(async (r) => {
    const n = await r.notes.getById(params.id), v = n && await r.notes.revision(params.id, rev); if (!v) return nf();
    await r.notes.put({ path: n.path, content: v.content });
    return ok({ note: await r.notes.getById(n.id) });
  });
});
export const notesGraph = guard(async () => ok(await brainGraph()));
export const notesProjects = guard(async () => ok(await brainProjects()));

// ---------------------------------------------------------------- conversation log (short-term memory)
export const listConversations = guard(async ({ user, query }) => ok({ conversations: await user.db((r) => r.messages.conversations({ limit: Math.min(200, Math.max(1, Number(query.limit) || 50)), before: query.before && !Number.isNaN(Date.parse(query.before)) ? query.before : null })) }));
export const getConversation = guard(async ({ user, params }) => { if (id404(params.id)) return nf(); const c = await user.db((r) => r.messages.conversation(params.id)); return c ? ok({ conversation: c }) : nf(); });
export const deleteConversation = guard(async ({ user, params }) => (id404(params.id) ? nf() : (await user.db((r) => r.messages.delConversation(params.id))) ? ok() : nf()));

/** The page sends the turns it heard (every few minutes, when a conversation ends). Secrets are masked before anything is stored. */
export const postMessages = guard(async ({ user, body }) => {
  const turns = Array.isArray(body?.turns) ? body.turns : null; if (!turns || !turns.length) return bad(400, 'empty', '記録する会話がありません');
  if (!(await user.cfg.hit('messages', 60, 60))) return bad(429, 'rate_limited', '記録の回数が多すぎます。少し待ってください');
  const channel = ['voice', 'text', 'agent'].includes(body.channel) ? body.channel : 'voice';
  try { const r = await brainAppendConversation({ turns, channel }); return ok({ ok: true, written: r.turns, added: r.added, conversationId: r.conversationId }); }
  catch (e) { return e?.status ? fail(e) : bad(400, 'bad_turns', e.message); }
});
export const listMessages = guard(async ({ user, query }) => {
  const q = String(query.q || '').trim().slice(0, 100);
  return ok({ messages: await user.db((r) => r.messages.list({ q: q || null, limit: Math.min(200, Math.max(1, Number(query.limit) || 50)) })) });
});
export const deleteMessage = guard(async ({ user, params }) => (/^\d{1,18}$/.test(String(params.id)) && (await user.db((r) => r.messages.del(params.id))) ? ok() : nf()));
/** By period (before: an ISO time) or everything (all: true). */
export const purgeMessages = guard(async ({ user, body }) => {
  if (body?.all === true) return ok({ ok: true, deleted: await user.db((r) => r.messages.purge({})) });
  if (typeof body?.before === 'string' && !Number.isNaN(Date.parse(body.before))) return ok({ ok: true, deleted: await user.db((r) => r.messages.purge({ before: new Date(body.before).toISOString() })) });
  return bad(400, 'bad_request', 'before（この日時より前）か all: true を指定してください');
});

// ---------------------------------------------------------------- the bell panel
export const listInbox = guard(async ({ user }) => ok({ items: await user.db((r) => r.inbox.list({ limit: 100 })) }));
export const addInbox = guard(async ({ user, body }) => { try { return ok({ item: await user.db((r) => r.inbox.add(body)) }); } catch (e) { return e?.code === 'invalid_value' ? bad(400, 'bad_item') : fail(e); } });
export const patchInbox = guard(async ({ user, params, body }) => (id404(params.id) ? nf() : body?.read === true && (await user.db((r) => r.inbox.markRead(params.id))) ? ok() : body?.read === true ? nf() : bad(400, 'bad_request')));
export const readAllInbox = guard(async ({ user }) => ok({ ok: true, marked: await user.db((r) => r.inbox.markAllRead()) }));
export const deleteInbox = guard(async ({ user, params }) => (id404(params.id) ? nf() : (await user.db((r) => r.inbox.del(params.id))) ? ok() : nf()));
export const clearInbox = guard(async ({ user }) => ok({ ok: true, deleted: await user.db((r) => r.inbox.delAll()) }));
