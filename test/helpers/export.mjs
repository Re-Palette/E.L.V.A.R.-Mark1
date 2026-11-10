// What a user does to get their data: ask for an export, let the page call the steps until it is done, download every part through its link, open the zips.
import assert from 'node:assert/strict';
import { getStorage } from '../../server/storage/index.js';
import { readZip } from '../../server/rights/zip.js';

/** @returns {Promise<{job: object, parts: object[], files: Record<string, Buffer>, json: (name: string) => any, names: string[]}>} `files` merges every part (names are unique across parts) */
export async function runExport(h, who, { max = 50 } = {}) {
  const st = await getStorage();
  let r = await h.call('POST', '/api/elvar/export', who, {}); assert.equal(r.status, 200, JSON.stringify(r.body));
  let job = r.body.job;
  for (let i = 0; i < max && job.status !== 'done'; i++) {
    assert.ok(['queued', 'running'].includes(job.status), `export ${job.status}: ${job.error}`);
    r = await h.call('POST', `/api/elvar/export/${job.id}/step`, who, {}); assert.equal(r.status, 200, JSON.stringify(r.body)); job = r.body.job;
  }
  assert.equal(job.status, 'done', JSON.stringify(job));
  const files = {}, parts = [];
  for (const d of job.downloads) {
    const tok = new URL(d.url).searchParams.get('token'), got = await st.downloadWithToken(tok); const z = readZip(got.bytes); parts.push({ part: d.part, bytes: got.bytes.length, names: Object.keys(z) });
    for (const [n, b] of Object.entries(z)) { assert.ok(!(n in files), `entry in two parts: ${n}`); files[n] = b; }
  }
  /** Every row of one table, from the rows/<table>-part<n>.jsonl files in part order. */
  const rows = (table) => Object.keys(files).filter((n) => new RegExp(`^rows/${table}-part\\d+\\.jsonl$`).test(n)).sort((x, y) => Number(x.match(/part(\d+)/)[1]) - Number(y.match(/part(\d+)/)[1])).flatMap((n) => files[n].toString('utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)));
  return { job, parts, files, names: Object.keys(files), json: (n) => JSON.parse(files[n].toString('utf8')), rows };
}

/** The old shape of the export (`{ files: { 'notes.json': {...} }, user }`) from the zip, for tests that look at what leaves with the user. Lifts the one-a-day limit for this user first. */
export async function exportBody(h, who) {
  const uid = h.tokenOwner(who.authorization); h.db.testing.setHardLimits(uid, { exportsPerDay: 1000 });
  const { _clearUsageCache } = await import('../../server/usage.js'), { _clearAccountCache } = await import('../../server/auth/with-user.js'); _clearUsageCache(); _clearAccountCache();
  const x = await runExport(h, who), files = {};
  for (const n of x.names) if (n.startsWith('data/')) files[n.slice(5)] = x.json(n);
  // the old shape of the files that carry rows (tests look at what leaves with the user, not at how the zip lays it out)
  const revs = x.rows('note_revisions'), msgs = x.rows('messages'), texts = new Map(x.rows('file_texts').map((t) => [t.file_id, t.text]));
  files['notes.json'] = { ...files['notes.json'], notes: x.rows('notes').map((n) => ({ ...n, content: x.files[n.file].toString('utf8'), trashed: n.deleted_at !== null, revisions: revs.filter((v) => v.note_id === n.id) })) };
  files['conversations.json'] = { ...files['conversations.json'], conversations: x.rows('conversations').map((c) => ({ ...c, messages: msgs.filter((m) => m.conversation_id === c.id) })) };
  const ready = x.rows('files').filter((f) => f.status === 'ready');
  files['files.json'] = { ...files['files.json'], files: ready.map((f) => ({ ...f, text: texts.get(f.id) ?? null })), originals: ready.map((f) => ({ id: f.id, name: f.name, size: f.size_bytes, sha256: f.sha256, exportPath: `files/${f.id}-${f.name}`, downloadPath: `/api/elvar/files/${f.id}/download` })) };
  files['inbox.json'] = { ...files['inbox.json'], inbox: x.rows('inbox_items') }; files['audit.json'] = { ...files['audit.json'], audit: x.rows('audit_log') }; files['builds.json'] = { ...files['builds.json'], builds: x.rows('build_requests') };
  files['usage.json'] = { ...files['usage.json'], daily: x.rows('usage_daily'), events: x.rows('usage_events') };
  return { files, user: x.json('manifest.json').user, manifest: x.json('manifest.json'), zip: x };
}
