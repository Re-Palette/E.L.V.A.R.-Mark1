// The caller's own file vault over HTTP (docs/ELVAR_MULTIUSER.md 3.3, 6.2, 8.2; principles 4 and 6). Every call runs as the signed-in user (Row Level Security): another
// user's file id is simply "not found". The original of a file lives in Supabase Storage (bucket user-files, users/<uid>/files/<id>/<sha256>) and never passes through
// this server: the browser uploads with its own access token (Storage checks the live reservation on every write) and downloads from a short signed link. What the server does is the part nobody may skip:
//   reserve    quota check (used + reserved + this file + the extracted text it announced, per-file limit) in ONE database function; only then the upload target
//   finalize   looks at the REAL object (size and SHA-256 must equal the reservation), then takes the memory the browser worker built and releases the reservation
//   delete     removes the Storage object and the row: the bytes are free again
//   search     the user's own files, ranked on the server (the same answer on every device and for the sub-agents)
// Text is read in the browser (a Worker); the server only receives the result and checks its shape and size.
import { userStorage, getStorage, USER_BUCKET } from '../storage/index.js';
import { searchFiles as rankFiles, queryTerms, parseDateQuery, searchResultForModel } from '../../web/src/file-index.js';
import { indexOf, metaOf } from '../../shared/file-record.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MB = 1024 * 1024;
const bad = (status, error, message, extra = {}) => ({ status, body: { error, ...(message ? { message } : {}), ...extra } });
const nf = () => bad(404, 'not_found');
const ok = (body = { ok: true }) => ({ status: 200, body });
const id404 = (id) => !UUID.test(String(id));
const fail = (e) => (e?.status && e.status < 500 ? bad(e.status, e.code || 'error') : (() => { throw e; })());
const guard = (fn) => async (a) => { try { return await fn(a); } catch (e) { return fail(e); } };
/** Bytes the way the screen shows them (B / KB / MB), so a small quota or a small file is not "0.0 MB". */
const mb = (n) => { n = Number(n) || 0; return n < 1024 ? `${n} B` : n < MB ? `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB` : `${(n / MB).toFixed(n < 10 * MB ? 1 : 0)} MB`; };

/** What the vault accepts (the same list as web/src/file-lib.js; SVG, HTML and anything executable are refused). */
const TYPES = {
  pdf: ['pdf', 'application/pdf'], png: ['image', 'image/png'], jpg: ['image', 'image/jpeg'], jpeg: ['image', 'image/jpeg'], webp: ['image', 'image/webp'], gif: ['image', 'image/gif'],
  txt: ['text', 'text/plain'], log: ['text', 'text/plain'], md: ['text', 'text/markdown'], markdown: ['text', 'text/markdown'], csv: ['text', 'text/csv'], tsv: ['text', 'text/tab-separated-values'], json: ['text', 'application/json'],
  doc: ['office', 'application/msword'], docx: ['office', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'], xls: ['office', 'application/vnd.ms-excel'],
  xlsx: ['office', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'], ppt: ['office', 'application/vnd.ms-powerpoint'], pptx: ['office', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'],
};
export const extOf = (name) => (/\.([A-Za-z0-9]{1,8})$/.exec(String(name || ''))?.[1] || '').toLowerCase();
const SOURCES = new Set(['picker', 'drop', 'paste', 'elvar-doc', 'migrate']);
/** A name that is safe to store and to offer for download: no path, no control or reserved characters, at most 100 characters (the extension is kept). */
export function cleanName(name) {
  let s = String(name ?? '').replace(/^.*[\\/]/, '').replace(/[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩]/g, '').replace(/[<>:"|?*\\/]/g, '_').replace(/\s+/g, ' ').trim().replace(/^\.+/, '');
  if (!s) return 'ファイル';
  if (s.length > 100) { const e = extOf(s), keep = e ? e.length + 1 : 0; s = s.slice(0, 100 - keep) + (keep ? s.slice(-keep) : ''); }
  return s;
}

/** A file row without its Storage path (that never leaves the server). */
const publicFile = ({ objectPath, status, reservedUntil, ...f }) => { void objectPath; void status; void reservedUntil; return f; };

// the platform's per-file limit (app.platform_config; refreshed at most every 30 s per instance)
let platformMax = 62914560, platformMaxAt = 0;
async function loadPlatformMax(user) {
  if (Date.now() - platformMaxAt < 30_000) return platformMax;
  try { platformMax = await user.system.maxFileBytes(); platformMaxAt = Date.now(); } catch { /* keep the last known value */ }
  return platformMax;
}
export const _resetPlatformMax = () => { platformMax = 62914560; platformMaxAt = 0; };
const usageView = (u, acct) => ({
  usedBytes: u.filesBytes + u.textBytes + u.notesBytes + u.messagesBytes, reservedBytes: u.reservedBytes, quotaBytes: acct?.storageQuotaBytes ?? 524288000,
  breakdown: { files: u.filesBytes, text: u.textBytes, notes: u.notesBytes, messages: u.messagesBytes }, maxFileBytes: Math.min(platformMax, Number(acct?.hardLimits?.maxFileBytes) >= 0 && acct?.hardLimits?.maxFileBytes !== undefined ? Number(acct.hardLimits.maxFileBytes) : platformMax),
});

/** Remove what the caller left behind: deleted files whose object is still there, and uploads that ran out of time. Best effort; the daily sweep does the same for everybody. */
async function sweepOwn(user) {
  try {
    const stale = await user.db((r) => r.files.stale());
    if (!stale.length) return 0;
    await (await getStorage()).service.remove(stale.map((s) => s.objectPath), { bucket: USER_BUCKET });   // the server's own cleanup of this user's dead rows (an expired reservation's object is not the owner's to touch)
    let n = 0; for (const s of stale) if (await user.db((r) => r.files.finishDelete(s.id))) n++;
    return n;
  } catch (e) { console.error('[elvar] files: sweep of stale uploads failed:', e?.code || e?.message); return 0; }
}

// ---------------------------------------------------------------- the library
export const listFiles = guard(async ({ user }) => {
  await loadPlatformMax(user);
  await sweepOwn(user);
  return user.db(async (r) => ok({ files: (await r.files.list()).map(publicFile), usage: usageView(await r.usage.storage(), await r.accounts.get()) }));
});

export const getFile = guard(async ({ user, params }) => {
  if (id404(params.id)) return nf();
  const f = await user.db((r) => r.files.get(params.id));
  return f && f.status === 'ready' ? ok({ file: publicFile(f) }) : nf();
});

export const getFileText = guard(async ({ user, params }) => {
  if (id404(params.id)) return nf();
  const t = await user.db(async (r) => ((await r.files.get(params.id))?.status === 'ready' ? (await r.files.text(params.id)) ?? '' : null));
  return t === null ? nf() : ok({ text: t });
});

/** Ranked search over the caller's own files: names, tags, kind, keywords, summary and the extracted text. */
export const searchFiles = guard(async ({ user, query }) => {
  const q = String(query.q || '').trim().slice(0, 200); if (!q) return bad(400, 'empty', '検索する言葉を入れてください');
  if (!(await user.cfg.hit('files-search', 60, 120))) return bad(429, 'rate_limited', '検索の回数が多すぎます。少し待ってください');
  const limit = Math.min(30, Math.max(1, Number(query.limit) || 8));
  return user.db(async (r) => {
    const list = await r.files.list();
    const terms = [...queryTerms(parseDateQuery(q).rest).keys()];
    const found = terms.length ? await r.files.searchText(terms) : new Map();
    const indexes = new Map(list.map((f) => [f.id, indexOf(f)])), files = list.map(metaOf);
    const results = rankFiles({ files, indexes, texts: found }, q, { limit });
    return ok({ query: q, results: results.map((x) => ({ id: x.file.id, name: x.file.name, kind: x.kind, score: x.score, matched: x.where, snippet: x.snippet })), forModel: searchResultForModel(results) });
  });
});

// ---------------------------------------------------------------- upload: reserve -> (browser PUT to Storage) -> finalize
/** The answer to a refused reservation (413): what is used, what the limit is, what is needed, in words a person can act on. */
function quotaRefusal(code, user, acct, usage, need) {
  const u = usageView(usage, acct);
  if (code === 'file_too_large') return bad(413, 'file_too_large', `1ファイルは ${mb(u.maxFileBytes)} までです。このファイルは大きすぎるため、保存できません`, { maxFileBytes: u.maxFileBytes });
  const free = Math.max(0, u.quotaBytes - u.usedBytes - u.reservedBytes);
  return bad(413, 'storage_quota_exceeded', `保存容量の上限に達しました（使用中 ${mb(u.usedBytes + u.reservedBytes)} ／ 上限 ${mb(u.quotaBytes)}）。このファイル（${mb(need)}）を入れるには、あと ${mb(Math.max(0, need - free))} の空きが必要です。不要なファイルを削除してから、もう一度お試しください`,
    { usedBytes: u.usedBytes + u.reservedBytes, quotaBytes: u.quotaBytes, neededBytes: need });
}

export const reserveFile = guard(async ({ user, body }) => {
  const name = cleanName(body?.name), ext = extOf(name), type = TYPES[ext];
  if (!type) return bad(415, 'unsupported_type', 'この形式は取り込めません（PDF・画像・テキスト・CSV・JSON・Word・Excel・PowerPointに対応しています）');
  const size = body?.size, textBytes = body?.textBytes ?? 0, sha256 = body?.sha256;
  if (!Number.isInteger(size) || size < 1) return bad(400, 'bad_size', '空のファイルは取り込めません');
  if (!Number.isInteger(textBytes) || textBytes < 0 || textBytes > 4000000 || !/^[0-9a-f]{64}$/.test(String(sha256 || ''))) return bad(400, 'bad_request', '内容の確認情報が正しくありません');
  const maxFile = await loadPlatformMax(user);
  if (size > maxFile) return bad(413, 'file_too_large', `1ファイルは ${mb(maxFile)} までです。このファイルは大きすぎるため、保存できません`, { maxFileBytes: maxFile });
  if (!(await user.cfg.hit('files-reserve', 3600, 600))) return bad(429, 'rate_limited', '取り込みの回数が多すぎます。しばらくしてからにしてください');
  await sweepOwn(user);   // an upload that ran out of time gives its reservation back
  const source = SOURCES.has(body?.source) ? body.source : 'picker';
  let res;
  try { res = await user.db((r) => r.files.reserve({ name, mime: type[1], kind: type[0], size, sha256, textBytes, source, allowDuplicate: body?.allowDuplicate === true })); }
  catch (e) {
    if (e?.code === 'storage_quota_exceeded' || e?.code === 'file_too_large') { const [usage, acct] = await user.db(async (r) => [await r.usage.storage(), await r.accounts.get()]); return quotaRefusal(e.code, user, acct, usage, size + textBytes); }
    if (e?.code === 'platform_storage_full') return bad(413, 'platform_storage_full', 'このサービス全体の保存領域がいっぱいです。ご迷惑をおかけします。運営者にご連絡ください');
    if (e?.code === 'conflict') return bad(409, 'too_many_uploads', '同時にアップロードできる数をこえました。少し待ってからにしてください');
    throw e;
  }
  if (res.duplicate) return ok({ duplicate: res.duplicate });
  let upload;
  try { upload = await (await userStorage(user)).uploadTarget(res.objectPath); }
  catch (e) { await user.db((r) => r.files.beginDelete(res.fileId).then(() => r.files.finishDelete(res.fileId))).catch(() => {}); throw e; }   // no target, no reservation
  // The browser POSTs the bytes with its OWN access token (userToken): Storage checks the live reservation on every write, so a deleted or finished reservation can never be written again.
  return ok({ fileId: res.fileId, name, expiresAt: res.reservedUntil, upload: { url: upload.url, method: upload.method, userToken: true, headers: { ...(upload.headers || {}), 'content-type': type[1], 'x-upsert': 'false' } } });
});

const text = (v, max) => (typeof v === 'string' ? v.slice(0, max) : undefined);
/** Only the keys the vault knows, each cut to the size of its column (the database checks them again). */
function memoryFields(b) {
  const out = {};
  if (b.title !== undefined) out.title = b.title === null ? null : text(b.title, 200);
  if (b.docKind !== undefined) out.docKind = b.docKind === null ? null : text(b.docKind, 40);
  if (Array.isArray(b.keywords)) out.keywords = b.keywords.filter((k) => typeof k === 'string' && k && k.length <= 60).slice(0, 30);
  if (b.snippet !== undefined) out.snippet = text(b.snippet, 300) ?? '';
  if (b.related !== undefined) out.related = b.related && typeof b.related === 'object' ? { id: String(b.related.id || '').slice(0, 64), name: String(b.related.name || '').slice(0, 200), score: Number(b.related.score) || 0 } : null;
  if (b.analysis !== undefined) out.analysis = b.analysis;
  return out;
}

export const finalizeFile = guard(async ({ user, params, body }) => {
  if (id404(params.id)) return nf();
  if (!(await user.cfg.hit('files-finalize', 3600, 600))) return bad(429, 'rate_limited', '取り込みの回数が多すぎます。しばらくしてからにしてください');
  const file = await user.db((r) => r.files.get(params.id)); if (!file || file.status === 'deleting') return nf();
  if (file.status === 'ready') return ok({ file: publicFile(file) });
  // The owner's token cannot read an unverified object (policy files_read, migration 20): the bytes are measured with the service key, and a rejected object is removed with it.
  const svc = (await getStorage()).service;
  const discard = async () => { try { await svc.remove([file.objectPath], { bucket: USER_BUCKET }); await user.db(async (r) => { await r.files.beginDelete(file.id); await r.files.finishDelete(file.id); }); } catch (e) { console.error('[elvar] files: could not discard a rejected upload:', e?.code || e?.message); } };
  // the REAL object, not what the browser says about it: its size and SHA-256 must be what was reserved
  const real = await svc.hash(file.objectPath, { bucket: USER_BUCKET, maxBytes: file.size });
  if (!real) return bad(409, 'upload_missing', 'アップロードされたファイルが見つかりません。もう一度取り込んでください');
  if (real.tooLarge || real.size !== file.size || real.sha256 !== file.sha256) { await discard(); return bad(422, 'upload_mismatch', 'アップロードされたファイルの中身が、申告と一致しませんでした。保存していません。もう一度取り込んでください'); }
  const t = typeof body?.text === 'string' ? body.text : '';
  if (t.length > 1_500_000) { await discard(); return bad(413, 'text_too_large', '読み取った文字が大きすぎます'); }
  try {
    await user.db((r) => r.files.finalize(file.id, { size: real.size, text: t, ...memoryFields(body || {}) }));
  } catch (e) {
    if (e?.code === 'storage_quota_exceeded') { await discard(); return bad(413, 'storage_quota_exceeded', '読み取った文字を含めると、保存容量の上限をこえるため、保存していません'); }
    if (e?.code === 'reservation_expired') { await discard(); return bad(409, 'reservation_expired', 'アップロードの有効時間が過ぎました。もう一度取り込んでください'); }
    if (e?.code === 'invalid_value') { await discard(); return bad(400, 'bad_request', '読み取った内容の形式が正しくありません'); }
    throw e;
  }
  return ok({ file: publicFile(await user.db((r) => r.files.get(file.id))) });
});

/** Give the reservation back (the browser gave up, was cancelled, or the upload failed). */
export const cancelUpload = guard(async ({ user, params }) => {
  if (id404(params.id)) return nf();
  const f = await user.db((r) => r.files.get(params.id)); if (!f || f.status !== 'pending') return nf();
  const path = await user.db((r) => r.files.beginDelete(f.id)); if (!path) return nf();
  try { await (await userStorage(user)).remove([path]); } catch (e) { return fail(Object.assign(e, { status: 502 })); }
  await user.db((r) => r.files.finishDelete(f.id));
  return ok();
});

// ---------------------------------------------------------------- one file
/** A short-lived link to the original (the browser downloads it straight from Storage). */
export const downloadFile = guard(async ({ user, params }) => {
  if (id404(params.id)) return nf();
  if (!(await user.cfg.hit('files-download', 60, 240))) return bad(429, 'rate_limited', 'ダウンロードの回数が多すぎます。少し待ってください');
  const f = await user.db((r) => r.files.get(params.id)); if (!f || f.status !== 'ready') return nf();
  const url = await (await userStorage(user)).createDownloadUrl(f.objectPath, { name: f.name, expiresInSec: 120 });
  return ok({ url, name: f.name, mime: f.mime, size: f.size, expiresInSec: 120 });
});

/** The owner's own edits: name (the extension stays), tags, memo, kind label, the AI summary and the other fields of the memory. */
export const patchFile = guard(async ({ user, params, body }) => {
  if (id404(params.id)) return nf();
  const b = body && typeof body === 'object' ? body : {}, patch = {};
  const cur = await user.db((r) => r.files.get(params.id)); if (!cur || cur.status !== 'ready') return nf();
  if (b.name !== undefined) { const n = cleanName(b.name); if (extOf(n) !== extOf(cur.name)) return bad(400, 'bad_name', '拡張子は変えられません'); patch.name = n; }
  if (b.tags !== undefined) { if (!Array.isArray(b.tags)) return bad(400, 'bad_request'); patch.tags = [...new Set(b.tags.map((t) => String(t).normalize('NFKC').trim().replace(/^#/, '').slice(0, 30)).filter(Boolean))].slice(0, 30); }
  if (b.memo !== undefined) patch.memo = String(b.memo).slice(0, 1000);
  if (b.kindLabel !== undefined) patch.kindLabel = String(b.kindLabel ?? '').slice(0, 40);
  Object.assign(patch, memoryFields(b));   // title, kind guess, keywords, snippet, version mark, analysis: the memory of a file the browser read again
  try { await user.db((r) => r.files.patch(params.id, patch)); }
  catch (e) { if (e?.code === 'invalid_value') return bad(400, 'bad_request', '入力の形式が正しくありません'); throw e; }
  return ok({ file: publicFile(await user.db((r) => r.files.get(params.id))) });
});

/** A file that was read again (or read by the AI on request, with an approval card first): the memory and the extracted text are replaced. */
export const putFileText = guard(async ({ user, params, body }) => {
  if (id404(params.id)) return nf();
  const b = body && typeof body === 'object' ? body : {};
  if (typeof b.text !== 'string' || b.text.length > 1_500_000) return bad(400, 'bad_request', '文字の形式が正しくありません');
  try { await user.db((r) => r.files.patch(params.id, memoryFields(b), { text: b.text, setText: true })); }
  catch (e) {
    if (e?.code === 'storage_quota_exceeded') return bad(413, 'storage_quota_exceeded', '保存容量の上限をこえるため、読み取った文字を保存できません');
    if (e?.code === 'invalid_value') return bad(400, 'bad_request', '入力の形式が正しくありません');
    throw e;
  }
  return ok({ file: publicFile(await user.db((r) => r.files.get(params.id))) });
});

/** The file and its original are gone and the room is free again. If Storage cannot be reached the row stays hidden (deleting) and is removed by the next sweep. */
export const deleteFile = guard(async ({ user, params }) => {
  if (id404(params.id)) return nf();
  const f = await user.db((r) => r.files.get(params.id)); if (!f) return nf();
  const path = await user.db((r) => r.files.beginDelete(params.id)); if (!path) return nf();
  try { await (await userStorage(user)).remove([path]); }
  catch (e) { console.error('[elvar] files: the Storage object could not be removed (the sweep will retry):', e?.code || e?.message); return bad(502, 'storage_unavailable', 'ファイルの削除を完了できませんでした。しばらくして、もう一度お試しください（一覧からは消してあります）'); }
  await user.db((r) => r.files.finishDelete(params.id));
  return ok({ ok: true, freedBytes: f.size });
});

/** Everything the caller has in the vault (principle 7). */
export const deleteAllFiles = guard(async ({ user, body }) => {
  if (body?.confirm !== 'delete') return bad(400, 'confirm_required', '確認のため confirm: "delete" を付けてください');
  if (!(await user.cfg.hit('files-delete-all', 3600, 10))) return bad(429, 'rate_limited', '操作が多すぎます。しばらくしてからにしてください');
  const all = await user.db((r) => r.files.allPaths());
  if (!all.length) return ok({ ok: true, deleted: 0 });
  const paths = [];
  for (const f of all) { const p = await user.db((r) => r.files.beginDelete(f.id)); if (p) paths.push(p); }
  try { await (await userStorage(user)).remove(paths); }
  catch (e) { console.error('[elvar] files: delete-all could not remove the Storage objects (the sweep will retry):', e?.code || e?.message); return bad(502, 'storage_unavailable', 'ファイルの削除を完了できませんでした。しばらくして、もう一度お試しください'); }
  let n = 0; for (const f of all) if (await user.db((r) => r.files.finishDelete(f.id))) n++;
  return ok({ ok: true, deleted: n });
});
