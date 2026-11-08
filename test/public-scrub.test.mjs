// Public-repo guard. Two layers:
//  1. Committed checks: the old brand and anything that looks like a real secret must not appear in any tracked / untracked file.
//  2. Private terms (owner name, school, employer, GitHub org ...): the LIST ITSELF is personal data, so it is never committed. It is read from
//     .scrub-terms.local (git-ignored, one term per line) or from the ELVAR_SCRUB_TERMS env (newline separated; a CI secret). Without either, layer 2 is skipped.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');

function listFiles() {
  const run = (args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).split('\n').filter(Boolean);
  const all = new Set([...run(['ls-files']), ...run(['ls-files', '-o', '--exclude-standard'])]);
  return [...all].filter((f) => !/^(node_modules|web\/dist|dist)\//.test(f) && !/(^|\/)package-lock\.json$/.test(f) && fs.existsSync(path.join(ROOT, f)));
}

function readText(rel) {
  const buf = fs.readFileSync(path.join(ROOT, rel));
  if (buf.subarray(0, 8000).includes(0)) return null;   // binary
  return buf.toString('utf8');
}

const FILES = listFiles();
const SELF = 'test/public-scrub.test.mjs';

// Old brand. Written so that this file does not match its own patterns (and it is allow-listed anyway).
const OLD_BRAND = [/V\.E\.C\.T\.O\.R/, /ベクター/, /VECTOR_/, /x-vector-token/, /com\.vector/];
// TEMPORARY: the HUD is being redesigned by another worker; these two files still carry the old name in a comment. Remove this entry when they are cleaned.
const PENDING_HUD = [];
const BRAND_ALLOW = new Set([SELF, 'docs/ELVAR_ARCHITECTURE.md', ...PENDING_HUD]);   // the architecture doc describes the migration; drop it when MIGRATING_FROM_VECTOR is written

// Things that look like real credentials. Parts are joined so that this file is not itself a hit for secret scanners.
const SECRET_RES = [
  new RegExp('AIza' + '[0-9A-Za-z_-]{30,}'),
  new RegExp('gh[pousr]_' + '[0-9A-Za-z]{30,}'),
  new RegExp('github_pat_' + '[0-9A-Za-z_]{30,}'),
  new RegExp('GOCSPX-' + '[0-9A-Za-z_-]{20,}'),
  new RegExp('gsk_' + '[0-9A-Za-z]{30,}'),
  new RegExp('-----BEGIN [A-Z ]*PRIVATE ' + 'KEY'),
];
// Fixtures: fake credentials used to test redaction (redactSecrets) - not real keys.
const SECRET_ALLOW = new Set([SELF, 'test/agents.test.mjs', 'test/conv-log.test.mjs']);

test('public guard: the scanned file set is real (not accidentally empty)', () => {
  assert.ok(FILES.length > 100, `only ${FILES.length} files scanned`);
  for (const must of ['server/persona.js', 'web/src/main.js', 'package.json']) assert.ok(FILES.includes(must), must);
});

test('public guard: no old brand name / identifiers in any file', () => {
  const hits = [];
  for (const f of FILES) {
    if (BRAND_ALLOW.has(f)) continue;
    const t = readText(f); if (t === null) continue;
    for (const re of OLD_BRAND) if (re.test(t)) hits.push(`${f}  (${re})`);
  }
  assert.deepEqual(hits, [], 'old brand found:\n' + hits.join('\n'));
});

test('public guard: no secret-looking strings in any file', () => {
  const hits = [];
  for (const f of FILES) {
    if (SECRET_ALLOW.has(f)) continue;
    const t = readText(f); if (t === null) continue;
    for (const re of SECRET_RES) if (re.test(t)) hits.push(`${f}  (${re.source.slice(0, 18)}...)`);
  }
  assert.deepEqual(hits, [], 'secret-looking string found:\n' + hits.join('\n'));
});

function privateTerms() {
  const raw = [];
  if (process.env.ELVAR_SCRUB_TERMS) raw.push(...process.env.ELVAR_SCRUB_TERMS.split(/\r?\n/));
  try { raw.push(...fs.readFileSync(path.join(ROOT, '.scrub-terms.local'), 'utf8').split(/\r?\n/)); } catch { /* no local list */ }
  return [...new Set(raw.map((x) => x.trim()).filter(Boolean))];
}
const TERMS = privateTerms();

test(TERMS.length ? `public guard (private terms, ${TERMS.length} configured): none of them appears anywhere` : 'public guard (private terms): SKIPPED - no .scrub-terms.local and no ELVAR_SCRUB_TERMS', { skip: TERMS.length ? false : 'no private term list available' }, () => {
  const hits = [];
  for (const f of FILES) {
    const t = readText(f); if (t === null) continue;
    const hay = (f + '\n' + t).toLowerCase();
    TERMS.forEach((term, i) => { if (hay.includes(term.toLowerCase())) hits.push(`${f}  (term #${i + 1})`); });   // never print the term itself
  }
  assert.deepEqual(hits, [], 'private term found:\n' + hits.join('\n'));
});

test('public guard: .scrub-terms.local is git-ignored and never tracked', () => {
  const tracked = execFileSync('git', ['ls-files', '.scrub-terms.local'], { cwd: ROOT, encoding: 'utf8' }).trim();
  assert.equal(tracked, '');
  assert.match(fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8'), /^\.scrub-terms\.local$/m);
});
