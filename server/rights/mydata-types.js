// The kinds of data the 「私のデータ」 screen shows (docs/ELVAR_MULTIUSER.md 7.2). Every table of the registry belongs to exactly one kind (test/mydata.test.mjs fails otherwise),
// so a new table cannot be added without deciding where its owner sees it. `open` says where the existing screen for it is; `del` how it is removed from here:
//   route: an existing endpoint the page calls (a POST / DELETE with its body)   type: POST /api/elvar/mydata/<id>/delete   null: not removable on its own (it goes with the account)
export const TYPES = Object.freeze([
  { id: 'profile', label: 'プロフィール・人格・声', tables: ['profiles'], open: { tab: 'profile' }, del: { type: 'profile', label: '初期の状態に戻す' }, note: 'AI の名前・呼び方・口調・あいさつ・声。あなただけの設定です' },
  { id: 'settings', label: '設定', tables: ['settings', 'usage_limits'], open: { tab: 'features' }, del: { type: 'settings', label: '設定を消す（APIキーは残ります）' }, note: '機能のオン・オフ、場所、上限など' },
  { id: 'keys', label: 'APIキー（値は表示されません）', tables: ['user_secrets'], open: { tab: 'keys' }, del: { type: 'keys', label: 'キーをすべて消す' }, note: '名前と末尾4桁だけが見えます。サーバーでは暗号化して保管しています' },
  { id: 'google', label: 'Google連携', tables: ['oauth_tokens'], open: { tab: 'google' }, del: { route: { method: 'POST', path: '/api/elvar/connect/google/disconnect', body: {} }, label: '連携を解除する（Googleにも失効を伝えます）' }, note: '連携の状態と許可した範囲。トークンは書き出しません' },
  { id: 'connectors', label: '連携アプリ（コネクタ）', tables: ['connectors', 'connector_tools'], open: { tab: 'connectors' }, del: { route: { method: 'POST', path: '/api/elvar/connectors/delete-all', body: {} }, label: 'すべて削除する' }, note: '登録したサービスと、許可した道具' },
  { id: 'notes', label: '第二の脳（ノート）', tables: ['notes', 'note_revisions'], open: { action: 'brain' }, del: { route: { method: 'POST', path: '/api/elvar/notes/delete-all', body: { confirm: 'delete' } }, label: 'すべて削除する' }, bytesFrom: 'notes', note: '家計・シフト・履修・プロジェクトもここにノートとして入っています' },
  { id: 'conversations', label: '会話の記録（短期記憶）', tables: ['conversations', 'messages'], open: { action: 'conversations' }, del: { route: { method: 'POST', path: '/api/elvar/messages/purge', body: { all: true } }, label: '全部消す' }, bytesFrom: 'messages', note: '残す期間は「設定 → 記憶」で決められます' },
  { id: 'files', label: 'ファイル', tables: ['files', 'file_texts'], open: { action: 'files' }, del: { route: { method: 'POST', path: '/api/elvar/files/delete-all', body: { confirm: 'delete' } }, label: 'すべて削除する' }, bytesFrom: 'files', note: '原本・読み取った文字・タグとメモ' },
  { id: 'inbox', label: '通知箱・スマホ通知の中継', tables: ['inbox_items', 'notif_items'], open: null, del: { route: { method: 'DELETE', path: '/api/elvar/inbox', body: {} }, label: '通知箱を空にする' }, note: '通知箱は HUD のベルから見られます。スマホ通知の中継は暗号化されたまま3日で消えます' },
  { id: 'builds', label: 'ビルド依頼の記録', tables: ['build_requests'], open: { tab: 'connectors' }, del: { type: 'builds', label: '記録を消す（GitHub の依頼は残ります）' }, note: 'あなたの GitHub リポジトリへの依頼の記録' },
  { id: 'usage', label: '利用状況', tables: ['usage_events', 'usage_daily', 'storage_usage'], open: { action: 'usage' }, del: null, note: '回数と容量の記録です（内容は含みません）。アカウントを削除すると消えます' },
  { id: 'devices', label: '端末（通知を受け取るスマホ）', tables: ['devices'], open: { tab: 'account' }, del: { type: 'devices', label: 'すべての端末を使えなくする' }, note: '通知トークンの発行元。トークンの値は保存していません' },
  { id: 'audit', label: '操作の記録', tables: ['audit_log'], open: { action: 'audit' }, del: null, note: 'あなたと管理者が行った操作の記録（1年）。アカウントを削除すると消えます' },
  { id: 'account', label: 'アカウント', tables: ['accounts', 'admins', 'deletion_requests', 'export_jobs'], open: { tab: 'account' }, del: null, note: '状態・容量の上限・削除の予約・書き出しの作業' },
  { id: 'internal', label: 'サービスの作業用データ（鍵・一時データ）', tables: ['user_keys', 'kv_ephemeral', 'rate_limits', 'ticket_uses', 'oauth_pending'], open: null, del: null, note: '暗号鍵（あなたのキーを守るもの）と、短い時間だけ残る一時データ。アカウントを削除すると鍵ごと消えます' },
]);
export const typeTables = () => TYPES.flatMap((t) => t.tables);
