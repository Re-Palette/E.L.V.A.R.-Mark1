import { geminiModel } from '../gemini-models.js';
import { sarashinaConfigured, sarashinaModel, sarashinaBaseUrl } from '../sarashina.js';
import { isUp } from '../llm-health.js';
import { cfgEnv, env } from '../config/resolve.js';
// Which LLM each sub-agent uses. Two providers behind the same OpenAI-compatible API:
//  - Groq   (openai/gpt-oss-120b): very fast, strong reasoning, but the free tier allows few tokens per minute -> short, thinking-heavy jobs.
//  - Gemini (gemini-2.5-flash):    large context and high limits -> jobs that read a lot (notes, mail, search results, long documents).
// Gemini leads for every agent (the owner's choice: one main API, the others as backups). Each agent has a preference order; if the first provider fails (limit, outage, no key) the run continues on the next one.
export const PROVIDERS = {
  groq: { url: 'https://api.groq.com/openai/v1/chat/completions', key: () => env('GROQ_API_KEY'), model: () => env('SUBAGENT_MODEL') || env('GROQ_MODEL') || 'openai/gpt-oss-120b' },
  gemini: { url: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', key: () => env('GEMINI_API_KEY'), model: () => geminiModel(env('SUBAGENT_GEMINI_MODEL') || env('SUBAGENT_MODEL')) },
  //  - Sarashina (sarashina3-nano): Japanese-strong, its own quota. It fills in when Groq / Gemini hit their limits, and leads the Japanese-writing agents.
  //    Tool calling on its API is unverified: if it refuses tools, `sarashinaNoTools` is set and agents skip it (it still serves text-only work).
  sarashina: { get url() { return `${sarashinaBaseUrl()}/chat/completions`; }, key: () => (sarashinaConfigured() ? 'set' : ''), model: () => env('SARASHINA_AGENT_MODEL') || sarashinaModel(true) },   // nano: 60 requests/min (mini allows only 6, too few for a tool loop)
};
export const state = { sarashinaNoTools: false };
export function pickProvider(env = cfgEnv) {
  const want = String(env.SUBAGENT_PROVIDER || '').toLowerCase();
  if (PROVIDERS[want] && PROVIDERS[want].key()) return want;
  if (env.GROQ_API_KEY) return 'groq';
  if (env.GEMINI_API_KEY) return 'gemini';
  if (sarashinaConfigured()) return 'sarashina';
  return null;
}
export const subagentsAvailable = () => !!pickProvider();


/** Preference order per agent (first = best fit). Override one agent with AGENT_LLM_<AGENT>=groq|gemini, or all with SUBAGENT_PROVIDER. */
export const DEFAULT_ROUTE = {
  schedule: ['gemini', 'groq'],         // tool loops resend the whole chat every step: Groq's free per-minute token limit (429) is hit quickly, so Gemini leads and Groq backs up
  memory: ['gemini', 'groq'],       // reads many notes
  mail: ['gemini', 'groq'],         // reads mail bodies
  document: ['gemini', 'groq'],     // long input and long output
  research: ['gemini', 'groq'],     // long search excerpts
  project: ['gemini', 'groq'],      // reads several project notes
  briefing: ['gemini', 'groq'],     // mail + news + calendar in one go
  learning: ['gemini', 'groq'],     // reads a dozen notes
  review: ['gemini', 'groq'],       // a week of calendar + notes
  trip: ['gemini', 'groq'],         // tool loops resend the whole chat every step: Groq's free per-minute token limit (429) is hit quickly, so Gemini leads and Groq backs up
  news: ['gemini', 'groq'],         // reads search / news excerpts
  idea: ['gemini', 'groq'],         // reads notes and search results, writes a long memo
  money: ['gemini', 'groq'],        // reads mail bodies
  compare: ['gemini', 'groq'],      // reads search excerpts
  tasks: ['gemini', 'groq'],         // tool loops resend the whole chat every step: Groq's free per-minute token limit (429) is hit quickly, so Gemini leads and Groq backs up
  meeting: ['gemini', 'groq'],      // mail + notes
  minutes: ['gemini', 'groq'],      // long Japanese text (Sarashina joins last, only when SARASHINA_ENABLED=1)
  study: ['gemini', 'groq'],        // search + a long plan
  life: ['gemini', 'groq'],         // calendar analysis already computed
  fresh: ['gemini', 'groq'],        // reads many notes
  spec: ['gemini', 'groq'],         // reads notes + search, writes a long spec
  finance: ['gemini', 'groq'],      // reads mail bodies, writes a report
  pintel: ['gemini', 'groq'],       // reads many notes + conversation logs, writes entries and a dashboard
  predict: ['gemini', 'groq'],      // signals in, advice + a little research out
  reply: ['gemini', 'groq'],        // writes the replies (Sarashina joins last, only when enabled)
  notify: ['gemini', 'groq'],         // tool loops resend the whole chat every step: Groq's free per-minute token limit (429) is hit quickly, so Gemini leads and Groq backs up
  security: ['gemini', 'groq'],     // the scan is computed by code; the model only writes a short report
};
export function routeFor(agent, env = cfgEnv) {
  let order = [...(DEFAULT_ROUTE[agent] || ['groq', 'gemini'])];
  for (const forced of [String(env.SUBAGENT_PROVIDER || '').toLowerCase(), String(env['AGENT_LLM_' + String(agent).toUpperCase()] || '').toLowerCase()]) {
    if (PROVIDERS[forced]) order = [forced, ...order.filter((p) => p !== forced)];
  }
  if (!order.includes('sarashina')) order.push('sarashina');   // the last line of defence when the others are over their limits
  const ok = order.filter((p) => PROVIDERS[p].key() && !(p === 'sarashina' && state.sarashinaNoTools));
  const up = ok.filter((p) => isUp(p));   // one that was just rejected / limited is skipped for a while (the others cover); if every one is marked down, try them anyway
  return up.length ? up : ok;
}
