// Small pure helpers shared by the wizard and the settings screen (kept apart so the settings do not load the wizard).
/** Key status: never the key itself, only "設定済み・末尾4桁". */
export function keyStatusText(st) {
  if (!st?.set) return '未設定';
  return `設定済み${st.last4 ? `・末尾${st.last4}` : ''}${st.source === 'env' ? '（環境変数）' : ''}`;
}
