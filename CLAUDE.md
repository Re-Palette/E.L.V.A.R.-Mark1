## gstack (REQUIRED — global install)

**Before doing ANY work, verify gstack is installed:**

```bash
_GS=""
for _D in "${GSTACK_ROOT:-}" "$HOME/.claude/skills/gstack" "$HOME/.codex/skills/gstack" "$HOME/.factory/skills/gstack" "$HOME/.kiro/skills/gstack" "$HOME/.config/opencode/skills/gstack" "$HOME/.slate/skills/gstack" "$HOME/.cursor/skills/gstack" "$HOME/.openclaw/skills/gstack" "$HOME/.hermes/skills/gstack" "$HOME/.gbrain/skills/gstack" "$HOME/.copilot/skills/gstack" "$HOME/.gemini/antigravity-cli/skills/gstack" "$HOME/.gemini/skills/gstack" "$HOME/.gstack/repos/gstack"; do
  [ -z "$_GS" ] && [ -n "$_D" ] && [ -d "$_D/bin" ] && _GS="$_D"
done
[ -n "$_GS" ] && echo "GSTACK_OK: $_GS" || echo "GSTACK_MISSING"
```

If GSTACK_MISSING: STOP. Do not proceed. Tell the user:

> gstack is required for all AI-assisted work in this repo.
> Install it:
> ```bash
> git clone --depth 1 https://github.com/garrytan/gstack.git ~/.claude/skills/gstack
> cd ~/.claude/skills/gstack && ./setup --team
> ```
> Then restart your AI coding tool.

Do not skip skills, ignore gstack errors, or work around missing gstack.

Using gstack skills: After install, skills like /qa, /ship, /review
and /browse are available. Use /browse for all web browsing (Aside first, the bundled gstack browser as fallback).
Use the resolved install path above for gstack file paths
(default: ~/.claude/skills/gstack).

The Skill gate in .claude/settings.json runs .claude/hooks/check-gstack.cjs with
Node.js and blocks when it cannot run. If a skill is blocked with "node: not
found", tell the user to install Node.js (https://nodejs.org); if it is blocked
with "Cannot find module ... check-gstack.cjs", the hook file is missing from
this checkout. Do not work around either block.

## E.L.V.A.R. の基本方針（絶対・すべての作業に優先する）

E.L.V.A.R. は「1つの共通プラットフォームを、複数のユーザーが使う」サービスとして作る。
次の7つはどの設計・実装でも必ず守ること。守れない変更は、作業を止めてユーザーに確認する。

1. **1つの共通プラットフォーム** — コードとサーバーは1つ。ユーザーごとに別のデプロイをしない。
2. **ユーザーごとに独立したAI人格** — 名前・呼び方・口調・あいさつ・声などは、ユーザーごとに別。
3. **ユーザーごとに独立した短期・長期記憶** — 会話の記録・第二の脳・学習した好みは、本人だけのもの。
4. **ユーザーごとに独立したファイル保管庫** — 取り込んだファイルは本人だけが見られる。
5. **ユーザーごとに独立したGoogle・外部サービス連携** — 連携の鍵・トークンは本人ごとに分けて暗号化する。
6. **ユーザーごとに保存容量・利用量を管理** — 容量とAPI利用量を本人ごとに数え、上限を設けられる。
7. **データの閲覧・修正・エクスポート・完全削除ができる** — 本人が自分のデータを見て、直して、持ち出して、完全に消せる。

実装の決まり:
- すべてのデータは必ず `userId` で分ける。別のユーザーのデータに届く道を作らない（テストで確かめる）。
- 保存先のキーやパスは、必ずユーザーごとの名前空間を通して作る。
- 新しい保存データを足すときは、エクスポートと完全削除の対象にも必ず加える。

## モデルとパワーの使い分け

作業の種類に合わせて、`.claude/agents/` のエージェントに振り分けること。
軽い作業に重いモデルを使わず、難しい作業を軽いモデルで済ませないのが目的。

| 作業 | エージェント | モデル | effort |
|------|------------|--------|--------|
| ファイル探し、コード読み、ログ要約、簡単な確認 | `scout` | haiku | low |
| 仕様が決まった実装、バグ修正、テスト追加、リファクタ | `builder` | sonnet | medium |
| 設計、技術選定、原因不明のバグ、性能問題 | `architect` | opus | high |
| マージ前のレビュー、セキュリティ確認 | `reviewer` | opus | xhigh |
| README、ドキュメント、コミットメッセージ | `writer` | sonnet | low |

ルール:
- 1〜2回の検索や数行の修正で済むものは、エージェントを使わず直接やる（起動コストの方が高い）。
- 複数の作業が混ざる依頼は分けて振る（例: `architect` で設計 → `builder` で実装 → `reviewer` で確認）。
- `builder` が設計判断で止まったら `architect` に回す。
- `max` effort はユーザーが明示的に頼んだときだけ使う。
- gstack の重いスキル（`/autoplan`、`/plan-ceo-review`、`/cso`、`/review`）はメインのセッションで動くので、メインのモデルが軽いときはユーザーに `/model` で opus に切り替えるよう一言伝える。
