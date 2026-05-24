# Phase 2.A クライアント切り替え手順 (完了済の記録)

> **Status**: Phase 2.A は完了済 (2026-05-03)。3 MCP すべて Connected、e2e テスト (mermaid 図描画 / excalidraw 矩形作成 / openai-image 画像生成) 成功。
> 本ドキュメントは振り返り + 同種構成を再構築する際の参照手順。

## 切り替えの絶対原則

**「両側に鍵があるブラックホール時間」を作らない**。サーバー側 `.env` に新鍵を書く瞬間と、Windows / WSL2 クライアントから鍵 (旧 stdio 設定) を消す瞬間を、できるだけ同じセッション内で完結させる。

順序:
1. OpenAI ダッシュボードで旧鍵 revoke (= 旧 Windows stdio 設定が即時に死ぬ)
2. 直後に新鍵発行 → サーバー側 `.env` に貼る
3. Windows 側 `~/.claude.json` から旧 stdio 3 ブロック削除 → 新 HTTPS 3 ブロック追加 (バックアップは取る)
4. WSL2 側 `~/.claude.json` に新 HTTPS 3 ブロック追加 (旧 stdio は無いので削除不要)
5. Claude Code 再起動 → OAuth フロー (admin passcode 入力) → サンプル生成テスト

旧鍵 revoke を最初にやることで、「両側に鍵がある」ウィンドウは存在しない (サーバーが鍵を持つまで openai-image はそもそも動かない、その間 mermaid / excalidraw はキー不要で動く)。

## クライアント設定スニペット

### 共通: 公開エンドポイント

| MCP 名 | 公開 URL (Claude Code config に書く) | type |
|---|---|---|
| `openai-image` | `https://image-hub.kitepon.dev/mcp/openai-image` | `http` |
| `excalidraw`   | `https://image-hub.kitepon.dev/mcp/excalidraw`   | `http` |
| `mermaid`      | `https://image-hub.kitepon.dev/mcp/mermaid`      | `http` |

> **transport は Streamable HTTP**: SSE は採用しない (リバプロ越しで `messages?sessionId=...` の relative URL が host root に飛んで 404 になる)。詳細は memory `feedback_mcp_proxy_streamable_http` 参照。
> 接続時に Claude Code は `/.well-known/oauth-protected-resource/mcp` を辿って OAuth フロー (admin passcode) に進む。

### Windows 側 `~/.claude.json` (= `C:\Users\kite_\.claude.json`)

#### 旧 (削除する)
`mcpServers` の中の `openai-image` / `excalidraw` / `mermaid` 3 ブロックを **丸ごと削除**。
- `openai-image` ブロックの `env.OPENAI_API_KEY` の値が露出した旧鍵 (`sk-proj-OQjmm...`) なので、削除と同時に OpenAI ダッシュボードで revoke 必須。
- 削除前に `~/.claude.json.bak-YYYYMMDD` で必ずバックアップ。

#### 新 (追加する)
```json
"openai-image": {
  "type": "http",
  "url": "https://image-hub.kitepon.dev/mcp/openai-image"
},
"excalidraw": {
  "type": "http",
  "url": "https://image-hub.kitepon.dev/mcp/excalidraw"
},
"mermaid": {
  "type": "http",
  "url": "https://image-hub.kitepon.dev/mcp/mermaid"
}
```

PowerShell でのバックアップ + 編集の概形 (実際の編集はエディタで丁寧に):
```powershell
Copy-Item $HOME\.claude.json $HOME\.claude.json.bak-$(Get-Date -Format yyyyMMdd)
notepad $HOME\.claude.json
```

### WSL2 側 `~/.claude.json` (= `/home/kite/.claude.json`)

WSL2 側にはこれら 3 MCP は登録されていないので **追加のみ**。`mcpServers` オブジェクトに上の 3 ブロックを追記する。

```bash
cp ~/.claude.json ~/.claude.json.bak-$(date +%Y%m%d)
# jq があるなら:
jq '.mcpServers += {
  "openai-image": {"type":"http","url":"https://image-hub.kitepon.dev/mcp/openai-image"},
  "excalidraw":   {"type":"http","url":"https://image-hub.kitepon.dev/mcp/excalidraw"},
  "mermaid":      {"type":"http","url":"https://image-hub.kitepon.dev/mcp/mermaid"}
}' ~/.claude.json > ~/.claude.json.new && mv ~/.claude.json.new ~/.claude.json
```

## サーバー側 `.env` 新鍵反映

```bash
ssh kite@192.168.1.2 'cd /home/kite/image-hub && \
  cp .env .env.bak-$(date +%Y%m%d) && \
  sed -i "s|^OPENAI_API_KEY=.*|OPENAI_API_KEY=sk-proj-NEWKEY_HERE|" .env && \
  docker compose restart image-hub openai-image-mcp'
```

(`docker compose restart` は port mapping や environment 変更を反映しないが、`.env` は env_file 経由で再読み込みされるのでこれで OK。compose.yml 自体を変えた場合は `up -d --build` を使う。)

## デプロイ

```bash
rsync -av --exclude .env --exclude storage/ --exclude '_relay-*' --exclude 'node_modules' \
  /home/kite/projects/image-generator/server/ kite@192.168.1.2:/home/kite/image-hub/
ssh kite@192.168.1.2 'cd /home/kite/image-hub && docker compose up -d --build'
```

## OAuth 認可の進め方 (3 サーバー初回)

memory `feedback_mcp_oauth_one_per_session` の通り、**同一 MCP サーバーに対して 2 つの OAuth flow を並行起動すると state が上書きされる** (VSCode の MCP パネル click と `authenticate` ツール呼び出しを同時に走らせない)。安全策として 1 サーバーずつ順次:

1. `mermaid` だけ認可 → Connected を確認 → 次へ
2. `excalidraw` を認可 → Connected を確認 → 次へ
3. `openai-image` を認可

VSCode 拡張版 Claude Code 経由なら GUI から `Failed`/`Needs Auth` をクリックでブラウザが開く。`.env` の `IMAGEHUB_ADMIN_PASSCODE` を入力して consent 承認 → `Authentication Successful` ページが出れば完了。

CLI 経由 (`mcp__<name>__authenticate` ツール) なら、URL を渡されてユーザーが開く → callback URL (`localhost:<port>/callback?code=...&state=...`) を `mcp__<name>__complete_authentication` に渡す。

## 動作確認

```bash
# 1. OAuth metadata
curl -s https://image-hub.kitepon.dev/.well-known/oauth-authorization-server | python3 -m json.tool
# 2. 401 challenge (Streamable HTTP エンドポイント)
curl -i -X POST https://image-hub.kitepon.dev/mcp/excalidraw \
  -H 'content-type: application/json' -d '{}' | head -5
# 3. healthcheck pass を確認
ssh kite@192.168.1.2 'docker ps --format "{{.Names}}\t{{.Status}}"'
# 全 4 コンテナが (healthy) になっていること
```

Claude Code 再起動後:
- `/mcp` で 3 サーバーが Connected
- `mermaid` で簡単な図を描く (鍵不要、最初に動く)
- `excalidraw` でテスト (鍵不要)
- `openai-image` で `prompt: "a tiny test sketch"` 等で 1 枚生成 (新鍵で動くはず)

## 構築時に踏んだ地雷 (root cause 修正済み)

- **transport**: SSE は不可、Streamable HTTP に切替 (上記参照)
- **proxy**: `http-proxy-middleware` v3 + Express 5 の組合せが silent fail → `node:fetch` 直叩きに置換 ([../server/image-hub-app/src/index.ts](../server/image-hub-app/src/index.ts) の `app.all(mcpPath, bearer, async ...)` ブロック)
- **chromium**: claude-mermaid → puppeteer が root 起動を拒否 → Dockerfile で chromium ラッパに `--no-sandbox` 強制注入 ([../server/mermaid-mcp/Dockerfile](../server/mermaid-mcp/Dockerfile))
- **mcp-proxy エンドポイント**: 6.x の Streamable HTTP は `/mcp` 厳密一致、`/mcp/` (trailing slash) で 404 (fetch ベースに切り替えたので問題なくなった)
