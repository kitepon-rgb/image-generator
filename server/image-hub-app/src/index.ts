// image-hub-app entry point.
// 1 サブドメイン (image-hub.kitepon.dynv6.net) に集約された OAuth 2.1 認可サーバー +
// 3 MCP コンテナへのリバースプロキシ + 生成物配信 (/files/{id}) を 1 Express app で提供。
// Relay-MCP の index.ts パターンを image-hub 用に拡張。

import express from 'express';
import type { Request, Response } from 'express';
import { Readable } from 'node:stream';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { authorizationHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/authorize.js';
import { tokenHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/token.js';
import { clientRegistrationHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/register.js';
import { metadataHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/metadata.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { getOAuthProtectedResourceMetadataUrl } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { loadConfig } from './config.js';
import { openStorage } from './storage.js';
import { openAuthSubsystem } from './auth.js';

const config = loadConfig();
const storage = openStorage(config.dbPath);
console.log(`[image-hub] storage opened at ${config.dbPath}`);

// Derived paths
const mcpBasePath      = config.publicMcpUrl.pathname.replace(/\/$/, '');     // /mcp
const authBasePath     = config.publicAuthUrl.pathname.replace(/\/$/, '');    // ''
const authorizePath    = `${authBasePath}/authorize`;
const tokenPath        = `${authBasePath}/token`;
const registerPath     = `${authBasePath}/register`;
const consentPath      = `${authBasePath}/consent`;
const asMetadataPath   = `/.well-known/oauth-authorization-server${authBasePath || '/'}`;
const rsMetadataPath   = `/.well-known/oauth-protected-resource${mcpBasePath}`;

const consentUrl = new URL(consentPath, config.publicAuthUrl);

const auth = openAuthSubsystem({
  dbPath: config.dbPath,
  signingKey: config.oauthSigningKey,
  issuer: config.publicAuthUrl,
  audience: config.publicMcpUrl,
  consentUrl,
  relayStorage: storage,
});

const app = express();

// --- Health (auth 不要) ---
app.get('/healthz', (_req, res) => {
  res.json({
    ok: true,
    mcp: config.publicMcpUrl.href,
    auth: config.publicAuthUrl.href,
    upstreams: Object.keys(config.mcpUpstreams),
  });
});

// --- OAuth metadata (RFC 8414 + RFC 9728) ---
const asMetadata = {
  issuer: config.publicAuthUrl.href.replace(/\/$/, ''),
  authorization_endpoint: new URL(authorizePath, config.publicAuthUrl).href,
  token_endpoint: new URL(tokenPath, config.publicAuthUrl).href,
  registration_endpoint: new URL(registerPath, config.publicAuthUrl).href,
  response_types_supported: ['code'],
  grant_types_supported: ['authorization_code', 'refresh_token'],
  code_challenge_methods_supported: ['S256'],
  token_endpoint_auth_methods_supported: ['none'],
};

const rsMetadata = {
  resource: config.publicMcpUrl.href,
  authorization_servers: [config.publicAuthUrl.href.replace(/\/$/, '')],
  resource_name: 'image-hub',
};

app.use(asMetadataPath, metadataHandler(asMetadata));
app.use(rsMetadataPath, metadataHandler(rsMetadata));

// --- OAuth endpoints (auth 不要、認可フロー本体) ---
app.use(express.json({ limit: '10mb' }));
app.use(registerPath, clientRegistrationHandler({ clientsStore: auth.provider.clientsStore }));
app.use(authorizePath, authorizationHandler({ provider: auth.provider }));
app.use(tokenPath, tokenHandler({ provider: auth.provider }));
auth.mountConsent(app, consentPath, config.adminPasscode);

// --- Bearer middleware (以後の /mcp/* と /files/* に適用) ---
const bearer = requireBearerAuth({
  verifier: { verifyAccessToken: token => auth.provider.verifyAccessToken(token) },
  resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(config.publicMcpUrl),
});

// --- /files/{id} 配信 (Bearer 必須) ---
app.get(`/files/:id`, bearer, async (req: Request, res: Response) => {
  const idParam = req.params.id;
  const id = typeof idParam === 'string' ? idParam : '';
  // basename チェック (path traversal 防止)
  if (id.length === 0 || !/^[a-zA-Z0-9._-]+$/.test(id)) {
    res.status(400).json({ error: 'invalid id' });
    return;
  }
  const meta = storage.getArtifact(id.replace(/\.[^.]+$/, ''));
  if (meta === undefined) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  const filePath = join(config.storageDir, id);
  try {
    await stat(filePath);
  } catch {
    res.status(404).json({ error: 'file missing on disk' });
    return;
  }
  res.setHeader('Content-Type', meta.mime);
  res.setHeader('Cache-Control', 'private, max-age=86400');
  createReadStream(filePath).pipe(res);
});

// --- /mcp/{name} → 内部 MCP コンテナへ proxy (Bearer 必須) ---
// upstream は mcp-proxy 6.x の Streamable HTTP 単一エンドポイント。
// http-proxy-middleware v3 + Express 5 の組合せでフォワードが silent fail したため、
// node:fetch ベースの素朴フォワーダで実装する (Streamable HTTP は単一 URL なのでこれで十分)。
const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'host', 'content-length',
]);

for (const [name, upstream] of Object.entries(config.mcpUpstreams)) {
  const mcpPath = `${mcpBasePath}/${name}`;
  app.all(mcpPath, bearer, async (req: Request, res: Response) => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (HOP_BY_HOP.has(k.toLowerCase())) continue;
      if (typeof v === 'string') headers[k] = v;
      else if (Array.isArray(v)) headers[k] = v.join(', ');
    }
    const init: RequestInit & { duplex?: string } = {
      method: req.method,
      headers,
    };
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      init.body = req.body !== undefined && Object.keys(req.body).length > 0
        ? JSON.stringify(req.body)
        : undefined;
      headers['content-type'] = headers['content-type'] ?? 'application/json';
    }
    try {
      const upstreamRes = await fetch(upstream, init);
      res.status(upstreamRes.status);
      upstreamRes.headers.forEach((value, key) => {
        if (HOP_BY_HOP.has(key.toLowerCase())) return;
        res.setHeader(key, value);
      });
      if (upstreamRes.body !== null) {
        Readable.fromWeb(upstreamRes.body as never).pipe(res);
      } else {
        res.end();
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[image-hub] proxy error for ${name}:`, message);
      if (!res.headersSent) {
        res.status(502).json({ error: 'upstream unreachable', upstream: name });
      }
    }
  });
  console.log(`[image-hub] mounted ${mcpPath} -> ${upstream}`);
}

// --- 起動 ---
app.listen(config.port, '0.0.0.0', () => {
  console.log(`[image-hub] listening on :${config.port}`);
  console.log(`[image-hub] public MCP base: ${config.publicMcpUrl.href}`);
  console.log(`[image-hub] public auth base: ${config.publicAuthUrl.href}`);
});

// 終了時にクリーンアップ
process.on('SIGTERM', () => {
  console.log('[image-hub] SIGTERM received, shutting down');
  auth.close();
  storage.close();
  process.exit(0);
});
