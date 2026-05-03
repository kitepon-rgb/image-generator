// image-hub config — env から URL / secrets / 内部 MCP URL を読む。
// Relay-MCP の config.ts パターンを image-hub 用に改造。

export interface Config {
  readonly port: number;
  readonly publicMcpUrl: URL;
  readonly publicAuthUrl: URL;
  readonly oauthSigningKey: string;
  readonly adminPasscode: string;
  readonly staticBearerToken: string | null;
  readonly storageDir: string;
  readonly dbPath: string;
  readonly mcpUpstreams: Readonly<Record<string, string>>;
  readonly logLevel: 'debug' | 'info' | 'warn' | 'error';
}

function reqEnv(name: string): string {
  const v = process.env[name];
  if (v === undefined || v.length === 0) {
    throw new Error(`Missing required env: ${name}`);
  }
  return v;
}

function parseUrl(name: string): URL {
  const raw = reqEnv(name);
  try {
    return new URL(raw);
  } catch {
    throw new Error(`Invalid URL in env ${name}: ${raw}`);
  }
}

export function loadConfig(): Config {
  const port = Number(process.env.IMAGEHUB_PORT ?? '18810');
  if (!Number.isFinite(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid IMAGEHUB_PORT: ${process.env.IMAGEHUB_PORT}`);
  }
  const oauthSigningKey = reqEnv('IMAGEHUB_OAUTH_SIGNING_KEY');
  if (oauthSigningKey.length < 32) {
    throw new Error('IMAGEHUB_OAUTH_SIGNING_KEY must be at least 32 characters');
  }
  const adminPasscode = reqEnv('IMAGEHUB_ADMIN_PASSCODE');
  if (adminPasscode.length < 8) {
    throw new Error('IMAGEHUB_ADMIN_PASSCODE must be at least 8 characters');
  }
  const rawStaticToken = process.env.IMAGEHUB_STATIC_BEARER_TOKEN ?? '';
  const staticBearerToken = rawStaticToken.length > 0 ? rawStaticToken : null;
  if (staticBearerToken !== null && staticBearerToken.length < 32) {
    throw new Error('IMAGEHUB_STATIC_BEARER_TOKEN must be at least 32 characters when set');
  }

  return {
    port,
    publicMcpUrl: parseUrl('IMAGEHUB_PUBLIC_MCP_URL'),
    publicAuthUrl: parseUrl('IMAGEHUB_PUBLIC_AUTH_URL'),
    oauthSigningKey,
    adminPasscode,
    staticBearerToken,
    storageDir: process.env.IMAGEHUB_STORAGE_DIR ?? '/var/lib/image-hub/storage',
    dbPath: process.env.IMAGEHUB_DB_PATH ?? '/var/lib/image-hub/image-hub.db',
    mcpUpstreams: Object.freeze({
      'openai-image': reqEnv('MCP_OPENAI_IMAGE_URL'),
      'excalidraw':   reqEnv('MCP_EXCALIDRAW_URL'),
      'mermaid':      reqEnv('MCP_MERMAID_URL'),
    }),
    logLevel: (process.env.LOG_LEVEL ?? 'info') as Config['logLevel'],
  };
}
