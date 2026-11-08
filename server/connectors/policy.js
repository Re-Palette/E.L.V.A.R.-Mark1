// Approval levels (docs/ELVAR_ARCHITECTURE.md 5.6), decided by the SERVER from the stored manifest: the model's arguments can never raise or lower them.
//   ask       every call needs an approval card (the default)         ask_high  the same, with the orange "high" frame
//   auto      no card, audit log only: ONLY when the tool is marked read-only AND the owner chose it for this tool; the mark is the remote side's own claim
//   off       the tool is not offered and cannot be called
// A tool whose hash changed (needsReapproval) is off until the owner approves it again.

export const isReadOnly = (c, t) => (c.type === 'mcp' ? t.annotations?.readOnlyHint === true : t.readOnly === true);
export const isDestructive = (c, t) => t.annotations?.destructiveHint === true || t.method === 'DELETE' || t.danger === 'high' || t.approval === 'ask_high';

/** @returns {{allowed:boolean, mode:'ask'|'auto', danger:'normal'|'high', readOnly:boolean, reason?:string}} */
export function toolPolicy(c, t) {
  const readOnly = isReadOnly(c, t);
  const danger = isDestructive(c, t) ? 'high' : 'normal';
  if (!c.enabled) return { allowed: false, mode: 'ask', danger, readOnly, reason: '連携アプリが無効です' };
  if (!t.enabled || t.approval === 'off') return { allowed: false, mode: 'ask', danger, readOnly, reason: 'この道具は使わない設定です' };
  if (t.needsReapproval) return { allowed: false, mode: 'ask', danger, readOnly, reason: '内容が変わったため、再承認が必要です' };
  // auto survives only while every condition still holds (a server that stops claiming "read-only" silently falls back to asking)
  const auto = t.approval === 'auto' && readOnly && danger !== 'high';
  return { allowed: true, mode: auto ? 'auto' : 'ask', danger, readOnly };
}
