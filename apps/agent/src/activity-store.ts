import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import type { ActivityRecord, CreateActivityInput } from '@devpilot/contracts';

export const agentSchemaVersion = 2;

interface ActivityRow {
  readonly id: string;
  readonly kind: ActivityRecord['kind'];
  readonly severity: ActivityRecord['severity'];
  readonly message: string;
  readonly occurred_at: string;
  readonly metadata_json: string;
}

function toActivity(row: ActivityRow): ActivityRecord {
  let metadata: Readonly<Record<string, unknown>> = {};
  try {
    const parsed = JSON.parse(row.metadata_json) as unknown;
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      metadata = parsed as Readonly<Record<string, unknown>>;
    }
  } catch {
    metadata = {};
  }

  return {
    id: row.id,
    kind: row.kind,
    severity: row.severity,
    message: row.message,
    occurredAt: row.occurred_at,
    metadata,
  };
}

export class ActivityStore {
  readonly #database: DatabaseSync;
  readonly #listeners = new Set<(activity: ActivityRecord) => void>();

  constructor(databasePath: string) {
    if (databasePath !== ':memory:') {
      mkdirSync(dirname(databasePath), { recursive: true });
    }
    this.#database = new DatabaseSync(databasePath);
    this.#database.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    if (databasePath !== ':memory:') {
      this.#database.exec('PRAGMA journal_mode = WAL;');
    }
    this.#migrate();
  }

  #migrate(): void {
    const currentVersion = this.#database.prepare('PRAGMA user_version').get() as {
      user_version: number;
    };
    if (currentVersion.user_version < 1) {
      this.#database.exec(`
      BEGIN IMMEDIATE;
      CREATE TABLE IF NOT EXISTS pairings (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        device_name TEXT,
        public_key TEXT,
        token_hash TEXT,
        created_at TEXT NOT NULL,
        expires_at TEXT,
        approved_at TEXT,
        revoked_at TEXT
      );
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        root_path TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id),
        state TEXT NOT NULL,
        device_id TEXT,
        started_at TEXT NOT NULL,
        ended_at TEXT
      );
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        session_id TEXT REFERENCES sessions(id),
        state TEXT NOT NULL,
        idempotency_key TEXT UNIQUE,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS approvals (
        id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL REFERENCES jobs(id),
        decision TEXT,
        created_at TEXT NOT NULL,
        decided_at TEXT
      );
      CREATE TABLE IF NOT EXISTS activities (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        severity TEXT NOT NULL,
        message TEXT NOT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        occurred_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_activities_occurred_at
        ON activities(occurred_at DESC);
      CREATE TABLE IF NOT EXISTS test_metadata (
        id TEXT PRIMARY KEY,
        project_id TEXT REFERENCES projects(id),
        status TEXT NOT NULL,
        summary_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      );
      PRAGMA user_version = 1;
      COMMIT;
    `);
    }

    if (currentVersion.user_version < 2) {
      this.#database.exec(`
        BEGIN IMMEDIATE;
        ALTER TABLE pairings ADD COLUMN nonce_hash TEXT;
        ALTER TABLE pairings ADD COLUMN confirmation_ticket_hash TEXT;
        ALTER TABLE pairings ADD COLUMN delivery_ciphertext TEXT;
        ALTER TABLE pairings ADD COLUMN delivery_consumed_at TEXT;
        ALTER TABLE pairings ADD COLUMN failed_attempts INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE pairings ADD COLUMN updated_at TEXT;
        CREATE TABLE IF NOT EXISTS device_tokens (
          id TEXT PRIMARY KEY,
          pairing_id TEXT NOT NULL REFERENCES pairings(id),
          kind TEXT NOT NULL CHECK(kind IN ('access', 'refresh')),
          token_hash TEXT NOT NULL UNIQUE,
          expires_at TEXT NOT NULL,
          revoked_at TEXT,
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_device_tokens_pairing
          ON device_tokens(pairing_id, kind, revoked_at);
        PRAGMA user_version = 2;
        COMMIT;
      `);
    }
  }

  schemaVersion(): number {
    const row = this.#database.prepare('PRAGMA user_version').get() as { user_version: number };
    return row.user_version;
  }

  append(input: CreateActivityInput, occurredAt = new Date().toISOString()): ActivityRecord {
    const activity: ActivityRecord = {
      id: randomUUID(),
      kind: input.kind,
      severity: input.severity ?? 'info',
      message: input.message,
      occurredAt,
      metadata: input.metadata ?? {},
    };
    this.#database
      .prepare(
        `INSERT INTO activities
          (id, kind, severity, message, metadata_json, occurred_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        activity.id,
        activity.kind,
        activity.severity,
        activity.message,
        JSON.stringify(activity.metadata),
        activity.occurredAt,
      );
    for (const listener of this.#listeners) {
      listener(activity);
    }
    return activity;
  }

  list(limit = 50): readonly ActivityRecord[] {
    const safeLimit = Math.min(Math.max(limit, 1), 200);
    const rows = this.#database
      .prepare(
        `SELECT id, kind, severity, message, metadata_json, occurred_at
         FROM activities ORDER BY occurred_at DESC LIMIT ?`,
      )
      .all(safeLimit) as unknown as ActivityRow[];
    return rows.map(toActivity);
  }

  purgeOlderThan(retentionDays: number, now = new Date()): number {
    const cutoff = new Date(now.getTime() - retentionDays * 86_400_000).toISOString();
    const result = this.#database
      .prepare('DELETE FROM activities WHERE occurred_at < ?')
      .run(cutoff);
    return Number(result.changes);
  }

  subscribe(listener: (activity: ActivityRecord) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  close(): void {
    this.#database.close();
  }
}
