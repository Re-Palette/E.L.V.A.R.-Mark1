// One place for "which Gemini text model do we call". Model names get retired (the API then answers 404 / "not found"), so every call site tries a
// list in order and remembers (per server process) which names are gone. 'gemini-flash-latest' is Google's own alias for the current Flash model.
const CANDIDATES = ['gemini-flash-latest', 'gemini-2.5-flash', 'gemini-2.0-flash'];
const gone = new Set();

/** Ordered model names to try: the override (if any) first, then the known candidates not yet marked as gone. */
export function geminiModels(override) {
  const list = [override, ...CANDIDATES].filter(Boolean).filter((m, i, a) => a.indexOf(m) === i);
  const ok = list.filter((m) => !gone.has(m));
  return ok.length ? ok : list;   // everything marked gone: try them all again rather than fail without a request
}
export const geminiModel = (override) => geminiModels(override)[0];
export const markGone = (m) => { gone.add(m); };
export const _resetGone = () => gone.clear();

/** Is this API answer "the model itself is unusable" (not found / retired / unsupported) rather than a quota or request problem? */
export const modelIsGone = (status, message = '') => status === 404 || (status === 400 && /not (found|supported)|no longer|deprecated|unsupported|invalid model/i.test(String(message)));

/** Run `call(model)` over the candidate list; move on only when the model itself is unusable. The error should carry `.status` (and optionally `.apiMessage`). */
export async function withGeminiModel(override, call) {
  let last;
  for (const m of geminiModels(override)) {
    try { return await call(m); }
    catch (e) { last = e; if (!(e?.modelGone || modelIsGone(e?.status, e?.apiMessage || e?.message))) throw e; markGone(m); console.warn('[gemini] model unusable, trying the next:', m); }
  }
  throw last;
}
