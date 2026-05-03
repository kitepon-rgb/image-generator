// image-hub storage — SQLite で artifacts (生成物メタデータ) と clients (auth.ts 用) を管理。
// auth.ts (Relay-MCP からの流用) が要求する registerClient / touchClient interface を満たす。

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS artifacts (
  id              TEXT PRIMARY KEY,
  mime            TEXT NOT NULL,
  schema_version  INTEGER NOT NULL DEFAULT 1,
  prompt          TEXT,
  params_json     TEXT,
  project         TEXT,
  created_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_artifacts_project_created ON artifacts(project, created_at);
CREATE INDEX IF NOT EXISTS idx_artifacts_created ON artifacts(created_at);

CREATE TABLE IF NOT EXISTS clients (
  client_id     TEXT PRIMARY KEY,
  source_label  TEXT NOT NULL,
  last_seen     INTEGER NOT NULL
);
`;

export interface ArtifactRow {
  id: string;
  mime: string;
  schema_version: number;
  prompt: string | null;
  params_json: string | null;
  project: string | null;
  created_at: number;
}

export interface Storage {
  putArtifact(input: {
    id: string;
    mime: string;
    schema_version?: number;
    prompt?: string;
    params_json?: string;
    project?: string;
  }): void;
  getArtifact(id: string): ArtifactRow | undefined;
  listArtifactsByProject(project: string, limit?: number): ArtifactRow[];
  // auth.ts (RelayProvider) から呼ばれる interface
  registerClient(input: { clientId: string; sourceLabel: string }): void;
  touchClient(clientId: string): void;
  close(): void;
}

export function openStorage(dbPath: string): Storage {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA_SQL);

  const insertArtifact = db.prepare<[
    string, string, number, string | null, string | null, string | null, number
  ]>(
    `INSERT INTO artifacts (id, mime, schema_version, prompt, params_json, project, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       mime=excluded.mime,
       schema_version=excluded.schema_version,
       prompt=excluded.prompt,
       params_json=excluded.params_json,
       project=excluded.project`,
  );
  const getArtifactStmt = db.prepare<[string], ArtifactRow>(
    `SELECT id, mime, schema_version, prompt, params_json, project, created_at FROM artifacts WHERE id = ?`,
  );
  const listByProject = db.prepare<[string, number], ArtifactRow>(
    `SELECT id, mime, schema_version, prompt, params_json, project, created_at
       FROM artifacts WHERE project = ? ORDER BY created_at DESC LIMIT ?`,
  );

  const upsertClient = db.prepare<[string, string, number]>(
    `INSERT INTO clients (client_id, source_label, last_seen)
     VALUES (?, ?, ?)
     ON CONFLICT(client_id) DO UPDATE SET source_label=excluded.source_label`,
  );
  const touchClientStmt = db.prepare<[number, string]>(
    `UPDATE clients SET last_seen = ? WHERE client_id = ?`,
  );

  return {
    putArtifact(input) {
      insertArtifact.run(
        input.id,
        input.mime,
        input.schema_version ?? 1,
        input.prompt ?? null,
        input.params_json ?? null,
        input.project ?? null,
        Date.now(),
      );
    },
    getArtifact(id) {
      return getArtifactStmt.get(id);
    },
    listArtifactsByProject(project, limit = 100) {
      return listByProject.all(project, limit);
    },
    registerClient({ clientId, sourceLabel }) {
      upsertClient.run(clientId, sourceLabel, Date.now());
    },
    touchClient(clientId) {
      touchClientStmt.run(Date.now(), clientId);
    },
    close() {
      db.close();
    },
  };
}
