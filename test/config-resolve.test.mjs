import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { env, cfgEnv, getConfig, runWithConfig, currentConfig, envConfig } from '../server/config/resolve.js';
import { KEYS, keyInfo, isSecret } from '../server/config/keys.js';
import { promptVars, fill } from '../server/profile/vars.js';
import { DEFAULT_PROFILE, mergeProfile } from '../server/profile/defaults.js';
import { buildInstruction } from '../server/persona.js';
import { AGENTS } from '../server/agents/registry.js';
import { declarations } from '../server/google/tools.js';

const withEnv = async (vars, fn) => {
  const old = {}; for (const k of Object.keys(vars)) { old[k] = process.env[k]; if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k]; }
  try { return await fn(); } finally { for (const k of Object.keys(old)) { if (old[k] === undefined) delete process.env[k]; else process.env[k] = old[k]; } }
};

test('env(): reads process.env outside any request, and a request config wins inside runWithConfig', async () => {
  await withEnv({ GROQ_MODEL: 'from-env' }, async () => {
    assert.equal(env('GROQ_MODEL'), 'from-env');
    assert.equal(env('NO_SUCH_SETTING_X'), undefined);
    const cfg = { ...envConfig(), get: (n) => (n === 'GROQ_MODEL' ? 'from-app' : undefined) };
    await runWithConfig(cfg, async () => {
      await new Promise((r) => setTimeout(r, 1));   // the context survives awaits
      assert.equal(env('GROQ_MODEL'), 'from-app');
      assert.equal(cfgEnv.GROQ_MODEL, 'from-app');
      assert.equal(env('GEMINI_LIVE_MODEL'), process.env.GEMINI_LIVE_MODEL, 'unset in the app config -> falls back to env');
    });
    assert.equal(env('GROQ_MODEL'), 'from-env', 'context does not leak out');
  });
});

test('cfgEnv is an env-shaped view: property read, "in", and a live view of changes', async () => {
  await withEnv({ SUBAGENT_PROVIDER: 'gemini' }, async () => {
    assert.equal(cfgEnv.SUBAGENT_PROVIDER, 'gemini');
    assert.ok('SUBAGENT_PROVIDER' in cfgEnv);
    process.env.SUBAGENT_PROVIDER = 'groq'; assert.equal(cfgEnv.SUBAGENT_PROVIDER, 'groq');
  });
  assert.ok(!('SUBAGENT_PROVIDER' in cfgEnv));
});

test('getConfig(req): env-only for now; shape is final (get/source/profile/features)', async () => {
  await withEnv({ BRAIN_BRANCH: 'dev', BRAIN_DIR: undefined }, async () => {
    const r = await getConfig({ headers: {} });
    assert.equal(r.ok, true); assert.equal(r.status, 200);
    assert.equal(r.cfg.get('BRAIN_BRANCH'), 'dev'); assert.equal(r.cfg.source('BRAIN_BRANCH'), 'env'); assert.equal(r.cfg.source('BRAIN_DIR'), 'default');
    assert.deepEqual(r.cfg.profile, DEFAULT_PROFILE); assert.equal(typeof r.cfg.features, 'object');
  });
  await withEnv({ ELVAR_PROFILE: JSON.stringify({ owner: { address: 'テスト様' } }) }, async () => {
    assert.equal(currentConfig().profile.owner.address, 'テスト様');
    assert.equal(currentConfig().profile.assistant.displayName, 'E.L.V.A.R.', 'partial profile is merged over the defaults');
  });
  await withEnv({ ELVAR_PROFILE: '{broken' }, async () => assert.deepEqual(currentConfig().profile, DEFAULT_PROFILE));
});

test('keys ledger: unique names, secrets are not defaulted, families are recognised', () => {
  const names = KEYS.map((k) => k.name); assert.equal(new Set(names).size, names.length);
  for (const k of KEYS) { assert.ok(['secret', 'setting', 'infra'].includes(k.kind), k.name); assert.ok(k.envNames.includes(k.name)); if (k.kind === 'secret') assert.equal(k.default, undefined, k.name); }
  assert.ok(isSecret('GEMINI_API_KEY') && !isSecret('GROQ_MODEL') && !isSecret('PORT'));
  assert.equal(keyInfo('AGENT_LLM_MEMORY').kind, 'setting'); assert.equal(keyInfo('ROUTE_NEWS').kind, 'setting'); assert.equal(keyInfo('NOPE'), null);
});

test('every env name read in server/ and api/ is in the ledger (or is an allowed dynamic family)', () => {
  const root = path.resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
  const files = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (p.endsWith('.js')) files.push(p); } };
  walk(path.join(root, 'server')); walk(path.join(root, 'api'));
  const seen = new Set(); const direct = [];
  for (const f of files) {
    if (f.includes(`${path.sep}config${path.sep}`)) continue;
    const t = fs.readFileSync(f, 'utf8');
    for (const m of t.matchAll(/\benv\('([A-Z][A-Z0-9_]*)'\)/g)) seen.add(m[1]);
    for (const m of t.matchAll(/\benv\.([A-Z][A-Z0-9_]{3,})\b/g)) seen.add(m[1]);
    for (const m of t.matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)) direct.push(`${path.relative(root, f)}: ${m[1]}`);
  }
  const unknown = [...seen].filter((n) => !keyInfo(n));
  assert.deepEqual(unknown, [], 'add these to server/config/keys.js');
  // direct process.env reads are only for infrastructure keys
  const bad = direct.filter((x) => keyInfo(x.split(': ')[1])?.kind !== 'infra');
  assert.deepEqual(bad, [], 'use env() for non-infra keys');
});

test('profile placeholders: fill() replaces known keys, keeps unknown ones; the default profile is neutral', () => {
  const v = promptVars(DEFAULT_PROFILE, Date.UTC(2026, 10, 8, 20));
  assert.equal(v.A, 'E.L.V.A.R.'); assert.equal(v.AS, 'エルヴァー'); assert.equal(v.AX, 'Evolving Learning Virtual Adaptive Reasoning');
  assert.equal(v.U, 'ご主人様'); assert.equal(v.TZ, 'Asia/Tokyo'); assert.equal(v.TODAY, '2026-11-09');
  assert.equal(fill('{{U}}と{{A}}と{{NOPE}}', v), 'ご主人様とE.L.V.A.R.と{{NOPE}}');
  const p = mergeProfile({ owner: { address: 'テスト様' }, assistant: { expansion: '' } });
  assert.equal(p.owner.name, 'User'); assert.equal(p.owner.address, 'テスト様'); assert.equal(p.assistant.spokenName, 'エルヴァー');
});

test('no unfilled {{...}} placeholder reaches the model: persona, every agent prompt, every tool declaration', () => {
  const left = (t) => String(t).match(/\{\{[A-Z_]+\}\}/g);
  for (const g of [true, false]) assert.equal(left(buildInstruction({ google: g })), null, 'persona google=' + g);
  for (const [id, def] of Object.entries(AGENTS)) assert.equal(left(def.system()), null, 'agent ' + id);
  assert.equal(left(JSON.stringify(declarations({ includeHidden: true }))), null, 'tool declarations');
  // a custom profile reaches all three
  const prof = { owner: { address: 'テスト様', name: 'テスト' }, assistant: { displayName: 'ELV-X', spokenName: 'えるぶいえっくす', expansion: '' } };
  return withEnv({ ELVAR_PROFILE: JSON.stringify(prof) }, () => {
    const t = buildInstruction({ google: true });
    assert.ok(t.includes('テスト様') && t.includes('ELV-X') && !t.includes('ご主人様専属'), 'custom profile in the persona');
    assert.ok(!t.includes('Evolving Learning Virtual Adaptive Reasoning'), 'no expansion -> the long form is not spoken');
    assert.ok(AGENTS.memory.system().includes('テスト様専用の第二の脳'));
    assert.ok(JSON.stringify(declarations()).includes('テスト様'));
  });
});
