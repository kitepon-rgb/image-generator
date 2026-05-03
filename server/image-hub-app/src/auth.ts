// OAuth 2.1 authorization server + bearer auth provider for Relay.
// Implements the OAuthServerProvider interface that the MCP SDK expects.

import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Request, Response } from 'express';
import express from 'express';
import Database from 'better-sqlite3';
import { SignJWT, jwtVerify } from 'jose';
import type { Storage } from './storage.js';
import type {
  OAuthRegisteredClientsStore,
} from '@modelcontextprotocol/sdk/server/auth/clients.js';
import type {
  AuthorizationParams,
  OAuthServerProvider,
} from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type {
  OAuthClientInformationFull,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import { InvalidGrantError } from '@modelcontextprotocol/sdk/server/auth/errors.js';

const ACCESS_TOKEN_TTL_SEC = 60 * 60 * 4;            // 4 hours
const REFRESH_TOKEN_TTL_SEC = 60 * 60 * 24 * 90;     // 90 days
const PENDING_TTL_MS = 10 * 60 * 1000;               // 10 minutes
const CODE_TTL_MS = 60 * 1000;                       // 1 minute

const AUTH_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS oauth_clients (
  client_id      TEXT PRIMARY KEY,
  client_name    TEXT NOT NULL,
  redirect_uris  TEXT NOT NULL,
  scopes         TEXT,
  registered_at  INTEGER NOT NULL,
  data           TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS oauth_codes (
  -- code_hash is SHA-256(code); the raw code is never stored.
  -- Symmetry with oauth_refresh_tokens — if the DB leaks, no in-flight code is usable.
  code_hash             TEXT PRIMARY KEY,
  client_id             TEXT NOT NULL,
  redirect_uri          TEXT NOT NULL,
  code_challenge        TEXT NOT NULL,
  code_challenge_method TEXT NOT NULL,
  scope                 TEXT,
  expires_at            INTEGER NOT NULL,
  consumed              INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS oauth_pending (
  session_id            TEXT PRIMARY KEY,
  client_id             TEXT NOT NULL,
  redirect_uri          TEXT NOT NULL,
  code_challenge        TEXT NOT NULL,
  code_challenge_method TEXT NOT NULL,
  state                 TEXT,
  scope                 TEXT,
  expires_at            INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS oauth_refresh_tokens (
  -- token_hash is SHA-256(refresh_token); the raw token is never stored.
  token_hash    TEXT PRIMARY KEY,
  client_id     TEXT NOT NULL,
  scope         TEXT,
  issued_at     INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL,
  revoked       INTEGER NOT NULL DEFAULT 0,
  -- When this token is rotated, rotated_to holds the hash of the replacement.
  -- Used for reuse detection: presenting an already-rotated token is a theft signal.
  rotated_to    TEXT
);

CREATE INDEX IF NOT EXISTS idx_refresh_client ON oauth_refresh_tokens(client_id);
`;

interface PendingRow {
  session_id: string;
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  code_challenge_method: string;
  state: string | null;
  scope: string | null;
  expires_at: number;
}

interface CodeRow {
  code_hash: string;
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  code_challenge_method: string;
  scope: string | null;
  expires_at: number;
  consumed: number;
}

interface ClientRow {
  client_id: string;
  client_name: string;
  redirect_uris: string;
  scopes: string | null;
  registered_at: number;
  data: string;
}

interface RefreshRow {
  token_hash: string;
  client_id: string;
  scope: string | null;
  issued_at: number;
  expires_at: number;
  revoked: number;
  rotated_to: string | null;
}

// SHA-256 is sufficient here: tokens are 256-bit cryptographically random
// values, not low-entropy passwords, so dictionary/rainbow-table attacks are
// computationally infeasible. A server-side pepper (HMAC-SHA256) would add
// defense-in-depth against a stolen DB but requires careful key rotation
// procedures we don't currently have. Revisit if tokens become low-entropy.
function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

// Constant-time string comparison to prevent timing-based length/prefix
// disclosure on the consent passcode. Returns false on length mismatch
// without invoking timingSafeEqual (which throws on differing lengths).
function constantTimeEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}

interface ProviderDeps {
  readonly db: Database.Database;
  readonly signingKey: Uint8Array;
  readonly issuer: URL;
  readonly audience: URL;
  readonly consentUrl: URL;
  readonly relayStorage: Storage;
}

class RelayClientsStore implements OAuthRegisteredClientsStore {
  private readonly getStmt: Database.Statement<[string], ClientRow>;
  private readonly insertStmt: Database.Statement<[string, string, string, string | null, number, string]>;

  constructor(db: Database.Database) {
    this.getStmt = db.prepare<[string], ClientRow>(
      `SELECT client_id, client_name, redirect_uris, scopes, registered_at, data
         FROM oauth_clients WHERE client_id = ?`,
    );
    this.insertStmt = db.prepare<[string, string, string, string | null, number, string]>(
      `INSERT INTO oauth_clients (client_id, client_name, redirect_uris, scopes, registered_at, data)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
  }

  getClient(clientId: string): OAuthClientInformationFull | undefined {
    const row = this.getStmt.get(clientId);
    if (row === undefined) return undefined;
    return JSON.parse(row.data) as OAuthClientInformationFull;
  }

  registerClient(
    input: Omit<OAuthClientInformationFull, 'client_id' | 'client_id_issued_at'>,
  ): OAuthClientInformationFull {
    const clientId = `client_${randomBytes(12).toString('hex')}`;
    const now = Math.floor(Date.now() / 1000);
    const full: OAuthClientInformationFull = {
      ...input,
      client_id: clientId,
      client_id_issued_at: now,
    };
    const clientName = full.client_name ?? 'Unnamed Connector';
    this.insertStmt.run(
      clientId,
      clientName,
      JSON.stringify(full.redirect_uris),
      full.scope ?? null,
      now * 1000,
      JSON.stringify(full),
    );
    return full;
  }
}

function makePendingHelpers(db: Database.Database) {
  const insert = db.prepare<[string, string, string, string, string, string | null, string | null, number]>(
    `INSERT INTO oauth_pending
       (session_id, client_id, redirect_uri, code_challenge, code_challenge_method, state, scope, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const get = db.prepare<[string], PendingRow>(
    `SELECT session_id, client_id, redirect_uri, code_challenge, code_challenge_method, state, scope, expires_at
       FROM oauth_pending WHERE session_id = ?`,
  );
  const del = db.prepare<[string]>(`DELETE FROM oauth_pending WHERE session_id = ?`);
  return { insert, get, del };
}

function makeCodeHelpers(db: Database.Database) {
  const insert = db.prepare<[string, string, string, string, string, string | null, number]>(
    `INSERT INTO oauth_codes
       (code_hash, client_id, redirect_uri, code_challenge, code_challenge_method, scope, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const get = db.prepare<[string], CodeRow>(
    `SELECT code_hash, client_id, redirect_uri, code_challenge, code_challenge_method, scope, expires_at, consumed
       FROM oauth_codes WHERE code_hash = ?`,
  );
  // Atomic consume: only succeeds if not yet consumed. Caller checks .changes
  // to detect the lost-race case where another request already consumed it.
  const consume = db.prepare<[string]>(
    `UPDATE oauth_codes SET consumed = 1 WHERE code_hash = ? AND consumed = 0`,
  );
  return { insert, get, consume };
}

function makeRefreshHelpers(db: Database.Database) {
  const insert = db.prepare<[string, string, string | null, number, number]>(
    `INSERT INTO oauth_refresh_tokens (token_hash, client_id, scope, issued_at, expires_at)
     VALUES (?, ?, ?, ?, ?)`,
  );
  const get = db.prepare<[string], RefreshRow>(
    `SELECT token_hash, client_id, scope, issued_at, expires_at, revoked, rotated_to
       FROM oauth_refresh_tokens WHERE token_hash = ?`,
  );
  const rotate = db.prepare<[string, string]>(
    `UPDATE oauth_refresh_tokens SET revoked = 1, rotated_to = ? WHERE token_hash = ?`,
  );
  const revokeAllForClient = db.prepare<[string]>(
    `UPDATE oauth_refresh_tokens SET revoked = 1 WHERE client_id = ?`,
  );
  return { insert, get, rotate, revokeAllForClient };
}

class RelayProvider implements OAuthServerProvider {
  readonly clientsStore: RelayClientsStore;
  private readonly pending: ReturnType<typeof makePendingHelpers>;
  private readonly codes: ReturnType<typeof makeCodeHelpers>;
  private readonly refresh: ReturnType<typeof makeRefreshHelpers>;

  constructor(private readonly deps: ProviderDeps) {
    this.clientsStore = new RelayClientsStore(deps.db);
    this.pending = makePendingHelpers(deps.db);
    this.codes = makeCodeHelpers(deps.db);
    this.refresh = makeRefreshHelpers(deps.db);
  }

  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response,
  ): Promise<void> {
    const sessionId = randomUUID();
    this.pending.insert.run(
      sessionId,
      client.client_id,
      params.redirectUri,
      params.codeChallenge,
      'S256',
      params.state ?? null,
      params.scopes !== undefined && params.scopes.length > 0 ? params.scopes.join(' ') : null,
      Date.now() + PENDING_TTL_MS,
    );
    const consent = new URL(this.deps.consentUrl.href);
    consent.searchParams.set('session', sessionId);
    res.redirect(consent.href);
  }

  async challengeForAuthorizationCode(
    _client: OAuthClientInformationFull,
    authorizationCode: string,
  ): Promise<string> {
    const row = this.codes.get.get(hashToken(authorizationCode));
    if (row === undefined) throw new Error('invalid authorization code');
    return row.code_challenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    redirectUri?: string,
    _resource?: URL,
  ): Promise<OAuthTokens> {
    const codeHash = hashToken(authorizationCode);
    const row = this.codes.get.get(codeHash);
    if (row === undefined) throw new InvalidGrantError('invalid authorization code');
    if (row.expires_at < Date.now()) throw new InvalidGrantError('authorization code expired');
    if (row.client_id !== client.client_id) throw new InvalidGrantError('client_id mismatch');
    if (redirectUri !== undefined && redirectUri !== row.redirect_uri) {
      throw new InvalidGrantError('redirect_uri mismatch');
    }
    // Atomic claim — UPDATE sets consumed=1 only if it was 0. If .changes is 0,
    // another request raced and already consumed this code.
    const result = this.codes.consume.run(codeHash);
    if (result.changes === 0) {
      throw new InvalidGrantError('authorization code already used');
    }

    const accessToken = await this.mintAccessToken(client.client_id, row.scope ?? undefined);
    const refreshToken = this.issueRefreshToken(client.client_id, row.scope);
    const tokens: OAuthTokens = {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: ACCESS_TOKEN_TTL_SEC,
      refresh_token: refreshToken,
    };
    if (row.scope !== null) tokens.scope = row.scope;
    return tokens;
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    _scopes?: string[],
    _resource?: URL,
  ): Promise<OAuthTokens> {
    const presentedHash = hashToken(refreshToken);
    const row = this.refresh.get.get(presentedHash);
    if (row === undefined) {
      throw new InvalidGrantError('invalid refresh token');
    }

    // Reuse detection: a token that was already rotated (revoked + has rotated_to)
    // is presented again. Treat as theft and revoke every refresh token for this
    // client per OAuth 2.1 §6.1.
    if (row.revoked === 1) {
      this.refresh.revokeAllForClient.run(row.client_id);
      throw new InvalidGrantError('refresh token reuse detected; all sessions revoked');
    }

    if (row.expires_at < Date.now()) {
      throw new InvalidGrantError('refresh token expired');
    }
    if (row.client_id !== client.client_id) {
      throw new InvalidGrantError('client_id mismatch');
    }

    // Rotate atomically: insert the new token and mark the old one rotated.
    const newRefreshToken = randomBytes(32).toString('base64url');
    const newHash = hashToken(newRefreshToken);
    const now = Date.now();
    const txn = this.deps.db.transaction(() => {
      this.refresh.insert.run(
        newHash,
        row.client_id,
        row.scope,
        now,
        now + REFRESH_TOKEN_TTL_SEC * 1000,
      );
      this.refresh.rotate.run(newHash, presentedHash);
    });
    txn();

    const accessToken = await this.mintAccessToken(client.client_id, row.scope ?? undefined);
    const tokens: OAuthTokens = {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: ACCESS_TOKEN_TTL_SEC,
      refresh_token: newRefreshToken,
    };
    if (row.scope !== null) tokens.scope = row.scope;
    return tokens;
  }

  private issueRefreshToken(clientId: string, scope: string | null): string {
    const token = randomBytes(32).toString('base64url');
    const now = Date.now();
    this.refresh.insert.run(
      hashToken(token),
      clientId,
      scope,
      now,
      now + REFRESH_TOKEN_TTL_SEC * 1000,
    );
    return token;
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const { payload } = await jwtVerify(token, this.deps.signingKey, {
      issuer: this.deps.issuer.href,
      audience: this.deps.audience.href,
    });
    if (typeof payload.sub !== 'string') throw new Error('token missing sub');
    const scope = typeof payload.scope === 'string' ? payload.scope : '';
    const info: AuthInfo = {
      token,
      clientId: payload.sub,
      scopes: scope.length > 0 ? scope.split(' ') : [],
    };
    if (typeof payload.exp === 'number') info.expiresAt = payload.exp;
    return info;
  }

  async approveConsent(sessionId: string): Promise<{ redirectTo: string }> {
    const row = this.pending.get.get(sessionId);
    if (row === undefined) throw new Error('consent session not found or expired');
    if (row.expires_at < Date.now()) {
      this.pending.del.run(sessionId);
      throw new Error('consent session expired');
    }
    const code = randomBytes(24).toString('base64url');
    this.codes.insert.run(
      hashToken(code),
      row.client_id,
      row.redirect_uri,
      row.code_challenge,
      row.code_challenge_method,
      row.scope,
      Date.now() + CODE_TTL_MS,
    );
    this.pending.del.run(sessionId);

    const redirect = new URL(row.redirect_uri);
    redirect.searchParams.set('code', code);
    if (row.state !== null) redirect.searchParams.set('state', row.state);
    return { redirectTo: redirect.href };
  }

  getPending(sessionId: string): { clientName: string; redirectUri: string } | null {
    const row = this.pending.get.get(sessionId);
    if (row === undefined) return null;
    if (row.expires_at < Date.now()) return null;
    const client = this.clientsStore.getClient(row.client_id);
    return {
      clientName: client?.client_name ?? row.client_id,
      redirectUri: row.redirect_uri,
    };
  }

  rememberSource(clientId: string): void {
    const client = this.clientsStore.getClient(clientId);
    if (client === undefined) return;
    this.deps.relayStorage.registerClient({
      clientId,
      sourceLabel: client.client_name ?? clientId,
    });
    this.deps.relayStorage.touchClient(clientId);
  }

  private async mintAccessToken(clientId: string, scope?: string): Promise<string> {
    const jwt = new SignJWT(scope === undefined ? {} : { scope })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer(this.deps.issuer.href)
      .setAudience(this.deps.audience.href)
      .setSubject(clientId)
      .setIssuedAt()
      .setExpirationTime(`${ACCESS_TOKEN_TTL_SEC}s`);
    return jwt.sign(this.deps.signingKey);
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => {
    switch (c) {
      case '&': return '&amp;';
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '"': return '&quot;';
      case "'": return '&#39;';
      default:  return c;
    }
  });
}

function renderConsentPage(opts: { clientName: string; redirectUri: string; sessionId: string; formAction: string; error?: string }): string {
  const errBlock = opts.error === undefined
    ? ''
    : `<p class="err">${escapeHtml(opts.error)}</p>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Approve Connector — Relay</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 28rem; margin: 4rem auto; padding: 0 1rem; color: #222; }
  h1 { font-size: 1.4rem; }
  .card { border: 1px solid #ddd; border-radius: 0.5rem; padding: 1.25rem; }
  dl { margin: 0; }
  dt { font-weight: 600; margin-top: 0.5rem; color: #555; font-size: 0.85rem; }
  dd { margin: 0; word-break: break-all; }
  input[type=password] { width: 100%; padding: 0.5rem; font-size: 1rem; box-sizing: border-box; }
  button { width: 100%; padding: 0.75rem; font-size: 1rem; background: #111; color: #fff; border: 0; border-radius: 0.4rem; margin-top: 0.75rem; cursor: pointer; }
  .err { color: #b00020; margin-top: 0.5rem; }
  .hint { color: #666; font-size: 0.85rem; margin-top: 1rem; }
</style>
</head>
<body>
<h1>Approve this Connector?</h1>
<form method="POST" action="${escapeHtml(opts.formAction)}" class="card">
  <input type="hidden" name="session" value="${escapeHtml(opts.sessionId)}" />
  <dl>
    <dt>Application</dt>
    <dd>${escapeHtml(opts.clientName)}</dd>
    <dt>Will redirect to</dt>
    <dd><code>${escapeHtml(opts.redirectUri)}</code></dd>
  </dl>
  <p class="hint">Enter the admin passcode to approve.</p>
  <label for="passcode" style="display:block;margin-top:0.5rem;">Passcode</label>
  <input id="passcode" name="passcode" type="password" autocomplete="off" required />
  ${errBlock}
  <button type="submit">Approve</button>
</form>
</body>
</html>`;
}

function renderMessagePage(title: string, body: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${escapeHtml(title)} — Relay</title>
<style>body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:28rem;margin:4rem auto;padding:0 1rem;color:#222}</style>
</head><body><h1>${escapeHtml(title)}</h1><p>${escapeHtml(body)}</p></body></html>`;
}

function openAuthDb(dbPath: string): Database.Database {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  // Migration: oauth_codes used to have a `code` column (raw value); we now
  // store SHA-256(code) in `code_hash`. Codes have a 60-second TTL so the
  // table holds at most a few in-flight rows — safe to drop on schema change.
  const codeColumns = db.prepare(`PRAGMA table_info('oauth_codes')`).all() as Array<{ name: string }>;
  if (codeColumns.length > 0 && !codeColumns.some(c => c.name === 'code_hash')) {
    db.exec(`DROP TABLE oauth_codes`);
  }

  db.exec(AUTH_SCHEMA_SQL);
  return db;
}

export interface AuthSubsystem {
  readonly provider: RelayProvider;
  /** Mount /consent (GET, POST) at the given absolute path (e.g. "/relay/auth/consent"). */
  mountConsent(app: express.Express, consentPath: string, adminPasscode: string): void;
  close(): void;
}

export function openAuthSubsystem(opts: {
  dbPath: string;
  signingKey: string;
  issuer: URL;
  audience: URL;
  consentUrl: URL;
  relayStorage: Storage;
}): AuthSubsystem {
  const db = openAuthDb(opts.dbPath);
  const provider = new RelayProvider({
    db,
    signingKey: new TextEncoder().encode(opts.signingKey),
    issuer: opts.issuer,
    audience: opts.audience,
    consentUrl: opts.consentUrl,
    relayStorage: opts.relayStorage,
  });

  return {
    provider,
    mountConsent(app, consentPath, adminPasscode) {
      app.use(express.urlencoded({ extended: false }));

      app.get(consentPath, (req: Request, res: Response) => {
        const sessionId = req.query.session;
        if (typeof sessionId !== 'string') {
          res.status(400).type('html').send(renderMessagePage('Missing session', 'No consent session was provided.'));
          return;
        }
        const pending = provider.getPending(sessionId);
        if (pending === null) {
          res.status(404).type('html').send(renderMessagePage('Expired', 'This consent session is invalid or expired. Restart the connector setup from the client app.'));
          return;
        }
        res.type('html').send(renderConsentPage({ ...pending, sessionId, formAction: consentPath }));
      });

      app.post(consentPath, async (req: Request, res: Response) => {
        const session = (req.body as { session?: unknown })?.session;
        const passcode = (req.body as { passcode?: unknown })?.passcode;
        if (typeof session !== 'string' || typeof passcode !== 'string') {
          res.status(400).type('html').send(renderMessagePage('Bad request', 'Missing fields.'));
          return;
        }
        const pending = provider.getPending(session);
        if (pending === null) {
          res.status(404).type('html').send(renderMessagePage('Expired', 'This consent session is invalid or expired.'));
          return;
        }
        if (!constantTimeEqual(passcode, adminPasscode)) {
          res.status(401).type('html').send(renderConsentPage({ ...pending, sessionId: session, formAction: consentPath, error: 'Wrong passcode.' }));
          return;
        }
        const { redirectTo } = await provider.approveConsent(session);
        res.redirect(redirectTo);
      });
    },
    close() {
      db.close();
    },
  };
}
