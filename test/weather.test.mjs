import test from 'node:test';
import assert from 'node:assert/strict';
import { TOOL_MAP } from '../server/google/tools.js';

test('weather tool: geocodes then forecasts via Open-Meteo (stubbed)', async () => {
  const real = globalThis.fetch, urls = [];
  globalThis.fetch = async (u, o) => {
    u = String(u); urls.push(u);
    const body = u.includes('geocoding')
      ? { results: [{ name: '大阪', admin1: '大阪府', country: '日本', latitude: 34.69, longitude: 135.5 }] }
      : { current: { temperature_2m: 18.2, apparent_temperature: 17, relative_humidity_2m: 60, precipitation: 0, weather_code: 3, wind_speed_10m: 9 },
          daily: { time: ['2026-11-01'], weather_code: [61], temperature_2m_max: [20], temperature_2m_min: [12], precipitation_probability_max: [70], precipitation_sum: [4] } };
    return { ok: true, status: 200, json: async () => body };
  };
  try {
    const r = await TOOL_MAP.weather.run({ place: '大阪', days: 1 });
    assert.equal(urls.filter((x) => x.includes('geocoding')).length, 0);   // built-in city: no lookup
    const r2 = await TOOL_MAP.weather.run({ place: '那須', days: 1 });
    assert.match(r2.place, /大阪/); // (stub returns Osaka for any geocode)
    assert.equal(r.now.condition, 'くもり');
    assert.equal(r.daily[0].condition, '雨');
    assert.match(r.place, /大阪/);
    assert.ok(urls[0].includes('api.open-meteo.com') && urls[0].includes('latitude=34.69'));
    globalThis.fetch = async () => ({ ok: true, json: async () => ({}) });
    await assert.rejects(TOOL_MAP.weather.run({ place: 'zzz' }), /場所が見つかりません/);
    globalThis.fetch = async () => { throw new TypeError('fetch failed', { cause: { code: 'ENOTFOUND' } }); };
    await assert.rejects(TOOL_MAP.weather.run({ place: '東京' }), /接続できません: ENOTFOUND/);
  } finally { globalThis.fetch = real; }
});

test('news tool: needs key, sends it in a header, returns trimmed articles (stubbed)', async () => {
  const real = globalThis.fetch, oldKey = process.env.NEWSDATA_API_KEY;
  try {
    delete process.env.NEWSDATA_API_KEY;
    await assert.rejects(TOOL_MAP.news.run({}), /NEWSDATA_API_KEY/);
    process.env.NEWSDATA_API_KEY = 'secret-key';
    let seen;
    globalThis.fetch = async (u, o) => { seen = { u: String(u), h: o.headers }; return { ok: true, status: 200, json: async () => ({ status: 'success', results: [{ title: 'T', description: 'D', source_name: 'S', pubDate: '2026-11-01', category: ['business'], link: 'https://x' }] }) }; };
    const r = await TOOL_MAP.news.run({ query: '円相場', maxResults: 3 });
    assert.equal(r.articles[0].title, 'T');
    assert.ok(seen.u.includes('language=ja') && seen.u.includes('country=jp') && !seen.u.includes('secret-key'));
    assert.equal(seen.h['X-ACCESS-KEY'], 'secret-key');
    globalThis.fetch = async () => ({ ok: false, status: 401, json: async () => ({ status: 'error', results: { message: 'bad key' } }) });
    await assert.rejects(TOOL_MAP.news.run({}), /NewsDataのエラー \(401\)/);
  } finally { globalThis.fetch = real; if (oldKey === undefined) delete process.env.NEWSDATA_API_KEY; else process.env.NEWSDATA_API_KEY = oldKey; }
});

test('deep_think tool: calls Groq with Bearer key; only declared when GROQ_API_KEY is set (stubbed)', async () => {
  const { declarations } = await import('../server/google/tools.js');
  const real = globalThis.fetch, oldKey = process.env.GROQ_API_KEY, oldModel = process.env.GROQ_MODEL;
  try {
    delete process.env.GROQ_API_KEY; delete process.env.GROQ_MODEL;
    assert.ok(!declarations().some((d) => d.name === 'deep_think'));
    await assert.rejects(TOOL_MAP.deep_think.run({ question: 'q' }), /GROQ_API_KEY/);
    process.env.GROQ_API_KEY = 'gsk-test';
    assert.ok(declarations().some((d) => d.name === 'deep_think'));
    let seen;
    globalThis.fetch = async (u, o) => { seen = { u: String(u), h: o.headers, b: JSON.parse(o.body) }; return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '結論です' } }] }) }; };
    const r = await TOOL_MAP.deep_think.run({ question: '1+1は？' });
    assert.equal(r.answer, '結論です');
    assert.ok(seen.u.startsWith('https://api.groq.com/openai/v1/chat/completions'));
    assert.equal(seen.h.authorization, 'Bearer gsk-test');
    assert.equal(seen.b.messages[1].content, '1+1は？');
    assert.equal(seen.b.reasoning_effort, 'medium');
    globalThis.fetch = async () => ({ ok: false, status: 429, json: async () => ({ error: { message: 'rate limit' } }) });
    await assert.rejects(TOOL_MAP.deep_think.run({ question: 'q' }), /Groqのエラー \(429\)/);
  } finally {
    globalThis.fetch = real;
    if (oldKey === undefined) delete process.env.GROQ_API_KEY; else process.env.GROQ_API_KEY = oldKey;
    if (oldModel === undefined) delete process.env.GROQ_MODEL; else process.env.GROQ_MODEL = oldModel;
  }
});

test('usage_report needs a signed-in user (the numbers are the account\'s own); deep_think passes Groq rate-limit headers through as _quota', async () => {
  (await import('../server/llm-health.js'))._reset();
  const real = globalThis.fetch, k = process.env.GROQ_API_KEY, n = process.env.GEMINI_LIVE_DAILY_MINUTES;
  try {
    process.env.GEMINI_LIVE_DAILY_MINUTES = '45'; process.env.GROQ_API_KEY = 'gsk-x';
    await assert.rejects(TOOL_MAP.usage_report.run({}), /ログインしているときだけ/);
    globalThis.fetch = async () => ({ ok: true, status: 200, headers: { get: (h) => ({ 'x-ratelimit-limit-requests': '1000', 'x-ratelimit-remaining-requests': '990', 'x-ratelimit-limit-tokens': '8000', 'x-ratelimit-remaining-tokens': '7000' }[h]) }, json: async () => ({ choices: [{ message: { content: 'ok' } }] }) });
    const d = await TOOL_MAP.deep_think.run({ question: 'q' });
    assert.deepEqual([d._quota.requestsLimit, d._quota.requestsRemaining, d._quota.tokensRemaining], [1000, 990, 7000]);
  } finally { globalThis.fetch = real; k === undefined ? delete process.env.GROQ_API_KEY : (process.env.GROQ_API_KEY = k); n === undefined ? delete process.env.GEMINI_LIVE_DAILY_MINUTES : (process.env.GEMINI_LIVE_DAILY_MINUTES = n); }
});

test('web_search: Gemini Google-Search grounding via the existing key; returns answer + sources, flags ungrounded answers, clear errors', async () => {
  const real = globalThis.fetch, oldKey = process.env.GEMINI_API_KEY;
  try {
    delete process.env.GEMINI_API_KEY;
    const { declarations } = await import('../server/google/tools.js');
    assert.ok(!declarations().some((d) => d.name === 'web_search'));
    await assert.rejects(TOOL_MAP.web_search.run({ query: 'x' }), /GEMINI_API_KEY/);
    process.env.GEMINI_API_KEY = 'AIza-test';
    assert.ok(declarations().some((d) => d.name === 'web_search'));
    let seen;
    globalThis.fetch = async (u, o) => { seen = { u: String(u), h: o.headers, b: JSON.parse(o.body) }; return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: '結論です。' }] }, groundingMetadata: { webSearchQueries: ['q1'], groundingChunks: [{ web: { uri: 'https://a.example/x', title: 'a.example' } }, { web: { uri: 'https://a.example/x', title: 'dup' } }, { web: { uri: 'https://b.example/y', title: 'b.example' } }] } }] }) }; };
    const r = await TOOL_MAP.web_search.run({ query: '新型の発売日' });
    assert.match(seen.u, /models\/gemini-flash-latest:generateContent/); assert.equal(seen.h['x-goog-api-key'], 'AIza-test'); assert.deepEqual(seen.b.tools, [{ google_search: {} }]);
    assert.equal(r.answer, '結論です。'); assert.deepEqual(r.sources.map((s) => s.url), ['https://a.example/x', 'https://b.example/y']); assert.equal(r.grounded, true); assert.match(r.warning, /信頼できない/);
    globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: '記憶による回答' }] } }] }) });
    assert.equal((await TOOL_MAP.web_search.run({ query: 'q' })).grounded, false);
    globalThis.fetch = async () => ({ ok: false, status: 429, json: async () => ({ error: { message: 'quota' } }) });
    await assert.rejects(TOOL_MAP.web_search.run({ query: 'q' }), /検索のエラー \(429/);
  } finally { globalThis.fetch = real; oldKey === undefined ? delete process.env.GEMINI_API_KEY : (process.env.GEMINI_API_KEY = oldKey); }
});

test('web search with Exa: key header, /answer for web_search, /search for web_sources (hidden), Gemini fallback when Exa fails, clear errors', async () => {
  const real = globalThis.fetch, keep = { e: process.env.EXA_API_KEY, g: process.env.GEMINI_API_KEY, p: process.env.WEB_SEARCH_PROVIDER };
  const { declarations } = await import('../server/google/tools.js');
  try {
    delete process.env.WEB_SEARCH_PROVIDER; delete process.env.GEMINI_API_KEY; process.env.EXA_API_KEY = 'exa-test';
    assert.ok(declarations().some((d) => d.name === 'web_search'));
    assert.ok(!declarations().some((d) => d.name === 'web_sources'), 'raw results tool is for the research agent only');
    const calls = [];
    globalThis.fetch = async (u, o) => {
      u = String(u); calls.push({ u, h: o.headers, b: JSON.parse(o.body) });
      if (u.endsWith('/answer')) return { ok: true, status: 200, json: async () => ({ answer: '発売日は11月です。', citations: [{ url: 'https://a.example/1', title: 'A', publishedDate: '2026-10-30T00:00:00.000Z' }, { url: 'https://a.example/1', title: 'dup' }, { url: 'https://b.example/2', title: 'B' }] }) };
      return { ok: true, status: 200, json: async () => ({ results: [{ title: 'T1', url: 'https://c.example/3', publishedDate: '2026-11-01T00:00:00Z', text: '本文 '.repeat(500) }, { title: 'T2', url: 'https://d.example/4', highlights: ['要点だけ'] }] }) };
    };
    const a = await TOOL_MAP.web_search.run({ query: '新型の発売日' });
    assert.equal(calls[0].u, 'https://api.exa.ai/answer'); assert.equal(calls[0].h['x-api-key'], 'exa-test');
    assert.equal(a.source, 'Exa'); assert.deepEqual(a.sources.map((s) => s.url), ['https://a.example/1', 'https://b.example/2']); assert.equal(a.sources[0].published, '2026-10-30'); assert.equal(a.grounded, true);
    const s = await TOOL_MAP.web_sources.run({ query: 'x', numResults: 20, recencyDays: 7, category: 'news' });
    assert.equal(calls[1].u, 'https://api.exa.ai/search'); assert.equal(calls[1].b.numResults, 8); assert.equal(calls[1].b.category, 'news'); assert.ok(Date.parse(calls[1].b.startPublishedDate) > Date.now() - 8 * 864e5);
    assert.equal(s.results.length, 2); assert.ok(s.results[0].excerpt.length <= 901); assert.equal(s.results[1].excerpt, '要点だけ');
    // Exa fails (quota) -> Gemini answers and says so; with no Gemini key the Exa error is reported
    process.env.GEMINI_API_KEY = 'AIza-test'; process.env.ROUTE_SEARCH_QUICK = 'exa,gemini';   // Exa first for this case
    globalThis.fetch = async (u) => String(u).includes('exa.ai') ? { ok: false, status: 402, json: async () => ({ error: 'credits exhausted' }) } : { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: 'Geminiの答え' }] } }] }) };
    const f = await TOOL_MAP.web_search.run({ query: 'q' }); assert.equal(f.answer, 'Geminiの答え'); assert.match(f.note, /Exaが使えなかった/);
    delete process.env.GEMINI_API_KEY; delete process.env.ROUTE_SEARCH_QUICK;
    await assert.rejects(TOOL_MAP.web_search.run({ query: 'q' }), /Exaのエラー \(402\)/);
    delete process.env.EXA_API_KEY; await assert.rejects(TOOL_MAP.web_sources.run({ query: 'q' }), /EXA_API_KEY/);
  } finally { globalThis.fetch = real; for (const [k, v] of [['EXA_API_KEY', keep.e], ['GEMINI_API_KEY', keep.g], ['WEB_SEARCH_PROVIDER', keep.p]]) v === undefined ? delete process.env[k] : (process.env[k] = v); }
});

test('routing: short searches prefer Gemini, deep research prefers Exa; env overrides; weather and news fall back through their backups', async () => {
  const { routeOrder, runRoute } = await import('../server/routing.js');
  const all = () => true;
  assert.deepEqual(routeOrder('search_quick', all, {}), ['gemini', 'exa']); assert.deepEqual(routeOrder('search_deep', all, {}), ['exa', 'gemini']);
  assert.deepEqual(routeOrder('weather', all, {}), ['open-meteo', 'met-no', 'search']); assert.deepEqual(routeOrder('news', all, {}), ['newsdata', 'exa', 'gemini']);
  assert.deepEqual(routeOrder('weather', all, { ROUTE_WEATHER: 'met-no, open-meteo' }), ['met-no', 'open-meteo', 'search'], 'override goes first, the rest keep their order');
  assert.deepEqual(routeOrder('news', (n) => n !== 'newsdata', {}), ['exa', 'gemini'], 'unavailable services are skipped');
  const r = await runRoute('weather', { 'open-meteo': async () => { throw new Error('down'); }, 'met-no': async () => ({ ok: 1 }) }, all, {});
  assert.equal(r.via, 'met-no'); assert.match(r.note, /Open-Meteoが使えなかった/);
  await assert.rejects(runRoute('weather', { 'open-meteo': async () => { throw Object.assign(new Error('場所が見つかりません: x'), { noFallback: true }); }, 'met-no': async () => ({}) }, all, {}), /場所が見つかりません/);

  const real = globalThis.fetch, keep = Object.fromEntries(['NEWSDATA_API_KEY', 'EXA_API_KEY', 'GEMINI_API_KEY'].map((k) => [k, process.env[k]]));
  try {
    // weather: Open-Meteo down -> MET Norway (a real-shaped compact response), in Japanese terms
    delete process.env.EXA_API_KEY; delete process.env.GEMINI_API_KEY;
    const t0 = '2026-11-02T00:00:00Z';
    const ts = Array.from({ length: 30 }, (_, i) => ({ time: new Date(Date.parse(t0) + i * 3600e3).toISOString(), data: { instant: { details: { air_temperature: 10 + (i % 12), relative_humidity: 60, wind_speed: 2 } }, next_1_hours: { summary: { symbol_code: i < 10 ? 'cloudy' : 'rain' }, details: { precipitation_amount: i >= 10 ? 0.5 : 0 } } } }));
    let seenUA = '';
    globalThis.fetch = async (u, o) => { u = String(u); if (u.includes('open-meteo')) return { ok: false, status: 503, json: async () => ({}) }; if (u.includes('api.met.no')) { seenUA = o.headers['user-agent']; return { ok: true, status: 200, json: async () => ({ properties: { timeseries: ts } }) }; } throw new Error('unexpected ' + u); };
    const w = await TOOL_MAP.weather.run({ place: '東京', days: 2 });
    assert.equal(w.source, 'MET Norway'); assert.match(w.note, /Open-Meteoが使えなかった/); assert.ok(seenUA.includes('elvar'));
    assert.equal(w.now.condition, 'くもり'); assert.equal(w.daily.length, 2); assert.ok(typeof w.daily[0].maxC === 'number' && w.daily[0].rainMm > 0 && w.daily[0].condition);
    await assert.rejects(TOOL_MAP.weather.run({ place: '那須', days: 1 }), /場所が見つかりません|座標が分かりません/);   // not a built-in city: MET cannot help
    // news: NewsData rate-limited -> Exa news search
    process.env.NEWSDATA_API_KEY = 'nk'; process.env.EXA_API_KEY = 'ek';
    globalThis.fetch = async (u, o) => { u = String(u); if (u.includes('newsdata.io')) return { ok: false, status: 429, json: async () => ({ status: 'error', results: { message: 'limit' } }) }; return { ok: true, status: 200, json: async () => ({ results: [{ title: 'N1', url: 'https://news.example/a', publishedDate: '2026-11-02T00:00:00Z', text: '本文' }] }), _b: JSON.parse(o.body) }; };
    const n = await TOOL_MAP.news.run({ query: '半導体', maxResults: 3 });
    assert.equal(n.source, 'Exa（ニュース検索）'); assert.equal(n.articles[0].source, 'news.example'); assert.match(n.note, /NewsDataが使えなかった/);
  } finally { globalThis.fetch = real; for (const [k, v] of Object.entries(keep)) v === undefined ? delete process.env[k] : (process.env[k] = v); }
});
