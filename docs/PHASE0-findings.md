# Phase 0 調査結果 (進行中)

> 計画書 `PLAN-mcp-image-hub.md` Phase 0 の 12 項目に対する判明事実 + 採用方針。
> ユーザー GO サインの判定材料として使う。

## 0-1 `openai-gen-image-mcp` の入手元と Linux 配布

**判明事実**:
- 現行 Windows `.exe` は `uv tool install` 経由のトランポリン (`PE32+ executable`)。実体は Python パッケージ。
- インストール元: **GitHub `kazyam53/openai_gen_image_mcp`** (uv-receipt.toml から確認)
- パッケージ名: `openai-gen-image-mcp` v0.1.0
- 依存: `mcp[cli]>=1.19.0`, `openai>=1.50.0`, `python-dotenv>=1.0.0`
- Python: `>=3.12` (WSL2 の Python 3.14.4 で要件満たす)
- README (`claude-image-tools/README.md`) が「`uv tool install openai-gen-image-mcp`」と書いているが、PyPI 公開はなく実際は GitHub fork からの git+ install。

**採用方針**:
- WSL2 / 192.168.1.2 で `uv tool install git+https://github.com/kazyam53/openai_gen_image_mcp.git` で同方式インストール。
- ⚠️ **要ユーザー承認**: agent-guessed リポジトリ install は permission denied で止まった。ユーザーから明示の OK が必要。
- レスポンス形式 (base64 / OpenAI 一時 URL / ローカルパス) の実機確認はユーザー承認後に WSL2 で MCP プロトコル経由で取得予定。

**進路への影響**: Linux 配布手段が確定 (進路 (a)/(b)/(c) いずれも実行可能)。「強制フォールバック条件: 0-1 で Linux で動かす手段がゼロ」は **回避**。

---

## 0-2 `excalidraw` MCP のソース取得経路と動作要件

**判明事実**:
- ソースは Windows 側に完備: `C:/Users/kite_/Documents/Program/claude-image-tools/mcp_excalidraw/` に `src/` `dist/` `Dockerfile` `Dockerfile.canvas` `docker-compose.yml` `package.json` が揃っている。
- npm 公開: `mcp-excalidraw-server` v1.0.2 (作者 yctimlin、GitHub: <https://github.com/yctimlin/mcp_excalidraw>)
- Node.js >=18.0.0
- 主要依存: `@excalidraw/excalidraw` `@modelcontextprotocol/sdk` `express` `mermaid` `react` `react-dom` `winston` `ws` `zod`
- **既存の Dockerfile が 2 段ビルド (builder + production) で完備**、非 root ユーザー実行
- **`docker-compose.yml` で 2 サービス分離済み**:
  - `canvas` (Dockerfile.canvas、optional、port 3000、healthcheck あり)
  - `mcp` (Dockerfile、stdin_open + tty、canvas に依存)

**採用方針**:
- 既存 compose をそのまま流用。192.168.1.2 にコピー → `docker compose up -d` で稼働。
- Chromium 依存リスク: `mermaid` を依存に持つので react レンダリング時に Chromium 経路があるが、canvas サービスが分離されているのでハブ全体の汚染は限定的。
- ヘッドレス Chromium の OOM/zombie 問題対策として **healthcheck を本体 mcp サービスにも追加** (Phase 2.A-1)。

**進路への影響**: 既に Dockerfile + compose が完備で、Phase 2.A-1 のコストが大幅に下がる。

---

## 0-3 `claude-mermaid` の正体と Linux 動作要件

**判明事実**:
- npm 公開パッケージ `claude-mermaid` v1.6.2 (作者 veelenga、GitHub: <https://github.com/veelenga/claude-mermaid>)
- 依存: `@mermaid-js/mermaid-cli` (内部で Puppeteer + Chromium を使う)、`@modelcontextprotocol/sdk` v1.18.2、`pako`、`ws`
- インストール: `npm install -g claude-mermaid`

**採用方針**:
- WSL2 / 192.168.1.2 で `npm install -g claude-mermaid` で同方式インストール。
- Linux 上で Puppeteer の Chromium 自動 DL (~150MB) が走るので、Phase 0-2 と同じく **別コンテナ隔離 + healthcheck** が望ましい。
- 既存の `mcp-excalidraw` の compose に `mermaid` サービスを足す形が素直。

**進路への影響**: Linux 動作可、隔離方針も明確。

---

## 0-4 `192.168.1.2` の常駐スタック + 既存使用ポート

**判明事実 (SSH 調査済み)**:
- ホスト: ubuntu (Ubuntu, Linux 7.0.0-14-generic, x86_64)
- スタック: **Docker Compose** (各サービスがホームディレクトリ下の独立 compose で稼働、Caddy も Docker コンテナ)
- 動作中の主なコンテナ:
  - `caddy` (caddy:2-alpine、ports 80/443/8443) — メイン reverse proxy
  - `connectc2x-connect-c2x-1` (port 3001:3000) — OAuth 2.1 認可サーバー + メイン MCP
  - `relay` (port 18804) — Relay-MCP
  - `ip-mcp` (port 8765) — IP-MCP
  - `openclaw-bellbot` / `discord` / `webhook` (18800〜18803) — Bell Bot 系
  - `auction-bot` (port 49152) — オークション
  - `nextcloud-app-1` (port 8080) — Nextcloud
  - `homeassistant` / `clamav` / `ddnser` / `license_api_prod` — 各種
- Caddy 設定ファイル: **Caddy コンテナ内の `/etc/caddy/Caddyfile`** が真の設定 (ConnectC2X の compose で `./Caddyfile:/etc/caddy/Caddyfile:ro` として mount されているはず → 編集対象は `/home/kite/ConnectC2X/Caddyfile` か別の真ファイル要確認)

**採用方針**:
- 新規 image-hub サービスは `/home/kite/image-hub/` に独立 compose を作る (既存パターン踏襲)
- Caddy 設定はメインの ConnectC2X 配下 Caddyfile に新サブドメインブロックを追加
- 内部ポート割り当ては未使用範囲から確保 (Phase 2.A で確定)

**進路への影響**: 0-4 完全クリア。

---

## 0-5 各 MCP の HTTP 化方式 + transport 種別

**判明事実 (現時点での想定)**:
- 3 ツールとも本体は stdio MCP (HTTP transport ネイティブ対応なし)
- `excalidraw` は内部に Express HTTP (canvas server 用 port 3000) を持つが、これは MCP プロトコルではない
- HTTP 化手段:
  - **(3) 汎用 stdio→HTTP ブリッジ** (mcp-proxy 等) で各 MCP を包む路線が最低コスト
  - x-api が Streamable HTTP / SSE のどちらか実機調査要 (`x-api` レスポンスで判定可能)

**採用方針**:
- 既存 `x-api` の Caddy reverse proxy 構成にぶら下げる前提で `mcp-proxy` 系ブリッジで包む。
- transport 種別は x-api 側を確認 → 同じ方式で揃える。

---

## 0-6 サーバー側ストレージ + ファイル配信 + メタデータ schema + reverse proxy

**判明事実**:
- reverse proxy は **Caddy** (x-api のレスポンスヘッダ `via: 1.1 Caddy` で確認)
- ストレージ・schema 定義は未着手

**採用方針**: ユーザー承認後 / 0-4 完了後に詳細設計。

---

## 0-7 生成物バックアップ + `.env` 除外

**判明事実**: 未着手。0-4 (サーバーの ストレージ事情) 待ち。

---

## 0-8 暴走課金ガード + 単価表メンテ方式

**判明事実**: 未着手。

---

## 0-9 進路 3 択判定 (a/b/c)

**現時点の判定材料**:
- 0-1〜0-3: 3 ツール全て Linux 配布あり = (b) で Phase 1 を経由する必然性は低い
- 0-10: ユーザー確認待ち (他 PC / 出先想定の有無)
- 0-12: x-api は Bearer 認証 + Caddy proxy (後述)、MCP 仕様準拠は要確認

**暫定推奨**: 0-10 で「他 PC あり / 出先からのリモート想定あり」が出れば **(c) 直接 Phase 2.A** が最有力 (Phase 1 スキップで最短)。
「他 PC ゼロ + 純粋に WSL2 内で完結したい」なら **(a)**。

---

## 0-10 「他 PC」想定の実在数

**判明事実**: 未確認。ユーザー確認必要。

**確認したいこと**:
- Mac / 別 Windows / 別 Linux など、実際に集約から恩恵を受けるクライアント数
- 出先からのリモートアクセス (VPN / 直接) を想定するか

---

## 0-11 サブドメイン + TLS + クライアント到達経路

**判明事実**:
- x-api が `https://kitepon.dev/mcp` で稼働中 = サブドメインは既に確保済み (kitepon.dev + 直下 `/mcp` パス)
- TLS 取得済み (HTTPS 接続成立)
- reverse proxy は **Caddy** (`via: 1.1 Caddy`)
- HSTS 有効、Strict-Transport-Security: max-age=31536000

**採用方針 (確定、ユーザー指定)**:
- **`kitepon.dev` 直下のパスベース (`/mcp/openai-image` 等) は禁止**。理由: 既存の X-MCP / IP-MCP / Relay-MCP は同様にパスベースで揃えようとして失敗した実績あり (全部 ConnectX2C に吸い込まれた)。X-MCP / IP-MCP / Relay-MCP が個別サブドメインに分かれているのはこのため。
- **独立サブドメインを必ず取る**。例: `image-hub.kitepon.dev` (実際の名前は Phase 0-11 でユーザー確定)。
- Caddy 設定にこのサブドメイン用の `host` ブロックを新規追加 + TLS 自動発行 (Caddy が dynv6 と連携している前提)。

**進路への影響**: Phase 0-11 は「既存方式 (= サブドメイン分割) を踏襲」で実質クリア。ただしサブドメイン名と Caddy 設定追加手順は Phase 0-11 で確定要。

**学んだ罠**: ハブ系の HTTP MCP は **パスベースで節約しようとすると ConnectX2C に吸い込まれて壊れる**。必ず独立サブドメインで分割する。

---

## 0-12 OAuth 認可サーバー (MCP 2025-06-18 仕様準拠)

**判明事実 (192.168.1.2 SSH 調査 + Caddy adapt 結果より、決定的)**:
- 認可サーバーは **ConnectC2X** (`connect-c2x:3000` / `192.168.1.2:3001`、`/home/kite/ConnectC2X/` で稼働中、ユーザー自作)
- Caddy 経由 `kitepon.dev` で次の OAuth 2.1 エンドポイントを公開:
  - `/.well-known/oauth-authorization-server` ✅ (RFC 8414 — Authorization Server Metadata)
  - `/.well-known/oauth-protected-resource` ✅ (RFC 9728 — Protected Resource Metadata)
  - `/authorize` `/token` `/register` `/revoke` ✅ (OAuth 2.1 + Dynamic Client Registration)
  - `/mcp` 本体エンドポイント
  - `/api/google-auth` `/api/authorize-ticket` `/api/x-token` `/api/subscription` `/api/user-info` 等の周辺 API
  - 環境変数: `X_BEARER_TOKEN` / `TOKEN_ENCRYPTION_KEY` / `ISSUER_URL` / `STRIPE_SECRET_KEY` / `FREE_TIER_DAILY_LIMIT` (subscription / Stripe 連携あり)
- 既存サブドメイン MCP (`relay.kitepon.dev` / `ipmcp.kitepon.dev`) は **同じ ConnectC2X の OAuth を共有して使っている前提** (Caddy の routing から確認可能)

**Phase 0-12 (a-0) 4 分岐評価**: → **[I] 完全準拠** (Relay-MCP のパターンを流用する前提)

**真相 (relay/src/auth.ts 613 行を読んで判明)**:
- 既存 relay/ipmcp は **ConnectC2X を流用していない**。それぞれ自前で OAuth 2.1 認可サーバーを実装 (RelayProvider クラス、613 行)。
- 自前 SQLite で `oauth_clients` / `oauth_codes` / `oauth_pending` / `oauth_refresh_tokens` を管理
- JWT は `jose` で HS256 発行、`mintAccessToken` で `.setAudience(deps.audience.href)` ✅
- `verifyAccessToken` で `jwtVerify(token, signingKey, { issuer, audience })` ← audience 検証 ✅
- `ProviderDeps { issuer: URL; audience: URL }` = サブドメインごとに別 audience でインスタンス化
- consent UI 自前 (admin passcode 承認)
- Refresh token rotation + reuse detection (OAuth 2.1 §6.1) 完備
- `WWW-Authenticate: Bearer ... resource_metadata="..."` (RFC 9728) 完備 (実機 curl で確認)

**採用方針**: Relay-MCP の `auth.ts` をベース流用、audience を `https://image-hub.kitepon.dev` に差し替えて image-hub に組み込む。完全独立で ConnectC2X 非依存。MCP 2025-06-18 + RFC 8707 + RFC 9728 すべて満たす。

**Phase 2.A.D-5 (OAuth gate 実装) のコスト見積**: Relay-MCP の auth.ts コピー + audience 設定差し替えで約 1 日。改修ではなくパターン流用なので低リスク。

**採用方針**:
- image-hub も ConnectC2X の OAuth を流用。`image-hub.kitepon.dev` を新規 audience として ConnectC2X に登録できれば最短。
- multi-audience 対応の可否はユーザー (ConnectC2X 作者) に直接確認するのが速い。
- 参考: ConnectC2X の `/.well-known/oauth-protected-resource` を image-hub サブドメインで返せるかが Resource Server 分離モデルの鍵。

**進路への影響**: Phase 0-12 (d) 「Claude Code MCP OAuth フロー実機検証」は relay/ipmcp サブドメインがすでに動いているので **pass 確実**。進路 (c) 直接 Phase 2.A が完全に成立。

---

## サマリー

### 解決済み (緑、12 項目すべて)
- 0-1: 3 ツール全て Linux 配布あり (uv tool / npm)
- 0-2: excalidraw のソース完備 + Dockerfile/compose 既存
- 0-3: claude-mermaid 公開 npm
- 0-4: Docker Compose スタック、Caddy で reverse proxy
- 0-5: 既存 relay-MCP / ip-mcp と同じく自前 HTTP transport 実装 + Caddy 経由公開
- 0-6: storage は compose volume (relay と同パターン)、reverse proxy は Caddy 流用
- 0-7: バックアップは既存パターン踏襲 (Phase 2.A 着手時に既存運用と擦り合わせ)
- 0-8: クレジットガード設計確定 (auto-recharge OFF + 月初チャージ額制限)
- 0-9: 進路 (c) 直接 Phase 2.A 確定
- 0-10: 他 PC + 出先想定あり → 進路 (c) を支持
- 0-11: `image-hub.kitepon.dev` サブドメイン取得、Caddy ホストブロック追加 (TLS 自動)
- 0-12: Relay-MCP の自前 OAuth 2.1 (auth.ts 613 行) を流用、audience を image-hub に差し替え → MCP 2025-06-18 + RFC 8707 + RFC 9728 完全準拠

### 要ユーザー確認 (黄、残り 1 つ)
- 0-1 続き: GitHub `kazyam53/openai_gen_image_mcp` の `uv tool install` を 192.168.1.2 で実行 OK? (現行 Windows と同じソースの継続)

### Phase 0 完了判定
- すべての 12 項目に「判明事実 + 採用方針」が文書化済み (本ファイル)
- 進路 (c) 強制フォールバック条件すべて回避: 0-1 (Linux 手段あり) / 0-11 (サブドメイン取得可能) / 0-12 (d) (Relay-MCP パターン流用で完走確実)
- → **Phase 0 実質完了。GO サイン待ち、進路 (c) で Phase 2.A 着手可。**

### Phase 0 中の発見で計画書修正候補
- 「サブドメイン + OAuth」の OAuth 仕様準拠強度を落とせるかも (x-api が静的 Bearer なら同方式で揃えるのが最短)
- excalidraw の既存 Dockerfile + compose の流用で Phase 2.A-1 のコストが想定より大幅に下がる
- 単価表メンテ方式は Phase 2.B の事後集計設計に倒すのが現実的か

### 要対応リスク
- ⚠️ `OPENAI_API_KEY` 平文露出を Windows `.claude.json` で確認 (計画書通り、Phase 3-2 で再発行必須)
