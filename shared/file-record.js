// How a file's "memory" (the index the browser worker builds: web/src/file-index.js buildIndex) is split into the columns of app.files and put back together.
// One module for both sides, so the server's search and the browser's list read a file the same way (docs/ELVAR_MULTIUSER.md 5.1, 8.2).
//   toColumns(index)    the index -> { title, docKind, keywords, snippet, related, analysis } (what finalize / patch send)
//   indexOf(file)       a file row (as GET /api/elvar/files returns it) -> the index record the screen and searchFiles() use
const COLUMN_KEYS = new Set(['title', 'docKind', 'keywords', 'snippet', 'related', 'tags', 'memo', 'kind', 'sha256', 'size', 'id']);

/** The index split in two: the columns that are searched and listed, and the rest (kept as JSON in `analysis`). */
export function toColumns(index = {}) {
  const analysis = {};
  for (const [k, v] of Object.entries(index)) if (!COLUMN_KEYS.has(k) && v !== undefined) analysis[k] = v;
  return {
    title: index.title ? String(index.title).slice(0, 200) : null, docKind: index.docKind ? String(index.docKind).slice(0, 40) : null,
    keywords: (index.keywords || []).map((k) => String(k).slice(0, 60)).slice(0, 30), snippet: String(index.snippet || '').slice(0, 300),
    related: index.related && typeof index.related === 'object' ? { id: index.related.id, name: index.related.name, score: index.related.score } : null,
    analysis,
  };
}

/** The columns the owner edits: tags, memo, kind label (an empty label = "use the guess"). */
export const ownerColumns = (index = {}) => ({ tags: index.tags || [], memo: index.memo || '', kindLabel: index.kind || '' });

/** A file row -> the index record (the shape web/src/file-index.js works on: tags, keywords, snippet, kind (the owner's label), docKind ...). */
export function indexOf(file) {
  const a = file?.analysis || {};
  return {
    ...a, sha256: file.sha256, size: file.size, title: file.title || a.title || '', docKind: file.docKind || 'その他', kind: file.kindLabel || '', tags: [...(file.tags || [])], memo: file.memo || '',
    keywords: [...(file.keywords || [])], snippet: file.snippet || '', related: file.related || null, headings: a.headings || [], ext: a.ext || (/\.([A-Za-z0-9]{1,8})$/.exec(file.name || '')?.[1] || '').toLowerCase(),
  };
}

/** The list entry of a file (the `meta` record the screen used to keep in IndexedDB). */
export const metaOf = (file) => ({ id: file.id, name: file.name, type: file.mime, kind: file.kind, size: file.size, addedAt: Date.parse(file.createdAt) || 0, source: file.source });
