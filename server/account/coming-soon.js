// Features of the old single-owner build that are not on the multi-user platform yet (docs/ELVAR_MULTIUSER.md phases P3 to P5). They answer one clear
// message, never data, and never touch another user's or the platform owner's data: there is nothing behind them to read.
export const COMING_SOON = Object.freeze({
  google: 'Googleとの連携は、準備中です（まもなく使えるようになります）',
  connectors: '外部アプリとの連携は、準備中です（まもなく使えるようになります）',
  notifications: '通知の同期は、準備中です（まもなく使えるようになります）',
});

const body = (feature) => ({ error: 'coming_soon', feature, message: COMING_SOON[feature] });
export const comingSoon = (feature) => () => ({ status: 503, body: body(feature) });
/** For status endpoints the screens poll: 200 with a plain "not available" instead of an error. */
export const comingSoonStatus = (feature, extra = {}) => () => ({ status: 200, body: { configured: false, comingSoon: true, feature, message: COMING_SOON[feature], ...extra } });
/** The browser comes back from another site (OAuth callback): a small page, no data. */
export const comingSoonPage = (feature) => () => ({
  status: 503,
  html: `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>E.L.V.A.R.</title><body style="font:16px sans-serif;background:#080604;color:#f6efe2;padding:2em"><p>${COMING_SOON[feature]}</p><p><a style="color:#E8B96A" href="/">戻る</a></p>`,
});
