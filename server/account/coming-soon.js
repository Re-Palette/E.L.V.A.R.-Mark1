// Features of the old single-owner build that are not on the multi-user platform yet (docs/ELVAR_MULTIUSER.md P4: the notification relay). They answer one clear
// message, never data, and never touch another user's or the platform owner's data: there is nothing behind them to read. (Google and connected apps are on the
// platform since P3.)
export const COMING_SOON = Object.freeze({
  notifications: '通知の同期は、準備中です（まもなく使えるようになります）',
});

const body = (feature) => ({ error: 'coming_soon', feature, message: COMING_SOON[feature] });
export const comingSoon = (feature) => () => ({ status: 503, body: body(feature) });
