# instagram-api-test-assets

Instagram の予約投稿を、GitHub Actions と Instagram API（Instagram ログイン方式）で行うリポジトリです。Metricool などの有料ツールは使いません。

- 素材（画像・動画）を `YYYY-MM/<No>/` に置き、GitHub Pages で公開URLにします。
- 投稿の予定を `queue/` に1投稿1ファイルで置きます。
- 15分ごとに動くワークフローが、時刻の来た投稿を公開し、結果を `queue/` に書き戻します。

## 仕組み

| ファイル | 役割 |
| --- | --- |
| `.github/workflows/publish.yml` | 15分ごとに実行。時刻の来た投稿を公開する |
| `.github/workflows/refresh-token.yml` | 毎週月曜 3:17（日本時間）にアクセストークンを更新する（有効期限60日） |
| `publisher/publish.mjs` | 公開処理。コンテナ作成 → 処理完了を待つ → 公開 |
| `publisher/refresh-token.mjs` | トークン更新 |
| `queue/*.json` | 投稿の予定と結果 |

### queue のファイル

```json
{
  "id": "R9",
  "account": "webcompany_ai_iwamoto",
  "publish_at": "2026-12-14T12:00:00+09:00",
  "type": "REEL",
  "media": ["2026-12/R9/reel.mp4"],
  "cover": "2026-12/R9/cover.png",
  "share_to_feed": true,
  "caption": "本文",
  "status": "queued"
}
```

- `type` は `REEL`・`CAROUSEL`・`POST`（1枚画像）。
- `media`・`cover` は、このリポジトリの中のパス。

| status | 意味 | 次に動くのは |
| --- | --- | --- |
| `hold` | 保留。公開しない | 人が `queued` にする |
| `queued` | 予約中 | ワークフロー |
| `publishing` | 公開処理中 | ワークフロー |
| `published` | 公開済み（`ig_media_id`・`permalink` が入る） | — |
| `failed` | 公開前の段階で3回失敗した | 人が原因を直して `queued` に戻す |
| `unknown` | 公開の途中で止まり、公開されたか分からない | 人が Instagram を見て確認する（自動で再実行しない） |
| `late` | 予定から3時間以上遅れたので公開しなかった | 人が日時を直して `queued` に戻す |

### 二重投稿を防ぐ仕組み

- 公開の前に一度「公開処理中」とコミットしてからプッシュします。プッシュできなければ公開しません。
- 「公開処理中」のまま残ったものや、公開の呼び出し後にエラーになったものは、自動でやり直しません。`unknown` として人の確認を待ちます。
- 同時に2つ実行されないようにしています（`concurrency`）。
- トークンのアカウント名が `EXPECTED_USERNAME` と違えば、何も公開しません。
- 失敗があるとワークフローが失敗扱いになり、GitHub からメールで通知されます。

### 注意

- このリポジトリは公開されているので、`queue/` の本文や素材は投稿前でも誰でも見られます。
- GitHub の定期実行は、混雑すると数分〜それ以上遅れることがあります。
- リール（REELS）・カルーセルの API の項目名（`video_url`・`cover_url`・`share_to_feed`・`is_carousel_item`・`children`）は記憶をもとにした実装です。Meta の公式ドキュメントで未確認のため、最初の1本は試運転と手動実行で確かめてください。

## 初回の設定（運用者が行う）

### 1. Meta のアプリを作り、アクセストークンを発行する

1. [Meta for Developers](https://developers.facebook.com/) にログインし、アプリを作成する。用途は Instagram API を選ぶ。
2. 「Instagram ログインによる API 設定」で、Instagram アカウント @webcompany_ai_iwamoto を追加する。
3. 権限 `instagram_business_basic` と `instagram_business_content_publish` で、アクセストークンを生成する。
4. 生成したトークンはチャットに貼らず、次の手順の GitHub の画面に直接貼る。

### 2. GitHub の設定（このリポジトリの Settings）

| 場所 | 名前 | 値 |
| --- | --- | --- |
| Secrets and variables → Actions → Secrets | `IG_ACCESS_TOKEN` | 手順1のトークン |
| 同 → Secrets | `SECRETS_PAT` | 下の「トークン自動更新用のキー」 |
| 同 → Variables | `EXPECTED_USERNAME` | `webcompany_ai_iwamoto` |
| 同 → Variables | `MEDIA_BASE_URL` | `https://hifusiako2400-spec.github.io/instagram-api-test-assets` |
| Pages | Source | Deploy from a branch → `main` / `(root)` |

**トークン自動更新用のキー（SECRETS_PAT）**：GitHub の Settings → Developer settings → Fine-grained personal access tokens で作成します。対象リポジトリはこのリポジトリだけ、権限は「Secrets: Read and write」だけにします。これがないと、60日ごとにトークンを手で入れ替える必要があります。

### 3. 試運転

1. Actions → 「Instagram 予約投稿」→ Run workflow で `dry_run` を `1` にして実行する。時刻の来た `queued` があれば、URL だけ表示して状態を戻す。
2. Actions → 「Instagram トークン更新」を手動で実行し、成功するか確かめる（発行から24時間以上たってから）。
3. 本番の最初の1本は、公開時刻のあとに Instagram と `queue/` の `status` を確認する。
