# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository status

このリポジトリは **設計書 + 実装 + デプロイ** が同居する。

- [docs/](docs/) — 計画書 / Phase 0 調査 / クライアント切り替え手順
- [server/](server/) — image-hub サーバー実装 (Express + Docker Compose)
  - `image-hub-app/` — OAuth 2.1 サーバー + 3 MCP リバースプロキシ + `/files/{id}` 配信 (Express + 自前 fetch ベース proxy)
  - `openai-image-mcp/` `excalidraw-mcp/` `mermaid-mcp/` — 各 stdio MCP を `mcp-proxy` で HTTP 化したコンテナ
  - `caddy/image-hub.snippet` — メイン Caddyfile に追記するホストブロック
  - `compose.yml` — 4 サービス並列稼働
- 実機デプロイ先: `kite@192.168.1.2:/home/kite/image-hub/`、公開 URL `https://image-hub.kitepon.dynv6.net`

## What this project is about

Windows 側に stdio で登録されていた画像/作図系 MCP サーバー 3 本 (`openai-image` / `excalidraw` / `mermaid`) を、LAN サーバー `192.168.1.2` の Docker Compose 上に集約し、`image-hub.kitepon.dynv6.net` サブドメインから OAuth 2.1 経由で Windows / WSL2 / 他 PC から共有利用する。

## 進捗

- **Phase 0 (調査)**: 完了 ([docs/PHASE0-findings.md](docs/PHASE0-findings.md))
- **Phase 2.A (デプロイ・集約)**: 完了。3 MCP すべて Connected、e2e テスト (図描画 / 画像生成) 成功
- **Phase 3-2 (鍵ローテ)**: 完了。旧鍵 revoke 済、新鍵 `image-hub` で稼働中
- **Phase 2.B (ハブ化: gallery / dashboard / cache)**: 未着手
- **Phase 4 (拡張機能)**: 未着手

詳細な完了/残作業は [docs/PLAN-mcp-image-hub.md §2](docs/PLAN-mcp-image-hub.md) のチェックリストを参照。

## Working with this repo

- 計画書を編集するときは §2 の「検証可能なゴール」と §5 の「既知のリスク」のチェックリスト形式を維持する。
- 実装変更を入れたら必ず `docs/PLAN-mcp-image-hub.md` と `server/README.md` の対応箇所を同時更新する。

## Project-specific constraints (must read before touching MCP config or server)

- **MCP 設定先**: WSL2 / Windows どちらも `~/.claude.json` の `mcpServers` に書く。`~/.claude/settings.json` は `mcpServers` を受け付けない。
- **transport は Streamable HTTP (`type: "http"`)**: SSE は採用しない (リバプロ越しで messages の relative URL が崩れて死ぬ — memory `feedback_mcp_proxy_streamable_http` 参照)。
- **リバプロは `node:fetch` 直叩き**: `http-proxy-middleware` v3 + Express 5 の組合せは silent fail を起こす。`server/image-hub-app/src/index.ts` の `app.all(mcpPath, bearer, async ...)` パターンを踏襲する。
- **chromium を含むコンテナは `--no-sandbox` 強制**: root 実行を拒否されるので Dockerfile で `/usr/bin/chromium` をラッパに差し替えて `--no-sandbox --disable-dev-shm-usage` を強制注入する (`server/mermaid-mcp/Dockerfile` 参照)。
- **`OPENAI_API_KEY` 露出履歴**: 旧鍵がこの計画の元になったチャットで露出済み → Phase 3-2 で再発行済 (project key 名 `image-hub`)。新規にコード/設定例を書くときも旧鍵を使い回さない。
- **`.env` は絶対 commit しない**: `server/.gitignore` で除外済。バックアップにも `.env*` exclude (Day-1 で実機検証済)。
- **claude-spotter で WSL2 から Windows 側 MCP を収集する場合**: 1.2.2 以上を使う。
- **`/mcp/<name>` は 3 経路の認可** (2026-05-04 追加): (1) JSON-RPC method が discovery 系 (`initialize` / `tools/list` / `prompts/list` / `resources/list` / `resources/templates/list` / `notifications/initialized` / `notifications/cancelled` / `ping`) なら bearer 不要 (2) `Authorization: Bearer ${IMAGEHUB_STATIC_BEARER_TOKEN}` 一致なら OAuth 検証 skip (3) それ以外は従来の OAuth bearer 検証。理由: Spotter 等の外部 catalog 消費者は OAuth トークンを持てないので `tools/list` が 401 で取れない / Bell のような OAuth フロー回せない隔離 Claude も救う必要があった。実装は [server/image-hub-app/src/index.ts](server/image-hub-app/src/index.ts) の `mcpAuth` ミドルウェア。静的トークンは `IMAGEHUB_STATIC_BEARER_TOKEN` を `.env` に置く (32 文字以上、空なら経路 (2) は無効化)。漏洩時のローテは `openssl rand -hex 32` で再発行 → ローカル + prod `.env` 両方更新 → `docker compose up -d --build image-hub`。

## デプロイ

```bash
# server/ を rsync (.env と storage/ は exclude)
rsync -av --exclude .env --exclude storage/ \
  /home/kite/projects/image-generator/server/ kite@192.168.1.2:/home/kite/image-hub/

# .env 変更だけなら restart で OK、compose.yml/Dockerfile/コードを変えたら up -d --build
ssh kite@192.168.1.2 'cd /home/kite/image-hub && docker compose up -d --build'
```
