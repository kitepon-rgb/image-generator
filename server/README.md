# image-hub server

`image-hub.kitepon.dynv6.net` サブドメインに OAuth 2.1 経由で 3 MCP (`openai-image` / `excalidraw` / `mermaid`) を集約するサーバー実装一式。

> Phase 2.A 完了 (2026-05-03)。3 MCP すべて Connected + e2e テスト成功。
> 計画書は `../docs/PLAN-mcp-image-hub.md`、Phase 0 調査結果は `../docs/PHASE0-findings.md`、クライアント切替手順は `../docs/PHASE2A-client-cutover.md`。

## 構成

- `image-hub-app/` — Express ベースの本体: OAuth 2.1 認可サーバー + 3 MCP への HTTP proxy + `/files/{id}` 配信。proxy は `node:fetch` 直叩き (http-proxy-middleware は v3 + Express 5 で silent fail を起こすので使わない)
- `openai-image-mcp/` `excalidraw-mcp/` `mermaid-mcp/` — 各 stdio MCP を `mcp-proxy` で HTTP 化したコンテナ。Streamable HTTP (`/mcp`) を使用 (SSE はリバプロ越しで messages relative URL が壊れるので使わない)
- `caddy/image-hub.snippet` — メイン Caddyfile に追記するサブドメインホストブロック
- `compose.yml` — 4 サービス並列稼働 (`image-hub` + `openai-image-mcp` + `excalidraw-mcp` + `mermaid-mcp`)
- `storage/` — bind mount 先 (生成物の永続化、バックアップ対象)
- `.env.example` — 雛形 (`.env` は git/バックアップから exclude)

### transport / proxy の方針

- **Client → image-hub**: Streamable HTTP (`type: "http"` in `~/.claude.json`)、URL `https://image-hub.kitepon.dynv6.net/mcp/{name}`、Bearer 認証
- **image-hub → upstream**: `node:fetch` で POST/GET/DELETE をそのまま転送 (HOP_BY_HOP ヘッダーは除外)。実装は `image-hub-app/src/index.ts` の `app.all(mcpPath, bearer, async ...)` ブロック
- **upstream の mcp-proxy**: Streamable HTTP `/mcp` を expose (`mcp-proxy` 6.x のデフォルト)、SSE `/sse` も同居しているが image-hub は Streamable HTTP しか叩かない

## デプロイ手順 (Phase 2.A)

### Day-1 (鍵集約前ゲート、すべて pass まで `OPENAI_API_KEY` を `.env` に置かない)

#### 2.A.D-1 OpenAI クレジットガード (ユーザー手動、Web UI で 10 分)
- OpenAI Platform → Billing → **auto-recharge OFF**
- 月初チャージ額を被害許容額 (例: $50) に絞る
- Usage limit / Budget alert を設定
- これが「最終防衛線」(prepaid モデルで「設定したら止まる」hard limit は無い)

#### 2.A.D-2〜3 LAN 限定 listen + バックアップ最小実装

```bash
# .env を作る (ダミー値で開始、本物 OPENAI_API_KEY は D-5 まで置かない)
cp .env.example .env
echo "IMAGEHUB_OAUTH_SIGNING_KEY=$(openssl rand -base64 64)" >> .env
echo "IMAGEHUB_ADMIN_PASSCODE=$(openssl rand -base64 18)" >> .env

# サーバーへ転送 (.env と _relay-* は除外)
rsync -av --exclude .env --exclude storage/ --exclude '_relay-*' --exclude 'node_modules' \
  /home/kite/projects/image-generator/server/ kite@192.168.1.2:/home/kite/image-hub/

# .env のみ別途転送
scp .env kite@192.168.1.2:/home/kite/image-hub/.env

# サーバー側でバックアップ最小実装 (ダミー .env で exclude 検証)
ssh kite@192.168.1.2 'echo OPENAI_API_KEY=DUMMY > /home/kite/image-hub/.env.test && \
  rsync -av --exclude ".env*" /home/kite/image-hub/ /tmp/image-hub-backup-test/ && \
  ls /tmp/image-hub-backup-test/.env* 2>&1 || echo "OK: .env not in backup"'
```

#### 2.A.D-4 サブドメイン取得 + TLS

```bash
ssh kite@192.168.1.2 'cat /home/kite/image-hub/caddy/image-hub.snippet >> /home/kite/license-server/Caddyfile && \
  docker exec caddy caddy reload --config /etc/caddy/Caddyfile'

curl -i https://image-hub.kitepon.dynv6.net/healthz
# まだ image-hub サービス未起動なので 502、TLS 証明書は OK
```

#### 2.A.D-5 image-hub-app + 3 MCP 起動

```bash
ssh kite@192.168.1.2 'cd /home/kite/image-hub && docker compose up -d --build'

# OAuth metadata 確認 (RFC 8414 + RFC 9728)
curl -s https://image-hub.kitepon.dynv6.net/.well-known/oauth-authorization-server | jq .
curl -s https://image-hub.kitepon.dynv6.net/.well-known/oauth-protected-resource/mcp | jq .

# 未認可リクエストが 401 + WWW-Authenticate を返す
curl -i -X POST https://image-hub.kitepon.dynv6.net/mcp/openai-image \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"probe","version":"0"}}}'
```

### Week-2 (鍵集約 + 残りタスク)

#### 2.A-3a/3b 鍵集約 (両側に鍵ある中間状態を作らない)

```bash
# サーバー側 .env に Phase 3-2 で再発行した新 OPENAI_API_KEY を書く
ssh kite@192.168.1.2 'sed -i "s|^OPENAI_API_KEY=.*|OPENAI_API_KEY=sk-proj-NEWKEY|" /home/kite/image-hub/.env && \
  cd /home/kite/image-hub && docker compose restart image-hub openai-image-mcp'

# 同時に Windows / WSL2 クライアント側 ~/.claude.json から openai-image の鍵削除
```

#### 2.A-8a クライアント側 .claude.json を HTTPS URL に書き換え

```jsonc
"openai-image": { "type": "http", "url": "https://image-hub.kitepon.dynv6.net/mcp/openai-image" },
"excalidraw":   { "type": "http", "url": "https://image-hub.kitepon.dynv6.net/mcp/excalidraw" },
"mermaid":      { "type": "http", "url": "https://image-hub.kitepon.dynv6.net/mcp/mermaid" }
```

OAuth トークン取得は Claude Code の MCP HTTP transport が動的に処理 (Dynamic Client Registration 経由)。初回は admin passcode で consent 承認が必要。

## トラブルシュート

- **502**: image-hub コンテナ未起動 or 内部 MCP の healthcheck failure。`docker compose ps` と `docker compose logs image-hub` を確認
- **401 + invalid_token**: OAuth フロー未完了。Claude Code 側で MCP 接続時に consent 画面が出る
- **Chromium silent fail (mermaid)**: Dockerfile で `/usr/bin/chromium` をラッパに差し替え `--no-sandbox --disable-dev-shm-usage` を強制注入済み (root 実行回避)。それでも落ちる場合は `docker compose logs mermaid-mcp` で puppeteer エラー確認
- **MCP 接続が `Failed` / `Streamable HTTP error: Error POSTing to endpoint`**: 過去のトークンが古い proxy 実装由来で残っている可能性。MCP servers パネルで `Check connection` 押下、または `mcp__<name>__authenticate` 経由で再認可
- **OAuth で `No OAuth flow is in progress`**: 同一 session で複数 MCP の認可を並行に走らせると flow state が上書きされる (memory `feedback_mcp_oauth_one_per_session`)。1 サーバーずつ完走させる
- **path traversal で 400**: `/files/{id}` が `[a-zA-Z0-9._-]+` のみ許可

## バックアップ運用

```bash
# 日次 cron (Phase 2.A.D-3 で稼働)
rsync -a --exclude '.env*' /home/kite/image-hub/storage/ /backup/image-hub-storage-$(date +%Y%m%d)/
```

`.env` は **必ず exclude**。鍵は別ルート (1Password / pass) で管理。

## 関連 caveat

- `kitepon.dynv6.net` 直下のパスベース MCP 並列は禁止 (memory: `feedback_subdomain_per_mcp`)
- `OPENAI_API_KEY` 平文露出が現行 Windows `~/.claude.json` にあり、Phase 3-2 で再発行必須
- Mermaid CLI の Chromium 依存は別コンテナ + healthcheck で隔離 (compose.yml で対応済み)
