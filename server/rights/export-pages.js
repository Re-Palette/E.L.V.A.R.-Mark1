// The tables whose rows the export carries page by page (docs/ELVAR_MULTIUSER.md 7.3, 19). A user can have any number of notes, messages, audit entries, usage events, files:
// no table is read with a fixed cap. Each is walked with a KEYSET cursor over its primary key (everything after the last key of the previous page), so the walk is stable
// while rows are added, needs no OFFSET, and ends when a page comes back short. `page` is how many rows one database call returns (small where one row can be large).
// Both database implementations (pg.js, memory.js) implement `rights.exportPage(table, { after, limit })` with this one spec; test/export-complete.test.mjs checks that the
// rows in the zip equal the manifest's counts for every table.
import { entryFor, redactRow } from './registry.js';

/** table -> { key: [[column, sql type]...] (the primary key without user_id), ts: timestamp columns (ISO strings in the export), drop: columns that never leave, page } */
export const PAGED = Object.freeze({
  build_requests: { key: [['id', 'uuid']], ts: ['created_at', 'updated_at'], drop: [], page: 200 },
  notes: { key: [['id', 'uuid']], ts: ['created_at', 'updated_at', 'deleted_at'], drop: [], page: 20 },
  note_revisions: { key: [['note_id', 'uuid'], ['rev', 'int']], ts: ['at'], drop: [], page: 20 },
  conversations: { key: [['id', 'uuid']], ts: ['started_at', 'last_at'], drop: [], page: 500 },
  messages: { key: [['id', 'bigint']], ts: ['at'], drop: [], page: 500 },
  inbox_items: { key: [['id', 'uuid']], ts: ['at', 'read_at'], drop: [], page: 200 },
  audit_log: { key: [['id', 'bigint']], ts: ['at'], drop: [], page: 500 },
  usage_events: { key: [['id', 'bigint']], ts: ['at'], drop: [], page: 1000 },
  usage_daily: { key: [['day', 'date'], ['provider', 'text'], ['metric', 'text']], ts: [], drop: [], page: 1000 },
  files: { key: [['id', 'uuid']], ts: ['reserved_until', 'created_at', 'finalized_at', 'updated_at'], drop: ['object_path'], page: 100 },   // the Storage path never leaves
  file_texts: { key: [['file_id', 'uuid']], ts: ['created_at', 'updated_at'], drop: [], page: 4 },
});
/** The order the export walks them in (parents first). */
export const PAGED_ORDER = Object.freeze(['build_requests', 'notes', 'note_revisions', 'conversations', 'messages', 'inbox_items', 'audit_log', 'usage_events', 'usage_daily', 'files', 'file_texts']);

const isoOf = (v) => (v === null || v === undefined ? null : new Date(v).toISOString());
/** One row as the export shows it: no user_id, none of the registry's excluded columns or the table's own dropped ones, timestamps as ISO strings. @param {object} raw snake_case columns */
export function pageRow(table, raw) {
  const spec = PAGED[table], drop = new Set(['user_id', ...spec.drop]), ts = new Set(spec.ts), out = {};
  for (const [k, v] of Object.entries(redactRow(entryFor(table), raw))) if (!drop.has(k)) out[k] = ts.has(k) ? isoOf(v) : v;
  return out;
}
/** The cursor of a row: the values of its key columns as strings. */
export const keyOf = (table, row) => PAGED[table].key.map(([c]) => String(row[c]));
