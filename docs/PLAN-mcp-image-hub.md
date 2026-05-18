# 計画書: 画像/作図 MCP 3 本を image-hub サブドメインに集約 + 自分専用ハブ化

> Phase 0 完了、進路 (c) 確定済み。詳細調査結果は [PHASE0-findings.md](PHASE0-findings.md) 参照。
> 本計画書は Phase 2.A / 3 / 2.B / 4 の実装手順書。

## TL;DR

- **対象 3 MCP**: `openai-image` / `excalidraw` / `mermaid` を Windows stdio から **`image-hub.kitepon.dynv6.net` サブドメイン経由の HTTP MCP** に集約。
- **進路**: (c) 直接 Phase 2.A → Phase 3 → 運用 → Phase 2.B (ハブ化) → Phase 4 (拡張、任意)。Phase 1 (WSL2 ローカル stdio 検証) は完全スキップ。
- **OAuth**: 既存 Relay-MCP の `auth.ts` (613 行) を流用。MCP 2025-06-18 + RFC 8707 + RFC 9728 完全準拠、audience を `https://image-hub.kitepon.dynv6.net` に差し替え。
- **絶対原則**: 既存ツールのクライアント呼び出し API (メソッド名 / 必須引数) は互換維持。レスポンス JSON は HTTP 集約で `{id, url, mime, schema_version}` 形式に変わる (§3.5)。新機能は層 I (透明) / II (optional 引数) / III (新 MCP) に隔離。

## 0. 結論先出し

Windows 側に登録されている画像/作図系 MCP 3 本を 192.168.1.2 の Docker Compose 上に集約稼働させ、`image-hub.kitepon.dynv6.net` サブドメインで Windows / WSL2 / 他 PC / 出先から共有利用する。さらにギャラリー / コストダッシュボード / スタイルプリセット / パイプラインなどの付加機能を段階的に乗せる。

**確定事項**:
- サブドメインは `image-hub.kitepon.dynv6.net` (kitepon.dynv6.net 直下のパス並列は禁止 — ConnectX2C に吸い込まれる、X-MCP/IP-MCP/Relay-MCP が個別サブドメインに分かれているのと同じ理由)
- 認可サーバーは Relay-MCP の自前 OAuth 2.1 実装をパターン流用
- Reverse proxy は既存 Caddy (Docker コンテナ) にホストブロックを 1 つ追加
- 3 MCP は Docker Compose で `/home/kite/image-hub/` 配下に並べる (relay/ip-mcp と同じ運用パターン)

## 1. 現状

### Windows 側 `~/.claude.json` の `mcpServers` (Phase 0 で確認)

| 名前 | 形式 | 実装 |
|---|---|---|
| openai-image | stdio | `C:/Users/kite_/.local/bin/openai-gen-image-mcp.exe` (uv tool トランポリン、実体は GitHub `kazyam53/openai_gen_image_mcp` の Python パッケージ) + `OPENAI_API_KEY` 平文直書き |
| excalidraw | stdio | `node C:/Users/kite_/Documents/Program/claude-image-tools/mcp_excalidraw/dist/index.js` (npm `mcp-excalidraw-server` v1.0.2、Dockerfile/docker-compose 完備) |
| mermaid | stdio | `claude-mermaid` (npm `claude-mermaid` v1.6.2、Mermaid CLI 経由で Chromium 必要) |

### 192.168.1.2 (Phase 0 で SSH 調査)

- Ubuntu / Linux 7.0.0-14-generic / x86_64
- スタック: Docker Compose (各サービスがホームディレクトリ下の独立 compose、Caddy も Docker コンテナ)
- 既存 MCP 系コンテナ: `connect-c2x` (port 3001、メイン) / `relay` (18804) / `ip-mcp` (8765) / `caddy` (80/443/8443)
- メイン Caddyfile: `/home/kite/ConnectC2X/Caddyfile` (Docker mount 経由で `/etc/caddy/Caddyfile` として動作)

### 既存サブドメインと OAuth パターン

- `kitepon.dynv6.net` → ConnectC2X が OAuth 2.1 サーバー + メイン MCP (古い実装、`resource_metadata` 未対応)
- `relay.kitepon.dynv6.net` → Relay-MCP (自前 OAuth、`resource_metadata` 完備、audience-bound JWT)
- `ipmcp.kitepon.dynv6.net` → IP-MCP (Relay-MCP と同パターン想定)

## 2. 検証可能なゴール

### 2.1 移植・集約 (Phase 2.A 完了 ✅ 2026-05-03)

- [x] WSL2 / Windows / 出先の Claude Code から `mcp__openai-image__*` / `mcp__excalidraw__*` / `mcp__mermaid__*` が `https://image-hub.kitepon.dynv6.net/mcp/{name}` 経由で呼べる (transport は Streamable HTTP)
- [x] OAuth 2.1 認可フローを Claude Code が完走できる (Dynamic Client Registration + audience-bound JWT)
- [x] サーバー側に生成物ストレージ + `/files/{id}` 配信エンドポイントがあり、各 MCP のレスポンスが `{id, url, mime, schema_version}` 形式で返す
- [x] Day-1 防御一式が動いている: OpenAI クレジットガード (auto-recharge OFF + 月初チャージ額制限 + usage limit) / 内部ポート LAN 限定 listen / TLS / OAuth gate / バックアップ最小実装
- [ ] Week-2 ガード: ハブ側予算上限 / クライアント単位レート制限 / 異常検知 / アクセス監視 (= 残: Phase 2.A-5/6 相当、初期運用後に着手)
- [x] Windows / WSL2 の `~/.claude.json` から 3 つの stdio 設定が消え、HTTPS URL に置換、`OPENAI_API_KEY` がクライアントから完全に消えている
- [x] 各 MCP で「サンプル画像/図を 1 件生成」が両クライアントから成功 (WSL2 から e2e テスト 2026-05-03 / Windows 側からの実接続確認は別途)

### 2.2 ハブ化 (Phase 2.B、Phase 2.A + 3 完了後しばらく運用してから着手)

- [ ] `https://image-hub.kitepon.dynv6.net/gallery` でブラウザから生成物履歴一覧 (層 I)
- [ ] `https://image-hub.kitepon.dynv6.net/dashboard` でコスト/使用量集計 (層 I)
- [ ] content-hash キャッシュ (`use_cache=true` 指定時のみ hit、default は新規生成、層 II)

### 2.3 拡張機能 (Phase 4、必要になったら順次)

- [ ] `openai-image.generate` の optional `project` 引数で project 別スタイルプリセット (層 II)
- [ ] `openai-image.generate` の optional `base_image_id` 引数でバリエーション生成 (層 II、モデル制約注意)
- [ ] パイプライン MCP `diagram-pipeline` (mermaid → excalidraw → openai-image を 1 コマンド連鎖、層 III)
- [ ] 画像→プロンプト逆生成 MCP `image-vision` (OpenAI Vision、層 III)
- [ ] (任意) fal.ai 動画/音声 MCP / Slack 通知 / GitHub PR 自動添付 (層 III + 4.C)

## 3. アーキテクチャ

### 3.1 トポロジ

```
Windows / WSL2 / 出先   ─→  https://image-hub.kitepon.dynv6.net/  (Caddy で TLS + OAuth gate)
Claude Code             ↓
                        ├── /mcp/openai-image    →  内部 image-hub-openai-image:PORT
                        ├── /mcp/excalidraw      →  内部 image-hub-excalidraw:PORT
                        ├── /mcp/mermaid         →  内部 image-hub-mermaid:PORT
                        ├── /files/{id}          →  内部 image-hub-files:PORT (生成物配信)
                        ├── /gallery             →  Phase 2.B で稼働
                        ├── /dashboard           →  Phase 2.B で稼働
                        ├── /.well-known/oauth-authorization-server   ┐
                        ├── /.well-known/oauth-protected-resource     │ Relay-MCP パターン流用
                        ├── /authorize / /token / /register / /revoke │ で実装する自前 OAuth
                        └── /consent (admin passcode)                 ┘
```

各クライアント側設定:

```json
"openai-image": { "type": "http", "url": "https://image-hub.kitepon.dynv6.net/mcp/openai-image" },
"excalidraw":   { "type": "http", "url": "https://image-hub.kitepon.dynv6.net/mcp/excalidraw" },
"mermaid":      { "type": "http", "url": "https://image-hub.kitepon.dynv6.net/mcp/mermaid" }
```

### 3.2 stdio→HTTP 化の手段

- `excalidraw`: 既存 Dockerfile (`yctimlin/mcp_excalidraw`) を流用、内部の Express HTTP wrapper 経由で MCP HTTP transport 化
- `mermaid`: `claude-mermaid` を Node コンテナで動かし、薄い HTTP wrapper を被せる。Chromium 依存があるので healthcheck + restart policy 必須
- `openai-image`: `uv tool install git+https://github.com/kazyam53/openai_gen_image_mcp.git` で Python パッケージ化、HTTP wrapper を被せる (Phase 0-1 のレスポンス形式実機確認結果次第で wrapper の改修内容を確定)

### 3.3 認証 / TLS

`x-api` の Caddy + dynv6 + Let's Encrypt 自動発行を流用。**`image-hub.kitepon.dynv6.net` の独立サブドメイン**で Caddy ホストブロックを追加。OAuth は Relay-MCP `auth.ts` パターン流用 (自前 OAuth 2.1 サーバー、JWT audience を `https://image-hub.kitepon.dynv6.net` に bind、admin passcode で consent 承認)。

### 3.4 配置・常駐

- 実装フォルダ: `/home/kite/image-hub/` (relay と同パターン、独立 compose)
- compose で 5 サービス並列稼働: `openai-image-mcp` / `excalidraw-mcp` / `mermaid-mcp` / `files-server` / `oauth-server`
- ストレージは compose volume + bind mount (Phase 2.A で具体化)

### 3.5 生成物の返し方

MCP レスポンス JSON: `{ "id": "abc123", "url": "https://image-hub.kitepon.dynv6.net/files/abc123.png", "mime": "image/png", "schema_version": 1 }`

- サーバー側ストレージに保存 → URL 返却 (一時 URL ではなく永続)
- 小さい図 (mermaid SVG など) は base64 inline でも返す選択肢を残す
- メタデータ schema (生成パラメータ / プロジェクト識別子 / 作成日時) には `schema_version` 必須 — Phase 2.B の gallery / cache / 層 II が依存

### 3.6 機能の階層分け

| 層 | 性質 | 例 | クライアント変化 |
|---|---|---|---|
| I | サーバー側で完全に透明 | gallery / dashboard | なし |
| II | 既存ツールに optional 引数 1 個追加 (機能ごと、デフォルト挙動温存) | content-hash キャッシュ (`use_cache=true`) / project プリセット / base_image_id | optional フィールドが増えるだけ |
| III | 独立した新 MCP | パイプライン / 画像→プロンプト / fal.ai | install しなければ存在しない |

「層 I/II/III」と「進路 a/b/c」は別概念 (進路は確定済みなので以後は層のみ)。

### 3.7 暴走課金ガード

**Day-1 (鍵集約前ゲート、すべて pass まで鍵を置かない)**:
- OpenAI Platform 側のクレジットガード (auto-recharge OFF + 月初チャージ額制限 + usage limit)。現行 OpenAI は prepaid モデルで「設定したら止まる」hard limit はないので、月初チャージ額自体を被害許容額に絞るのが本物の防衛線。
- 内部 MCP / hub web の listen を LAN 限定 (`0.0.0.0` 禁止)、外向きは Caddy のみ受ける。
- `OPENAI_API_KEY` を `.env` に置く前にバックアップ exclude pattern を実機検証 (テスト用ダミー .env で 1 周期回す)。

**Week-2 (Phase 2.A 完了までに揃える)**:
- ハブ側 月次予算上限 (例: $50/月、推定コスト積算で 429)、モデル別単価表のメンテ方式は Phase 0-8 の方針 (手動 / Pricing API / 事後集計のみ) で確定。
- クライアント単位 (`client_id` / トークン / IP) の短期レート制限。実利用者 1 人前提なので「ユーザー別」は無意味、暴走は同一ユーザーの異常集中で検知。
- 異常発火検知 (通常運用の 5x 超過など) で即時遮断 + 通知 (経路は Phase 0-8 で確定)。
- アクセス監視: OAuth ログに未知アカウント / リクエスト急増を検知。

### 3.8 生成物バックアップ

- **Day-1 最小実装**: `rsync + cron` 5 行で 24h 以内にどこかにコピー。退避先は relay と同パターン (compose volume → 別ホスト or 外部ディスク)。
- **`.env` を必ず除外**: バックアップ対象は `storage/` のみ、`.env` は backup から exclude (Day-1 で実機検証 → 鍵集約)。鍵は別ルート (1Password / pass / 暗号化 vault) で管理、復旧は Phase 3-2 の再発行手順を踏む。
- **Phase 3 で揃える**: 退避先整備 + 復元 dry-run 年 1 回 + 復旧 RTO (例: 24h 以内に gallery 復活)。

## 4. 実装ステップ

### Phase 0: 完了 ✅

詳細は [PHASE0-findings.md](PHASE0-findings.md) 参照。12 項目すべて判明事実 + 採用方針が文書化済み。進路 (c) 確定。

唯一残った確認: **GitHub `kazyam53/openai_gen_image_mcp` の `uv tool install` を 192.168.1.2 で実行する許可**。

### Phase 2.A: 192.168.1.2 にデプロイ・集約 (完了 ✅ 2026-05-03)

#### 2.A Day-1 (鍵集約前ゲート、すべて pass するまで `OPENAI_API_KEY` を `.env` に置かない)

| # | タスク | 検証 | 状態 |
|---|---|---|---|
| 2.A.D-1 | OpenAI Platform 側のクレジットガード一式設定 (auto-recharge OFF + 月初チャージ額制限 + usage limit) | OpenAI 管理画面で auto-recharge OFF + 月額上限が見える | ✅ |
| 2.A.D-2 | 内部 MCP / hub web の listen を LAN 限定 (`0.0.0.0` 禁止)、外向きは Caddy のみ | LAN 外から内部ポートに `curl` 不可 | ✅ |
| 2.A.D-3 | バックアップ最小実装 (`rsync + cron`) を稼働 + テスト用ダミー `.env` で exclude pattern を実機検証 | 翌日にコピー存在 + ダミー `.env` が退避先に**出ていない** | ✅ |
| 2.A.D-4 | `image-hub.kitepon.dynv6.net` を Caddy ホストブロックに追加 + TLS 自動発行 | `https://image-hub.kitepon.dynv6.net/` に LAN 内 / 出先想定経路の両方から接続可能、有効な証明書 | ✅ |
| 2.A.D-5 | OAuth 2.1 サーバーを実装 (Relay-MCP `auth.ts` 流用、audience を `https://image-hub.kitepon.dynv6.net` に差し替え)。Caddy で OAuth gate 動作 | 未認可 POST /mcp/* が 401 + `WWW-Authenticate: Bearer ... resource_metadata=...`、Claude Code から MCP セッション張れる | ✅ |

#### 2.A Week-2 (Phase 2.A 完了までに揃える)

| # | タスク | 検証 | 状態 |
|---|---|---|---|
| 2.A-1 | 各 MCP を HTTP wrapper で包む。`excalidraw` は既存 Dockerfile 流用、`mermaid` は Chromium 依存なので別コンテナ + healthcheck + restart policy、`openai-image` は uv tool install Python パッケージ + HTTP wrapper | サーバー側 `curl http://localhost:PORT/mcp` で応答 | ✅ (mcp-proxy で stdio→HTTP 化、Streamable HTTP `/mcp` を使用) |
| 2.A-2 | `/home/kite/image-hub/compose.yml` で常駐化 (4 サービス: 3 MCP + image-hub-app) | サーバー再起動後の自動起動を確認 | ✅ |
| 2.A-3a | 鍵集約前: D-3 の rsync exclude pattern を再確認 + 本物 `.env` 配置パス想定でダミーで実機検証 | ダミー `.env` が退避先に出ていない | ✅ |
| 2.A-3b | Day-1 + 2.A-3a が pass した上で、本物 `OPENAI_API_KEY` をサーバー `.env` に集約 + **同時に Windows / WSL2 クライアント側 `~/.claude.json` から鍵削除** | クライアント側に鍵なし、サーバーで動く、`storage/` のバックアップに `.env` が含まれない | ✅ |
| 2.A-4 | 各 MCP のレスポンスを `{id, url, mime, schema_version}` 形式に統一 (§3.5)。メタデータ schema を SQLite or JSON で永続 | レスポンス JSON に url + schema_version、ブラウザで `/files/{id}` が開ける | ✅ (`image-hub-app/src/storage.ts` + `/files/{id}`) |
| 2.A-5 | ハブ側予算上限 / レート制限 / 異常検知の Week-2 部分実装 (§3.7)。設定値は Phase 0-8 で確定 | 上限超過で 429、通知が届く | ⏳ 残 |
| 2.A-6 | アクセス監視 (OAuth ログ + リクエスト急増検知) のアラート設定 | アラート送信が検知できる | ⏳ 残 |
| 2.A-7 | LAN 内別マシンから `curl https://image-hub.kitepon.dynv6.net/mcp/openai-image` (OAuth トークン付き) で疎通 | 200 応答 × 3 | ✅ (WSL2 から e2e テスト済) |
| 2.A-8a | クライアント側 (Claude Code 設定 / skill / よく使う呼び出しパターン) で `mcp__openai-image__*` 等のレスポンスを「ローカルファイルパス」として消費している箇所を棚卸し → 新形式に書き換え | 棚卸しリスト + 書き換え済みコード (壊れる呼び出しゼロ) | ✅ |
| 2.A-8b | Windows + WSL2 の `~/.claude.json` を HTTPS URL に書き換え (二段階: 新ブロック追加 → 旧 stdio 削除、書き換え前にバックアップ) | 両クライアントから 3 ツール見え、サンプル生成が成功 | ✅ (WSL2 ✅ / Windows 設定書き換え済、実接続確認は別途) |

### Phase 3: 後始末 + 運用基盤の地金化

| # | タスク | 検証 | 状態 |
|---|---|---|---|
| 3-1 | Phase 2.A-8b で残した stdio バックアップファイルの最終クリーンアップ + `claude mcp list` で重複ゼロ | 重複なし | ✅ |
| 3-2 | **`OPENAI_API_KEY` を再発行** (本チャットで露出済み) + 新鍵に対してクレジットガードが効いていることを確認 | 旧鍵が 401、新鍵が稼働、クレジットガード設定済み | ✅ (project key 名 `image-hub`) |
| 3-3 | (任意) WSL2 側にローカル stdio を残すか判断。残す場合は別 API key で OS 鍵束管理 | ユーザー判断 | ⏳ HTTP 集約版で十分のため stdio は残さない判断 |
| 3-4 | バックアップ復元 dry-run 演習 (退避先から `storage/` を別ディレクトリに復元、ファイル数とサイズ一致確認) + 復元 RTO 規定 (例: 24h 以内 gallery 復活) | 復元成功 + 所要時間記録 | ⏳ 残 |
| 3-5 | バックアップ復元演習を年 1 回行う運用ルール定着 (cron reminder / カレンダー)。3-6 と同月に固める | リマインダー登録 | ⏳ 残 |
| 3-6 | OAuth 認可リスト + 認可スコープの年 1 回手動レビュー運用ルール化 | リマインダー登録 | ⏳ 残 |

### Phase 2.B: ハブ化 (Phase 2.A + 3 完了後しばらく運用してから着手)

**着手判断**: Phase 2.A + 3 完了後しばらく (例: 2 週間) 運用し、「実際に困った点」を実測してから。Web UI の CSS で半日溶ける独立作業。

| # | タスク | 層 | 検証 |
|---|---|---|---|
| 2.B-1 | content-hash (prompt + パラメータ + schema_version) ベースのキャッシュ。**default cache miss、`use_cache=true` 指定時のみ hit** (画像生成は非決定性が前提) | II | 通常呼び毎回新規、`use_cache=true` 指定で 2 回目以降 hit |
| 2.B-2 | 生成物ギャラリー Web UI (`/gallery`)。サムネイル + プロンプト + 日時 + プロジェクト + メタ検索 | I | ブラウザで一覧と検索可能 (OAuth ログイン後) |
| 2.B-3 | コスト/使用量ダッシュボード (`/dashboard`)。OpenAI usage を集計 (§3.7 の Day-1/Week-2 ガードはこれより先に動く前提) | I | 月次/プロジェクト別の集計が見える |

### Phase 4: 拡張機能 (層 II / III、必要になったら順次)

#### 4.A 層 II (既存ツールへの optional 引数追加)

| # | タスク | 検証 |
|---|---|---|
| 4.A-1 | `openai-image.generate` に optional `project` 引数 → サーバー側で project → スタイルプリセット辞書を持ち自動付与 | `project="image-generator"` でスタイル付与、未指定で従来通り |
| 4.A-2 | `openai-image.generate` に optional `base_image_id` 引数 → 過去生成物 (gallery の id) のバリエーション生成。**モデル制約**: 純粋 variations は DALL-E 2 のみ、`gpt-image-1` 系では edit/inpainting で代替 | 過去画像 id でバリエーション or 派生生成成功 |

#### 4.B 層 III (独立した新 MCP)

| # | タスク | 検証 |
|---|---|---|
| 4.B-1 | パイプライン MCP `diagram-pipeline` (mermaid → excalidraw → openai-image を 1 コマンド連鎖) | 1 回呼び出しで 3 段リレーが完了し最終画像が返る |
| 4.B-2 | 画像→プロンプト逆生成 MCP `image-vision` (OpenAI Vision) | 画像 URL から自然言語プロンプトが返る |
| 4.B-3 | (後日) fal.ai 動画/音声 MCP を追加 (ECC `fal-ai-media` skill 流用) | 同じハブ手順で 1 本追加完了 |

#### 4.C 出力先の自動投下 (任意)

| # | タスク | 検証 |
|---|---|---|
| 4.C-1 | 生成完了通知を Slack / Discord DM に投下する optional フック | フック有効化したアカウントだけ通知が来る |
| 4.C-2 | GitHub Issue/PR への自動添付 MCP (gh CLI ラップ) | 指定した PR に画像が貼られる |

## 5. 既知のリスク / caveat

- **MCP 設定先**: `~/.claude/settings.json` は `mcpServers` を受け付けない。`~/.claude.json` か `.mcp.json` 経由 (caveat: `settings-mcpservers-rejected`)
- **claude-spotter の Windows MCP 収集**: 1.2.2 以上でないと `mcp__mermaid__*` / `mcp__openai-image__*` の収集に失敗
- **OPENAI_API_KEY 露出**: 旧鍵が本チャットで露出済み → Phase 3-2 で再発行済 ✅ → さらに 2026-05-18 の §7 切替で OpenAI 経路自体を廃止、新鍵も unbind 済
- **kitepon.dynv6.net 直下のパス禁止**: 新規 HTTP MCP は必ず独立サブドメイン (本計画書は `image-hub.kitepon.dynv6.net`)。直下のパスは ConnectX2C に吸い込まれる (memory: `feedback_subdomain_per_mcp`)
- **デフォルト互換性**: 層 II/III 実装時に既存ツールの引数を変更しない。新引数は必ず optional、新機能は必ず別 MCP
- **キャッシュ default 方向**: 画像生成は非決定性が前提なので default OFF + `use_cache=true` 明示時のみ hit (default ON にすると「もう一枚」で古い画像が返る混乱モード)
- **生成物消失リスク**: §3.8 のバックアップを Phase 2.A で必ず稼働。ハブ集約 = 1 ホスト全損リスク化
- **暴走課金リスク**: §3.7 のガードを Phase 2.A で必ず稼働。事後集計のダッシュボードでは予算超過の前に止まらない
- **OpenAI Platform は prepaid モデル**: 「設定したら止まる」hard limit は無い。auto-recharge OFF + 月初チャージ額制限が事実上の最終防衛線
- **データ schema の互換性義務**: 生成物メタデータ schema には `schema_version` 必須 (§3.5)。Phase 2.B / Phase 4 が依存して育つので後から壊すと gallery / cache / 層 II 拡張すべてが影響
- **Chromium silent fail**: `mermaid` (Mermaid CLI) と `excalidraw` の Chromium 依存は別コンテナ隔離 + healthcheck + restart policy を必ず入れる。無いと「ハブごと動いてるように見えて mermaid だけ死んでる」が常態化
- **MCP プロトコル経由の OAuth 完走**: Relay-MCP パターンが既に実機で動いているので Phase 2.A.D-5 は完走確実だが、Claude Code 側 MCP クライアントの実装変更で挙動が変わる可能性は残る (Phase 3-6 の年次レビューで確認)
- **Phase 4-A-2 のモデル制約**: 純粋 variations API は DALL-E 2 のみ。`gpt-image-1` 系では edit/inpainting で代替

## 5.5 Phase 2.A 構築時の知見 (root cause 修正済み)

| # | 地雷 | 採用解 | 詳細 |
|---|---|---|---|
| L-1 | SSE transport がリバプロ越しで死ぬ (mcp-proxy が `event: endpoint` で `/messages?sessionId=...` を絶対パスで返す → クライアントが host root に POST して 404) | **Streamable HTTP (`/mcp`) に統一** | memory `feedback_mcp_proxy_streamable_http` |
| L-2 | `http-proxy-middleware` v3 + Express 5 の組合せが silent fail (bearer 通過後 upstream に到達しない、proxy ログにも upstream ログにも痕跡なし、client 30s timeout) | **`node:fetch` 直叩きの素朴フォワーダに置換** ([server/image-hub-app/src/index.ts](../server/image-hub-app/src/index.ts) の `app.all(mcpPath, bearer, async ...)`) | 同上 |
| L-3 | `mcp-proxy` 6.x の Streamable HTTP は `/mcp` 厳密一致、`/mcp/` (trailing slash) で 404 | fetch ベース実装にしたので回避 | 同上 |
| L-4 | `claude-mermaid` 内部の puppeteer / chromium が root 起動を拒否 | **Dockerfile で `/usr/bin/chromium` をラッパに差し替え `--no-sandbox --disable-dev-shm-usage` 強制注入** ([server/mermaid-mcp/Dockerfile](../server/mermaid-mcp/Dockerfile)) | 同上 |
| L-5 | Claude Code MCP OAuth: **同一サーバーへ 2 つの flow を並行起動すると state が上書きされる** (VSCode MCP パネル click と `authenticate` ツールを同時に走らせると後発が code_verifier を上書き → 「No OAuth flow is in progress」)。session 全体での flow 数制約や cross-server 衝突は未検証 | 1 サーバーの認可は **GUI クリック OR `authenticate` ツール、どちらか一方だけ** で進める。サーバー間は 1 つずつ Connected を確認しながら順次 | memory `feedback_mcp_oauth_one_per_session` |
| L-6 (2026-05-04) | OAuth 必須の HTTP MCP は **外部カタログ消費者** (Spotter daemon、Bell の prompt builder、将来の他ツール) からツール一覧を取れない (`tools/list` が 401)。実行は Claude Code MCP クライアント経由で動くが、推薦 / 提案レイヤーが「ツールが存在することを知らない」 | image-hub 側で `mcpAuth` 分岐 middleware を実装: (1) JSON-RPC discovery method (`initialize` / `tools/list` / `prompts/list` / `resources/list` / `resources/templates/list` / `notifications/initialized` / `notifications/cancelled` / `ping`) は bearer 不要、(2) `Authorization: Bearer ${IMAGEHUB_STATIC_BEARER_TOKEN}` 一致なら OAuth 検証 skip、(3) それ以外は従来 OAuth bearer。`auth.ts` の `verifyAccessToken` も `InvalidTokenError` で例外正規化し、誤トークン時の 500→401 を是正 | [server/image-hub-app/src/index.ts](../server/image-hub-app/src/index.ts) `mcpAuth` / [server/image-hub-app/src/auth.ts](../server/image-hub-app/src/auth.ts) `verifyAccessToken` / [server/README.md](../server/README.md) §「認可の 3 経路」 |

## 6. 実装フォルダ構成

```
/home/kite/image-hub/
├── compose.yml              # 5 サービス: openai-image-mcp / excalidraw-mcp / mermaid-mcp / files-server / oauth-server
├── .env                     # OPENAI_API_KEY / OAUTH_SIGNING_KEY / ADMIN_PASSCODE 等 (バックアップ exclude)
├── .env.example             # 雛形
├── openai-image-mcp/        # Dockerfile + HTTP wrapper (uv tool 経由で git+https から install)
├── excalidraw-mcp/          # 既存 yctimlin/mcp_excalidraw の Dockerfile を流用
├── mermaid-mcp/             # claude-mermaid + Node コンテナ + 自前 HTTP wrapper + Chromium healthcheck
├── files-server/            # /files/{id} 配信 + メタデータ DB (SQLite)
├── oauth-server/            # Relay-MCP auth.ts パターン流用 (audience: image-hub.kitepon.dynv6.net)
├── storage/                 # bind mount 先 (画像/SVG/メタデータ、バックアップ対象)
└── future/                  # Phase 4 用の層 II/III 実装スケルトン
    ├── pipeline-mcp/
    ├── image-vision-mcp/
    └── fal-mcp/
```

Caddy 設定は `/home/kite/ConnectC2X/Caddyfile` (またはマウント元の真ファイル) に下記ホストブロックを追加:

```caddy
image-hub.kitepon.dynv6.net {
    header {
        Strict-Transport-Security "max-age=31536000; includeSubDomains"
        X-Content-Type-Options "nosniff"
        -X-Powered-By
        -Server
    }
    reverse_proxy 192.168.1.2:<image-hub の外向きポート> {
        flush_interval -1
    }
}
```

(Phase 2.A 着手時に内部ポート割り当てとマウント元 Caddyfile の真の場所を確定)

## 7. 2026-05-18 更新: HermesAgent 上流への切替

### 背景

Phase 2.A / 3-2 までは `openai-image` ルートが OpenAI Platform に直課金される構成だった。Phase 3-2 で発行した新鍵 (`image-hub`) も §3.7 のクレジットガード前提の運用が続いていた。2026-05-18 に並行プロジェクト [HermesAgent](https://github.com/kitepon-rgb/HermesAgent) (X / Grok Imagine の OAuth セッション借用で `generate_image` を MCP 公開) が動いていることが確定したため、image-hub の `openai-image` 経路をその上流に差し替えた。

### 何が変わったか

| 領域 | Before | After |
|---|---|---|
| `openai-image-mcp` コンテナの中身 | `kazyam53/openai_gen_image_mcp` (Python、uv tool install) | 自前 [server.py](../server/openai-image-mcp/server.py) (fastmcp ラッパ、 HermesAgent MCP に JSON-RPC で `tools/call generate_image` を投げる) |
| `OPENAI_API_KEY` | `.env` 必須 | 廃止 (.env.example からも削除) |
| 新環境変数 | — | `HERMES_MCP_URL` / `HERMES_BEARER_TOKEN` |
| 課金経路 | OpenAI Platform (prepaid + クレジットガード) | HermesAgent 側の SuperGrok / Premium Plus OAuth セッション (実質ゼロ) |
| `sitecustomize.py` monkey-patch | あり (Python `tempfile.mkdtemp` の 0o700 を 0o755 に補正) | server.py 内で `os.chmod(sub, 0o755)` を明示呼び出し、ファイル削除 |
| 互換維持の範囲 | — | service 名 `openai-image-mcp` / volume 名 `openai-image-tmp` / 出力 path 形式 `/var/lib/openai-image-tmp/openai_gen_image_*/generated_*.{png,jpg,webp}` / image-hub-app の REWRITE_RULES key `openai-image` / クライアントの `~/.claude.json` URL `/mcp/openai-image` — すべて温存 |

### 影響範囲

| Area | 影響 |
|---|---|
| image-hub-app | **無変更**。intercept.ts の path pattern も REWRITE_RULES key もそのまま。 |
| 他クライアント (Windows / WSL2 / 他 PC の `~/.claude.json`) | **無変更**。URL も tool 名 (`mcp__openai-image__generate_image`) もそのまま。 |
| Tool schema | **変更あり**。旧 OpenAI 引数 (`size`, `n`, `quality(str)` 等) から HermesAgent 互換 (`prompt`, `aspect_ratio`, `resolution`, `quality(bool)`) に変わった。古い呼び出しコードがあれば見直す。 |
| §3.7 暴走課金ガード (Day-1 OpenAI クレジット制限) | **役割終了**。OpenAI 経路が無くなったので Phase 2.A の Day-1 ガードは適用対象なし。HermesAgent 側の quota (SuperGrok 上限) が新しい防衛ライン。 |
| §3.5 生成物の返し方 (`{id, url, mime, schema_version}` 形式) | **無変更**。image-hub-app の `/files/<id>` 配信経路は引き続き上流のレスポンスを intercept で書き換える。 |

### 残作業 (運用)

- [ ] HermesAgent 側のサブドメイン公開設定 (`hermes.kitepon.dynv6.net` 等) と静的 bearer (`HERMES_BEARER_TOKEN` 相当) が安定運用に乗っていることを継続観察。Hermes 側が落ちると image-hub の openai-image ルートも 5xx になる。
- [ ] 旧 OpenAI 鍵 (`image-hub` project key) の最終 unbind 確認 (OpenAI Platform 管理画面で revoke)。
- [ ] 新スキーマで失敗するクライアント呼び出しが残っていないか、初回数回の呼び出しログで確認。

### tool docstring の方針 (2026-05-18 確定)

[server.py](../server/openai-image-mcp/server.py) の `generate_image` docstring は **比較表現を排除し、絶対指標 (USE FOR / DON'T USE FOR / Args / Returns / Limits) のみで記述する**。理由は memory `feedback_tool_docstring_no_comparison` に固定済。MCP `tools/list` 経由で全クライアントに伝播するため、ローカル特殊事情ではなくグローバルに正しい表現を維持する責務がある。
